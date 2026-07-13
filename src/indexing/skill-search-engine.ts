import type {
	IndexArtifacts,
	RawSkill,
	SearchHit,
	SkillGapCandidate,
	SkillGapResult,
	SkillResolveEntry,
	SkillResolveResult,
	SkillSearchDiagnostics,
	SkillSearchResult,
} from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import type { ActiveIndexStore } from "./active-index-store";
import type { SkillSearchDatabaseInterface } from "./skill-search-database.interface";

const FALLBACK_QUERY_STOP_WORDS: Record<string, true> = {
	diagnostic: true,
	diagnostics: true,
	improvement: true,
	low: true,
	mismatch: true,
	improvements: true,
	postmortem: true,
	report: true,
	reports: true,
	retrospective: true,
	usefulness: true,
	value: true,
};

/** BM25, fallback, resolve, gap 질의의 concrete owner입니다. */
export class SkillSearchEngine {
	constructor(
		private readonly searchDatabase: SkillSearchDatabaseInterface,
		private readonly searchTokenizer: SearchTokenizerInterface,
		private readonly activeIndexStore: ActiveIndexStore,
	) {}

	/**
	 * BM25 기반으로 검색 hit를 계산합니다.
	 */
	searchByBm25(index: IndexArtifacts, query: string | undefined, limit = index.settings.maxTopK, minScore = 0): SearchHit[] {
		const activeSnapshotToken = this.activeIndexStore.assertActive(index);

		const queryVariants = this.searchTokenizer.buildQueryVariants(index, query ?? "");
		if (queryVariants.length === 0 || index.docCount === 0) {
			return [];
		}
		const terms = queryVariants.flatMap((queryVariant) => queryVariant.variants.map((variant) => variant.token));
		const matchesByTerm = this.searchDatabase.searchTerms(activeSnapshotToken, terms);
		const rankByTermAndSkill = new Map<string, Map<string, number>>();
		for (const [term, matches] of matchesByTerm) {
			rankByTermAndSkill.set(term, new Map(matches.map((match) => [match.skillId, match.bm25Rank] as const)));
		}
		const result: SearchHit[] = [];

		for (const skill of index.skills) {
			let score = 0;
			let coverage = 0;
			const matchedTerms: string[] = [];

			for (const queryVariant of queryVariants) {
				let bestVariantScore = 0;
				let bestMatchedTerm = "";

				for (const variant of queryVariant.variants) {
					const bm25Rank = rankByTermAndSkill.get(variant.token)?.get(skill.id);
					if (bm25Rank === undefined) {
						continue;
					}

					const variantScore = Math.max(0, -bm25Rank) * variant.scoreMultiplier;
					if (variantScore <= bestVariantScore) {
						continue;
					}

					bestVariantScore = variantScore;
					bestMatchedTerm = variant.token;
				}

				if (bestVariantScore <= 0) {
					continue;
				}

				coverage += 1;
				score += bestVariantScore;
				matchedTerms.push(bestMatchedTerm || queryVariant.sourceToken);
			}

			if (score >= minScore && score > 0) {
				result.push({ skill, score, coverage, matchedTerms });
			}
		}

		return result
			.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score;
				}
				if (b.coverage !== a.coverage) {
					return b.coverage - a.coverage;
				}
				return a.skill.canonicalName.localeCompare(b.skill.canonicalName);
			})
			.slice(0, limit);
	}

	/**
	 * fallback diagnostics 포함 검색 hit를 계산합니다.
	 */
	searchWithDiagnostics(index: IndexArtifacts, query: string, limit = index.settings.maxTopK, minScore = 0): SkillSearchResult {
		const normalizedQuery = query.trim();
		const hits = this.searchByBm25(index, normalizedQuery, limit, minScore);
		if (hits.length > 0) {
			return {
				hits,
				diagnostics: this.buildSearchDiagnostics(normalizedQuery, hits, "none"),
			};
		}

		const fallbackQuery = this.buildFallbackQuery(index, normalizedQuery);
		if (fallbackQuery && fallbackQuery !== normalizedQuery) {
			const fallbackHits = this.searchByBm25(index, fallbackQuery, limit, minScore);
			if (fallbackHits.length > 0) {
				return {
					hits: fallbackHits,
					diagnostics: this.buildSearchDiagnostics(fallbackQuery, fallbackHits, "query-rewrite"),
				};
			}
		}

		return {
			hits: [],
			diagnostics: {
				normalizedQuery: fallbackQuery || normalizedQuery,
				matchedAliases: [],
				fallbackMode: "safe-zero",
				whyZero:
					fallbackQuery && fallbackQuery !== normalizedQuery
						? `fallback query "${fallbackQuery}"도 후보를 찾지 못했습니다.`
						: "index token과 겹치는 query token이 없습니다.",
			},
		};
	}

	/**
	 * 검색 hit 기준 compact diagnostics를 구성합니다.
	 */
	private buildSearchDiagnostics(
		normalizedQuery: string,
		hits: SearchHit[],
		fallbackMode: SkillSearchDiagnostics["fallbackMode"],
	): SkillSearchDiagnostics {
		const topHit = hits[0];
		return {
			normalizedQuery,
			matchedAliases: this.collectMatchedAliases(normalizedQuery, hits),
			fallbackMode,
			whyThisTop1: topHit
				? `${topHit.skill.canonicalName} matched ${topHit.matchedTerms.join(", ") || "direct score"} with score ${topHit.score.toFixed(3)}.`
				: undefined,
		};
	}

	/**
	 * query와 겹치는 alias를 compact diagnostics용으로 수집합니다.
	 */
	private collectMatchedAliases(normalizedQuery: string, hits: SearchHit[]): string[] {
		const queryTokens = new Set(this.searchTokenizer.tokenizeQueryText(normalizedQuery).baseTokens);
		const normalizedLower = normalizedQuery.toLowerCase();
		const aliases = hits
			.flatMap((hit) => hit.skill.aliases)
			.filter((alias) => {
				const aliasLower = alias.toLowerCase();
				return (
					normalizedLower.includes(aliasLower) ||
					this.searchTokenizer.tokenizeQueryText(alias).baseTokens.some((token) => queryTokens.has(token))
				);
			});

		return [...new Set(aliases)].sort();
	}

	/**
	 * 0-result query를 핵심 token 또는 운영 fallback query로 축소합니다.
	 */
	private buildFallbackQuery(index: IndexArtifacts, normalizedQuery: string): string | undefined {
		const baseTokens = this.searchTokenizer.tokenizeQueryText(normalizedQuery).baseTokens;
		const focusedTokens = baseTokens.filter((token) => !FALLBACK_QUERY_STOP_WORDS[token]);
		const indexedTokens = focusedTokens.filter((token) => this.hasIndexedTokenCandidate(index, token));
		if (indexedTokens.length > 0) {
			return indexedTokens.join(" ");
		}

		if (
			baseTokens.some((token) =>
				["diagnostic", "diagnostics", "mismatch", "postmortem", "report", "retrospective", "usefulness", "value"].includes(token),
			)
		) {
			return "skill registry diagnostics";
		}

		if (baseTokens.includes("skill")) {
			return "skill registry";
		}

		return undefined;
	}

	/**
	 * token이 index에 exact 또는 prefix 후보를 갖는지 확인합니다.
	 */
	private hasIndexedTokenCandidate(index: IndexArtifacts, token: string): boolean {
		if (index.dfByTerm.has(token)) {
			return true;
		}

		if (token.length < 4) {
			return false;
		}

		for (const indexedToken of index.dfByTerm.keys()) {
			if (indexedToken.startsWith(token)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * query coverage 기준으로 gap과 scaffold hint를 계산합니다.
	 */
	gapSkills(
		index: IndexArtifacts,
		query: string,
		names: string[],
		coverageThreshold: number,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillGapResult {
		const hits = this.searchByBm25(index, query, limit, minScore);
		const allowedNames = names.length > 0 ? new Set(this.findSkillsByNames(index, names).map((skill) => skill.canonicalName)) : null;
		const candidates = hits
			.filter((hit) => !allowedNames || allowedNames.has(hit.skill.canonicalName))
			.map(
				(hit) =>
					({
						name: hit.skill.canonicalName,
						readPath: `skill://${hit.skill.canonicalName}`,
						path: hit.skill.path,
						title: hit.skill.title,
						category: hit.skill.category,
						aliases: hit.skill.aliases,
						score: hit.score,
						coverage: hit.coverage,
						matchedTerms: hit.matchedTerms,
						preview: hit.skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " "),
					}) satisfies SkillGapCandidate,
			);
		const queryTerms = [...new Set(this.searchTokenizer.tokenizeQueryText(query).baseTokens)];
		const coveredTerms = [...new Set(candidates.flatMap((candidate) => candidate.matchedTerms))].sort();
		const uncoveredTerms = queryTerms.filter((term) => !coveredTerms.includes(term));
		const coverageRatio = queryTerms.length > 0 ? coveredTerms.length / queryTerms.length : 0;
		const recommendedAction =
			candidates.length > 0 && coverageRatio >= coverageThreshold
				? "use-existing"
				: coveredTerms.length > 0
					? "add-alias"
					: "create-skill";
		return {
			ok: recommendedAction === "use-existing",
			query,
			coverageThreshold,
			coveredTerms,
			uncoveredTerms,
			candidates,
			recommendedAction,
			scaffold:
				recommendedAction === "use-existing"
					? undefined
					: {
							name: queryTerms.slice(0, 3).join("-") || "new-skill",
							category: "custom",
							keywords: queryTerms.slice(0, 5),
							description: `${query.trim()} coverage scaffold`,
							body: "",
						},
		};
	}

	/**
	 * exact name/alias 기준으로 skill을 deterministic resolve합니다.
	 */
	resolveSkills(
		index: IndexArtifacts,
		names: string[],
		includeBody: boolean,
		budgetChars: number,
		budgetTokens: number,
	): SkillResolveResult {
		const { resolved, missing } = this.resolveRequestedSkills(index, names);
		const effectiveChars =
			budgetChars > 0 && budgetTokens > 0 ? Math.min(budgetChars, budgetTokens * 4) : Math.max(budgetChars, budgetTokens * 4);
		let usedChars = 0;
		const omittedReadPaths: string[] = [];
		const resolvedEntries = resolved.map((skill) => {
			const preview = skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, " ");
			const fullBody = includeBody ? skill.bodyText : undefined;
			const nextBodyChars = fullBody?.length ?? 0;
			const canIncludeBody = Boolean(fullBody) && (effectiveChars <= 0 || usedChars + nextBodyChars <= effectiveChars);
			if (canIncludeBody) {
				usedChars += nextBodyChars;
			} else if (fullBody) {
				omittedReadPaths.push(`skill://${skill.canonicalName}`);
			}
			return {
				name: skill.canonicalName,
				readPath: `skill://${skill.canonicalName}`,
				path: skill.path,
				title: skill.title,
				category: skill.category,
				aliases: skill.aliases,
				requires: skill.requires,
				recommends: skill.recommends,
				preview,
				body: canIncludeBody ? fullBody : undefined,
				omittedByBudget: Boolean(fullBody) && !canIncludeBody,
			} satisfies SkillResolveEntry;
		});

		return {
			resolved: resolvedEntries,
			missing,
			omittedReadPaths,
			budget: {
				requestedChars: budgetChars,
				requestedTokens: budgetTokens,
				effectiveChars,
				usedChars,
			},
		};
	}

	/**
	 * 요청 name 목록을 exact canonical/alias 기준으로 resolve합니다.
	 */
	private resolveRequestedSkills(index: IndexArtifacts, names: string[]): { resolved: RawSkill[]; missing: string[] } {
		const byName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const seen = new Set<string>();
		const resolved: RawSkill[] = [];
		const missing: string[] = [];
		for (const requestedName of names) {
			const canonicalName = index.aliasToCanonical.get(requestedName) ?? requestedName;
			const skill = byName.get(canonicalName);
			if (!skill) {
				missing.push(requestedName);
				continue;
			}
			if (seen.has(skill.canonicalName)) {
				continue;
			}
			seen.add(skill.canonicalName);
			resolved.push(skill);
		}
		return {
			resolved,
			missing,
		};
	}

	/**
	 * 요청 name 순서를 유지하며 인덱스에서 exact match skill을 찾습니다.
	 */
	findSkillsByNames(index: IndexArtifacts, names: string[]): RawSkill[] {
		const byName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const seen = new Set<string>();
		return names
			.map((name) => index.aliasToCanonical.get(name) ?? name)
			.map((name) => byName.get(name))
			.filter((skill): skill is RawSkill => {
				if (!skill || seen.has(skill.canonicalName)) {
					return false;
				}
				seen.add(skill.canonicalName);
				return true;
			});
	}

	/**
	 * compose/graph 공통 seed skill 집합을 계산합니다.
	 */
	resolveSeedSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit: number,
		minScore: number,
	): RawSkill[] {
		const namedSeedSkills = this.findSkillsByNames(index, names);
		const querySeedSkills = query ? this.searchByBm25(index, query, limit, minScore).map((hit) => hit.skill) : [];
		return [...namedSeedSkills, ...querySeedSkills].filter(
			(skill, indexPosition, collection) =>
				collection.findIndex((entry) => entry.canonicalName === skill.canonicalName) === indexPosition,
		);
	}

}
