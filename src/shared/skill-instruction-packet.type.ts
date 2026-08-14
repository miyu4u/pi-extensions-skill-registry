import type { SkillRelationMode } from './registry-context.type'
import type { SkillTurnPacketTurn } from './skill-read-packet.type'

/** instruction-packet 결과 payload입니다. */
export type SkillInstructionPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * current-turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * current-turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  instructionText: string
  checklistText: string
  commandBlock: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** markdown-packet 결과 payload입니다. */
export type SkillMarkdownPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * current-turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * current-turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  markdown: string
  commandBlock: string
  checklistItems: string[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** checklist-packet 결과 payload입니다. */
export type SkillChecklistPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * current-turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * current-turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  checklistItems: string[]
  checklistText: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** commands-packet 결과 payload입니다. */
export type SkillCommandsPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * current-turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * current-turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  commandBlock: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** summary-packet 결과 payload입니다. */
export type SkillSummaryPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  sourcePaths: string[]
  nextCommands: string[]
  /**
   * current-turn sourcePaths의 스코프 정렬입니다.
   */
  sourcePathScopes?: Array<string | undefined>
  /**
   * current-turn sourcePaths의 category 정렬입니다.
   */
  sourcePathCategories?: string[]
  summaryText: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}
