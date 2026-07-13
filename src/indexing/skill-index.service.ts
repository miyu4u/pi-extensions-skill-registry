import path from "node:path";
import type {
	IndexArtifacts,
	IndexedStats,
	RawSkill,
	SearchHit,
	SkillApplyPacketResult,
	SkillBriefEntry,
	SkillBriefResult,
	SkillBundleResult,
	SkillChecklistPacketResult,
	SkillCommandsPacketResult,
	SkillCompareEntry,
	SkillComparePair,
	SkillCompareRelation,
	SkillCompareResult,
	SkillCurrentTurnPacketResult,
	SkillDecideEntry,
	SkillDecideResult,
	SkillExecutionPacketResult,
	SkillExplainEntry,
	SkillExplainResult,
	SkillFileReadyPacketResult,
	SkillHandoffResult,
	SkillInstructionPacketResult,
	SkillMarkdownPacketResult,
	SkillPack,
	SkillPackEntry,
	SkillPlanResult,
	SkillPlanStep,
	SkillRecommendEntry,
	SkillRecommendRelationSignal,
	SkillRecommendResult,
	SkillRecoveryPacketResult,
	SkillRecoveryPacketTurn,
	SkillRelationGraph,
	SkillRelationGraphEdge,
	SkillRelationGraphNode,
	SkillRelationMode,
	SkillResumePacketResult,
	SkillRoutePhase,
	SkillRouteResult,
	SkillSessionPacketResult,
	SkillSessionPacketStep,
	SkillSummaryPacketResult,
	SkillTurnPacketResult,
	SkillTurnPacketTurn,
	SkillVerificationPacketResult,
	SkillWriteScriptPacketResult,
} from "../shared";
import { composeReasonPriority } from "./compose-reason-priority";
import { dedupeDuplicateAliasEntries } from "./dedupe-duplicate-alias-entries";
import type { SkillDecisionEngine } from "./skill-decision-engine";
import type { SkillIndexDiagnostics } from "./skill-index-diagnostics";
import type { SkillIndexInterface } from "./skill-index.interface";
import type { SkillRelationEngine } from "./skill-relation-engine";

/** skill-registry 인덱싱/검색 구현체입니다. */
export class SkillIndexService implements SkillIndexInterface {
	constructor(
		private readonly relationEngine: SkillRelationEngine,
		private readonly indexDiagnostics: SkillIndexDiagnostics,
		private readonly decisionEngine: SkillDecisionEngine,
	) {}

	/**
	 * route와 pack을 합쳐 bounded read packet을 구성합니다.
	 */
	briefSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		includeBody = true,
		budgetChars = 4_000,
		budgetTokens = 1_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillBriefResult {
		const summaryLimit = Math.max(1, limit);
		const route = this.decisionEngine.routeSkills(index, query, names, relationMode, summaryLimit, minScore);
		const pack = this.packSkills(
			index,
			query,
			names,
			relationMode,
			includeBody,
			budgetChars,
			budgetTokens,
			Math.max(summaryLimit, route.phases.flatMap((phase) => phase.names).length),
			minScore,
		);
		const packEntryByName = new Map(pack.entries.map((entry) => [entry.name, entry] as const));
		const seenNames = new Set<string>();
		const entries: SkillBriefEntry[] = [];
		for (const phase of route.phases) {
			for (const name of phase.names) {
				if (seenNames.has(name)) {
					continue;
				}
				const packEntry = packEntryByName.get(name);
				if (!packEntry) {
					continue;
				}
				seenNames.add(name);
				entries.push({
					phaseOrder: phase.order,
					phaseKind: phase.kind,
					layer: phase.layer,
					name: packEntry.name,
					readPath: packEntry.readPath,
					path: packEntry.path,
					title: packEntry.title,
					category: packEntry.category,
					preview: packEntry.preview,
					body: packEntry.body,
					omittedByBudget: packEntry.omittedByBudget,
				});
			}
		}
		return {
			query,
			basis: route.basis,
			relationMode,
			winner: route.winner,
			phases: route.phases,
			entries,
			deferred: route.deferred,
			omittedReadPaths: pack.omittedReadPaths,
			budget: pack.budget,
		};
	}

	/**
	 * brief를 agent-ready preset으로 묶은 bundle을 구성합니다.
	 */
	bundleSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillBundleResult {
		const brief = this.briefSkills(index, query, names, relationMode, true, budgetChars, budgetTokens, limit, minScore);
		const entries = brief.entries.map(({ body, ...entry }) => entry);
		const entriesWithBody = brief.entries.some((entry) => entry.body) ? brief.entries : undefined;
		return {
			query: brief.query,
			basis: brief.basis,
			relationMode: brief.relationMode,
			winner: brief.winner,
			ready: brief.omittedReadPaths.length === 0,
			phases: brief.phases,
			entries,
			entriesWithBody,
			deferred: brief.deferred,
			omittedReadPaths: brief.omittedReadPaths,
			budget: brief.budget,
		};
	}

	/**
	 * bundle에 source/next command 힌트를 얹은 handoff packet을 구성합니다.
	 */
	handoffSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillHandoffResult {
		const bundle = this.bundleSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const winnerEntry = bundle.entries.find((entry) => entry.name === bundle.winner);
		const sourcePath = winnerEntry?.path ?? null;
		const nextCommand = sourcePath ? `read("${sourcePath}")` : null;
		return {
			query: bundle.query,
			basis: bundle.basis,
			relationMode: bundle.relationMode,
			winner: bundle.winner,
			ready: bundle.ready,
			sourcePath,
			nextCommand,
			applyHint: bundle.ready ? undefined : "Increase budgetChars/budgetTokens or inspect omittedReadPaths before apply.",
			phases: bundle.phases,
			entries: bundle.entries,
			entriesWithBody: bundle.entriesWithBody,
			deferred: bundle.deferred,
			omittedReadPaths: bundle.omittedReadPaths,
			budget: bundle.budget,
		};
	}

	/**
	 * handoff를 session-ready ordered packet으로 투영합니다.
	 */
	sessionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillSessionPacketResult {
		const handoff = this.handoffSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const sourcePaths = handoff.entries.map((entry) => entry.path);
		const nextCommands = sourcePaths.map((sourcePath) => `read("${sourcePath}")`);
		const steps: SkillSessionPacketStep[] = handoff.entries.map((entry, indexPosition) => ({
			order: indexPosition + 1,
			name: entry.name,
			sourcePath: entry.path,
			nextCommand: `read("${entry.path}")`,
			phaseKind: entry.phaseKind,
			layer: entry.layer,
			omittedByBudget: entry.omittedByBudget,
		}));
		return {
			query: handoff.query,
			basis: handoff.basis,
			relationMode: handoff.relationMode,
			winner: handoff.winner,
			ready: handoff.ready,
			sourcePaths,
			nextCommands,
			applyHint: handoff.applyHint,
			recoveryGuidance: handoff.ready
				? []
				: [
						...(handoff.omittedReadPaths.length ? [`Read omitted paths first: ${handoff.omittedReadPaths.join(", ")}`] : []),
						...(handoff.applyHint ? [handoff.applyHint] : []),
					],
			steps,
		};
	}

	/**
	 * session-packet을 turn 단위 execution packet으로 투영합니다.
	 */
	turnPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillTurnPacketResult {
		const handoff = this.handoffSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const turns: SkillTurnPacketTurn[] = handoff.phases.map((phase) => {
			const phaseEntries = handoff.entries.filter((entry) => entry.phaseOrder === phase.order);
			const sourcePaths = phaseEntries.map((entry) => entry.path);
			const nextCommands = sourcePaths.map((sourcePath) => `read("${sourcePath}")`);
			const blockedByBudget = phaseEntries.some((entry) => entry.omittedByBudget);
			const objective =
				phase.kind === "start"
					? `Start with winner ${phase.names[0] ?? "-"}`
					: phase.kind === "read-layer"
						? `Read required layer ${phase.layer ?? "-"} before dependent peers`
						: phase.kind === "apply-layer"
							? `Read apply layer ${phase.layer ?? "-"} for optional extension`
							: "Inspect remaining fallback steps";
			const checklist = [
				phase.readPaths.length ? `Read packet entries: ${phase.readPaths.join(", ")}` : undefined,
				nextCommands.length ? `Open source files: ${nextCommands.join(" -> ")}` : undefined,
				blockedByBudget ? "Resolve omitted skill bodies before applying this turn." : "No omitted skill body in this turn.",
			].filter((item): item is string => Boolean(item));
			const exitCriteria = [
				phase.names.length ? `Reviewed skills: ${phase.names.join(", ")}` : undefined,
				blockedByBudget
					? `Budget omissions cleared for turn ${phase.order}`
					: `Turn ${phase.order} is ready without extra budget recovery`,
			].filter((item): item is string => Boolean(item));
			return {
				order: phase.order,
				phaseKind: phase.kind,
				layer: phase.layer,
				names: phase.names,
				readPaths: phase.readPaths,
				sourcePaths,
				nextCommands,
				objective,
				checklist,
				exitCriteria,
				blockedByBudget,
			};
		});
		const sourcePaths = turns.flatMap((turn) => turn.sourcePaths);
		const nextCommands = turns.flatMap((turn) => turn.nextCommands);
		return {
			query: handoff.query,
			basis: handoff.basis,
			relationMode: handoff.relationMode,
			winner: handoff.winner,
			ready: handoff.ready,
			sourcePaths,
			nextCommands,
			applyHint: handoff.applyHint,
			recoveryGuidance: handoff.ready
				? []
				: [
						...(handoff.omittedReadPaths.length ? [`Read omitted paths first: ${handoff.omittedReadPaths.join(", ")}`] : []),
						...(handoff.applyHint ? [handoff.applyHint] : []),
					],
			deferred: handoff.deferred,
			omittedReadPaths: handoff.omittedReadPaths,
			budget: handoff.budget,
			turns,
		};
	}

	/**
	 * turn-packet에서 recovery 대상 turn만 추려 resume packet으로 투영합니다.
	 */
	recoveryPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillRecoveryPacketResult {
		const handoff = this.handoffSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const blockedTurns: SkillRecoveryPacketTurn[] = handoff.phases
			.map((phase) => {
				const omittedEntries = handoff.entries.filter((entry) => entry.phaseOrder === phase.order && entry.omittedByBudget);
				if (omittedEntries.length === 0) {
					return null;
				}
				const omittedReadPaths = omittedEntries.map((entry) => entry.readPath);
				const sourcePaths = omittedEntries.map((entry) => entry.path);
				const recoveryCommands = sourcePaths.map((sourcePath) => `read("${sourcePath}")`);
				const objective =
					phase.kind === "start"
						? `Recover winner ${phase.names[0] ?? "-"} before continuing`
						: phase.kind === "read-layer"
							? `Recover required layer ${phase.layer ?? "-"} before dependent peers`
							: phase.kind === "apply-layer"
								? `Recover optional apply layer ${phase.layer ?? "-"} before extension work`
								: "Recover fallback steps before resuming";
				const unblockCriteria = [
					`Read omitted skill bodies: ${omittedReadPaths.join(", ")}`,
					recoveryCommands.length ? `Open source files: ${recoveryCommands.join(" -> ")}` : undefined,
				].filter((item): item is string => Boolean(item));
				return {
					order: phase.order,
					phaseKind: phase.kind,
					layer: phase.layer,
					names: phase.names,
					omittedReadPaths,
					sourcePaths,
					recoveryCommands,
					objective,
					unblockCriteria,
				};
			})
			.filter((turn): turn is SkillRecoveryPacketTurn => Boolean(turn));
		const sourcePaths = blockedTurns.flatMap((turn) => turn.sourcePaths);
		const recoveryCommands = blockedTurns.flatMap((turn) => turn.recoveryCommands);
		return {
			query: handoff.query,
			basis: handoff.basis,
			relationMode: handoff.relationMode,
			winner: handoff.winner,
			ready: handoff.ready,
			applyHint: handoff.applyHint,
			recoveryGuidance: handoff.ready
				? []
				: [
						...(handoff.omittedReadPaths.length ? [`Read omitted paths first: ${handoff.omittedReadPaths.join(", ")}`] : []),
						...(handoff.applyHint ? [handoff.applyHint] : []),
					],
			omittedReadPaths: handoff.omittedReadPaths,
			sourcePaths,
			recoveryCommands,
			deferred: handoff.deferred,
			resumeTurnOrder: blockedTurns[0]?.order ?? null,
			budget: handoff.budget,
			blockedTurns,
		};
	}

	/**
	 * recovery 이후 재개할 remaining turn sequence를 packet으로 투영합니다.
	 */
	resumePacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillResumePacketResult {
		const turnPacket = this.turnPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const recoveryPacket = this.recoveryPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const resumeTurnOrder = recoveryPacket.resumeTurnOrder ?? turnPacket.turns[0]?.order ?? null;
		const turns = resumeTurnOrder === null ? [] : turnPacket.turns.filter((turn) => turn.order >= resumeTurnOrder);
		const sourcePaths = turns.flatMap((turn) => turn.sourcePaths);
		const nextCommands = turns.flatMap((turn) => turn.nextCommands);
		return {
			query: turnPacket.query,
			basis: turnPacket.basis,
			relationMode: turnPacket.relationMode,
			winner: turnPacket.winner,
			ready: recoveryPacket.ready,
			applyHint: recoveryPacket.applyHint,
			recoveryGuidance: recoveryPacket.recoveryGuidance,
			omittedReadPaths: recoveryPacket.omittedReadPaths,
			recoveryCommands: recoveryPacket.recoveryCommands,
			sourcePaths,
			nextCommands,
			deferred: turnPacket.deferred,
			resumeTurnOrder,
			budget: turnPacket.budget,
			turns,
			blockedTurns: recoveryPacket.blockedTurns,
		};
	}

	/**
	 * resume 이후 지금 바로 실행할 첫 turn 1개만 packet으로 투영합니다.
	 */
	currentTurnPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillCurrentTurnPacketResult {
		const resumePacket = this.resumePacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const turn = resumePacket.turns[0] ?? null;
		return {
			query: resumePacket.query,
			basis: resumePacket.basis,
			relationMode: resumePacket.relationMode,
			winner: resumePacket.winner,
			ready: turn ? !turn.blockedByBudget : resumePacket.ready,
			applyHint: resumePacket.applyHint,
			recoveryGuidance: resumePacket.recoveryGuidance,
			omittedReadPaths: resumePacket.omittedReadPaths,
			recoveryCommands: resumePacket.recoveryCommands,
			sourcePaths: turn?.sourcePaths ?? [],
			nextCommands: turn?.nextCommands ?? [],
			deferred: resumePacket.deferred,
			activeTurnOrder: turn?.order ?? null,
			budget: resumePacket.budget,
			turn,
			blockedTurns: resumePacket.blockedTurns,
		};
	}

	/**
	 * current turn을 prompt-ready 실행 지시문으로 직렬화합니다.
	 */
	instructionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillInstructionPacketResult {
		const currentTurnPacket = this.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const checklistText = turn?.checklist.length ? turn.checklist.map((item, idx) => `${idx + 1}. ${item}`).join("\n") : "";
		const commandBlock = currentTurnPacket.nextCommands.join("\n");
		const instructionText = turn
			? [
					`Focus on turn ${turn.order} (${turn.phaseKind}${turn.layer !== null ? `:${turn.layer}` : ""}).`,
					`Read skills: ${turn.names.join(", ")}.`,
					turn.objective,
					commandBlock ? `Commands:\n${commandBlock}` : "Commands: -",
					checklistText ? `Checklist:\n${checklistText}` : "Checklist: -",
				].join("\n")
			: "No active turn is available.";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			instructionText,
			checklistText,
			commandBlock,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn을 summary 문장으로 직렬화합니다.
	 */
	summaryPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillSummaryPacketResult {
		const currentTurnPacket = this.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const summaryText = turn
			? `${currentTurnPacket.winner ?? "skill"} turn ${turn.order}: ${turn.objective}. commands=${turn.nextCommands.length}, checklist=${turn.checklist.length}`
			: "No active turn is available.";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			summaryText,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn을 markdown checklist/command 문서로 직렬화합니다.
	 */
	markdownPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillMarkdownPacketResult {
		const instructionPacket = this.instructionPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const checklistItems = instructionPacket.checklistText ? instructionPacket.checklistText.split("\n") : [];
		const markdown = [
			`# ${instructionPacket.winner ?? "skill"} turn ${instructionPacket.activeTurnOrder ?? "-"}`,
			"",
			"## Summary",
			instructionPacket.instructionText,
			"",
			"## Commands",
			instructionPacket.commandBlock || "-",
			"",
			"## Checklist",
			checklistItems.length ? checklistItems.map((item) => `- ${item}`).join("\n") : "-",
			"",
			"## Recovery",
			instructionPacket.recoveryGuidance.length ? instructionPacket.recoveryGuidance.map((item) => `- ${item}`).join("\n") : "-",
		].join("\n");
		return {
			query: instructionPacket.query,
			basis: instructionPacket.basis,
			relationMode: instructionPacket.relationMode,
			winner: instructionPacket.winner,
			ready: instructionPacket.ready,
			applyHint: instructionPacket.applyHint,
			recoveryGuidance: instructionPacket.recoveryGuidance,
			activeTurnOrder: instructionPacket.activeTurnOrder,
			sourcePaths: instructionPacket.sourcePaths,
			nextCommands: instructionPacket.nextCommands,
			markdown,
			commandBlock: instructionPacket.commandBlock,
			checklistItems,
			budget: instructionPacket.budget,
			turn: instructionPacket.turn,
		};
	}

	/**
	 * current turn에서 checklist 전용 packet만 추출합니다.
	 */
	checklistPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillChecklistPacketResult {
		const currentTurnPacket = this.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const checklistItems = turn?.checklist ?? [];
		const checklistText = checklistItems.length ? checklistItems.map((item, idx) => `${idx + 1}. ${item}`).join("\n") : "";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			checklistItems,
			checklistText,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn에서 command 전용 packet만 추출합니다.
	 */
	commandsPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillCommandsPacketResult {
		const currentTurnPacket = this.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			commandBlock: currentTurnPacket.nextCommands.join("\n"),
			budget: currentTurnPacket.budget,
			turn: currentTurnPacket.turn,
		};
	}

	/**
	 * current turn packet을 파일 저장용 payload로 묶습니다.
	 */
	fileReadyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillFileReadyPacketResult {
		const markdownPacket = this.markdownPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const checklistPacket = this.checklistPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const commandsPacket = this.commandsPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const baseName = `${markdownPacket.winner ?? "skill"}-turn-${markdownPacket.activeTurnOrder ?? "current"}`;
		const files = [
			{
				kind: "markdown" as const,
				suggestedPath: `packets/${baseName}.md`,
				mediaType: "text/markdown" as const,
				content: markdownPacket.markdown,
			},
			{
				kind: "checklist" as const,
				suggestedPath: `packets/${baseName}.checklist.md`,
				mediaType: "text/markdown" as const,
				content:
					checklistPacket.checklistItems.length > 0
						? checklistPacket.checklistItems.map((item) => `- ${item}`).join("\n")
						: checklistPacket.checklistText || "-",
			},
			{
				kind: "commands" as const,
				suggestedPath: `packets/${baseName}.commands.txt`,
				mediaType: "text/plain" as const,
				content: commandsPacket.commandBlock || "-",
			},
		];
		return {
			query: markdownPacket.query,
			basis: markdownPacket.basis,
			relationMode: markdownPacket.relationMode,
			winner: markdownPacket.winner,
			ready: markdownPacket.ready,
			applyHint: markdownPacket.applyHint,
			recoveryGuidance: markdownPacket.recoveryGuidance,
			activeTurnOrder: markdownPacket.activeTurnOrder,
			baseName,
			sourcePaths: markdownPacket.sourcePaths,
			nextCommands: markdownPacket.nextCommands,
			files,
			budget: markdownPacket.budget,
			turn: markdownPacket.turn,
		};
	}

	/**
	 * file-ready-packet을 write/apply payload로 투영합니다.
	 */
	applyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillApplyPacketResult {
		const fileReadyPacket = this.fileReadyPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const writes = fileReadyPacket.files.map((file) => ({
			kind: "write" as const,
			sourceKind: file.kind,
			path: file.suggestedPath,
			mediaType: file.mediaType,
			content: file.content,
		}));
		const applyText = writes.length
			? writes.map((write, indexPosition) => `${indexPosition + 1}. write ${write.path} (${write.sourceKind})`).join("\n")
			: "write 작업 없음";
		return {
			query: fileReadyPacket.query,
			basis: fileReadyPacket.basis,
			relationMode: fileReadyPacket.relationMode,
			winner: fileReadyPacket.winner,
			ready: fileReadyPacket.ready,
			applyHint: fileReadyPacket.applyHint,
			recoveryGuidance: fileReadyPacket.recoveryGuidance,
			activeTurnOrder: fileReadyPacket.activeTurnOrder,
			baseName: fileReadyPacket.baseName,
			sourcePaths: fileReadyPacket.sourcePaths,
			nextCommands: fileReadyPacket.nextCommands,
			writes,
			applyText,
			budget: fileReadyPacket.budget,
			turn: fileReadyPacket.turn,
		};
	}

	/**
	 * apply-packet을 실행 가능한 write script payload로 투영합니다.
	 */
	writeScriptPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillWriteScriptPacketResult {
		const applyPacket = this.applyPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const scriptPath = `packets/${applyPacket.baseName}.write.ts`;
		const scriptContent = [
			"/** apply-packet write script 입니다. */",
			'import { mkdir } from "node:fs/promises";',
			'import path from "node:path";',
			"",
			`const writes = ${JSON.stringify(applyPacket.writes, null, 2)} as const;`,
			"",
			"for (const write of writes) {",
			"\tawait mkdir(path.dirname(write.path), { recursive: true });",
			"\tawait Bun.write(write.path, write.content);",
			'\tconsole.log("wrote " + write.path + " (" + write.sourceKind + ")");',
			"}",
		].join("\n");
		const commandBlock = `bun ${scriptPath}`;
		return {
			query: applyPacket.query,
			basis: applyPacket.basis,
			relationMode: applyPacket.relationMode,
			winner: applyPacket.winner,
			ready: applyPacket.ready,
			applyHint: applyPacket.applyHint,
			recoveryGuidance: applyPacket.recoveryGuidance,
			activeTurnOrder: applyPacket.activeTurnOrder,
			baseName: applyPacket.baseName,
			sourcePaths: applyPacket.sourcePaths,
			nextCommands: applyPacket.nextCommands,
			writes: applyPacket.writes,
			scriptPath,
			scriptContent,
			commandBlock,
			budget: applyPacket.budget,
			turn: applyPacket.turn,
		};
	}

	/**
	 * write-script-packet을 script file + run command bundle로 투영합니다.
	 */
	executionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillExecutionPacketResult {
		const writeScriptPacket = this.writeScriptPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const files = [
			{
				kind: "script" as const,
				path: writeScriptPacket.scriptPath,
				mediaType: "text/typescript" as const,
				content: writeScriptPacket.scriptContent,
			},
		];
		const runCommands = [writeScriptPacket.commandBlock].filter(Boolean);
		const executionText = [
			`1. Write script file: ${writeScriptPacket.scriptPath}`,
			`2. Run command: ${writeScriptPacket.commandBlock}`,
			`3. Expect ${writeScriptPacket.writes.length} file write operations.`,
		].join("\n");
		return {
			query: writeScriptPacket.query,
			basis: writeScriptPacket.basis,
			relationMode: writeScriptPacket.relationMode,
			winner: writeScriptPacket.winner,
			ready: writeScriptPacket.ready,
			applyHint: writeScriptPacket.applyHint,
			recoveryGuidance: writeScriptPacket.recoveryGuidance,
			activeTurnOrder: writeScriptPacket.activeTurnOrder,
			baseName: writeScriptPacket.baseName,
			sourcePaths: writeScriptPacket.sourcePaths,
			nextCommands: writeScriptPacket.nextCommands,
			files,
			runCommands,
			executionText,
			budget: writeScriptPacket.budget,
			turn: writeScriptPacket.turn,
		};
	}

	/**
	 * execution-packet을 검증 checklist bundle로 투영합니다.
	 */
	verificationPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillVerificationPacketResult {
		const executionPacket = this.executionPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const verificationItems = executionPacket.turn?.exitCriteria.length
			? executionPacket.turn.exitCriteria
			: ["Run command completed without write errors."];
		const verificationCommands = executionPacket.runCommands;
		const verificationText = [
			"Run:",
			verificationCommands.length ? verificationCommands.join("\n") : "-",
			"",
			"Verify:",
			verificationItems.length ? verificationItems.map((item, indexPosition) => `${indexPosition + 1}. ${item}`).join("\n") : "-",
		].join("\n");
		return {
			query: executionPacket.query,
			basis: executionPacket.basis,
			relationMode: executionPacket.relationMode,
			winner: executionPacket.winner,
			ready: executionPacket.ready,
			applyHint: executionPacket.applyHint,
			recoveryGuidance: executionPacket.recoveryGuidance,
			activeTurnOrder: executionPacket.activeTurnOrder,
			baseName: executionPacket.baseName,
			sourcePaths: executionPacket.sourcePaths,
			nextCommands: executionPacket.nextCommands,
			files: executionPacket.files,
			runCommands: executionPacket.runCommands,
			verificationCommands,
			verificationItems,
			verificationText,
			budget: executionPacket.budget,
			turn: executionPacket.turn,
		};
	}

	/**
	 * compose/graph/validate를 한 snapshot bundle로 계산합니다.
	 */
	packSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode | undefined,
		includeBody: boolean,
		budgetChars: number,
		budgetTokens: number,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillPack {
		const projection = this.relationEngine.projectSkills(index, query, names, relationMode, limit, minScore);
		const validation = this.indexDiagnostics.validateIndex(index);
		const effectiveChars =
			budgetChars > 0 && budgetTokens > 0 ? Math.min(budgetChars, budgetTokens * 4) : Math.max(budgetChars, budgetTokens * 4);
		let usedChars = 0;
		const omittedReadPaths: string[] = [];
		const entries = projection.entries.map((entry) => {
			const skill = index.skills.find((candidate) => candidate.canonicalName === entry.name);
			return { ...entry, body: includeBody ? skill?.bodyText : undefined };
		});
		const selectedBodyPaths = new Set<string>();
		for (const entry of [...entries].sort((left, right) => this.comparePackEntries(left, right))) {
			const nextBodyChars = entry.body?.length ?? 0;
			const canIncludeBody = Boolean(entry.body) && (effectiveChars <= 0 || usedChars + nextBodyChars <= effectiveChars);
			if (canIncludeBody) {
				usedChars += nextBodyChars;
				selectedBodyPaths.add(entry.readPath);
			} else if (entry.body) {
				omittedReadPaths.push(entry.readPath);
			}
		}
		const finalizedEntries = entries.map((entry) =>
			selectedBodyPaths.has(entry.readPath)
				? entry
				: { ...entry, body: undefined, omittedByBudget: Boolean(entry.body) },
		);
		return {
			ok: projection.missing.every((entry) => entry.relation !== "required") && projection.cycles.length === 0 && validation.ok,
			relationMode: projection.relationMode,
			seeds: projection.seeds,
			entries: finalizedEntries,
			readLayers: projection.readLayers,
			applyLayers: projection.applyLayers,
			missing: projection.missing,
			cycles: projection.cycles,
			orphans: projection.orphans,
			omittedReadPaths,
			budget: { requestedChars: budgetChars, requestedTokens: budgetTokens, effectiveChars, usedChars },
			compose: projection.compose,
			graph: projection.graph,
			validate: validation,
			diagnostics: projection.diagnostics,
		};
	}

	/**
	 * pack entry 우선순위 비교자입니다.
	 */
	private comparePackEntries(left: SkillPackEntry, right: SkillPackEntry): number {
		const reasonDelta = composeReasonPriority(right.reason) - composeReasonPriority(left.reason);
		if (reasonDelta !== 0) {
			return reasonDelta;
		}
		const readLayerLeft = left.readLayer ?? Number.MAX_SAFE_INTEGER;
		const readLayerRight = right.readLayer ?? Number.MAX_SAFE_INTEGER;
		if (readLayerLeft !== readLayerRight) {
			return readLayerLeft - readLayerRight;
		}
		if (left.depth !== right.depth) {
			return left.depth - right.depth;
		}
		return left.name.localeCompare(right.name);
	}


}
