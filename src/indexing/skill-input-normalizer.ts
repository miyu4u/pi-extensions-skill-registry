import os from 'node:os'
import path from 'node:path'
import type { SettingsLoaderInterface } from '../settings'
import {
  DEFAULT_FILE_NAMES,
  SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT,
  SKILL_RESOLVE_SUGGESTION_HARD_CAP,
  type SkillGraphMode,
  type SkillRelationMode,
  type ToolContext,
  type ToolInput,
  type SkillTaskSize,
  type SkillRegistrySettings,
} from '../shared'
import { normalizeSkillName } from './skill-name-normalizer'
import type { SkillScopeResolverInterface } from './skill-scope-resolver.interface'

type ResolvedSettings = Required<SkillRegistrySettings> & {
  scopeRoots: Record<string, string[]>
  scopePriority: string[]
}

const TASK_SIZE_LIMITS = {
  small: 2,
  medium: 5,
} as const

/** Tool 입력을 설정 기반 실행 컨텍스트로 정규화합니다. */
export class SkillInputNormalizer {
  constructor(
    private readonly settingsLoader: SettingsLoaderInterface,
    private readonly scopeResolver: SkillScopeResolverInterface,
  ) {}

  normalizeToolInput(params: ToolInput): ToolContext {
    const settings = this.settingsLoader.loadSettings()
    const scopeSelection = this.resolveScopeSelection(params.scopes, settings.scopeRoots, settings.scopePriority)
    const { roots, fileNames } = this.resolveRootsAndFileNames(params, settings, scopeSelection)
    const { taskSize, limit, suggestionLimit } = this.resolveLimitSettings(params, settings)
    const modes = this.resolveExecutionModes(params, taskSize)

    return {
      action: params.action,
      query: params.query?.trim(),
      names: this.normalizeNames(params.names),
      orderedNames: this.normalizeNames(params.names, true),
      scopes: scopeSelection.scopes,
      scopesExplicit: scopeSelection.explicit,
      suggestionLimit,
      roots,
      fileNames,
      limit,
      taskSize,
      ...modes,
      settings: this.resolveNestedSettings(params, settings, roots, fileNames),
    }
  }

  /**
   * 입력의 roots 및 fileNames를 로드된 설정과 병합하여
   * 정규화된 최종 roots와 fileNames 목록을 결정합니다.
   */
  private resolveRootsAndFileNames(
    params: ToolInput,
    settings: ResolvedSettings,
    scopeSelection: { scopes: string[]; roots: string[]; explicit: boolean },
  ) {
    const roots = this.selectConfiguredRoots(
      params.roots?.length ? params.roots : settings.roots,
      settings.scopeRoots,
      settings.scopePriority,
      scopeSelection,
    )
    const fileNames = params.fileNames?.length ? this.normalizeFileNames(params.fileNames) : settings.fileNames
    return { roots, fileNames }
  }

  /**
   * 입력의 taskSize, limit 및 suggestionLimit을 평가하여
   * 최대 상한 값을 넘지 않도록 정규화합니다.
   */
  private resolveLimitSettings(
    params: ToolInput,
    settings: ResolvedSettings,
  ): {
    taskSize: SkillTaskSize
    limit: number
    suggestionLimit: number
  } {
    const taskSize = this.normalizeTaskSize(params.taskSize)
    const taskSizeLimit = taskSize === 'large' ? settings.maxTopK : TASK_SIZE_LIMITS[taskSize]
    const requestedLimit = params.limit ?? taskSizeLimit
    const limit = Math.max(1, Math.min(requestedLimit, settings.maxTopK, taskSizeLimit))

    const suggestionLimit = Math.max(
      0,
      Math.min(params.suggestionLimit ?? SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT, SKILL_RESOLVE_SUGGESTION_HARD_CAP),
    )

    return { taskSize, limit, suggestionLimit }
  }

  private normalizeTaskSize(taskSize: ToolInput['taskSize']): SkillTaskSize {
    if (taskSize === 'small') {
      return 'small'
    }
    if (taskSize === 'large') {
      return 'large'
    }
    return 'medium'
  }

  /**
   * 입력 파라미터를 기반으로 관계/그래프 모드, 바디 포함 여부 및
   * 실행 한계 임계값 등의 옵션을 설정합니다.
   */
  private resolveExecutionModes(
    params: ToolInput,
    taskSize: 'large' | 'medium' | 'small',
  ): {
    relationMode: SkillRelationMode
    graphMode: SkillGraphMode
    includeBody: boolean
    refresh: boolean
    minScore: number
    budgetChars: number
    budgetTokens: number
    coverageThreshold: number
  } {
    const relationMode: SkillRelationMode = params.relationMode === 'required' || taskSize !== 'large' ? 'required' : 'full'
    const graphMode: SkillGraphMode =
      params.graphMode === 'inbound' || params.graphMode === 'cycles' || params.graphMode === 'orphans' ? params.graphMode : 'outbound'
    const includeBody = params.includeBody ?? params.action !== 'resolve'

    return {
      relationMode,
      graphMode,
      includeBody,
      refresh: params.refresh ?? false,
      minScore: params.minScore ?? 0,
      budgetChars: params.budgetChars ?? 4_000,
      budgetTokens: params.budgetTokens ?? 1_000,
      coverageThreshold: params.coverageThreshold ?? 0.7,
    }
  }

  /**
   * 최종 확정된 roots 및 fileNames를 기반으로
   * 컨텍스트 내부에 포함될 병합 설정을 빌드합니다.
   */
  private resolveNestedSettings(params: ToolInput, settings: ResolvedSettings, roots: string[], fileNames: string[]): ResolvedSettings {
    const includePreviewBodyChars =
      params.includePreviewBodyChars && params.includePreviewBodyChars > 0
        ? params.includePreviewBodyChars
        : settings.includePreviewBodyChars
    return {
      ...settings,
      roots,
      fileNames,
      includePreviewBodyChars,
    }
  }

  /**
   * 기존 scan root 범위를 유지하면서 명시 scope 요청에 해당하는 root만
   * boundary-aware 분류 결과로 선택합니다.
   */
  private selectConfiguredRoots(
    configuredRoots: string[],
    scopeRoots: Record<string, string[]>,
    scopePriority: string[],
    selection: { scopes: string[]; explicit: boolean; roots: string[] },
  ): string[] {
    const normalizedRoots = this.normalizeRootList(configuredRoots)
    if (!selection.explicit) {
      return normalizedRoots
    }
    if (selection.scopes.length === 0) {
      return []
    }
    const entries = this.scopeResolver.resolveScopeRootEntries(scopeRoots, scopePriority)
    const selectedScopes = new Set(selection.scopes)
    const selectedScopeRoots = selection.roots.length > 0 ? selection.roots : this.flattenScopeRoots(scopeRoots, selection.scopes)
    return normalizedRoots.filter((root) => {
      if (selectedScopes.has(this.scopeResolver.classifySourcePath(root, entries))) {
        return true
      }
      return this.isBoundaryRelatedToAnySelectedScopeRoot(root, selectedScopeRoots)
    })
  }

  /**
   * 요청 스코프 입력을 설정 기반 정책으로 정규화해
   * 생략/명시 여부와 유효성별 루트 대상 목록을 결정합니다.
   */
  private resolveScopeSelection(
    inputScopes: string[] | undefined,
    scopeRoots: Record<string, string[]>,
    scopePriority: string[],
  ): { scopes: string[]; roots: string[]; explicit: boolean } {
    if (inputScopes === undefined) {
      const allScopes = this.orderScopeNames(scopePriority, Object.keys(scopeRoots))
      return {
        scopes: allScopes,
        roots: this.flattenScopeRoots(scopeRoots, allScopes),
        explicit: false,
      }
    }

    const explicitScopes = this.normalizeStrings(inputScopes)
    if (explicitScopes.length === 0) {
      return {
        scopes: [],
        roots: [],
        explicit: true,
      }
    }

    const scopeNameSet = new Set<string>(Object.keys(scopeRoots))
    if (!explicitScopes.every((scopeName) => scopeNameSet.has(scopeName))) {
      return {
        scopes: [],
        roots: [],
        explicit: true,
      }
    }

    const orderedScopes = this.orderScopeNames(scopePriority, explicitScopes)
    const selectedScopes = orderedScopes.filter((scopeName) => scopeNameSet.has(scopeName))
    return {
      scopes: selectedScopes,
      roots: this.flattenScopeRoots(scopeRoots, selectedScopes),
      explicit: true,
    }
  }

  /**
   * 루트 정렬 우선순위를 scopePriority 기반으로 구성해
   * priority 뒤편의 미래 스코프 키까지 보존합니다.
   */
  private orderScopeNames(scopePriority: string[], scopeNames: string[]): string[] {
    const requestedScopes = new Set(scopeNames)
    const orderedScopes = [...scopePriority.filter((scope) => requestedScopes.has(scope)), ...scopeNames]
    const dedupedScopes: string[] = []
    const seen = new Set<string>()
    for (const scopeName of orderedScopes) {
      if (seen.has(scopeName)) {
        continue
      }
      seen.add(scopeName)
      dedupedScopes.push(scopeName)
    }
    return dedupedScopes
  }

  /**
   * 스코프별 루트 목록을 정규화해 병합하고
   * 중복 없는 deterministic한 탐색 대상 경로 배열을 반환합니다.
   */
  private flattenScopeRoots(scopeRoots: Record<string, string[]>, scopeNames: string[]): string[] {
    const dedupedRoots = new Set<string>()
    for (const scopeName of scopeNames) {
      const roots = scopeRoots[scopeName]
      if (!Array.isArray(roots)) {
        continue
      }
      for (const rawRoot of roots) {
        const normalizedRoot = this.normalizeRoot(rawRoot)
        if (normalizedRoot) {
          dedupedRoots.add(normalizedRoot)
        }
      }
    }

    return [...dedupedRoots]
  }

  /**
   * 공백 제거, 경로 정규화, 절대경로 확장, 중복 제거를 통해
   * 경로 리스트를 요청 스캔 입력으로 맞춥니다.
   */
  private normalizeRootList(rawRoots: string[]): string[] {
    const normalizedRoots = rawRoots
      .map((rawRoot) => this.normalizeRoot(rawRoot))
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
    return [...new Set(normalizedRoots)]
  }

  private normalizeNames(names?: string[], preserveOrder = false): string[] {
    if (!names || names.length === 0) {
      return []
    }
    const deduped = [...new Set(names.map(normalizeSkillName).filter(Boolean))]
    return preserveOrder ? deduped : deduped.sort()
  }

  private normalizeFileNames(fileNames: string[]): string[] {
    const deduped = [...new Set(fileNames.map((name) => name.trim()).filter(Boolean))]
    return deduped.length > 0 ? deduped : DEFAULT_FILE_NAMES
  }

  /**
   * 문자열 배열에서 trim + dedupe를 수행해
   * 값이 빈 항목을 제거하고 순서를 안정적으로 정리합니다.
   */
  private normalizeStrings(values: string[]): string[] {
    const normalizedValues = values.map((value) => value.trim()).filter(Boolean)
    return [...new Set(normalizedValues)]
  }

  /**
   * 루트 문자열의 `~`, 상대 경로, 구분자/슬래시 정규화를
   * 통해 실제 검색에서 사용할 절대 경로 형태로 변환합니다.
   */
  private normalizeRoot(raw: string): string {
    const normalized = this.resolvePath(raw)
    return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(normalized)
  }

  /**
   * 사용자 홈(`~`) 확장만 담당하는 기본 경로 보정입니다.
   */
  private resolvePath(raw: string): string {
    if (!raw) {
      return raw
    }
    return raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(1)) : raw
  }

  /**
   * 루트 관계를 boundary 기준으로 판정해 ancestor/descendant 관계를 판정합니다.
   */
  private isBoundaryRelatedToAnySelectedScopeRoot(candidateRoot: string, scopeRoots: string[]): boolean {
    const normalizedCandidate = this.normalizeBoundaryPath(candidateRoot)
    if (!normalizedCandidate) {
      return false
    }

    return scopeRoots.some((scopeRoot) => {
      const normalizedScopeRoot = this.normalizeBoundaryPath(scopeRoot)
      if (!normalizedScopeRoot) {
        return false
      }
      return (
        this.isBoundaryMatch(normalizedCandidate, normalizedScopeRoot) || this.isBoundaryMatch(normalizedScopeRoot, normalizedCandidate)
      )
    })
  }

  /**
   * boundary 매칭에 사용할 경로 문자열을 슬래시 통일/정규화합니다.
   */
  private normalizeBoundaryPath(rawPath: string): string {
    if (!rawPath) {
      return ''
    }
    const normalized = rawPath.replace(/\\/g, '/')
    if (normalized.length <= 1) {
      return normalized
    }
    if (/^[A-Za-z]:\/$/u.test(normalized)) {
      return normalized
    }
    return normalized.replace(/\/+$/u, '')
  }

  /**
   * 후보 경로가 root 경계 내부이거나 경계일치일 때 true를 반환합니다.
   */
  private isBoundaryMatch(candidatePath: string, root: string): boolean {
    if (!candidatePath || !root) {
      return false
    }
    if (root === '/') {
      return candidatePath.startsWith('/')
    }
    if (/^[A-Za-z]:\/$/u.test(root)) {
      return candidatePath.startsWith(root)
    }
    if (candidatePath === root) {
      return true
    }
    return candidatePath.startsWith(`${root}/`)
  }
}
