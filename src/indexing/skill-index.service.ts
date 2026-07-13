import path from "node:path";
import type {
	IndexArtifacts,
	IndexedStats,
	RawSkill,
	SearchHit,
	SkillApplyPacketResult,
	SkillAuditDegreeSummary,
	SkillAuditIssue,
	SkillAuditReport,
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
	SkillValidationIssue,
	SkillValidationReport,
	SkillVerificationPacketResult,
	SkillWriteScriptPacketResult,
} from "../shared";
import { composeReasonPriority } from "./compose-reason-priority";
import { dedupeDuplicateAliasEntries } from "./dedupe-duplicate-alias-entries";
import type { SkillIndexInterface } from "./skill-index.interface";
import type { SkillRelationEngine } from "./skill-relation-engine";
import type { SkillSearchEngine } from "./skill-search-engine";

/** skill-registry 인덱싱/검색 구현체입니다. */
export class SkillIndexService implements SkillIndexInterface {
	constructor(
		private readonly searchEngine: SkillSearchEngine,
		private readonly relationEngine: SkillRelationEngine,
	) {}

	/**
	 * search와 pack 근거를 합친 explain 결과를 계산합니다.
	 */
	explainSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillExplainResult {
		const hits = query ? this.searchEngine.searchByBm25(index, query, limit, minScore) : [];
		const hitByName = new Map(hits.map((hit) => [hit.skill.canonicalName, hit] as const));
		const pack = this.packSkills(index, query, names, relationMode, false, 0, 0, limit, minScore);

		return {
			query,
			relationMode: pack.relationMode,
			seeds: pack.seeds,
			entries: pack.entries.map((entry) => {
				const hit = hitByName.get(entry.name);
				return {
					name: entry.name,
					readPath: entry.readPath,
					path: entry.path,
					title: entry.title,
					category: entry.category,
					aliases: entry.aliases,
					reason: entry.reason,
					via: entry.via,
					depth: entry.depth,
					readLayer: entry.readLayer,
					applyLayer: entry.applyLayer,
					score: hit?.score,
					coverage: hit?.coverage,
					matchedTerms: hit?.matchedTerms ?? [],
					matchPreview: entry.preview,
				} satisfies SkillExplainEntry;
			}),
			missing: pack.missing,
			cycles: pack.cycles,
			diagnostics: pack.diagnostics,
		};
	}

	/**
	 * query 또는 names 후보를 side-by-side 비교합니다.
	 */
	compareSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillCompareResult {
		const summaryLimit = Math.max(2, Math.min(limit, 8));
		const pool = this.collectRankedCandidates(index, query, names, summaryLimit, minScore);
		const { basis, hitByName } = pool;
		const candidates = pool.candidates.slice(0, summaryLimit);
		const candidateEntries = candidates.map((skill) => {
			const hit = hitByName.get(skill.canonicalName);
			return {
				name: skill.canonicalName,
				readPath: `skill://${skill.canonicalName}`,
				path: skill.path,
				title: skill.title,
				category: skill.category,
				aliases: skill.aliases,
				score: hit?.score,
				coverage: hit?.coverage,
				matchedTerms: hit?.matchedTerms ?? [],
				requires: skill.requires,
				recommends: skill.recommends,
				preview: skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " "),
			} satisfies SkillCompareEntry;
		});
		const resolvePairRelation = (from: RawSkill, to: RawSkill): SkillCompareRelation | undefined => {
			const targetNames = new Set([to.canonicalName, ...to.aliases]);
			if (from.requires.some((name) => targetNames.has(name))) {
				return "requires";
			}
			if (from.recommends.some((name) => targetNames.has(name))) {
				return "recommends";
			}
			return undefined;
		};
		const intersect = (left: string[], right: string[]): string[] => {
			const rightSet = new Set(right);
			return [...new Set(left.filter((item) => rightSet.has(item)))].sort();
		};
		const subtract = (left: string[], right: string[]): string[] => {
			const rightSet = new Set(right);
			return [...new Set(left.filter((item) => !rightSet.has(item)))].sort();
		};
		const pairs: SkillComparePair[] = [];
		for (let indexPosition = 0; indexPosition < candidates.length; indexPosition += 1) {
			const leftSkill = candidates[indexPosition];
			if (!leftSkill) {
				continue;
			}
			const leftEntry = candidateEntries[indexPosition];
			if (!leftEntry) {
				continue;
			}
			for (let rightIndexPosition = indexPosition + 1; rightIndexPosition < candidates.length; rightIndexPosition += 1) {
				const rightSkill = candidates[rightIndexPosition];
				const rightEntry = candidateEntries[rightIndexPosition];
				if (!rightSkill || !rightEntry) {
					continue;
				}
				pairs.push({
					left: leftSkill.canonicalName,
					right: rightSkill.canonicalName,
					sameCategory: leftSkill.category === rightSkill.category,
					sharedAliases: intersect(leftSkill.aliases, rightSkill.aliases),
					sharedMatchedTerms: intersect(leftEntry.matchedTerms, rightEntry.matchedTerms),
					leftOnlyMatchedTerms: subtract(leftEntry.matchedTerms, rightEntry.matchedTerms),
					rightOnlyMatchedTerms: subtract(rightEntry.matchedTerms, leftEntry.matchedTerms),
					sharedRequires: intersect(leftSkill.requires, rightSkill.requires),
					sharedRecommends: intersect(leftSkill.recommends, rightSkill.recommends),
					leftToRight: resolvePairRelation(leftSkill, rightSkill),
					rightToLeft: resolvePairRelation(rightSkill, leftSkill),
					scoreDelta:
						leftEntry.score !== undefined || rightEntry.score !== undefined
							? Number(((leftEntry.score ?? 0) - (rightEntry.score ?? 0)).toFixed(3))
							: undefined,
				});
			}
		}
		return {
			query,
			basis,
			entries: candidateEntries,
			pairs,
		};
	}

	/**
	 * query 또는 names 후보 중 첫 read winner를 결정합니다.
	 */
	decideSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillDecideResult {
		const summaryLimit = Math.max(1, limit);
		const candidateSearchLimit = limit;
		const pool = this.collectRankedCandidates(index, query, names, candidateSearchLimit, minScore);
		const { basis, namedSkills, hitByName } = pool;
		const candidates = pool.candidates;
		const explicitNameSet = new Set(namedSkills.map((skill) => skill.canonicalName));
		const candidateNameSet = new Set(candidates.map((skill) => skill.canonicalName));
		const allSkillNameSet = new Set(index.skills.map((skill) => skill.canonicalName));
		const resolveCandidateNames = (targets: string[]): string[] =>
			[
				...new Set(targets.map((name) => index.aliasToCanonical.get(name) ?? name).filter((name) => candidateNameSet.has(name))),
			].sort();
		const resolveUnresolvedRequires = (targets: string[]): string[] =>
			[
				...new Set(
					targets.filter((name) => {
						const canonical = index.aliasToCanonical.get(name) ?? name;
						return !allSkillNameSet.has(canonical);
					}),
				),
			].sort();
		const orderedAll = candidates
			.map((skill) => {
				const hit = hitByName.get(skill.canonicalName);
				const explicitName = explicitNameSet.has(skill.canonicalName);
				const peerRequiredBy = candidates
					.filter(
						(other) =>
							other.canonicalName !== skill.canonicalName &&
							other.requires.some((name) => (index.aliasToCanonical.get(name) ?? name) === skill.canonicalName),
					)
					.map((other) => other.canonicalName)
					.sort();
				const peerRecommendedBy = candidates
					.filter(
						(other) =>
							other.canonicalName !== skill.canonicalName &&
							other.recommends.some((name) => (index.aliasToCanonical.get(name) ?? name) === skill.canonicalName),
					)
					.map((other) => other.canonicalName)
					.sort();
				const requiredPeers = resolveCandidateNames(skill.requires).filter((name) => name !== skill.canonicalName);
				const unresolvedRequires = resolveUnresolvedRequires(skill.requires);
				const queryScore = hit?.score;
				const queryCoverage = hit?.coverage;
				const score =
					(queryScore ?? 0) +
					(queryCoverage ?? 0) * 0.25 +
					(explicitName ? 0.5 : 0) +
					peerRequiredBy.length * 4 +
					peerRecommendedBy.length * 2 -
					requiredPeers.length * 2 -
					unresolvedRequires.length * 4;
				const reasons = [
					queryScore !== undefined ? `query score ${queryScore.toFixed(3)} coverage ${queryCoverage ?? 0}` : "",
					explicitName ? "explicit names input" : "",
					peerRequiredBy.length ? `required by peers: ${peerRequiredBy.join(", ")}` : "",
					peerRecommendedBy.length ? `recommended by peers: ${peerRecommendedBy.join(", ")}` : "",
					requiredPeers.length ? `requires peers first: ${requiredPeers.join(", ")}` : "",
					unresolvedRequires.length ? `unresolved requires: ${unresolvedRequires.join(", ")}` : "",
				].filter(Boolean);
				return {
					name: skill.canonicalName,
					readPath: `skill://${skill.canonicalName}`,
					path: skill.path,
					title: skill.title,
					category: skill.category,
					aliases: skill.aliases,
					score: Number(score.toFixed(3)),
					queryScore: queryScore !== undefined ? Number(queryScore.toFixed(3)) : undefined,
					queryCoverage,
					explicitName,
					peerRequiredBy,
					peerRecommendedBy,
					requiredPeers,
					unresolvedRequires,
					reasons,
					preview: skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " "),
				} satisfies SkillDecideEntry;
			})
			.sort((left, right) => {
				if (right.score !== left.score) {
					return right.score - left.score;
				}
				if ((right.queryScore ?? 0) !== (left.queryScore ?? 0)) {
					return (right.queryScore ?? 0) - (left.queryScore ?? 0);
				}
				if (right.peerRequiredBy.length !== left.peerRequiredBy.length) {
					return right.peerRequiredBy.length - left.peerRequiredBy.length;
				}
				return left.name.localeCompare(right.name);
			});
		return {
			query,
			basis,
			winner: orderedAll[0]?.name ?? null,
			ordered: orderedAll.slice(0, summaryLimit),
		};
	}

	/**
	 * winner를 시작점으로 후속 read sequence를 계획합니다.
	 */
	planSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillPlanResult {
		const summaryLimit = Math.max(1, limit);
		const isLarge = limit >= index.settings.maxTopK;
		const decideLimit = isLarge ? index.skills.length : Math.min(Math.max(summaryLimit * 5, 25), index.skills.length);
		const decision = this.decideSkills(index, query, names, decideLimit, minScore);
		const winner = decision.winner;
		if (!winner) {
			return {
				query,
				basis: decision.basis,
				relationMode,
				winner: null,
				steps: [],
				deferred: [],
			};
		}
		const orderedByName = new Map(decision.ordered.map((entry) => [entry.name, entry] as const));
		const orderIndexByName = new Map(decision.ordered.map((entry, indexPosition) => [entry.name, indexPosition] as const));
		const steps: SkillPlanStep[] = [];
		const usedNames = new Set<string>();
		const addStep = (
			entry: SkillDecideEntry | undefined,
			reason: SkillPlanStep["reason"],
			phase: SkillPlanStep["phase"],
			via?: string,
		): void => {
			if (!entry || usedNames.has(entry.name)) {
				return;
			}
			usedNames.add(entry.name);
			steps.push({
				order: steps.length + 1,
				phase,
				name: entry.name,
				readPath: entry.readPath,
				path: entry.path,
				title: entry.title,
				category: entry.category,
				reason,
				via,
				score: entry.score,
				queryScore: entry.queryScore,
				preview: entry.preview,
			});
		};
		const sortByDecisionOrder = (namesToSort: string[]): string[] =>
			[...namesToSort].sort((left, right) => {
				const leftIndex = orderIndexByName.get(left) ?? Number.MAX_SAFE_INTEGER;
				const rightIndex = orderIndexByName.get(right) ?? Number.MAX_SAFE_INTEGER;
				if (leftIndex !== rightIndex) {
					return leftIndex - rightIndex;
				}
				return left.localeCompare(right);
			});
		const winnerEntry = orderedByName.get(winner);
		addStep(winnerEntry, "winner", "first");
		for (const candidateName of sortByDecisionOrder(winnerEntry?.peerRequiredBy ?? [])) {
			addStep(orderedByName.get(candidateName), "unblocks-required-peer", "next", winner);
		}
		if (relationMode === "full") {
			for (const candidateName of sortByDecisionOrder(winnerEntry?.peerRecommendedBy ?? [])) {
				addStep(orderedByName.get(candidateName), "unblocks-recommended-peer", "later", winner);
			}
		}
		for (const entry of decision.ordered) {
			if (steps.length >= summaryLimit) {
				break;
			}
			addStep(entry, "alternative", "later");
		}
		const visibleSteps = steps.slice(0, summaryLimit).map((entry, indexPosition) => ({
			...entry,
			order: indexPosition + 1,
		}));
		const visibleNames = new Set(visibleSteps.map((entry) => entry.name));
		return {
			query,
			basis: decision.basis,
			relationMode,
			winner,
			steps: visibleSteps,
			deferred: decision.ordered.map((entry) => entry.name).filter((name) => !visibleNames.has(name)),
		};
	}

	/**
	 * plan 결과를 layer-aware itinerary로 투영합니다.
	 */
	routeSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillRouteResult {
		const summaryLimit = Math.max(1, limit);
		const plan = this.planSkills(index, query, names, relationMode, summaryLimit, minScore);
		if (!plan.winner) {
			return {
				query,
				basis: plan.basis,
				relationMode,
				winner: null,
				phases: [],
				deferred: [],
			};
		}
		const pack = this.packSkills(index, query, names, relationMode, false, 0, 0, Math.max(summaryLimit, plan.steps.length), minScore);
		const entryByName = new Map(pack.entries.map((entry) => [entry.name, entry] as const));
		const phases: SkillRoutePhase[] = [];
		for (const step of plan.steps.slice(0, summaryLimit)) {
			const packEntry = entryByName.get(step.name);
			const kind: SkillRoutePhase["kind"] =
				step.reason === "winner"
					? "start"
					: step.reason === "unblocks-required-peer"
						? "read-layer"
						: step.reason === "unblocks-recommended-peer"
							? "apply-layer"
							: "fallback";
			const layer =
				kind === "read-layer"
					? (packEntry?.readLayer ?? null)
					: kind === "apply-layer"
						? (packEntry?.applyLayer ?? packEntry?.readLayer ?? null)
						: null;
			const rationale =
				kind === "start"
					? ["decide winner"]
					: kind === "read-layer"
						? [`pack read layer ${layer ?? "-"}`]
						: kind === "apply-layer"
							? [`pack apply layer ${layer ?? "-"}`]
							: ["remaining planned steps"];
			const lastPhase = phases.at(-1);
			if (lastPhase && lastPhase.kind === kind && lastPhase.layer === layer) {
				lastPhase.names.push(step.name);
				lastPhase.readPaths.push(step.readPath);
				for (const item of rationale) {
					if (!lastPhase.rationale.includes(item)) {
						lastPhase.rationale.push(item);
					}
				}
				continue;
			}
			phases.push({
				order: phases.length + 1,
				kind,
				layer,
				names: [step.name],
				readPaths: [step.readPath],
				rationale,
			});
		}
		return {
			query,
			basis: plan.basis,
			relationMode,
			winner: plan.winner,
			phases,
			deferred: [...plan.steps.slice(summaryLimit).map((step) => step.name), ...plan.deferred].filter(
				(name, indexPosition, collection) => collection.indexOf(name) === indexPosition,
			),
		};
	}

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
		const route = this.routeSkills(index, query, names, relationMode, summaryLimit, minScore);
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
	 * query와 seed 인접 relation 기준 후속 추천 skill을 계산합니다.
	 */
	recommendSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillRecommendResult {
		const summaryLimit = Math.max(1, limit);
		const seeds = this.searchEngine.resolveSeedSkills(index, query, names, summaryLimit, minScore);
		const seedNames = new Set(seeds.map((skill) => skill.canonicalName));
		const seedCategories = new Map<string, string[]>();
		for (const seed of seeds) {
			const existing = seedCategories.get(seed.category) ?? [];
			existing.push(seed.canonicalName);
			seedCategories.set(seed.category, existing);
		}
		const queryHits = query ? this.searchEngine.searchByBm25(index, query, Math.max(summaryLimit * 4, summaryLimit), minScore) : [];
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const edges = this.relationEngine.buildRelationGraphEdges(index);
		const outboundByCanonical = this.relationEngine.groupEdgesByCanonical(edges, "from");
		const inboundByCanonical = this.relationEngine.groupEdgesByCanonical(edges, "to");
		type MutableRecommendEntry = {
			skill: RawSkill;
			score: number;
			queryScore?: number;
			queryCoverage?: number;
			matchedTermSet: Set<string>;
			outboundSignals: SkillRecommendRelationSignal[];
			outboundKeys: Set<string>;
			inboundSignals: SkillRecommendRelationSignal[];
			inboundKeys: Set<string>;
			sharedCategorySeedSet: Set<string>;
		};
		const recommendationByName = new Map<string, MutableRecommendEntry>();
		const ensureRecommendation = (skill: RawSkill): MutableRecommendEntry | null => {
			if (seedNames.has(skill.canonicalName)) {
				return null;
			}
			const existing = recommendationByName.get(skill.canonicalName);
			if (existing) {
				return existing;
			}
			const created: MutableRecommendEntry = {
				skill,
				score: 0,
				matchedTermSet: new Set<string>(),
				outboundSignals: [],
				outboundKeys: new Set<string>(),
				inboundSignals: [],
				inboundKeys: new Set<string>(),
				sharedCategorySeedSet: new Set<string>(),
			};
			recommendationByName.set(skill.canonicalName, created);
			return created;
		};
		for (const hit of queryHits) {
			const recommendation = ensureRecommendation(hit.skill);
			if (!recommendation) {
				continue;
			}
			recommendation.score += hit.score + hit.coverage * 0.25;
			recommendation.queryScore = Math.max(recommendation.queryScore ?? 0, hit.score);
			recommendation.queryCoverage = Math.max(recommendation.queryCoverage ?? 0, hit.coverage);
			for (const term of hit.matchedTerms) {
				recommendation.matchedTermSet.add(term);
			}
		}
		const canUseRecommendedRelation = relationMode === "full";
		for (const seed of seeds) {
			for (const edge of outboundByCanonical.get(seed.canonicalName) ?? []) {
				if (edge.relation === "recommends" && !canUseRecommendedRelation) {
					continue;
				}
				if (!edge.to || seedNames.has(edge.to)) {
					continue;
				}
				const relatedSkill = skillByName.get(edge.to);
				if (!relatedSkill) {
					continue;
				}
				const recommendation = ensureRecommendation(relatedSkill);
				if (!recommendation) {
					continue;
				}
				const relation = edge.relation === "requires" ? "required" : "recommended";
				const signalKey = `${seed.canonicalName}:${relation}`;
				if (recommendation.outboundKeys.has(signalKey)) {
					continue;
				}
				recommendation.outboundKeys.add(signalKey);
				recommendation.outboundSignals.push({
					via: seed.canonicalName,
					relation,
				});
				recommendation.score += relation === "required" ? 4 : 2;
			}
			for (const edge of inboundByCanonical.get(seed.canonicalName) ?? []) {
				if (edge.relation === "recommends" && !canUseRecommendedRelation) {
					continue;
				}
				const sourceName = edge.from;
				if (!sourceName || seedNames.has(sourceName)) {
					continue;
				}
				const relatedSkill = skillByName.get(sourceName);
				if (!relatedSkill) {
					continue;
				}
				const recommendation = ensureRecommendation(relatedSkill);
				if (!recommendation) {
					continue;
				}
				const relation = edge.relation === "requires" ? "required" : "recommended";
				const signalKey = `${seed.canonicalName}:${relation}`;
				if (recommendation.inboundKeys.has(signalKey)) {
					continue;
				}
				recommendation.inboundKeys.add(signalKey);
				recommendation.inboundSignals.push({
					via: seed.canonicalName,
					relation,
				});
				recommendation.score += relation === "required" ? 1.5 : 0.75;
			}
		}
		for (const skill of index.skills) {
			if (seedNames.has(skill.canonicalName)) {
				continue;
			}
			const sameCategorySeeds = seedCategories.get(skill.category) ?? [];
			if (sameCategorySeeds.length === 0) {
				continue;
			}
			const recommendation = ensureRecommendation(skill);
			if (!recommendation) {
				continue;
			}
			let addedCount = 0;
			for (const seedName of sameCategorySeeds) {
				if (recommendation.sharedCategorySeedSet.has(seedName)) {
					continue;
				}
				recommendation.sharedCategorySeedSet.add(seedName);
				addedCount += 1;
			}
			recommendation.score += addedCount * 0.5;
		}
		return {
			query,
			relationMode,
			seeds: seeds.map((skill) => skill.canonicalName),
			recommendations: Array.from(recommendationByName.values())
				.map(
					(entry) =>
						({
							name: entry.skill.canonicalName,
							readPath: `skill://${entry.skill.canonicalName}`,
							path: entry.skill.path,
							title: entry.skill.title,
							category: entry.skill.category,
							aliases: entry.skill.aliases,
							score: Number(entry.score.toFixed(3)),
							queryScore: entry.queryScore !== undefined ? Number(entry.queryScore.toFixed(3)) : undefined,
							queryCoverage: entry.queryCoverage,
							matchedTerms: [...entry.matchedTermSet].sort(),
							outboundSignals: [...entry.outboundSignals].sort((left, right) => {
								if (left.relation !== right.relation) {
									return left.relation.localeCompare(right.relation);
								}
								return left.via.localeCompare(right.via);
							}),
							inboundSignals: [...entry.inboundSignals].sort((left, right) => {
								if (left.relation !== right.relation) {
									return left.relation.localeCompare(right.relation);
								}
								return left.via.localeCompare(right.via);
							}),
							sharedCategorySeeds: [...entry.sharedCategorySeedSet].sort(),
							preview: entry.skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " "),
						}) satisfies SkillRecommendEntry,
				)
				.sort((left, right) => {
					if (right.score !== left.score) {
						return right.score - left.score;
					}
					if (right.outboundSignals.length !== left.outboundSignals.length) {
						return right.outboundSignals.length - left.outboundSignals.length;
					}
					if ((right.queryScore ?? 0) !== (left.queryScore ?? 0)) {
						return (right.queryScore ?? 0) - (left.queryScore ?? 0);
					}
					return left.name.localeCompare(right.name);
				})
				.slice(0, summaryLimit),
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
		const composePlan = this.relationEngine.composeSkills(index, query, names, limit, relationMode, minScore);
		const graph = this.relationEngine.graphSkills(index, query, names, "outbound", limit, minScore);
		const allowedNodeNames = new Set(composePlan.entries.map((entry) => entry.skill.canonicalName));
		const filteredEdges = graph.edges.filter((edge) => allowedNodeNames.has(edge.from) && (!edge.to || allowedNodeNames.has(edge.to)));
		const filteredResolvedEdges = filteredEdges.filter((edge): edge is SkillRelationGraphEdge & { to: string } => Boolean(edge.to));
		const filteredLayers = this.relationEngine.buildRelationGraphLayers(allowedNodeNames, filteredResolvedEdges);
		const filteredOrphans = Array.from(allowedNodeNames)
			.filter((nodeName) => {
				const outbound = filteredEdges.some((edge) => edge.from === nodeName);
				const inbound = filteredResolvedEdges.some((edge) => edge.to === nodeName);
				return !outbound && !inbound;
			})
			.sort();
		const filteredGraph: SkillRelationGraph = {
			...graph,
			nodes: graph.nodes.filter((node) => allowedNodeNames.has(node.name)),
			edges: filteredEdges,
			readLayers: filteredLayers.readLayers,
			applyLayers: filteredLayers.applyLayers,
			cycles: this.relationEngine.collectRelationCycles(index, filteredResolvedEdges, allowedNodeNames),
			orphans: filteredOrphans,
			missing: composePlan.missing,
		};
		const validation = this.validateIndex(index);
		const composeEntryByName = new Map(composePlan.entries.map((entry) => [entry.skill.canonicalName, entry] as const));
		const readLayerByName = new Map<string, number>();
		filteredGraph.readLayers.forEach((layer, layerIndex) => {
			for (const nodeName of layer) {
				readLayerByName.set(nodeName, layerIndex);
			}
		});
		const applyLayerByName = new Map<string, number>();
		filteredGraph.applyLayers.forEach((layer, layerIndex) => {
			for (const nodeName of layer) {
				applyLayerByName.set(nodeName, layerIndex);
			}
		});

		const effectiveChars =
			budgetChars > 0 && budgetTokens > 0 ? Math.min(budgetChars, budgetTokens * 4) : Math.max(budgetChars, budgetTokens * 4);
		let usedChars = 0;
		const omittedReadPaths: string[] = [];
		const entries = filteredGraph.nodes
			.map((node): SkillPackEntry | null => {
				const composeEntry = composeEntryByName.get(node.name);
				const skill = composeEntry?.skill ?? index.skills.find((entry) => entry.canonicalName === node.name);
				if (!skill) {
					return null;
				}
				const preview = skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " ");
				const body = includeBody ? skill.bodyText : undefined;
				const entry: SkillPackEntry = {
					name: skill.canonicalName,
					path: skill.path,
					title: skill.title,
					category: skill.category,
					aliases: skill.aliases,
					requires: skill.requires,
					recommends: skill.recommends,
					reason: composeEntry?.reason ?? "seed",
					via: composeEntry?.via ?? undefined,
					depth: composeEntry?.depth ?? 0,
					readLayer: readLayerByName.get(skill.canonicalName) ?? null,
					applyLayer: applyLayerByName.get(skill.canonicalName) ?? null,
					preview,
					body,
					readPath: `skill://${skill.canonicalName}`,
					omittedByBudget: false,
				};
				return entry;
			})
			.filter((entry): entry is SkillPackEntry => entry !== null);

		const selectedBodyPaths = new Set<string>();
		for (const entry of [...entries].sort((left, right) => this.comparePackEntries(left, right))) {
			const nextBodyChars = entry.body?.length ?? 0;
			const canIncludeBody = Boolean(entry.body) && (effectiveChars <= 0 || usedChars + nextBodyChars <= effectiveChars);
			if (canIncludeBody) {
				usedChars += nextBodyChars;
				selectedBodyPaths.add(entry.readPath);
				continue;
			}
			if (entry.body) {
				omittedReadPaths.push(entry.readPath);
			}
		}

		const finalizedEntries = entries.map((entry) =>
			selectedBodyPaths.has(entry.readPath)
				? entry
				: {
						...entry,
						body: undefined,
						omittedByBudget: Boolean(entry.body),
					},
		);

		return {
			ok: composePlan.missing.every((entry) => entry.relation !== "required") && filteredGraph.cycles.length === 0 && validation.ok,
			relationMode: composePlan.relationMode,
			seeds: composePlan.seeds.map((skill) => skill.canonicalName),
			entries: finalizedEntries,
			readLayers: filteredGraph.readLayers,
			applyLayers: filteredGraph.applyLayers,
			missing: composePlan.missing,
			cycles: filteredGraph.cycles,
			orphans: filteredGraph.orphans,
			omittedReadPaths,
			budget: {
				requestedChars: budgetChars,
				requestedTokens: budgetTokens,
				effectiveChars,
				usedChars,
			},
			compose: composePlan,
			graph: filteredGraph,
			validate: validation,
			diagnostics: filteredGraph.diagnostics,
		};
	}

	/**
	 * 인덱스 기반 validation issue를 계산합니다.
	 */
	validateIndex(index: IndexArtifacts): SkillValidationReport {
		const issues: SkillValidationIssue[] = [];

		for (const malformed of index.stats.malformedFiles) {
			issues.push({
				severity: "error",
				kind: "malformed-frontmatter",
				message: `Malformed SKILL.md: ${malformed.reason}`,
				path: malformed.path,
			});
		}

		for (const duplicate of index.stats.duplicateCanonicalEntries) {
			issues.push({
				severity: "error",
				kind: "duplicate-canonical-name",
				message: `Duplicate canonical name '${duplicate.canonicalName}' keeps ${duplicate.keptPath} and drops ${duplicate.droppedPath}.`,
				skillName: duplicate.canonicalName,
				path: duplicate.droppedPath,
			});
		}

		for (const duplicate of dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries)) {
			issues.push({
				severity: "warning",
				kind: "duplicate-alias",
				message: `Alias '${duplicate.alias}' resolves to '${duplicate.canonicalName}' and conflicts with '${duplicate.conflictingCanonicalName}'.`,
				skillName: duplicate.canonicalName,
				target: duplicate.conflictingCanonicalName,
			});
		}

		for (const skill of index.skills) {
			for (const target of skill.requires) {
				if (index.aliasToCanonical.has(target)) {
					continue;
				}
				issues.push({
					severity: "error",
					kind: "broken-required-relation",
					message: `Required relation '${target}' from '${skill.canonicalName}' does not resolve.`,
					skillName: skill.canonicalName,
					via: skill.canonicalName,
					target,
					path: skill.path,
				});
			}

			for (const target of skill.recommends) {
				if (index.aliasToCanonical.has(target)) {
					continue;
				}
				issues.push({
					severity: "warning",
					kind: "broken-recommended-relation",
					message: `Recommended relation '${target}' from '${skill.canonicalName}' does not resolve.`,
					skillName: skill.canonicalName,
					via: skill.canonicalName,
					target,
					path: skill.path,
				});
			}
		}

		const errors = issues.filter((issue) => issue.severity === "error").length;
		const warnings = issues.length - errors;

		return {
			ok: errors === 0,
			counts: {
				errors,
				warnings,
			},
			issues,
		};
	}

	/**
	 * validation/graph/degree summary를 묶어 corpus health audit를 계산합니다.
	 */
	auditSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit = Math.min(index.settings.maxTopK, 10),
		minScore = 0,
	): SkillAuditReport {
		const summaryLimit = Math.max(1, Math.min(limit, 20));
		const validate = this.validateIndex(index);
		const cycleGraph = this.relationEngine.graphSkills(index, query, names, "cycles", summaryLimit, minScore);
		const orphanGraph = this.relationEngine.graphSkills(index, query, names, "orphans", summaryLimit, minScore);
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const issues: SkillAuditIssue[] = [
			...validate.issues.map((issue) => ({
				severity: issue.severity,
				kind: "validation" as const,
				message: issue.message,
				skillName: issue.skillName,
				path: issue.path,
				sourceKind: issue.kind,
			})),
			...cycleGraph.cycles.map((cycle) => ({
				severity: "warning" as const,
				kind: "cycle" as const,
				message: `Relation cycle detected: ${[...cycle, cycle[0]].join(" -> ")}`,
				skillName: cycle[0],
				path: skillByName.get(cycle[0])?.path,
				relatedSkills: cycle,
			})),
			...orphanGraph.orphans.map((name) => ({
				severity: "info" as const,
				kind: "orphan" as const,
				message: `Orphan skill '${name}' has no inbound or outbound relations.`,
				skillName: name,
				path: skillByName.get(name)?.path,
				relatedSkills: [name],
			})),
		].sort((left, right) => {
			const severityDelta = this.auditIssueSeverityPriority(right.severity) - this.auditIssueSeverityPriority(left.severity);
			if (severityDelta !== 0) {
				return severityDelta;
			}
			if (left.kind !== right.kind) {
				return left.kind.localeCompare(right.kind);
			}
			if ((left.skillName ?? "") !== (right.skillName ?? "")) {
				return (left.skillName ?? "").localeCompare(right.skillName ?? "");
			}
			return left.message.localeCompare(right.message);
		});
		const counts = issues.reduce(
			(summary, issue) => {
				if (issue.severity === "error") {
					summary.errors += 1;
				} else if (issue.severity === "warning") {
					summary.warnings += 1;
				} else {
					summary.info += 1;
				}
				return summary;
			},
			{ errors: 0, warnings: 0, info: 0 },
		);
		const unresolvedRelations = validate.issues.filter(
			(issue) => issue.kind === "broken-required-relation" || issue.kind === "broken-recommended-relation",
		).length;
		const degreeSummary = this.buildAuditDegreeSummaries(index, summaryLimit);
		return {
			ok: counts.errors === 0 && cycleGraph.cycles.length === 0,
			counts: {
				totalSkills: index.docCount,
				errors: counts.errors,
				warnings: counts.warnings,
				info: counts.info,
				cycles: cycleGraph.cycles.length,
				orphans: orphanGraph.orphans.length,
				unresolvedRelations,
			},
			issues,
			topInbound: degreeSummary.topInbound,
			topOutbound: degreeSummary.topOutbound,
			validate,
			cycles: cycleGraph.cycles,
			orphans: orphanGraph.orphans,
		};
	}

	/**
	 * compare/decide 공통 candidate pool을 stable order로 수집합니다.
	 */
	private collectRankedCandidates(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit: number,
		minScore: number,
	): {
		basis: "query" | "names" | "query+names";
		namedSkills: RawSkill[];
		queryHits: SearchHit[];
		hitByName: Map<string, SearchHit>;
		candidates: RawSkill[];
	} {
		const namedSkills = this.searchEngine.findSkillsByNames(index, names);
		const queryHits = query ? this.searchEngine.searchByBm25(index, query, limit, minScore) : [];
		const hitByName = new Map(queryHits.map((hit) => [hit.skill.canonicalName, hit] as const));
		const candidates = [...namedSkills, ...queryHits.map((hit) => hit.skill)].filter(
			(skill, indexPosition, collection) =>
				collection.findIndex((entry) => entry.canonicalName === skill.canonicalName) === indexPosition,
		);
		return {
			basis: query && names.length > 0 ? "query+names" : names.length > 0 ? "names" : "query",
			namedSkills,
			queryHits,
			hitByName,
			candidates,
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

	/**
	 * audit issue 심각도 우선순위를 반환합니다.
	 */
	private auditIssueSeverityPriority(severity: SkillAuditIssue["severity"]): number {
		switch (severity) {
			case "error":
				return 3;
			case "warning":
				return 2;
			case "info":
				return 1;
			default:
				return 0;
		}
	}

	/**
	 * relation degree 기준 상위 inbound/outbound skill을 계산합니다.
	 */
	private buildAuditDegreeSummaries(
		index: IndexArtifacts,
		limit: number,
	): {
		topInbound: SkillAuditDegreeSummary[];
		topOutbound: SkillAuditDegreeSummary[];
	} {
		const summaryByName = new Map(
			index.skills.map(
				(skill) =>
					[
						skill.canonicalName,
						{
							name: skill.canonicalName,
							path: skill.path,
							inbound: 0,
							outbound: 0,
							requires: 0,
							recommends: 0,
						} satisfies SkillAuditDegreeSummary,
					] as const,
			),
		);
		for (const edge of this.relationEngine.buildRelationGraphEdges(index)) {
			const sourceSummary = summaryByName.get(edge.from);
			if (sourceSummary) {
				sourceSummary.outbound += 1;
				if (edge.relation === "requires") {
					sourceSummary.requires += 1;
				} else {
					sourceSummary.recommends += 1;
				}
			}
			if (!edge.to) {
				continue;
			}
			const targetSummary = summaryByName.get(edge.to);
			if (!targetSummary) {
				continue;
			}
			targetSummary.inbound += 1;
		}
		const summaries = Array.from(summaryByName.values());
		return {
			topInbound: summaries
				.filter((entry) => entry.inbound > 0)
				.sort((left, right) => {
					if (left.inbound !== right.inbound) {
						return right.inbound - left.inbound;
					}
					if (left.outbound !== right.outbound) {
						return right.outbound - left.outbound;
					}
					return left.name.localeCompare(right.name);
				})
				.slice(0, limit),
			topOutbound: summaries
				.filter((entry) => entry.outbound > 0)
				.sort((left, right) => {
					if (left.outbound !== right.outbound) {
						return right.outbound - left.outbound;
					}
					if (left.inbound !== right.inbound) {
						return right.inbound - left.inbound;
					}
					return left.name.localeCompare(right.name);
				})
				.slice(0, limit),
		};
	}


}
