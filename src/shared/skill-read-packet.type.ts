import type { SkillRelationMode } from './registry-context.type'
import type { SkillRoutePhase, SkillRoutePhaseKind } from './skill-decision-result.type'

/** brief packet entry입니다. */
export type SkillBriefEntry = {
  phaseOrder: number
  phaseKind: SkillRoutePhaseKind
  layer: number | null
  name: string
  readPath: string
  path: string
  title: string
  category: string
  /**
   * brief 출력에서 포함된 스코프입니다.
   * 동일 name 충돌 시 스코프 기준 병합/필터에 사용됩니다.
   */
  scope?: string
  preview: string
  body?: string
  omittedByBudget: boolean
}

/** brief 결과 payload입니다. */
export type SkillBriefResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  phases: SkillRoutePhase[]
  entries: SkillBriefEntry[]
  deferred: string[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
}

/** bundle 결과 payload입니다. */
export type SkillBundleResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  phases: SkillRoutePhase[]
  entries: Array<Omit<SkillBriefEntry, 'body'>>
  entriesWithBody?: SkillBriefEntry[]
  deferred: string[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
}

/** handoff 결과 payload입니다. */
export type SkillHandoffResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  sourcePath: string | null
  /**
   * handoff source의 카테고리 메타데이터입니다.
   * winner 후보를 경로 추적할 때 중복 후보 해소에 사용합니다.
   */
  sourceCategory?: string
  /**
   * handoff source의 스코프 메타데이터입니다.
   * 동일 이름 충돌/권한 분리 정책을 재현하기 위한 provenance입니다.
   */
  sourceScope?: string
  nextCommand: string | null
  applyHint?: string
  phases: SkillRoutePhase[]
  entries: Array<Omit<SkillBriefEntry, 'body'>>
  entriesWithBody?: SkillBriefEntry[]
  deferred: string[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
}

/** session-packet step entry입니다. */
export type SkillSessionPacketStep = {
  order: number
  name: string
  sourcePath: string
  /**
   * step 기반 source의 스코프 메타데이터입니다.
   * 같은 경로 후보가 다중 소스에서 유입되더라도 재구성 가능하게 합니다.
   */
  sourceScope?: string
  /**
   * step 기반 category 메타데이터입니다.
   */
  sourceCategory?: string
  nextCommand: string
  phaseKind: SkillRoutePhaseKind
  layer: number | null
  omittedByBudget: boolean
}

/** session-packet 결과 payload입니다. */
export type SkillSessionPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  sourcePaths: string[]
  /**
   * sourcePaths 항목 단위 스코프 정렬입니다.
   * sourcePaths와 동일 순서로 정렬되어야 합니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * sourcePaths 항목 단위 category 정렬입니다.
   * sourcePaths와 동일 순서로 정렬되어야 합니다.
   */
  sourcePathCategories?: string[]
  nextCommands: string[]
  applyHint?: string
  recoveryGuidance: string[]
  steps: SkillSessionPacketStep[]
}

/** turn-packet turn entry입니다. */
export type SkillTurnPacketTurn = {
  order: number
  phaseKind: SkillRoutePhaseKind
  layer: number | null
  names: string[]
  readPaths: string[]
  sourcePaths: string[]
  /**
   * turn sourcePaths의 스코프 정렬입니다.
   * phase 단위로 정렬되어 sourcePaths와 정합이 필요합니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * turn sourcePaths의 category 정렬입니다.
   * phase 단위로 정렬되어 sourcePaths와 정합이 필요합니다.
   */
  sourcePathCategories?: string[]
  nextCommands: string[]
  objective: string
  checklist: string[]
  exitCriteria: string[]
  blockedByBudget: boolean
}

/** turn-packet 결과 payload입니다. */
export type SkillTurnPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  sourcePaths: string[]
  /**
   * 모든 turn.sourcePaths를 phase 순으로 펼친 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * 모든 turn.sourcePaths를 phase 순으로 펼친 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  nextCommands: string[]
  applyHint?: string
  recoveryGuidance: string[]
  deferred: string[]
  omittedReadPaths: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turns: SkillTurnPacketTurn[]
}

/** recovery-packet blocked turn entry입니다. */
export type SkillRecoveryPacketTurn = {
  order: number
  phaseKind: SkillRoutePhaseKind
  layer: number | null
  names: string[]
  omittedReadPaths: string[]
  sourcePaths: string[]
  recoveryCommands: string[]
  /**
   * recovery turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * recovery turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  objective: string
  unblockCriteria: string[]
}

/** recovery-packet 결과 payload입니다. */
export type SkillRecoveryPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  omittedReadPaths: string[]
  sourcePaths: string[]
  /**
   * blocked turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * blocked turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  recoveryCommands: string[]
  deferred: string[]
  resumeTurnOrder: number | null
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  blockedTurns: SkillRecoveryPacketTurn[]
}

/** resume-packet 결과 payload입니다. */
export type SkillResumePacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  omittedReadPaths: string[]
  recoveryCommands: string[]
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * resume 대상 turns의 sourcePaths 정렬 스코프입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * resume 대상 turns의 sourcePaths 정렬 category입니다.
   */
  sourcePathCategories?: string[]
  deferred: string[]
  resumeTurnOrder: number | null
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turns: SkillTurnPacketTurn[]
  blockedTurns: SkillRecoveryPacketTurn[]
}

/** current-turn-packet 결과 payload입니다. */
export type SkillCurrentTurnPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  omittedReadPaths: string[]
  recoveryCommands: string[]
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * 현재 turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * 현재 turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  deferred: string[]
  activeTurnOrder: number | null
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
  blockedTurns: SkillRecoveryPacketTurn[]
}
