import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  buildApplyPacketResult,
  buildAuditResult,
  buildBriefResult,
  buildBundleResult,
  buildChecklistPacketResult,
  buildCommandsPacketResult,
  buildCompareResult,
  buildComposeResult,
  buildCurrentTurnPacketResult,
  buildDecideResult,
  buildDiscoverResult,
  buildExecutionPacketResult,
  buildExplainResult,
  buildFileReadyPacketResult,
  buildGapResult,
  buildGraphResult,
  buildHandoffResult,
  buildIndexResult,
  buildInstructionPacketResult,
  buildMarkdownPacketResult,
  buildMetricsResult,
  buildPackResult,
  buildPlanResult,
  buildRecommendResult,
  buildRecoveryPacketResult,
  buildResolveResult,
  buildResumePacketResult,
  buildRouteResult,
  buildSearchResult,
  buildSelectResult,
  buildSessionPacketResult,
  buildSummaryPacketResult,
  buildTurnPacketResult,
  buildValidateResult,
  buildVerificationPacketResult,
  buildWriteScriptPacketResult,
  errorResult,
} from './results'
import { SkillRegistryToolContract } from './schema'
import { SERVICE } from './service-registry'
import type { IndexArtifacts, SkillRegistryToolResult, ToolInput } from './shared'

const LARGE_ONLY_QUERY_ACTIONS: Partial<Record<ToolInput['action'], boolean>> = {
  decide: true,
  plan: true,
  route: true,
  'current-turn-packet': true,
  'session-packet': true,
  'turn-packet': true,
}

const ACTION_HANDLERS: Record<
  ToolInput['action'],
  (artifacts: IndexArtifacts, normalized: NormalizedInput) => SkillRegistryToolResult | Promise<SkillRegistryToolResult>
> = {
  discover: (artifacts, normalized) => {
    if (!normalized.query) {
      return errorResult("`discover` 동작은 query가 필요합니다. (예: {action:'discover', query:'commit staging'})")
    }
    const searchResult = SERVICE.skillSearchEngine.searchWithDiagnostics(artifacts, normalized.query, normalized.limit, normalized.minScore)
    return buildDiscoverResult(artifacts, searchResult.hits, normalized, searchResult.diagnostics)
  },
  index: (artifacts, normalized) => {
    return buildIndexResult(artifacts, normalized.limit)
  },
  search: (artifacts, normalized) => {
    if (!normalized.query) {
      return errorResult("`search` 동작은 query가 필요합니다. (예: {action:'search', query:'review code'})")
    }
    const searchResult = SERVICE.skillSearchEngine.searchWithDiagnostics(artifacts, normalized.query, normalized.limit, normalized.minScore)
    return buildSearchResult(artifacts, searchResult.hits, normalized, searchResult.diagnostics)
  },
  select: (artifacts, normalized) => {
    if (!normalized.query) {
      return errorResult("`select` 동작은 query가 필요합니다. (예: {action:'select', query:'metrics', limit: 5})")
    }
    const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, normalized.query, normalized.limit, normalized.minScore)
    return buildSelectResult(artifacts, hits, normalized)
  },
  compose: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`compose` 동작은 query 또는 names가 필요합니다. (예: {action:'compose', query:'typescript feature', relationMode:'full'})",
      )
    }
    const plan = SERVICE.skillRelationEngine.composeSkills({
      index: artifacts,
      query: normalized.query,
      names: normalized.names,
      limit: normalized.limit,
      relationMode: normalized.relationMode,
      minScore: normalized.minScore,
    })
    return buildComposeResult(artifacts, plan, normalized)
  },
  resolve: (artifacts, normalized) => {
    if (normalized.orderedNames.length === 0) {
      return errorResult("`resolve` 동작은 names가 필요합니다. (예: {action:'resolve', names:['typescript-developer'], includeBody:false})")
    }
    return buildResolveResult(
      artifacts,
      SERVICE.skillSearchEngine.resolveSkills({
        index: artifacts,
        names: normalized.orderedNames,
        includeBody: normalized.includeBody,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        suggestionLimit: normalized.suggestionLimit,
      }),
    )
  },
  pack: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`pack` 동작은 query 또는 names가 필요합니다. (예: {action:'pack', names:['typescript-developer'], budgetChars:4000})",
      )
    }
    return buildPackResult(
      artifacts,
      SERVICE.skillReadPacketBuilder.packSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        includeBody: normalized.includeBody,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  graph: (artifacts, normalized) => {
    if ((normalized.graphMode === 'outbound' || normalized.graphMode === 'inbound') && !normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`graph` 동작은 outbound/inbound 모드에서 query 또는 names가 필요합니다. (예: {action:'graph', graphMode:'outbound', names:['typescript-developer']})",
      )
    }
    return buildGraphResult(
      artifacts,
      SERVICE.skillRelationEngine.graphSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        graphMode: normalized.graphMode,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  gap: (artifacts, normalized) => {
    if (!normalized.query) {
      return errorResult("`gap` 동작은 query가 필요합니다. (예: {action:'gap', query:'typescript contract review'})")
    }
    return buildGapResult(
      SERVICE.skillSearchEngine.gapSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        coverageThreshold: normalized.coverageThreshold,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  explain: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult("`explain` 동작은 query 또는 names가 필요합니다. (예: {action:'explain', query:'typescript contract review'})")
    }
    return buildExplainResult(
      SERVICE.skillDecisionEngine.explainSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  decide: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`decide` 동작은 query 또는 names가 필요합니다. (예: {action:'decide', query:'typescript contract', names:['review']})",
      )
    }
    return buildDecideResult(
      SERVICE.skillDecisionEngine.decideSkills(artifacts, normalized.query, normalized.names, normalized.limit, normalized.minScore),
    )
  },
  plan: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`plan` 동작은 query 또는 names가 필요합니다. (예: {action:'plan', query:'typescript contract', relationMode:'full'})",
      )
    }
    const index = artifacts
    const { query, names, relationMode, limit, minScore } = normalized
    return buildPlanResult(
      SERVICE.skillDecisionEngine.planSkills({
        index,
        query,
        names,
        relationMode,
        limit,
        minScore,
      }),
    )
  },
  route: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`route` 동작은 query 또는 names가 필요합니다. (예: {action:'route', query:'typescript contract', relationMode:'full'})",
      )
    }
    return buildRouteResult(
      SERVICE.skillDecisionEngine.routeSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  brief: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`brief` 동작은 query 또는 names가 필요합니다. (예: {action:'brief', query:'typescript contract', budgetChars:2000})",
      )
    }
    return buildBriefResult(
      SERVICE.skillReadPacketBuilder.briefSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        includeBody: normalized.includeBody,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  bundle: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`bundle` 동작은 query 또는 names가 필요합니다. (예: {action:'bundle', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildBundleResult(
      SERVICE.skillReadPacketBuilder.bundleSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  handoff: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`handoff` 동작은 query 또는 names가 필요합니다. (예: {action:'handoff', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildHandoffResult(
      SERVICE.skillReadPacketBuilder.handoffSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'session-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`session-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'session-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildSessionPacketResult(
      SERVICE.skillReadPacketBuilder.sessionPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'turn-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`turn-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'turn-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildTurnPacketResult(
      SERVICE.skillReadPacketBuilder.turnPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'recovery-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`recovery-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'recovery-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildRecoveryPacketResult(
      SERVICE.skillReadPacketBuilder.recoveryPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'resume-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`resume-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'resume-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildResumePacketResult(
      SERVICE.skillReadPacketBuilder.resumePacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'current-turn-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`current-turn-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'current-turn-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildCurrentTurnPacketResult(
      SERVICE.skillReadPacketBuilder.currentTurnPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'instruction-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`instruction-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'instruction-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildInstructionPacketResult(
      SERVICE.skillExecutionPacketBuilder.instructionPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'summary-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`summary-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'summary-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildSummaryPacketResult(
      SERVICE.skillExecutionPacketBuilder.summaryPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'markdown-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`markdown-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'markdown-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildMarkdownPacketResult(
      SERVICE.skillExecutionPacketBuilder.markdownPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'checklist-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`checklist-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'checklist-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildChecklistPacketResult(
      SERVICE.skillExecutionPacketBuilder.checklistPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'commands-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`commands-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'commands-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildCommandsPacketResult(
      SERVICE.skillExecutionPacketBuilder.commandsPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'file-ready-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`file-ready-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'file-ready-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildFileReadyPacketResult(
      SERVICE.skillExecutionPacketBuilder.fileReadyPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'apply-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`apply-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'apply-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildApplyPacketResult(
      SERVICE.skillExecutionPacketBuilder.applyPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'write-script-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`write-script-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'write-script-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildWriteScriptPacketResult(
      SERVICE.skillExecutionPacketBuilder.writeScriptPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'execution-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`execution-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'execution-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildExecutionPacketResult(
      SERVICE.skillExecutionPacketBuilder.executionPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  'verification-packet': (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`verification-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'verification-packet', query:'typescript contract', budgetChars:4000})",
      )
    }
    return buildVerificationPacketResult(
      SERVICE.skillExecutionPacketBuilder.verificationPacketSkills({
        index: artifacts,
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        budgetChars: normalized.budgetChars,
        budgetTokens: normalized.budgetTokens,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  compare: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`compare` 동작은 query 또는 names가 필요합니다. (예: {action:'compare', query:'typescript contract', names:['review']})",
      )
    }
    return buildCompareResult(
      SERVICE.skillDecisionEngine.compareSkills(artifacts, normalized.query, normalized.names, normalized.limit, normalized.minScore),
    )
  },
  recommend: (artifacts, normalized) => {
    if (!normalized.query && normalized.names.length === 0) {
      return errorResult(
        "`recommend` 동작은 query 또는 names가 필요합니다. (예: {action:'recommend', names:['typescript-developer'], relationMode:'full'})",
      )
    }
    return buildRecommendResult(
      SERVICE.skillDecisionEngine.recommendSkills(artifacts, {
        query: normalized.query,
        names: normalized.names,
        relationMode: normalized.relationMode,
        limit: normalized.limit,
        minScore: normalized.minScore,
      }),
    )
  },
  audit: (artifacts, normalized) => {
    return buildAuditResult(
      artifacts,
      SERVICE.skillIndexDiagnostics.auditSkills(artifacts, normalized.query, normalized.names, normalized.limit, normalized.minScore),
    )
  },
  validate: (artifacts) => {
    return buildValidateResult(artifacts, SERVICE.skillIndexDiagnostics.validateIndex(artifacts))
  },
  metrics: (artifacts) => {
    return buildMetricsResult(artifacts)
  },
}

type NormalizedInput = ReturnType<typeof SERVICE.skillInputNormalizer.normalizeToolInput>

async function executeTool(
  _toolCallId: string,
  params: ToolInput,
  _signal: AbortSignal | undefined,
  _onUpdate: ((partial: SkillRegistryToolResult) => void) | undefined,
  _ctx: unknown,
): Promise<SkillRegistryToolResult> {
  try {
    const normalized = SERVICE.skillInputNormalizer.normalizeToolInput(params)
    if (normalized.taskSize !== 'large' && normalized.names.length === 0 && LARGE_ONLY_QUERY_ACTIONS[normalized.action]) {
      return errorResult(
        `"${normalized.action}" query-only 확장은 taskSize:"large"에서만 허용됩니다. small/medium 작업은 discover/search/brief를 먼저 사용하거나 names를 명시하세요.`,
      )
    }
    const artifacts = await SERVICE.skillIndexLoader.loadIndex(normalized)
    const handler = ACTION_HANDLERS[normalized.action]
    if (!handler) {
      return errorResult(`Unknown action: ${normalized.action}`)
    }
    return await handler(artifacts, normalized)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`skill_registry 실행 오류: ${message}`)
  }
}

function wireTools(pi: ExtensionAPI): void {
  pi.registerTool({
    ...SkillRegistryToolContract,
    execute: executeTool,
  })
}

function wireCommands(pi: ExtensionAPI): void {
  pi.registerCommand('skill-registry:reindex', {
    description: 'Effective scope의 skill index를 강제로 갱신합니다.',
    handler: async (args, context) => {
      const result = await SERVICE.reindexCommand.execute({ args })
      context.ui.notify(result.message, result.status === 'error' ? 'error' : 'info')
    },
  })
  pi.registerCommand('skill-registry:discover', {
    description: 'Query와 관련된 skill을 기존 BM25 ranking으로 탐색합니다.',
    handler: async (args, context) => {
      const result = await SERVICE.discoverCommand.execute({ args })
      context.ui.notify(result.message, result.status === 'error' ? 'error' : 'info')
    },
  })
  pi.registerCommand('skill-registry:diagnostics', {
    description: '현재 skill index의 audit, validation, metrics summary를 표시합니다.',
    handler: async (args, context) => {
      const result = await SERVICE.diagnosticsCommand.execute({ args })
      context.ui.notify(result.message, result.status === 'error' ? 'error' : 'info')
    },
  })
}

function wireHooks(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => SERVICE.promptGuidance.handleBeforeAgentStart(event))
  pi.on('before_provider_request', (event) => SERVICE.promptGuidance.handleBeforeProviderRequest(event.payload))
  pi.on('tool_result', (event) => SERVICE.skillReadResultCompactor.handleToolResult(event) as never)
}

/**
 * pi가 호출하는 skill-registry extension entrypoint입니다.
 *
 * @param pi pi extension API 인스턴스
 */
export default function register(pi: ExtensionAPI): void {
  wireTools(pi)
  wireCommands(pi)
  wireHooks(pi)
}
