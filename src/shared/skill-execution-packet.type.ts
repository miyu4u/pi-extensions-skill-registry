import type { SkillRelationMode } from './registry-context.type'
import type { SkillTurnPacketTurn } from './skill-read-packet.type'

/** file-ready-packet 파일 엔트리입니다. */
export type SkillFileReadyPacketFile = {
  kind: 'markdown' | 'checklist' | 'commands'
  suggestedPath: string
  mediaType: 'text/markdown' | 'text/plain'
  content: string
}

/** file-ready-packet 결과 payload입니다. */
export type SkillFileReadyPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  baseName: string
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
  files: SkillFileReadyPacketFile[]
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** apply-packet write 엔트리입니다. */
export type SkillApplyPacketWrite = {
  kind: 'write'
  sourceKind: SkillFileReadyPacketFile['kind']
  path: string
  mediaType: SkillFileReadyPacketFile['mediaType']
  content: string
}

/** apply-packet 결과 payload입니다. */
export type SkillApplyPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  baseName: string
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
  writes: SkillApplyPacketWrite[]
  applyText: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** write-script-packet 결과 payload입니다. */
export type SkillWriteScriptPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  baseName: string
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
  writes: SkillApplyPacketWrite[]
  scriptPath: string
  scriptContent: string
  commandBlock: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** execution-packet 실행 파일 엔트리입니다. */
export type SkillExecutionPacketFile = {
  kind: 'script'
  path: string
  mediaType: 'text/typescript'
  content: string
}

/** execution-packet 결과 payload입니다. */
export type SkillExecutionPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  baseName: string
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
  files: SkillExecutionPacketFile[]
  runCommands: string[]
  executionText: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}

/** verification-packet 결과 payload입니다. */
export type SkillVerificationPacketResult = {
  query?: string
  basis: 'query' | 'names' | 'query+names'
  relationMode: SkillRelationMode
  winner: string | null
  ready: boolean
  applyHint?: string
  recoveryGuidance: string[]
  activeTurnOrder: number | null
  baseName: string
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
  files: SkillExecutionPacketFile[]
  runCommands: string[]
  verificationCommands: string[]
  verificationItems: string[]
  verificationText: string
  budget: {
    requestedChars: number
    requestedTokens: number
    effectiveChars: number
    usedChars: number
  }
  turn: SkillTurnPacketTurn | null
}
