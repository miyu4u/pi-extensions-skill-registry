import type { SkillGraphMode, SkillRelationMode } from './registry-context.type'
import type { DuplicateAliasEntry, DuplicateCanonicalEntry, SkillValidationReport } from './skill-diagnostics.type'
import type { RawSkill } from './skill-document.type'

/** compose에 포함된 skill 엔트리입니다. */
export type ComposedSkillEntry = {
  skill: RawSkill
  reason: 'seed' | 'required' | 'recommended'
  via?: string
  depth: number
}

/** compose에서 해소되지 않은 relation 엔트리입니다. */
export type MissingSkillRelation = {
  name: string
  relation: 'required' | 'recommended'
  via: string
  depth: number
}

/** compose 실행 결과입니다. */
export type SkillComposePlan = {
  seeds: RawSkill[]
  entries: ComposedSkillEntry[]
  missing: MissingSkillRelation[]
  relationMode: SkillRelationMode
}

/** relation edge 종류입니다. */
export type SkillRelationEdgeKind = 'requires' | 'recommends'

/** canonicalized relation edge입니다. */
export type SkillRelationGraphEdge = {
  from: string
  to?: string
  target: string
  relation: SkillRelationEdgeKind
  resolved: boolean
}

/** graph node payload입니다. */
export type SkillRelationGraphNode = {
  name: string
  path: string
  category: string
  /**
   * graph에서 사용되는 스코프 태그입니다.
   * 동일 경로 후보가 여러 스코프에 걸칠 때 우선순위 표시용 메타데이터입니다.
   */
  scope?: string
  title: string
  aliases: string[]
}

/** graph 조회 결과 payload입니다. */
export type SkillRelationGraph = {
  mode: SkillGraphMode
  seeds: string[]
  nodes: SkillRelationGraphNode[]
  edges: SkillRelationGraphEdge[]
  readLayers: string[][]
  applyLayers: string[][]
  missing: MissingSkillRelation[]
  cycles: string[][]
  orphans: string[]
  diagnostics: {
    duplicateCanonicalEntries: DuplicateCanonicalEntry[]
    duplicateAliasEntries: DuplicateAliasEntry[]
  }
}

/** pack 결과 엔트리입니다. */
export type SkillPackEntry = {
  name: string
  path: string
  title: string
  category: string
  /**
   * pack 결과에서 전달되는 스코프 태그입니다.
   * 동일 canonical에 대한 스코프 충돌 해소 힌트로 사용합니다.
   */
  scope?: string
  aliases: string[]
  requires: string[]
  recommends: string[]
  reason: 'seed' | 'required' | 'recommended'
  via?: string
  depth: number
  readLayer: number | null
  applyLayer: number | null
  preview: string
  body?: string
  readPath: string
  omittedByBudget: boolean
}

/** pack 결과 payload입니다. */
export type SkillPack = {
  ok: boolean
  relationMode: SkillRelationMode
  seeds: string[]
  entries: SkillPackEntry[]
  readLayers: string[][]
  applyLayers: string[][]
  missing: MissingSkillRelation[]
  cycles: string[][]
  orphans: string[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  compose: SkillComposePlan
  graph: SkillRelationGraph
  validate: SkillValidationReport
  diagnostics: {
    duplicateCanonicalEntries: DuplicateCanonicalEntry[]
    duplicateAliasEntries: DuplicateAliasEntry[]
  }
}
