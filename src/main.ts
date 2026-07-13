import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
} from "./results";
import { SkillRegistryToolContract } from "./schema";
import { SERVICE } from "./service-registry";
import type { SkillRegistryToolResult, ToolInput } from "./shared";

const LARGE_ONLY_QUERY_ACTIONS: Partial<Record<ToolInput["action"], boolean>> = {
	decide: true,
	plan: true,
	route: true,
	"current-turn-packet": true,
	"session-packet": true,
	"turn-packet": true,
};

function wireTools(pi: ExtensionAPI): void {
	pi.registerTool({
		...SkillRegistryToolContract,
		async execute(
			_toolCallId: string,
			params: ToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: ((partial: SkillRegistryToolResult) => void) | undefined,
			_ctx: unknown,
		): Promise<SkillRegistryToolResult> {
			try {
				const normalized = SERVICE.skillInputNormalizer.normalizeToolInput(params);
				if (normalized.taskSize !== "large" && normalized.names.length === 0 && LARGE_ONLY_QUERY_ACTIONS[normalized.action]) {
					return errorResult(
						`"${normalized.action}" query-only 확장은 taskSize:"large"에서만 허용됩니다. small/medium 작업은 discover/search/brief를 먼저 사용하거나 names를 명시하세요.`,
					);
				}
				const artifacts = await SERVICE.skillIndexLoader.loadIndex(normalized);

				switch (normalized.action) {
					case "discover": {
						if (!normalized.query) {
							return errorResult("`discover` 동작은 query가 필요합니다. (예: {action:'discover', query:'commit staging'})");
						}
						const searchResult = SERVICE.skillSearchEngine.searchWithDiagnostics(artifacts,
							normalized.query,
							normalized.limit,
							normalized.minScore,);
						return buildDiscoverResult(artifacts, searchResult.hits, normalized, searchResult.diagnostics);
					}
					case "index":
						return buildIndexResult(artifacts, normalized.limit);
					case "search": {
						if (!normalized.query) {
							return errorResult("`search` 동작은 query가 필요합니다. (예: {action:'search', query:'review code'})");
						}
						const searchResult = SERVICE.skillSearchEngine.searchWithDiagnostics(artifacts,
							normalized.query,
							normalized.limit,
							normalized.minScore,);
						return buildSearchResult(artifacts, searchResult.hits, normalized, searchResult.diagnostics);
					}
					case "select": {
						if (!normalized.query) {
							return errorResult("`select` 동작은 query가 필요합니다. (예: {action:'select', query:'metrics', limit: 5})");
						}
						const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, normalized.query, normalized.limit, normalized.minScore);
						return buildSelectResult(artifacts, hits, normalized);
					}
					case "compose": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`compose` 동작은 query 또는 names가 필요합니다. (예: {action:'compose', query:'typescript feature', relationMode:'full'})",
							);
						}
						const plan = SERVICE.skillRelationEngine.composeSkills(artifacts,
							normalized.query,
							normalized.names,
							normalized.limit,
							normalized.relationMode,
							normalized.minScore,);
						return buildComposeResult(artifacts, plan, normalized);
					}
					case "resolve": {
						if (normalized.orderedNames.length === 0) {
							return errorResult(
								"`resolve` 동작은 names가 필요합니다. (예: {action:'resolve', names:['typescript-developer'], includeBody:false})",
							);
						}
						return buildResolveResult(
							artifacts,
							SERVICE.skillSearchEngine.resolveSkills(artifacts,
								normalized.orderedNames,
								normalized.includeBody,
								normalized.budgetChars,
								normalized.budgetTokens,),
						);
					}
					case "pack": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`pack` 동작은 query 또는 names가 필요합니다. (예: {action:'pack', names:['typescript-developer'], budgetChars:4000})",
							);
						}
						return buildPackResult(
							artifacts,
							SERVICE.skillIndex.packSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.includeBody,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "graph": {
						if (
							(normalized.graphMode === "outbound" || normalized.graphMode === "inbound") &&
							!normalized.query &&
							normalized.names.length === 0
						) {
							return errorResult(
								"`graph` 동작은 outbound/inbound 모드에서 query 또는 names가 필요합니다. (예: {action:'graph', graphMode:'outbound', names:['typescript-developer']})",
							);
						}
						return buildGraphResult(
							artifacts,
							SERVICE.skillRelationEngine.graphSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.graphMode,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "gap": {
						if (!normalized.query) {
							return errorResult("`gap` 동작은 query가 필요합니다. (예: {action:'gap', query:'typescript contract review'})");
						}
						return buildGapResult(
							SERVICE.skillSearchEngine.gapSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.coverageThreshold,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "explain": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`explain` 동작은 query 또는 names가 필요합니다. (예: {action:'explain', query:'typescript contract review'})",
							);
						}
						return buildExplainResult(
							SERVICE.skillDecisionEngine.explainSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "decide": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`decide` 동작은 query 또는 names가 필요합니다. (예: {action:'decide', query:'typescript contract', names:['review']})",
							);
						}
						return buildDecideResult(
							SERVICE.skillDecisionEngine.decideSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "plan": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`plan` 동작은 query 또는 names가 필요합니다. (예: {action:'plan', query:'typescript contract', relationMode:'full'})",
							);
						}
						return buildPlanResult(
							SERVICE.skillDecisionEngine.planSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "route": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`route` 동작은 query 또는 names가 필요합니다. (예: {action:'route', query:'typescript contract', relationMode:'full'})",
							);
						}
						return buildRouteResult(
							SERVICE.skillDecisionEngine.routeSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "brief": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`brief` 동작은 query 또는 names가 필요합니다. (예: {action:'brief', query:'typescript contract', budgetChars:2000})",
							);
						}
						return buildBriefResult(
							SERVICE.skillIndex.briefSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.includeBody,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "bundle": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`bundle` 동작은 query 또는 names가 필요합니다. (예: {action:'bundle', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildBundleResult(
							SERVICE.skillIndex.bundleSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "handoff": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`handoff` 동작은 query 또는 names가 필요합니다. (예: {action:'handoff', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildHandoffResult(
							SERVICE.skillIndex.handoffSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "session-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`session-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'session-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildSessionPacketResult(
							SERVICE.skillIndex.sessionPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "turn-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`turn-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'turn-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildTurnPacketResult(
							SERVICE.skillIndex.turnPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "recovery-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`recovery-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'recovery-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildRecoveryPacketResult(
							SERVICE.skillIndex.recoveryPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "resume-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`resume-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'resume-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildResumePacketResult(
							SERVICE.skillIndex.resumePacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "current-turn-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`current-turn-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'current-turn-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildCurrentTurnPacketResult(
							SERVICE.skillIndex.currentTurnPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "instruction-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`instruction-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'instruction-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildInstructionPacketResult(
							SERVICE.skillIndex.instructionPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "summary-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`summary-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'summary-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildSummaryPacketResult(
							SERVICE.skillIndex.summaryPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "markdown-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`markdown-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'markdown-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildMarkdownPacketResult(
							SERVICE.skillIndex.markdownPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "checklist-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`checklist-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'checklist-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildChecklistPacketResult(
							SERVICE.skillIndex.checklistPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "commands-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`commands-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'commands-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildCommandsPacketResult(
							SERVICE.skillIndex.commandsPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "file-ready-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`file-ready-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'file-ready-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildFileReadyPacketResult(
							SERVICE.skillIndex.fileReadyPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "apply-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`apply-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'apply-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildApplyPacketResult(
							SERVICE.skillIndex.applyPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "write-script-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`write-script-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'write-script-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildWriteScriptPacketResult(
							SERVICE.skillIndex.writeScriptPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "execution-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`execution-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'execution-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildExecutionPacketResult(
							SERVICE.skillIndex.executionPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "verification-packet": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`verification-packet` 동작은 query 또는 names가 필요합니다. (예: {action:'verification-packet', query:'typescript contract', budgetChars:4000})",
							);
						}
						return buildVerificationPacketResult(
							SERVICE.skillIndex.verificationPacketSkills(
								artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.budgetChars,
								normalized.budgetTokens,
								normalized.limit,
								normalized.minScore,
							),
						);
					}
					case "compare": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`compare` 동작은 query 또는 names가 필요합니다. (예: {action:'compare', query:'typescript contract', names:['review']})",
							);
						}
						return buildCompareResult(
							SERVICE.skillDecisionEngine.compareSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "recommend": {
						if (!normalized.query && normalized.names.length === 0) {
							return errorResult(
								"`recommend` 동작은 query 또는 names가 필요합니다. (예: {action:'recommend', names:['typescript-developer'], relationMode:'full'})",
							);
						}
						return buildRecommendResult(
							SERVICE.skillDecisionEngine.recommendSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.relationMode,
								normalized.limit,
								normalized.minScore,),
						);
					}
					case "audit":
						return buildAuditResult(
							artifacts,
							SERVICE.skillIndexDiagnostics.auditSkills(artifacts,
								normalized.query,
								normalized.names,
								normalized.limit,
								normalized.minScore,),
						);
					case "validate":
						return buildValidateResult(artifacts, SERVICE.skillIndexDiagnostics.validateIndex(artifacts));
					case "metrics":
						return buildMetricsResult(artifacts);
					default:
						return errorResult(`Unknown action: ${normalized.action}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`skill_registry 실행 오류: ${message}`);
			}
		},
	});
}

function wireCommands(_pi: ExtensionAPI): void {}

function wireHooks(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => SERVICE.promptGuidance.handleBeforeAgentStart(event));
	pi.on("before_provider_request", (event) => SERVICE.promptGuidance.handleBeforeProviderRequest(event.payload));
}

/**
 * pi가 호출하는 skill-registry extension entrypoint입니다.
 *
 * @param pi pi extension API 인스턴스
 */
export default function register(pi: ExtensionAPI): void {
	wireTools(pi);
	wireCommands(pi);
	wireHooks(pi);
}
