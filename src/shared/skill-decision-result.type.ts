import type { SkillRelationMode } from './registry-context.type'

/** decide 결과 엔트리입니다. */
export type SkillDecideEntry = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * decide 후보 스코프입니다.
   * winner 계산 시 충돌 시 가중치 보정에 활용될 수 있습니다.
   */
  scope?: string
  aliases: string[]
  score: number
  queryScore?: number
  queryCoverage?: number
  explicitName: boolean
  peerRequiredBy: string[]
  peerRecommendedBy: string[]
  requiredPeers: string[]
  unresolvedRequires: string[]
  reasons: string[]
  preview: string
}

/** decide 결과 payload입니다. */
export type SkillDecideResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  winner: string | null
  ordered: SkillDecideEntry[]
}

/** plan step reason입니다. */
export type SkillPlanStepReason = 'winner' | 'unblocks-required-peer' | 'unblocks-recommended-peer' | 'alternative'

/** plan step entry입니다. */
export type SkillPlanStep = {
  order: number
  phase: 'first' | 'next' | 'later'
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * plan 단계에서 실제 탐색한 스코프입니다.
   * 비어 있으면 요청 컨텍스트에서의 암묵적 기본 스코프로 처리합니다.
   */
  scope?: string
  reason: SkillPlanStepReason
  via?: string
  score?: number
  queryScore?: number
  preview: string
}

/** plan 결과 payload입니다. */
export type SkillPlanResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  steps: SkillPlanStep[]
  deferred: string[]
}

/** route phase 종류입니다. */
export type SkillRoutePhaseKind = 'start' | 'read-layer' | 'apply-layer' | 'fallback'

/** route phase entry입니다. */
export type SkillRoutePhase = {
  order: number
  kind: SkillRoutePhaseKind
  layer: number | null
  names: string[]
  readPaths: string[]
  rationale: string[]
}

/** route 결과 payload입니다. */
export type SkillRouteResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  phases: SkillRoutePhase[]
  deferred: string[]
}

/** compare skill pair의 directional relation입니다. */
export type SkillCompareRelation = 'requires' | 'recommends'

/** compare 후보 엔트리입니다. */
export type SkillCompareEntry = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * compare 항목의 스코프 라벨입니다.
   * 서로 다른 스코프 간 카테고리/별칭 비교를 위해 보관합니다.
   */
  scope?: string
  aliases: string[]
  score?: number
  coverage?: number
  matchedTerms: string[]
  requires: string[]
  recommends: string[]
  preview: string
}

/** compare pairwise 결과입니다. */
export type SkillComparePair = {
  left: string
  right: string
  sameCategory: boolean
  sharedAliases: string[]
  sharedMatchedTerms: string[]
  leftOnlyMatchedTerms: string[]
  rightOnlyMatchedTerms: string[]
  sharedRequires: string[]
  sharedRecommends: string[]
  leftToRight?: SkillCompareRelation
  rightToLeft?: SkillCompareRelation
  scoreDelta?: number
}

/** compare 결과 payload입니다. */
export type SkillCompareResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  entries: SkillCompareEntry[]
  pairs: SkillComparePair[]
}

/** recommend relation signal입니다. */
export type SkillRecommendRelationSignal = {
  via: string
  relation: 'required' | 'recommended'
}

/** recommend 결과 엔트리입니다. */
export type SkillRecommendEntry = {
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * recommend 후보 스코프입니다.
   * 추천 후보의 출처 추적에 사용됩니다.
   */
  scope?: string
  aliases: string[]
  score: number
  queryScore?: number
  queryCoverage?: number
  matchedTerms: string[]
  outboundSignals: SkillRecommendRelationSignal[]
  inboundSignals: SkillRecommendRelationSignal[]
  sharedCategorySeeds: string[]
  preview: string
}

/** recommend 결과 payload입니다. */
export type SkillRecommendResult = {
  query?: string
  relationMode: SkillRelationMode
  seeds: string[]
  recommendations: SkillRecommendEntry[]
}
