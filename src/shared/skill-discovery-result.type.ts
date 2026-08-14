import type { SkillRelationMode } from './registry-context.type'
import type { DuplicateAliasEntry, DuplicateCanonicalEntry } from './skill-diagnostics.type'
import type { MissingSkillRelation } from './skill-relation.type'

/** resolve 결과 엔트리입니다. */
export type SkillResolveEntry = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * resolve 결과 스코프 태그입니다.
   * 스코프가 없으면 legacy 호환 모드로 간주합니다.
   */
  scope?: string
  aliases: string[]
  requires: string[]
  recommends: string[]
  preview: string
  body?: string
  omittedByBudget: boolean
}

/** exact resolve 실패 시 검토할 수 있는 bounded 후보입니다. */
export type SkillResolveSuggestion = {
  name: string
  readPath: string
  confidence: number
}

/** resolve 결과 payload입니다. */
export type SkillResolveResult = {
  resolved: SkillResolveEntry[]
  missing: string[]
  suggestions: SkillResolveSuggestion[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
}

/** gap 후보 skill 요약입니다. */
export type SkillGapCandidate = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * gap 후보의 스코프입니다.
   * 후보 스코프를 추적해 동일 스킬 이름의 충돌을 완화합니다.
   */
  scope?: string
  aliases: string[]
  score: number
  coverage: number
  matchedTerms: string[]
  preview: string
}

/** gap scaffold 제안입니다. */
export type SkillGapScaffold = {
  name: string
  category: string
  keywords: string[]
  description: string
  body: string
}

/** gap 결과 payload입니다. */
export type SkillGapResult = {
  ok: boolean
  query: string
  coverageThreshold: number
  coveredTerms: string[]
  uncoveredTerms: string[]
  candidates: SkillGapCandidate[]
  recommendedAction: 'use-existing' | 'add-alias' | 'create-skill'
  scaffold?: SkillGapScaffold
}

/** explain 결과 엔트리입니다. */
export type SkillExplainEntry = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * explain 결과에서 선택된 스코프 태그입니다.
   * 레이어/경로 기반 후보 선별의 부수 메타데이터입니다.
   */
  scope?: string
  aliases: string[]
  reason: 'seed' | 'required' | 'recommended'
  via?: string
  depth: number
  readLayer: number | null
  applyLayer: number | null
  score?: number
  coverage?: number
  matchedTerms: string[]
  matchPreview: string
}

/** explain 결과 payload입니다. */
export type SkillExplainResult = {
  query?: string
  relationMode: SkillRelationMode
  seeds: string[]
  entries: SkillExplainEntry[]
  missing: MissingSkillRelation[]
  cycles: string[][]
  diagnostics: {
    duplicateCanonicalEntries: DuplicateCanonicalEntry[]
    duplicateAliasEntries: DuplicateAliasEntry[]
  }
}
