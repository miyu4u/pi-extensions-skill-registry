import type {
  IndexArtifacts,
  SkillApplyPacketResult,
  SkillChecklistPacketResult,
  SkillCommandsPacketResult,
  SkillExecutionPacketResult,
  SkillFileReadyPacketResult,
  SkillInstructionPacketResult,
  SkillMarkdownPacketResult,
  SkillSummaryPacketResult,
  SkillVerificationPacketResult,
  SkillWriteScriptPacketResult,
  ToolInput,
} from '../shared'
import type { SkillReadPacketBuilder } from './skill-read-packet-builder'

export type SkillExecutionPacketRequest = Pick<
  ToolInput,
  'query' | 'relationMode' | 'budgetChars' | 'budgetTokens' | 'limit' | 'minScore'
> & {
  index: IndexArtifacts
  names: string[]
}

/** serialization/execution packet projection의 concrete owner입니다. */
export class SkillExecutionPacketBuilder {
  constructor(private readonly readPacketBuilder: SkillReadPacketBuilder) {}

  private getCurrentTurnPacket(request: SkillExecutionPacketRequest) {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request
    return this.readPacketBuilder.currentTurnPacketSkills({
      index,
      query,
      names,
      relationMode,
      budgetChars,
      budgetTokens,
      limit,
      minScore,
    })
  }
  /**
   * current turn을 prompt-ready 실행 지시문으로 직렬화합니다.
   */
  instructionPacketSkills(request: SkillExecutionPacketRequest): SkillInstructionPacketResult {
    const currentTurnPacket = this.getCurrentTurnPacket(request)
    const turn = currentTurnPacket.turn
    const { checklistText, commandBlock, instructionText } = this.getInstructionDetails(turn, currentTurnPacket.nextCommands)
    return {
      ...this.copyBaseFields(currentTurnPacket),
      instructionText,
      checklistText,
      commandBlock,
      budget: currentTurnPacket.budget,
      turn,
    }
  }

  /**
   * current turn을 summary 문장으로 직렬화합니다.
   */
  summaryPacketSkills(request: SkillExecutionPacketRequest): SkillSummaryPacketResult {
    const currentTurnPacket = this.getCurrentTurnPacket(request)
    const turn = currentTurnPacket.turn
    const summaryText = turn
      ? `${currentTurnPacket.winner ?? 'skill'} turn ${turn.order}: ${turn.objective}. commands=${turn.nextCommands.length}, checklist=${turn.checklist.length}`
      : 'No active turn is available.'
    return {
      ...this.copyBaseFields(currentTurnPacket),
      summaryText,
      budget: currentTurnPacket.budget,
      turn,
    }
  }

  /**
   * current turn을 markdown checklist/command 문서로 직렬화합니다.
   */
  markdownPacketSkills(request: SkillExecutionPacketRequest): SkillMarkdownPacketResult {
    const instructionPacket = this.instructionPacketSkills(request)
    const checklistItems = instructionPacket.checklistText ? instructionPacket.checklistText.split('\n') : []
    const markdown = [
      `# ${instructionPacket.winner ?? 'skill'} turn ${instructionPacket.activeTurnOrder ?? '-'}`,
      '',
      '## Summary',
      instructionPacket.instructionText,
      '',
      '## Commands',
      instructionPacket.commandBlock || '-',
      '',
      '## Checklist',
      checklistItems.length ? checklistItems.map((item) => `- ${item}`).join('\n') : '-',
      '',
      '## Recovery',
      instructionPacket.recoveryGuidance.length ? instructionPacket.recoveryGuidance.map((item) => `- ${item}`).join('\n') : '-',
    ].join('\n')
    return {
      ...this.copyBaseFields(instructionPacket),
      markdown,
      commandBlock: instructionPacket.commandBlock,
      checklistItems,
      budget: instructionPacket.budget,
      turn: instructionPacket.turn,
    }
  }

  /**
   * current turn에서 checklist 전용 packet만 추출합니다.
   */
  checklistPacketSkills(request: SkillExecutionPacketRequest): SkillChecklistPacketResult {
    const currentTurnPacket = this.getCurrentTurnPacket(request)
    const turn = currentTurnPacket.turn
    const checklistItems = turn?.checklist ?? []
    const checklistText = checklistItems.length ? checklistItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n') : ''
    return {
      ...this.copyBaseFields(currentTurnPacket),
      checklistItems,
      checklistText,
      budget: currentTurnPacket.budget,
      turn,
    }
  }

  /**
   * current turn에서 command 전용 packet만 추출합니다.
   */
  commandsPacketSkills(request: SkillExecutionPacketRequest): SkillCommandsPacketResult {
    const currentTurnPacket = this.getCurrentTurnPacket(request)
    return {
      ...this.copyBaseFields(currentTurnPacket),
      commandBlock: currentTurnPacket.nextCommands.join('\n'),
      budget: currentTurnPacket.budget,
      turn: currentTurnPacket.turn,
    }
  }

  /**
   * current turn packet을 파일 저장용 payload로 묶습니다.
   */
  fileReadyPacketSkills(request: SkillExecutionPacketRequest): SkillFileReadyPacketResult {
    const markdownPacket = this.markdownPacketSkills(request)
    const checklistPacket = this.checklistPacketSkills(request)
    const commandsPacket = this.commandsPacketSkills(request)
    const baseName = `${markdownPacket.winner ?? 'skill'}-turn-${markdownPacket.activeTurnOrder ?? 'current'}`
    const files = this.buildReadyFiles(baseName, markdownPacket.markdown, checklistPacket, commandsPacket)
    return {
      ...this.copyBaseFields(markdownPacket),
      baseName,
      files,
      budget: markdownPacket.budget,
      turn: markdownPacket.turn,
    }
  }

  /**
   * file-ready-packet을 write/apply payload로 투영합니다.
   */
  applyPacketSkills(request: SkillExecutionPacketRequest): SkillApplyPacketResult {
    const fileReadyPacket = this.fileReadyPacketSkills(request)
    const writes = fileReadyPacket.files.map((file) => ({
      kind: 'write' as const,
      sourceKind: file.kind,
      path: file.suggestedPath,
      mediaType: file.mediaType,
      content: file.content,
    }))
    const applyText = writes.length
      ? writes.map((write, indexPosition) => `${indexPosition + 1}. write ${write.path} (${write.sourceKind})`).join('\n')
      : 'write 작업 없음'
    return {
      ...this.copyBaseFields(fileReadyPacket),
      baseName: fileReadyPacket.baseName,
      writes,
      applyText,
      budget: fileReadyPacket.budget,
      turn: fileReadyPacket.turn,
    }
  }

  /**
   * apply-packet을 실행 가능한 write script payload로 투영합니다.
   */
  writeScriptPacketSkills(request: SkillExecutionPacketRequest): SkillWriteScriptPacketResult {
    const applyPacket = this.applyPacketSkills(request)
    const scriptPath = `packets/${applyPacket.baseName}.write.ts`
    const scriptContent = this.buildScriptContent(applyPacket.writes)
    const commandBlock = `bun ${scriptPath}`
    return {
      ...this.copyBaseFields(applyPacket),
      baseName: applyPacket.baseName,
      writes: applyPacket.writes,
      scriptPath,
      scriptContent,
      commandBlock,
      budget: applyPacket.budget,
      turn: applyPacket.turn,
    }
  }

  /**
   * write-script-packet을 script file + run command bundle로 투영합니다.
   */
  executionPacketSkills(request: SkillExecutionPacketRequest): SkillExecutionPacketResult {
    const writeScriptPacket = this.writeScriptPacketSkills(request)
    const files = [
      {
        kind: 'script' as const,
        path: writeScriptPacket.scriptPath,
        mediaType: 'text/typescript' as const,
        content: writeScriptPacket.scriptContent,
      },
    ]
    const runCommands = [writeScriptPacket.commandBlock].filter(Boolean)
    const executionText = [
      `1. Write script file: ${writeScriptPacket.scriptPath}`,
      `2. Run command: ${writeScriptPacket.commandBlock}`,
      `3. Expect ${writeScriptPacket.writes.length} file write operations.`,
    ].join('\n')
    return {
      ...this.copyBaseFields(writeScriptPacket),
      baseName: writeScriptPacket.baseName,
      files,
      runCommands,
      executionText,
      budget: writeScriptPacket.budget,
      turn: writeScriptPacket.turn,
    }
  }

  /**
   * execution-packet을 검증 checklist bundle로 투영합니다.
   */
  verificationPacketSkills(request: SkillExecutionPacketRequest): SkillVerificationPacketResult {
    const executionPacket = this.executionPacketSkills(request)
    const turn = executionPacket.turn
    const verificationItems = turn && turn.exitCriteria.length > 0 ? turn.exitCriteria : ['Run command completed without write errors.']
    const verificationCommands = executionPacket.runCommands
    const verificationText = [
      'Run:',
      verificationCommands.length ? verificationCommands.join('\n') : '-',
      '',
      'Verify:',
      verificationItems.length ? verificationItems.map((item, indexPosition) => `${indexPosition + 1}. ${item}`).join('\n') : '-',
    ].join('\n')
    return {
      ...this.copyBaseFields(executionPacket),
      baseName: executionPacket.baseName,
      files: executionPacket.files,
      runCommands: executionPacket.runCommands,
      verificationCommands,
      verificationItems,
      verificationText,
      budget: executionPacket.budget,
      turn: executionPacket.turn,
    }
  }

  private copyBaseFields(
    src: Pick<
      SkillInstructionPacketResult,
      | 'query'
      | 'basis'
      | 'relationMode'
      | 'winner'
      | 'ready'
      | 'applyHint'
      | 'recoveryGuidance'
      | 'activeTurnOrder'
      | 'sourcePaths'
      | 'nextCommands'
      | 'sourcePathScopes'
      | 'sourcePathCategories'
    >,
  ): Pick<
    SkillInstructionPacketResult,
    | 'query'
    | 'basis'
    | 'relationMode'
    | 'winner'
    | 'ready'
    | 'applyHint'
    | 'recoveryGuidance'
    | 'activeTurnOrder'
    | 'sourcePaths'
    | 'nextCommands'
    | 'sourcePathScopes'
    | 'sourcePathCategories'
  > {
    return {
      query: src.query,
      basis: src.basis,
      relationMode: src.relationMode,
      winner: src.winner,
      ready: src.ready,
      applyHint: src.applyHint,
      recoveryGuidance: src.recoveryGuidance,
      activeTurnOrder: src.activeTurnOrder,
      sourcePaths: src.sourcePaths,
      nextCommands: src.nextCommands,
      sourcePathScopes: src.sourcePathScopes,
      sourcePathCategories: src.sourcePathCategories,
    }
  }

  private getInstructionDetails(turn: SkillInstructionPacketResult['turn'], nextCommands: string[]) {
    const checklistText = turn?.checklist.length ? turn.checklist.map((item, idx) => `${idx + 1}. ${item}`).join('\n') : ''
    const commandBlock = nextCommands.join('\n')
    const instructionText = turn
      ? [
          `Focus on turn ${turn.order} (${turn.phaseKind}${turn.layer === null ? '' : `:${turn.layer}`}).`,
          `Read skills: ${turn.names.join(', ')}.`,
          turn.objective,
          commandBlock ? `Commands:\n${commandBlock}` : 'Commands: -',
          checklistText ? `Checklist:\n${checklistText}` : 'Checklist: -',
        ].join('\n')
      : 'No active turn is available.'
    return { checklistText, commandBlock, instructionText }
  }

  private buildReadyFiles(
    baseName: string,
    markdownContent: string,
    checklistPacket: SkillChecklistPacketResult,
    commandsPacket: SkillCommandsPacketResult,
  ) {
    return [
      {
        kind: 'markdown' as const,
        suggestedPath: `packets/${baseName}.md`,
        mediaType: 'text/markdown' as const,
        content: markdownContent,
      },
      {
        kind: 'checklist' as const,
        suggestedPath: `packets/${baseName}.checklist.md`,
        mediaType: 'text/markdown' as const,
        content:
          checklistPacket.checklistItems.length > 0
            ? checklistPacket.checklistItems.map((item) => `- ${item}`).join('\n')
            : checklistPacket.checklistText || '-',
      },
      {
        kind: 'commands' as const,
        suggestedPath: `packets/${baseName}.commands.txt`,
        mediaType: 'text/plain' as const,
        content: commandsPacket.commandBlock || '-',
      },
    ]
  }

  private buildScriptContent(writes: Array<{ path: string; content: string; sourceKind: string }>) {
    return [
      '/** apply-packet write script 입니다. */',
      'import { mkdir } from "node:fs/promises";',
      'import path from "node:path";',
      '',
      `const writes = ${JSON.stringify(writes, null, 2)} as const;`,
      '',
      'for (const write of writes) {',
      '\tawait mkdir(path.dirname(write.path), { recursive: true });',
      '\tawait Bun.write(write.path, write.content);',
      '\tconsole.log("wrote " + write.path + " (" + write.sourceKind + ")");',
      '}',
    ].join('\n')
  }
}
