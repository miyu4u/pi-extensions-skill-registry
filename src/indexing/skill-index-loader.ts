import type { IndexArtifacts, IndexedStats, RawSkill, ToolContext } from '../shared'
import type { TokenizerContract } from '../tokenization'
import type { ActiveIndexStore } from './active-index-store'
import type { SkillDocumentParser } from './skill-document-parser'
import type { SkillFileScanner } from './skill-file-scanner'
import { normalizeSkillName } from './skill-name-normalizer'
import type { SkillScopeResolverInterface, SkillScopeRootEntry } from './skill-scope-resolver.interface'
import type { SkillSearchDatabaseInterface, SkillSearchDocument, SkillSearchSnapshot } from './skill-search-database.interface'
import type { SkillSourceScanResult, SourceManifestInterface } from './source-manifest.interface'

const FULL_DECISION_ACTIONS: Record<string, true> = {
  compare: true,
  decide: true,
  plan: true,
  route: true,
  brief: true,
  bundle: true,
  handoff: true,
  'session-packet': true,
  'turn-packet': true,
  'recovery-packet': true,
  'resume-packet': true,
  'markdown-packet': true,
  'checklist-packet': true,
  'commands-packet': true,
  'file-ready-packet': true,
  'apply-packet': true,
  'write-script-packet': true,
  'execution-packet': true,
  'verification-packet': true,
  'summary-packet': true,
}
const EXEMPT_ACTIONS: Record<string, true> = {
  compose: true,
  validate: true,
  recommend: true,
  audit: true,
  graph: true,
  pack: true,
  resolve: true,
  gap: true,
  explain: true,
}

interface LoadIndexPrep {
  databasePath: string
  explicitScopes: boolean
  classificationScopeEntries: SkillScopeRootEntry[]
  selectedScopeEntries: SkillScopeRootEntry[]
  scopeSelection: {
    scopes: string[]
    scopeSet: Set<string>
    safeZero: boolean
  }
  scopedRootMap: Record<string, string[]>
  scopedRoots: string[]
  scopePriority: string[]
  effectiveNames: string[]
  shouldFilterByRequestedNames: boolean
  scanRequestedSet: Set<string>
  requestedSet: Set<string>
  stats: ScopedIndexedStats
  requestKey: string
  now: number
  input: ToolContext
}

interface AliasResolutionContext {
  aliasToCanonical: Map<string, string>
  canonicalToSkill: Map<string, RawSkill>
  scopePriorityRank: Map<string, number>
  stats?: IndexedStats
}
type ScopedIndexedStats = IndexedStats & {
  scopeDistribution: Record<string, number>
}
/**
 * scope 선택/필터 상태에서 통계가 의존하는 요청 실행 결과를 기술합니다.
 */

interface SkillIndexLoaderDependencies {
  /** SQLite snapshot과 FTS lifecycle owner입니다. */
  searchDatabase: SkillSearchDatabaseInterface
  /** 검색 문서 token derivation contract입니다. */
  searchTokenizer: TokenizerContract
  /** Filesystem skill 후보 scanner입니다. */
  fileScanner: SkillFileScanner
  /** Markdown skill document parser입니다. */
  documentParser: SkillDocumentParser
  /** Process-local active index state owner입니다. */
  activeIndexStore: ActiveIndexStore
  /** Configured scope provenance resolver입니다. */
  scopeResolver: SkillScopeResolverInterface
  /** Filesystem source freshness signature contract입니다. */
  sourceManifest: SourceManifestInterface
}

interface ScanSourcesRequest {
  /** 정규화된 tool execution context입니다. */
  input: ToolContext
  /** 요청이 scope를 명시했는지 나타냅니다. */
  explicitScopes: boolean
  /** 요청 scope의 exact-match set입니다. */
  scopeSet: ReadonlySet<string>
  /** 유효한 scope가 없어 빈 결과를 반환해야 하는지 나타냅니다. */
  safeZero: boolean
  /** Path provenance 판별에 사용하는 configured scope entries입니다. */
  scopeEntries: readonly SkillScopeRootEntry[]
  /** Targeted scan에 사용하는 canonical requested names입니다. */
  requestedSet: Set<string>
}

/** Skill index 생성, cache, snapshot lifecycle의 concrete owner입니다. */
export class SkillIndexLoader {
  private readonly searchDatabase: SkillSearchDatabaseInterface
  private readonly searchTokenizer: TokenizerContract
  private readonly fileScanner: SkillFileScanner
  private readonly documentParser: SkillDocumentParser
  private readonly activeIndexStore: ActiveIndexStore
  private readonly scopeResolver: SkillScopeResolverInterface
  private readonly sourceManifest: SourceManifestInterface

  constructor(deps: SkillIndexLoaderDependencies) {
    this.searchDatabase = deps.searchDatabase
    this.searchTokenizer = deps.searchTokenizer
    this.fileScanner = deps.fileScanner
    this.documentParser = deps.documentParser
    this.activeIndexStore = deps.activeIndexStore
    this.scopeResolver = deps.scopeResolver
    this.sourceManifest = deps.sourceManifest
  }

  /**
   * Resolver가 매칭하지 못한 경로를 표현하기 위한 고정 라벨입니다.
   */
  private readonly unclassifiedScope = 'unclassified'

  /**
   * 열린 SQLite index와 process cache를 닫습니다.
   */
  close(): void {
    this.searchDatabase.close()
    this.activeIndexStore.clear()
    this.activeIndexStore.setDatabasePath('')
  }

  /**
   * 정규화된 context 기준으로 skill index를 로드합니다.
   */
  async loadIndex(input: ToolContext): Promise<IndexArtifacts> {
    const ctx = this.prepareLoadContext(input)
    await this.initDatabase(ctx.databasePath)
    const sourceScans = this.scanSources({
      input,
      explicitScopes: ctx.explicitScopes,
      scopeSet: ctx.scopeSelection.scopeSet,
      safeZero: ctx.scopeSelection.safeZero,
      scopeEntries: ctx.selectedScopeEntries,
      requestedSet: ctx.scanRequestedSet,
    })
    const sourceSignature = this.createSourceSignature(sourceScans)
    const cached = this.tryGetProcessCache(input.refresh, ctx.requestKey, sourceSignature, ctx.now)
    if (cached) {
      return cached
    }
    const persisted = this.tryGetPersistedSnapshot(input.refresh, ctx.requestKey, sourceSignature, ctx.now)
    if (persisted) {
      return persisted
    }
    const buildStartedAt = Date.now()
    if (ctx.scopeSelection.safeZero) {
      return this.handleSafeZero(ctx, sourceSignature, buildStartedAt)
    }
    return this.rebuildIndex(ctx, sourceScans, sourceSignature, buildStartedAt)
  }

  /**
   * persisted snapshot을 활성 process index로 변환합니다.
   */
  private activateSnapshot(snapshot: SkillSearchSnapshot): IndexArtifacts {
    const scopePriorityRank = this.buildScopeRank(snapshot.settings.scopePriority)
    const aliasToCanonical = this.buildAliasToCanonical(snapshot.skills, undefined, scopePriorityRank)
    const indexData: IndexArtifacts = {
      generatedAt: snapshot.generatedAt,
      ttlMs: snapshot.ttlMs,
      requestKey: snapshot.requestKey,
      sourceSignature: snapshot.sourceSignature,
      settings: snapshot.settings,
      requestedNames: snapshot.requestedNames,
      skills: snapshot.skills,
      docCount: snapshot.skills.length,
      stats: snapshot.stats,
      dfByTerm: snapshot.dfByTerm,
      aliasToCanonical,
      avgLength: snapshot.avgLength,
      indexBuildMs: snapshot.indexBuildMs,
    }

    this.activeIndexStore.activate(indexData, snapshot.snapshotToken)
    return indexData
  }

  /**
   * Cache freshness와 rebuild가 동일한 traversal 결과를 공유하도록 root scan을 한 번만 수행합니다.
   */
  private scanSources(request: ScanSourcesRequest): SkillSourceScanResult[] {
    const { input, explicitScopes, scopeSet, safeZero, scopeEntries, requestedSet } = request
    if (safeZero) {
      return []
    }
    const scans: SkillSourceScanResult[] = []
    for (const root of input.roots) {
      if (explicitScopes && !this.isRootAllowedByExplicitScopes(root, scopeSet, scopeEntries)) {
        continue
      }
      const scan = this.fileScanner.scan(root, input.fileNames, requestedSet)
      if (!explicitScopes || scan.missingRoot) {
        scans.push(scan)
        continue
      }
      const sourceFiles = scan.sourceFiles.filter((file) => scopeSet.has(this.resolveSkillScope(file.path, scopeEntries)))
      const includedPaths = new Set(sourceFiles.map((file) => file.path))
      scans.push({
        ...scan,
        files: scan.files.filter((file) => includedPaths.has(file)),
        sourceFiles,
      })
    }
    return scans
  }

  /**
   * Test doubles의 단계적 전환 중에도 명시적 deterministic service를 우선 사용합니다.
   */
  private createSourceSignature(scans: readonly SkillSourceScanResult[]): string {
    return this.sourceManifest.createSignature(scans)
  }

  /**
   * skill의 검색 필드를 기존 tokenizer로 정규화합니다.
   */
  private buildSearchDocument(skill: RawSkill): SkillSearchDocument {
    return {
      skillId: skill.id,
      canonicalName: this.serializeSearchText(skill.canonicalName),
      aliases: this.serializeSearchText(skill.aliases.join(' ')),
      title: this.serializeSearchText(skill.title),
      description: this.serializeSearchText(skill.frontmatter.description ?? ''),
      category: this.serializeSearchText(skill.category),
      keywords: this.serializeSearchText(skill.keywords.join(' ')),
      tags: this.serializeSearchText(skill.tags.join(' ')),
      bodyText: this.serializeSearchText(skill.bodyText),
    }
  }

  /**
   * 설정 scopePriority 기준으로 scope를 정수 순위로 정규화합니다.
   * 목록 앞쪽이 더 높은 우선순위입니다.
   */
  private buildScopeRank(scopePriority: string[]): Map<string, number> {
    const scopeRankByName = new Map<string, number>()
    for (const scopeName of this.dedupeValues(scopePriority)) {
      if (scopeRankByName.has(scopeName)) {
        continue
      }
      scopeRankByName.set(scopeName, scopeRankByName.size)
    }
    return scopeRankByName
  }

  /**
   * 비교 대상 canonical의 우선순위를 결정합니다.
   * priority 값이 낮을수록 더 선호되며, 미지정 스코프는 가장 낮은 우선순위로 간주합니다.
   */
  private getScopePriority(scope: string | undefined, scopePriorityRank: Map<string, number>): number {
    const normalizedScope = scope?.trim()
    if (!normalizedScope) {
      return Number.MAX_SAFE_INTEGER
    }
    return scopePriorityRank.get(normalizedScope) ?? Number.MAX_SAFE_INTEGER
  }

  /**
   * canonical 중복에서 기존 skill이 새 후보보다 우선인지 판단합니다.
   * 1) scopePriority, 2) 최신 mtime, 3) 경로 사전식 정렬로
   * traversal 의존성을 제거해 완전 결정적 승자를 만듭니다.
   */
  private isPreferredCanonicalCollision(existing: RawSkill, candidate: RawSkill, scopePriorityRank: Map<string, number>): number {
    const existingPriority = this.getScopePriority(existing.scope, scopePriorityRank)
    const candidatePriority = this.getScopePriority(candidate.scope, scopePriorityRank)
    if (existingPriority !== candidatePriority) {
      return existingPriority < candidatePriority ? -1 : 1
    }
    if (existing.mtimeMs !== candidate.mtimeMs) {
      return existing.mtimeMs > candidate.mtimeMs ? -1 : 1
    }
    if (existing.path === candidate.path) {
      return 0
    }
    return existing.path.localeCompare(candidate.path) <= 0 ? -1 : 1
  }

  /**
   * base token을 유지하면서 한국어 derived token을 보강합니다.
   */
  private serializeSearchText(text: string): string {
    if (!text) {
      return ''
    }
    const tokenization = this.searchTokenizer.tokenizeDocumentText(text)
    return [...tokenization.baseTokens, ...tokenization.derivedTokens.map((token) => token.token)].join(' ')
  }

  /**
   * scope resolver와 요청 모드에 따라 scope-root 해석 엔트리를 구성합니다.
   */
  private resolveScopeEntries(
    scopeRoots: Record<string, string[]>,
    scopePriority: string[],
    requestedScopes?: string[] | readonly string[],
  ): SkillScopeRootEntry[] {
    if (!this.scopeResolver) {
      return []
    }
    return this.scopeResolver.resolveScopeRootEntries(scopeRoots, scopePriority, requestedScopes)
  }

  /**
   * 명시 스코프 모드인지에 따라 요청 스코프, Set, safe-zero 필요 여부를 계산합니다.
   */
  private buildScopeSelection(
    input: ToolContext,
    explicitScopes: boolean,
    scopeEntries: readonly SkillScopeRootEntry[],
  ): {
    scopes: string[]
    scopeSet: Set<string>
    safeZero: boolean
  } {
    if (!explicitScopes) {
      const scopes = this.dedupeValues(scopeEntries.map((entry) => entry.scope)).sort((a, b) => a.localeCompare(b))
      return {
        scopes,
        scopeSet: new Set(scopes),
        safeZero: false,
      }
    }

    const selectedScopes = this.dedupeValues(input.scopes)
    if (selectedScopes.length === 0 || scopeEntries.length === 0) {
      return {
        scopes: selectedScopes,
        scopeSet: new Set(),
        safeZero: true,
      }
    }

    return {
      scopes: selectedScopes,
      scopeSet: new Set(selectedScopes),
      safeZero: false,
    }
  }

  /**
   * resolver가 산출한 scope-root 엔트리를 스코프별 정규화 맵으로 정렬합니다.
   */
  private buildScopeRootMap(entries: readonly SkillScopeRootEntry[]): Record<string, string[]> {
    const grouped: Record<string, Set<string>> = {}
    for (const { scope, root } of entries) {
      let bucket = grouped[scope]
      if (!bucket) {
        grouped[scope] = new Set()
        bucket = grouped[scope]
      }
      bucket?.add(root)
    }

    const map: Record<string, string[]> = {}
    const scopes = this.dedupeValues(Object.keys(grouped)).sort((a, b) => a.localeCompare(b))
    for (const scope of scopes) {
      const bucket = grouped[scope]
      map[scope] = bucket ? [...bucket].sort((a, b) => a.localeCompare(b)) : []
    }
    return map
  }

  /**
   * 스코프별 루트 맵을 request key에 쓰기 위해 정렬된 단일 루트 배열로 펼칩니다.
   */
  private flattenScopeRoots(scopeMap: Record<string, string[]>): string[] {
    const flattened: string[] = []
    for (const scope of Object.keys(scopeMap).sort((a, b) => a.localeCompare(b))) {
      flattened.push(...scopeMap[scope])
    }
    return flattened
  }

  /**
   * explicit 스코프 요청에서 root 단위로 스캔을 생략할지 판정합니다.
   */
  private isRootAllowedByExplicitScopes(
    root: string,
    requestedScopes: ReadonlySet<string>,
    scopeEntries: readonly SkillScopeRootEntry[],
  ): boolean {
    if (!this.scopeResolver || requestedScopes.size === 0) {
      return true
    }
    const normalizedRoot = this.normalizeBoundaryPathForAncestorFilter(root)
    if (!normalizedRoot) {
      return false
    }

    for (const { scope, root: resolvedRoot } of scopeEntries) {
      if (!requestedScopes.has(scope)) {
        continue
      }
      const normalizedScopeRoot = this.normalizeBoundaryPathForAncestorFilter(resolvedRoot)
      if (!normalizedScopeRoot) {
        continue
      }
      if (this.isBoundaryMatch(normalizedRoot, normalizedScopeRoot) || this.isBoundaryMatch(normalizedScopeRoot, normalizedRoot)) {
        return true
      }
    }
    return false
  }

  /**
   * 경계 매칭에 사용할 경로 문자열을 슬래시 통일 및 trailing separator 제거로 정규화합니다.
   */
  private normalizeBoundaryPathForAncestorFilter(rawPath: string): string {
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
   * 두 경로가 경계 기준으로 포함 관계인지 판단합니다.
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

  /**
   * 파싱된 문서를 scope 라벨로 분류해 글로벌 corpus 분할 누수를 차단합니다.
   */
  private resolveSkillScope(skillPath: string, scopeEntries: readonly SkillScopeRootEntry[]): string {
    if (!this.scopeResolver || scopeEntries.length === 0) {
      return this.unclassifiedScope
    }
    return this.scopeResolver.classifySourcePath(skillPath, scopeEntries)
  }

  /**
   * 최종 삽입되는 스킬 목록 기준으로 scope 분포 통계를 계산합니다.
   */
  private buildScopeDistribution(skills: readonly RawSkill[]): Record<string, number> {
    const distribution: Record<string, number> = {}
    for (const skill of skills) {
      const scope = skill.scope ?? this.unclassifiedScope
      distribution[scope] = (distribution[scope] ?? 0) + 1
    }
    return distribution
  }

  /**
   * 입력 문자열 배열을 정렬을 유지한 상태로 중복 제거합니다.
   */
  private dedupeValues(values: readonly string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of values) {
      if (seen.has(value)) {
        continue
      }
      seen.add(value)
      result.push(value)
    }
    return result
  }

  /**
   * canonical name 우선, scopePriority 기반 alias precedence로 exact lookup을 구성합니다.
   */
  private buildAliasToCanonical(
    skills: RawSkill[],
    stats?: IndexedStats,
    scopePriorityRank: Map<string, number> = new Map(),
  ): Map<string, string> {
    const aliasToCanonical = new Map<string, string>()
    const canonicalToSkill = new Map<string, RawSkill>()
    for (const skill of skills) {
      aliasToCanonical.set(skill.canonicalName, skill.canonicalName)
      canonicalToSkill.set(skill.canonicalName, skill)
    }
    const ctx: AliasResolutionContext = {
      aliasToCanonical,
      canonicalToSkill,
      scopePriorityRank,
      stats,
    }
    for (const skill of skills) {
      for (const alias of skill.aliases) {
        this.resolveAliasCollision(alias, skill, ctx)
      }
    }
    return aliasToCanonical
  }

  private buildStats(requestedSet: Set<string>, shouldFilter: boolean): ScopedIndexedStats {
    return {
      totalFilesVisited: 0,
      totalParsed: 0,
      skippedMissingRoot: 0,
      parseErrors: 0,
      deduplicated: 0,
      missingFromRequested: Array.from(requestedSet),
      malformedFiles: [],
      duplicateCanonicalEntries: [],
      duplicateAliasEntries: [],
      nameFilterMode: shouldFilter ? 'targeted' : 'full',
      scopeDistribution: {},
    }
  }

  private buildRequestKey(input: ToolContext, prep: Partial<LoadIndexPrep> & { preset: string[] }): string {
    return JSON.stringify({
      roots: input.roots,
      fileNames: input.fileNames,
      names: prep.effectiveNames,
      preset: prep.preset,
      nameFilterMode: prep.shouldFilterByRequestedNames ? 'targeted' : 'full',
      databasePath: input.settings.databasePath,
      selectedScopes: prep.scopeSelection?.scopes,
      scopesExplicit: prep.explicitScopes,
      effectiveRoots: prep.scopedRoots,
      normalizedScopeMap: prep.scopedRootMap,
      scopePriority: prep.scopePriority,
    })
  }

  private prepareLoadContextPrefix(input: ToolContext) {
    const preset = input.settings.presetSkills.map(normalizeSkillName)
    const explicitScopes = input.scopesExplicit === true
    const classEntries = this.resolveScopeEntries(input.settings.scopeRoots, input.settings.scopePriority)
    const selEntries = this.resolveScopeEntries(
      input.settings.scopeRoots,
      input.settings.scopePriority,
      explicitScopes ? input.scopes : undefined,
    )
    const scopeSelection = this.buildScopeSelection(input, explicitScopes, selEntries)
    const scopedRootMap = this.buildScopeRootMap(selEntries)
    const fullDecision = FULL_DECISION_ACTIONS[input.action] && Boolean(input.query)
    const effectiveNames =
      fullDecision || (EXEMPT_ACTIONS[input.action] && input.action !== 'compose') ? [] : input.names.length > 0 ? input.names : preset
    const requestedSet = new Set(effectiveNames)
    const shouldFilterByRequestedNames = requestedSet.size > 0 && !EXEMPT_ACTIONS[input.action] && !fullDecision
    return {
      preset,
      explicitScopes,
      classEntries,
      selEntries,
      scopeSelection,
      scopedRootMap,
      effectiveNames,
      shouldFilterByRequestedNames,
      requestedSet,
    }
  }

  private prepareLoadContext(input: ToolContext): LoadIndexPrep {
    const prefix = this.prepareLoadContextPrefix(input)
    const prep: LoadIndexPrep = {
      databasePath: input.settings.databasePath,
      explicitScopes: prefix.explicitScopes,
      classificationScopeEntries: prefix.classEntries,
      selectedScopeEntries: prefix.selEntries,
      scopeSelection: prefix.scopeSelection,
      scopedRootMap: prefix.scopedRootMap,
      scopedRoots: this.flattenScopeRoots(prefix.scopedRootMap),
      scopePriority: this.dedupeValues(input.settings.scopePriority),
      effectiveNames: prefix.effectiveNames,
      shouldFilterByRequestedNames: prefix.shouldFilterByRequestedNames,
      scanRequestedSet: prefix.shouldFilterByRequestedNames ? prefix.requestedSet : new Set<string>(),
      requestedSet: prefix.requestedSet,
      stats: this.buildStats(prefix.requestedSet, prefix.shouldFilterByRequestedNames),
      requestKey: '',
      now: Date.now(),
      input,
    }
    prep.requestKey = this.buildRequestKey(input, { ...prep, preset: prefix.preset })
    return prep
  }

  private async initDatabase(databasePath: string): Promise<void> {
    if (this.activeIndexStore.cachedDatabasePath && this.activeIndexStore.cachedDatabasePath !== databasePath) {
      this.searchDatabase.close()
      this.activeIndexStore.clear()
    }
    await this.searchDatabase.initialize(databasePath)
    this.activeIndexStore.setDatabasePath(databasePath)
  }

  private tryGetProcessCache(refresh: boolean | undefined, key: string, sig: string, now: number): IndexArtifacts | null {
    if (refresh || !this.activeIndexStore.cachedIndex || this.activeIndexStore.cachedIndex.requestKey !== key) {
      return null
    }
    const isUnexpired = now - this.activeIndexStore.cachedIndex.generatedAt < this.activeIndexStore.cachedIndex.ttlMs
    const isSourceCurrent = this.activeIndexStore.cachedIndex.sourceSignature === sig
    if (isUnexpired && isSourceCurrent && this.searchDatabase.isSnapshotCurrent(this.activeIndexStore.activeSnapshotToken)) {
      return this.activeIndexStore.cachedIndex
    }
    this.activeIndexStore.clear()
    return null
  }

  private tryGetPersistedSnapshot(refresh: boolean | undefined, key: string, sig: string, now: number): IndexArtifacts | null {
    if (refresh) {
      return null
    }
    const persistedSnapshot = this.searchDatabase.readSnapshot(key, now)
    if (persistedSnapshot?.sourceSignature === sig) {
      return this.activateSnapshot(persistedSnapshot)
    }
    return null
  }

  private handleSafeZero(ctx: LoadIndexPrep, sig: string, buildStartedAt: number): IndexArtifacts {
    const emptySnapshot = this.searchDatabase.replaceSnapshot(
      {
        generatedAt: ctx.now,
        ttlMs: ctx.input.settings.cacheTtlMs,
        requestKey: ctx.requestKey,
        sourceSignature: sig,
        settings: ctx.input.settings,
        requestedNames: ctx.effectiveNames,
        skills: [],
        stats: ctx.stats,
        buildStartedAt,
      },
      [],
    )
    return this.activateSnapshot(emptySnapshot)
  }

  private rebuildIndex(ctx: LoadIndexPrep, sourceScans: SkillSourceScanResult[], sig: string, buildStartedAt: number): IndexArtifacts {
    const scopePriorityRank = this.buildScopeRank(ctx.input.settings.scopePriority)
    const { bestByCanonical, indexBuildMode } = this.parseSkills(sourceScans, ctx, scopePriorityRank)
    ctx.stats.nameFilterMode = indexBuildMode
    const skills = Array.from(bestByCanonical.values())
    ctx.stats.scopeDistribution = this.buildScopeDistribution(skills)
    this.buildAliasToCanonical(skills, ctx.stats, scopePriorityRank)
    const snapshot = this.searchDatabase.replaceSnapshot(
      {
        generatedAt: ctx.now,
        ttlMs: ctx.input.settings.cacheTtlMs,
        requestKey: ctx.requestKey,
        sourceSignature: sig,
        settings: ctx.input.settings,
        requestedNames: ctx.effectiveNames,
        skills,
        stats: ctx.stats,
        buildStartedAt,
      },
      skills.map((skill) => this.buildSearchDocument(skill)),
    )
    return this.activateSnapshot(snapshot)
  }

  private parseSkills(
    sourceScans: SkillSourceScanResult[],
    ctx: LoadIndexPrep,
    scopePriorityRank: Map<string, number>,
  ): { bestByCanonical: Map<string, RawSkill>; indexBuildMode: 'targeted' | 'full' } {
    const bestByCanonical = new Map<string, RawSkill>()
    let indexBuildMode: 'targeted' | 'full' = ctx.shouldFilterByRequestedNames ? 'targeted' : 'full'
    for (const scanResult of sourceScans) {
      if (scanResult.missingRoot) {
        ctx.stats.skippedMissingRoot += 1
        continue
      }
      if (scanResult.mode === 'full') {
        indexBuildMode = 'full'
      }
      ctx.stats.totalFilesVisited += scanResult.files.length
      for (const file of scanResult.files) {
        this.processSkillFile(file, scanResult.root, ctx, bestByCanonical, scopePriorityRank)
      }
    }
    return { bestByCanonical, indexBuildMode }
  }

  private processSkillFile(
    skillFile: string,
    root: string,
    ctx: LoadIndexPrep,
    bestByCanonical: Map<string, RawSkill>,
    scopePriorityRank: Map<string, number>,
  ): void {
    const parseIssues: string[] = []
    const candidate = this.documentParser.parseSkillFile(skillFile, root, parseIssues)
    if (!candidate) {
      ctx.stats.parseErrors += 1
      ctx.stats.malformedFiles.push({ path: skillFile, reason: parseIssues[0] ?? 'skill file could not be parsed' })
      return
    }
    ctx.stats.totalParsed += 1
    candidate.scope = this.resolveSkillScope(skillFile, ctx.classificationScopeEntries)
    if (ctx.explicitScopes && !ctx.scopeSelection.scopeSet.has(candidate.scope)) {
      return
    }
    const matched =
      ctx.requestedSet.size > 0 ? [candidate.canonicalName, ...candidate.aliases].filter((name) => ctx.requestedSet.has(name)) : []
    if (ctx.shouldFilterByRequestedNames && matched.length === 0) {
      return
    }
    this.resolveCanonicalCollision(candidate, bestByCanonical, scopePriorityRank, ctx.stats, matched)
  }

  private resolveCanonicalCollision(
    candidate: RawSkill,
    bestByCanonical: Map<string, RawSkill>,
    scopePriorityRank: Map<string, number>,
    stats: ScopedIndexedStats,
    matched: string[],
  ): void {
    const existing = bestByCanonical.get(candidate.canonicalName)
    if (existing) {
      stats.deduplicated += 1
      const keepExisting = this.isPreferredCanonicalCollision(existing, candidate, scopePriorityRank) <= 0
      stats.duplicateCanonicalEntries.push({
        canonicalName: candidate.canonicalName,
        keptPath: keepExisting ? existing.path : candidate.path,
        droppedPath: keepExisting ? candidate.path : existing.path,
      })
      if (keepExisting) {
        return
      }
    }
    bestByCanonical.set(candidate.canonicalName, candidate)
    stats.missingFromRequested = stats.missingFromRequested.filter((name) => !matched.includes(name))
  }

  private resolveAliasCollision(alias: string, skill: RawSkill, ctx: AliasResolutionContext): void {
    const existingCanonical = ctx.aliasToCanonical.get(alias)
    if (!existingCanonical) {
      ctx.aliasToCanonical.set(alias, skill.canonicalName)
      return
    }
    if (existingCanonical !== skill.canonicalName) {
      const existingSkill = ctx.canonicalToSkill.get(existingCanonical)
      const preferredCanonical =
        existingSkill && this.isPreferredCanonicalCollision(existingSkill, skill, ctx.scopePriorityRank) > 0
          ? skill.canonicalName
          : existingCanonical
      if (preferredCanonical !== existingCanonical) {
        ctx.aliasToCanonical.set(alias, preferredCanonical)
      }
      ctx.stats?.duplicateAliasEntries.push({
        alias,
        canonicalName: preferredCanonical,
        conflictingCanonicalName: preferredCanonical === existingCanonical ? skill.canonicalName : existingCanonical,
      })
    }
  }
}
