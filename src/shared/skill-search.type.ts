import type { RawSkill } from './skill-document.type'

/** 검색 token 파생 출처입니다. */
export type SearchTokenSource = 'base' | 'ko-morph' | 'en-fuzzy'

/** 검색용 base/derived token 엔트리입니다. */
export type SearchToken = {
  token: string
  source: SearchTokenSource
  scoreMultiplier: number
}

/** base token과 파생 token을 함께 담는 토큰화 결과입니다. */
export type SearchTokenizationResult = {
  baseTokens: string[]
  derivedTokens: SearchToken[]
}

/** query 원문 token별 variant 묶음입니다. */
export type LanguageAwareQueryVariant = {
  sourceToken: string
  variants: SearchToken[]
}

/** BM25 검색 hit입니다. */
export type SearchHit = {
  skill: RawSkill
  score: number
  coverage: number
  matchedTerms: string[]
}

/** 검색 query fallback 및 miss 판단을 위한 compact diagnostics입니다. */
export type SkillSearchDiagnostics = {
  normalizedQuery: string
  matchedAliases: string[]
  fallbackMode: 'none' | 'query-rewrite' | 'safe-zero'
  whyThisTop1?: string
  whyZero?: string
}

/** 검색 hit와 diagnostics를 함께 반환하는 결과입니다. */
export type SkillSearchResult = {
  hits: SearchHit[]
  diagnostics: SkillSearchDiagnostics
}
