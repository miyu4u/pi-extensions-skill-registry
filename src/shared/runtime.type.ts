import type { AgentToolResult } from '@earendil-works/pi-coding-agent'

/** tool result payload 타입입니다. */
export type SkillRegistryToolResult = AgentToolResult<Record<string, unknown>>

/** before_agent_start event 후보입니다. */
export interface BeforeAgentStartEventLike {
  /** OMP runtime이 전달하는 system prompt 본문 또는 block 배열입니다. */
  systemPrompt?: string | readonly string[]
}

/** 변환된 system prompt 반환 payload입니다. */
export interface SystemPromptOverrideResult {
  /** provider 요청에 사용할 slim 처리된 system prompt입니다. */
  readonly systemPrompt: string
}
