import { describe, expect, test } from '@jest/globals'
import { SERVICE } from '../service-registry'
import type { PromptGuidanceSettings } from '../settings'
import { SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK } from '../shared'
import { PromptGuidanceService } from './prompt-guidance.service'

/** prompt guidance service 동작 검증입니다. */
describe('prompt guidance service', () => {
  type MessageLike = {
    role: string
    content?: unknown
  }

  type TextPart = {
    type: 'text'
    text: string
  }

  type ProviderPayload = {
    systemPrompt?: string | readonly string[]
    instructions?: unknown
    messages?: MessageLike[]
    extraState?: unknown
    [key: string]: unknown
  }

  /**
   * settings 주입만 바꿔 prompt renderer의 독립 동작을 검증합니다.
   */
  function createPromptService(settings: Partial<PromptGuidanceSettings> = {}): PromptGuidanceService {
    const normalizedSettings: PromptGuidanceSettings = {
      skillsPromptEnabled: true,
      promptSkillNames: [],
      ...settings,
    }
    return new PromptGuidanceService({
      loadPromptSettings: () => normalizedSettings,
    })
  }

  /** guidance가 unknown URI 직접 읽기와 full catalog 확장을 금지하는지 검증합니다. */
  test('forbids direct unknown skill:// URI reads and full-catalog recovery in prompt guidance', () => {
    expect(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK).toContain(
      'Do not guess or directly read an unknown `skill://<name>` URI; use `discover` or `search`, then `resolve`, then read the returned canonical URI.',
    )
    expect(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK).toContain(
      'Unknown URI recovery is bounded: low-confidence or missing suggestions are safe-zero and must not expand to the full skill catalog.',
    )
    expect(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK).toContain('Skill catalog omitted from the system prompt')
    expect(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK).not.toContain('Available:')

    const event: ProviderPayload = {
      systemPrompt: ['Intro', '<skills>', '- legacy catalog entry', '</skills>', 'Tail'].join('\n'),
    }
    const result = SERVICE.promptGuidance.handleBeforeAgentStart(event)
    expect(result?.systemPrompt).toContain(
      'Do not guess or directly read an unknown `skill://<name>` URI; use `discover` or `search`, then `resolve`, then read the returned canonical URI.',
    )
    expect(result?.systemPrompt).toContain('must not expand to the full skill catalog')
    expect(result?.systemPrompt).not.toContain('- legacy catalog entry')
  })

  /** systemPrompt 문자열에서 첫 skills block을 guid block으로 치환하는지 검증합니다. */
  test('replaces only the first skills block in a string systemPrompt', () => {
    const event: ProviderPayload = {
      systemPrompt: [
        'Intro',
        '<skills>',
        '- legacy catalog entry',
        '</skills>',
        'Body',
        '<skills>',
        '- should not rewrite',
        '</skills>',
        'Tail',
      ].join('\n'),
    }

    const result = SERVICE.promptGuidance.handleBeforeAgentStart(event)

    expect(result?.systemPrompt).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(result?.systemPrompt).not.toContain('- legacy catalog entry')
    expect(result?.systemPrompt).toContain('Body')
    expect(result?.systemPrompt).toContain('Tail')
    expect(result?.systemPrompt).toContain('<skills>')
    expect(result?.systemPrompt.match(/<skills>/g)?.length).toBe(2)
  })
  /** block 배열 prompt에서 첫 skills block만 치환하고 marker 없이 호출하면 no-op인지 검증합니다. */
  test('rewrites first block from message-array prompts and no-ops without markers', () => {
    const originalPrompt = ['System intro', ['Body', '<skills>', '- legacy catalog entry', '</skills>'].join('\n'), 'Body tail'] as const
    const event: ProviderPayload = {
      systemPrompt: originalPrompt,
    }

    const result = SERVICE.promptGuidance.handleBeforeAgentStart(event)
    const rewritten = result?.systemPrompt
    expect(rewritten).toContain('System intro')
    expect(rewritten).toContain('Body')
    expect(rewritten).toContain('Body tail')
    expect(rewritten).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(rewritten).not.toContain('- legacy catalog entry')
    expect(typeof event.systemPrompt).toBe('string')
    expect(SERVICE.promptGuidance.handleBeforeAgentStart({ systemPrompt: '# Skills & Rules\n- no markers' })).toBeUndefined()
    expect(SERVICE.promptGuidance.handleBeforeAgentStart({} as ProviderPayload)).toBeUndefined()
  })

  /** 배열 원소 하나에 전체 system prompt가 들어온 경우 skills block만 치환되고 주변 본문이 보존되는지 검증합니다. */
  test('rewrites the skills block inside a single full-system-prompt array element', () => {
    const event: ProviderPayload = {
      systemPrompt: ['System intro\n<skills>\n- legacy catalog entry\n</skills>\nSystem tail'] as const,
    }

    const result = SERVICE.promptGuidance.handleBeforeAgentStart(event)
    const rewritten = result?.systemPrompt

    expect(rewritten).toBe(['System intro', SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK, 'System tail'].join('\n'))
    expect(rewritten).not.toContain('- legacy catalog entry')
    expect(event.systemPrompt).toBe(rewritten)
  })

  /** instructions 문자열 payload 첫 skills block을 provider payload 결과로 반환하고 기존 shape는 유지되는지 검증합니다. */
  test('rewrites the first skills block from instruction string payload and returns a normalized payload', () => {
    const event: ProviderPayload = {
      instructions: [
        'Tooling policy',
        '<skills>',
        '- old instruction catalog',
        '</skills>',
        'User note',
        '<skills>',
        '- preserved legacy instruction catalog',
        '</skills>',
      ].join('\n'),
      messages: [{ role: 'user', content: 'unrelated message payload' }],
      extraState: { origin: 'contract test' },
    }
    const snapshot = JSON.stringify(event)

    const result = SERVICE.promptGuidance.handleBeforeProviderRequest(event)

    const rewritten = result as ProviderPayload | undefined
    expect(rewritten?.instructions).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(rewritten?.instructions).not.toContain('- old instruction catalog')
    expect(rewritten?.instructions).toContain('User note')
    expect(rewritten?.instructions).toContain('<skills>\n- preserved legacy instruction catalog\n</skills>')
    expect(rewritten?.instructions).toContain('Tooling policy')
    expect(rewritten?.messages).toEqual([{ role: 'user', content: 'unrelated message payload' }])
    expect(rewritten?.extraState).toEqual({ origin: 'contract test' })
    expect(result).not.toBe(event)
    expect(JSON.stringify(event)).toBe(snapshot)
  })

  /** system/developer 메시지 채널에 대해서만 첫 skills block을 수정하고 payload shape를 보존하는지 검증합니다. */
  test('targets only system/developer messages and rewrites only the first eligible block in provider payload', () => {
    const event: ProviderPayload = {
      messages: [
        { role: 'user', content: ['User sees', '<skills>', '- user catalog', '</skills>'].join('\n') },
        {
          role: 'system',
          content: [
            'System preface',
            '<skills>',
            '- system catalog',
            '</skills>',
            'system tail',
            '<skills>',
            '- should preserve',
            '</skills>',
          ].join('\n'),
        },
        { role: 'developer', content: ['Developer note', '<skills>', '- developer catalog', '</skills>'].join('\n') },
        { role: 'assistant', content: 'assistant content' },
      ],
    }
    const originalUserMessage = JSON.stringify(event.messages?.[0])
    const originalDeveloperMessage = JSON.stringify(event.messages?.[2])

    const result = SERVICE.promptGuidance.handleBeforeProviderRequest(event) as ProviderPayload
    expect(result?.messages?.[1]).toBeDefined()
    expect(result?.messages?.[1]).toHaveProperty('content')
    expect(typeof result?.messages?.[1]?.content).toBe('string')
    const systemContent = result?.messages?.[1]?.content
    expect(systemContent).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(systemContent).not.toContain('- system catalog')
    expect(systemContent).toContain('<skills>\n- should preserve\n</skills>')
    expect(result?.messages?.[0]).toEqual(JSON.parse(originalUserMessage))
    expect(result?.messages?.[2]).toEqual(JSON.parse(originalDeveloperMessage))
    expect(result?.messages?.[3]).toEqual({ role: 'assistant', content: 'assistant content' })
    expect(result).not.toBe(event)
  })

  /** system 메시지보다 빨리 나오는 developer 메시지도 조건을 만족하면 치환되는지 검증합니다. */
  test('rewrites the first skills block from the first developer message when no earlier system block exists', () => {
    const event: ProviderPayload = {
      messages: [
        { role: 'developer', content: ['Developer intro', '<skills>', '- developer catalog', '</skills>'].join('\n') },
        { role: 'system', content: 'System message without catalog' },
      ],
    }

    const result = SERVICE.promptGuidance.handleBeforeProviderRequest(event) as ProviderPayload
    expect(result?.messages?.[0]).toBeDefined()
    expect(result?.messages?.[0]?.content).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(result?.messages?.[0]?.content).not.toContain('- developer catalog')
    expect(result?.messages?.[1]?.content).toBe('System message without catalog')
    expect(result).not.toBe(event)
  })

  /** content 부분이 text-part object인 provider 메시지도 치환되는지 검증합니다. */
  test('rewrites provider message content objects with text payloads', () => {
    const event: ProviderPayload = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'System preface\n<skills>\n- legacy catalog\n</skills>' } as const,
            { type: 'text', text: 'tail text' } as const,
          ] as const,
        },
      ],
    }

    const result = SERVICE.promptGuidance.handleBeforeProviderRequest(event) as ProviderPayload
    const contents = result?.messages?.[0]?.content as unknown[] | undefined

    if (!Array.isArray(contents) || contents.length < 2) {
      throw new Error('expected two text content parts')
    }
    const firstContent = contents[0] as TextPart
    const secondContent = contents[1] as TextPart
    expect(firstContent.type).toBe('text')
    expect(typeof firstContent.text).toBe('string')
    expect(firstContent.text).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(firstContent.text).not.toContain('- legacy catalog')
    expect(secondContent.text).toBe('tail text')
    expect(result).not.toBe(event)
  })

  /** instructions/messages payload에 skills block이 없으면 변경 없이 pass through 되는지 검증합니다. */
  test('no-ops when instructions and messages contain no skills block', () => {
    const event: ProviderPayload = {
      instructions: 'No skills catalog here',
      messages: [{ role: 'system', content: 'No skills block in message body' }],
      extraState: { origin: 'contract test' },
    }
    const snapshot = JSON.stringify(event)

    const result = SERVICE.promptGuidance.handleBeforeProviderRequest(event)

    expect(result).toBeUndefined()
    expect(JSON.stringify(event)).toBe(snapshot)
  })
  test('passes before_agent_start through without changing identity when prompt replacement is disabled', () => {
    const service = createPromptService({ skillsPromptEnabled: false })
    const event: ProviderPayload = {
      systemPrompt: 'Intro\n<skills>\n- legacy\n</skills>\nTail',
    }
    const snapshot = JSON.stringify(event)

    expect(service.handleBeforeAgentStart(event)).toBeUndefined()
    expect(JSON.stringify(event)).toBe(snapshot)
  })

  test('passes provider request with instructions through without changing identity when prompt replacement is disabled', () => {
    const service = createPromptService({ skillsPromptEnabled: false })
    const providerPayload: ProviderPayload = {
      instructions: 'Intro\n<skills>\n- legacy\n</skills>\nTail',
    }
    const payloadSnapshot = JSON.stringify(providerPayload)
    const originalInstructions = providerPayload.instructions

    expect(service.handleBeforeProviderRequest(providerPayload)).toBeUndefined()
    expect(providerPayload.instructions).toBe(originalInstructions)
    expect(JSON.stringify(providerPayload)).toBe(payloadSnapshot)
  })

  test('passes provider request with system/developer and text-part payloads through when disabled', () => {
    const service = createPromptService({ skillsPromptEnabled: false })
    const providerPayload: ProviderPayload = {
      instructions: ['Intro', '<skills>', '- legacy', '</skills>', 'Tail'].join('\n'),
      messages: [
        { role: 'system', content: [{ type: 'text', text: ['System', '<skills>', '- legacy', '</skills>'].join('\n') }] },
        {
          role: 'developer',
          content: [
            { type: 'text', text: ['Developer', '<skills>', '- legacy', '</skills>'].join('\n') } as TextPart,
            { type: 'text', text: 'Developer tail' } as TextPart,
          ] as const,
        },
      ],
      extraState: { scenario: 'disabled pass-through' },
    }
    const payloadSnapshot = JSON.stringify(providerPayload)
    const originalMessages = providerPayload.messages
    const originalSystemMessage = providerPayload.messages?.[0]
    const originalDeveloperMessage = providerPayload.messages?.[1]
    const originalSystemContent = providerPayload.messages?.[0]?.content
    const originalDeveloperContent = providerPayload.messages?.[1]?.content
    const originalSystemPart = Array.isArray(originalSystemContent) ? originalSystemContent[0] : undefined
    const originalDeveloperFirstPart = Array.isArray(originalDeveloperContent) ? originalDeveloperContent[0] : undefined
    const originalDeveloperSecondPart = Array.isArray(originalDeveloperContent) ? originalDeveloperContent[1] : undefined

    expect(service.handleBeforeProviderRequest(providerPayload)).toBeUndefined()
    expect(providerPayload.messages).toBe(originalMessages)
    expect(providerPayload.messages?.[0]).toBe(originalSystemMessage)
    expect(providerPayload.messages?.[1]).toBe(originalDeveloperMessage)
    expect(providerPayload.messages?.[0]?.content).toBe(originalSystemContent)
    expect(providerPayload.messages?.[1]?.content).toBe(originalDeveloperContent)
    const currentSystemContent = providerPayload.messages?.[0]?.content
    const currentDeveloperContent = providerPayload.messages?.[1]?.content
    expect(Array.isArray(currentSystemContent)).toBe(true)
    expect(Array.isArray(currentDeveloperContent)).toBe(true)
    if (Array.isArray(currentSystemContent) && Array.isArray(currentDeveloperContent)) {
      expect(currentSystemContent[0]).toBe(originalSystemPart)
      expect(currentDeveloperContent[0]).toBe(originalDeveloperFirstPart)
      expect(currentDeveloperContent[1]).toBe(originalDeveloperSecondPart)
      expect(currentDeveloperContent[0]).toHaveProperty('text')
      expect((currentDeveloperContent[0] as TextPart).text).toBe((originalDeveloperFirstPart as TextPart)?.text)
      expect((currentSystemContent[0] as TextPart).text).toBe((originalSystemPart as TextPart)?.text)
    }
    expect(JSON.stringify(providerPayload)).toBe(payloadSnapshot)
    expect(providerPayload.messages?.[1]?.content).toBeDefined()
  })

  test('uses trimmed custom body, marker compatibility, and ordered prompt names', () => {
    const service = createPromptService({
      skillsPrompt: '  <skills>\nUse the registry for focused work.\n</skills>  ',
      promptSkillNames: ['planning', 'typescript-code-style'],
    })
    const event: ProviderPayload = {
      systemPrompt: 'Intro\n<skills>\n- legacy catalog\n</skills>\nTail',
    }

    const result = service.handleBeforeAgentStart(event)
    const rewritten = result?.systemPrompt ?? ''

    expect(rewritten).toContain('Use the registry for focused work.')
    expect(rewritten).toContain('- Configured prompt skills: planning, typescript-code-style')
    expect(rewritten).not.toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(rewritten).not.toContain('- legacy catalog')

    const providerResult = service.handleBeforeProviderRequest({
      instructions: 'Intro\n<skills>\n- legacy provider catalog\n</skills>\nTail',
    }) as ProviderPayload
    expect(providerResult.instructions).toContain('Use the registry for focused work.')
    expect(providerResult.instructions).toContain('- Configured prompt skills: planning, typescript-code-style')
  })

  test('falls back to built-in body for blank custom prompt and does not add an empty names line', () => {
    const service = createPromptService({
      skillsPrompt: ' \n ',
      promptSkillNames: [],
    })
    const event: ProviderPayload = {
      systemPrompt: 'Intro\n<skills>\n- legacy catalog\n</skills>\nTail',
    }

    const result = service.handleBeforeAgentStart(event)
    const rewritten = result?.systemPrompt ?? ''

    expect(rewritten).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK)
    expect(rewritten).not.toContain('- Configured prompt skills:')
  })
})
