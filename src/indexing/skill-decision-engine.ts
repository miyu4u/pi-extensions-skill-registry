import type {
	IndexArtifacts,
	RawSkill,
	SearchHit,
	SkillCompareEntry,
	SkillComparePair,
	SkillCompareRelation,
	SkillCompareResult,
	SkillDecideEntry,
	SkillDecideResult,
	SkillExplainEntry,
	SkillExplainResult,
	SkillPlanResult,
	SkillPlanStep,
	SkillRecommendEntry,
	SkillRecommendRelationSignal,
	SkillRecommendResult,
	SkillRelationMode,
	SkillRoutePhase,
	SkillRouteResult,
} from "../shared";
import type { SkillRelationEngine } from "./skill-relation-engine";
import type { SkillSearchEngine } from "./skill-search-engine";

/** compare/decide/plan/route/recommend/explain의 concrete owner입니다. */
export class SkillDecisionEngine {
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
		const pack = this.relationEngine.projectSkills(index, query, names, relationMode, limit, minScore);

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
		const pack = this.relationEngine.projectSkills(
			index,
			query,
			names,
			relationMode,
			Math.max(summaryLimit, plan.steps.length),
			minScore,
		);
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
}
