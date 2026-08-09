import type { PromptGuidanceSettings, SettingsLoaderInterface } from '../settings'
import type { BeforeAgentStartEventLike, SystemPromptOverrideResult } from '../shared'
import { SKILL_BLOCK_END_MARKER, SKILL_BLOCK_START_MARKER, SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK } from '../shared'
import type { PromptGuidanceInterface } from './prompt-guidance.interface'

/** before_agent_start prompt slim 처리 구현체입니다. */
export class PromptGuidanceService implements PromptGuidanceInterface {
  constructor(private readonly settingsLoader: Pick<SettingsLoaderInterface, 'loadPromptSettings'>) {}

  /**
   * before_agent_start 시점의 skills block을 slim guidance로 치환합니다.
   */
  handleBeforeAgentStart(event: BeforeAgentStartEventLike): SystemPromptOverrideResult | undefined {
    const settings = this.settingsLoader.loadPromptSettings()
    if (!settings.skillsPromptEnabled) {
      return undefined
    }

    const { systemPrompt } = event
    if (!systemPrompt) {
      return undefined
    }

    const guidanceBlock = this.buildGuidanceBlock(settings)
    const transformedPrompt =
      typeof systemPrompt === 'string'
        ? this.rewriteStringSystemPrompt(systemPrompt, guidanceBlock)
        : this.rewritePromptBlocks(systemPrompt, guidanceBlock)

    if (!transformedPrompt) {
      return undefined
    }

    event.systemPrompt = transformedPrompt

    return {
      systemPrompt: transformedPrompt,
    }
  }

  /**
   * before_agent_start 결과가 provider payload에 반영되지 않는 runtime에서도
   * provider 직전 instructions/messages를 동일한 규칙으로 보정합니다.
   */
  handleBeforeProviderRequest(payload: unknown): unknown | undefined {
    const settings = this.settingsLoader.loadPromptSettings()
    if (!settings.skillsPromptEnabled) {
      return undefined
    }

    if (!this.isRecord(payload)) {
      return undefined
    }

    const guidanceBlock = this.buildGuidanceBlock(settings)
    let replaced = false
    const next: Record<string, unknown> = { ...payload }

    if ('instructions' in next) {
      const rewrittenInstructions = this.rewriteProviderValue(next.instructions, guidanceBlock)
      if (rewrittenInstructions.changed) {
        next.instructions = rewrittenInstructions.value
        replaced = true
      }
    }

    if (!replaced && Array.isArray(next.messages)) {
      const rewrittenMessages = this.rewriteProviderMessages(next.messages, guidanceBlock)
      if (rewrittenMessages.changed) {
        next.messages = rewrittenMessages.value
        replaced = true
      }
    }

    return replaced ? next : undefined
  }

  /**
   * normalized settings를 marker를 포함한 replacement block으로 조립합니다.
   */
  private buildGuidanceBlock(settings: PromptGuidanceSettings): string {
    const builtInBody = this.extractPromptBody(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    const configuredBody = settings.skillsPrompt ? this.extractPromptBody(settings.skillsPrompt) : ''
    const body = configuredBody || builtInBody
    const namesLine =
      settings.promptSkillNames.length > 0 ? `- Configured prompt skills: ${settings.promptSkillNames.join(', ')}` : undefined
    const lines = [SKILL_BLOCK_START_MARKER, body]

    if (namesLine) {
      lines.push(namesLine)
    }

    lines.push(SKILL_BLOCK_END_MARKER)
    return lines.join('\n')
  }

  /**
   * custom prompt의 완성된 outer marker를 한 겹만 제거해 body contract를 호환합니다.
   */
  private extractPromptBody(prompt: string): string {
    const trimmed = prompt.trim()
    if (!trimmed.startsWith(SKILL_BLOCK_START_MARKER) || !trimmed.endsWith(SKILL_BLOCK_END_MARKER)) {
      return trimmed
    }

    return trimmed.slice(SKILL_BLOCK_START_MARKER.length, -SKILL_BLOCK_END_MARKER.length).trim()
  }

  /**
   * string 형태 system prompt에서 첫 skills block만 치환합니다.
   */
  private rewriteStringSystemPrompt(systemPrompt: string, guidanceBlock: string): string | undefined {
    const startIndex = systemPrompt.indexOf(SKILL_BLOCK_START_MARKER)

    if (startIndex < 0) {
      return undefined
    }

    const endIndex = systemPrompt.indexOf(SKILL_BLOCK_END_MARKER, startIndex + SKILL_BLOCK_START_MARKER.length)

    if (endIndex < 0) {
      return undefined
    }

    return [systemPrompt.slice(0, startIndex), guidanceBlock, systemPrompt.slice(endIndex + SKILL_BLOCK_END_MARKER.length)].join('')
  }

  /**
   * provider payload 내부의 문자열, text-part, 배열을 재귀적으로 순회합니다.
   */
  private rewriteProviderValue(value: unknown, guidanceBlock: string): { value: unknown; changed: boolean } {
    if (typeof value === 'string') {
      const rewritten = this.rewriteStringSystemPrompt(value, guidanceBlock)
      return rewritten === undefined ? { value, changed: false } : { value: rewritten, changed: true }
    }

    if (!Array.isArray(value)) {
      if (this.isRecord(value) && typeof value.text === 'string') {
        const rewrittenText = this.rewriteStringSystemPrompt(value.text, guidanceBlock)
        return rewrittenText === undefined ? { value, changed: false } : { value: { ...value, text: rewrittenText }, changed: true }
      }
      return { value, changed: false }
    }

    const next = [...value]
    for (let index = 0; index < next.length; index += 1) {
      const part = next[index]
      const rewritten = this.rewriteProviderValue(part, guidanceBlock)
      if (!rewritten.changed) {
        continue
      }
      next[index] = rewritten.value
      return { value: next, changed: true }
    }

    return { value, changed: false }
  }

  /**
   * system/developer message만 대상으로 첫 eligible content를 치환합니다.
   */
  private rewriteProviderMessages(messages: readonly unknown[], guidanceBlock: string): { value: unknown[]; changed: boolean } {
    const next = [...messages]

    for (let index = 0; index < next.length; index += 1) {
      const message = next[index]
      if (!this.isRecord(message) || (message.role !== 'system' && message.role !== 'developer')) {
        continue
      }

      const rewrittenContent = this.rewriteProviderValue(message.content, guidanceBlock)
      if (!rewrittenContent.changed) {
        continue
      }

      next[index] = { ...message, content: rewrittenContent.value }
      return { value: next, changed: true }
    }

    return { value: next, changed: false }
  }

  /**
   * provider payload의 object shape를 안전하게 판별합니다.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /**
   * block 배열 형태 system prompt에서 첫 skills block만 치환합니다.
   */
  private rewritePromptBlocks(systemPrompt: readonly string[], guidanceBlock: string): string | undefined {
    // A runtime segment is not necessarily one semantic prompt block. In
    // particular, a single segment can contain the complete system prompt and
    // its <skills> section. Replacing that array element would discard every
    // sibling section and leave only the skill guidance.
    return this.rewriteStringSystemPrompt(systemPrompt.join('\n\n'), guidanceBlock)
  }
}
