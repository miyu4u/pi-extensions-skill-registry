import path from "node:path";
import type {
	IndexArtifacts,
	RawSkill,
	SearchHit,
	SkillGapCandidate,
	SkillGapResult,
	SkillResolveEntry,
	SkillResolveResult,
	SkillResolveSuggestion,
	SkillSearchDiagnostics,
	SkillSearchResult,
} from "../shared";
import {
	SKILL_RESOLVE_RECOVERY_MAX_BYTES,
	SKILL_RESOLVE_RECOVERY_MAX_TOKENS,
	SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT,
	SKILL_RESOLVE_SUGGESTION_HARD_CAP,
	SKILL_RESOLVE_SUGGESTION_MIN_CONFIDENCE,
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
		const scopeRankByName = this.buildScopeRankByName(index);
		const scopeRankBySkillId = new Map<string, number>();

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
			.sort((a, b) => this.compareSearchHits(a, b, scopeRankByName, index.settings.scopeRoots, scopeRankBySkillId))
			.slice(0, limit);
	}

	/**
	 * BM25 점수와 coverage가 동일할 때 scope 우선순위 및 정렬 안정성을 적용해
	 * 후보를 재정렬합니다.
	 */
	private compareSearchHits(
		left: SearchHit,
		right: SearchHit,
		scopeRankByName: Map<string, number>,
		scopeRoots: Record<string, string[]>,
		scopeRankBySkillId: Map<string, number>,
	): number {
		if (left.score !== right.score) {
			return right.score - left.score;
		}
		if (left.coverage !== right.coverage) {
			return right.coverage - left.coverage;
		}
		const leftScopeRank = this.getScopeRank(left.skill, scopeRankByName, scopeRoots, scopeRankBySkillId);
		const rightScopeRank = this.getScopeRank(right.skill, scopeRankByName, scopeRoots, scopeRankBySkillId);
		if (leftScopeRank !== rightScopeRank) {
			return leftScopeRank - rightScopeRank;
		}
		return left.skill.canonicalName.localeCompare(right.skill.canonicalName);
	}

	/**
	 * 검색 스코프별 우선순위 맵을 구축합니다. 설정된 scopePriority를 우선 적용하고,
	 * 조회되지 않은 스코프는 정렬된 보조 순서로 배치해 재사용 가능한 비교 신호를 만듭니다.
	 */
	private buildScopeRankByName(index: IndexArtifacts): Map<string, number> {
		const unscopedLabel = "__unscoped__";
		const scopeRankByName = new Map<string, number>();
		if (index.skills.length === 0) {
			return scopeRankByName;
		}

		const observedScopes = new Set<string>();
		for (const skill of index.skills) {
			observedScopes.add(this.getSkillScope(skill, index.settings.scopeRoots) ?? unscopedLabel);
		}
		if (observedScopes.size === 0) {
			return scopeRankByName;
		}

		const orderedScopes: string[] = [];
		for (const scopeName of index.settings.scopePriority) {
			if (observedScopes.delete(scopeName)) {
				orderedScopes.push(scopeName);
			}
		}
		const unlistedScopes = [...observedScopes].sort();
		const finalScopes = [...orderedScopes, ...unlistedScopes];
		for (let rank = 0; rank < finalScopes.length; rank += 1) {
			scopeRankByName.set(finalScopes[rank], rank);
		}
		return scopeRankByName;
	}

	/**
	 * RawSkill에 scope가 없다면 sourceRoot 분류 정보를 이용해 대체 scope를 추정합니다.
	 */
	private getSkillScope(skill: RawSkill, scopeRoots: Record<string, string[]>): string | undefined {
		if (skill.scope?.trim()) {
			return skill.scope.trim();
		}
		const resolvedScope = this.classifyScopeBySourceRoot(skill.sourceRoot, scopeRoots);
		return resolvedScope;
	}

	/**
	 * sourceRoot를 scopeRoot 매핑으로 역분류해 가장 적합한 scope를 찾습니다.
	 */
	private classifyScopeBySourceRoot(sourceRoot: string, scopeRoots: Record<string, string[]>): string | undefined {
		const normalizedSourceRoot = this.normalizeScopePathForBoundary(sourceRoot);
		if (!normalizedSourceRoot) {
			return undefined;
		}

		let bestMatchLength = 0;
		let bestScopes: string[] = [];
		for (const [scopeName, roots] of Object.entries(scopeRoots)) {
			for (const rawRoot of roots) {
				const normalizedRoot = this.normalizeScopePathForBoundary(rawRoot);
				if (!normalizedRoot || !this.isScopeBoundaryMatch(normalizedSourceRoot, normalizedRoot)) {
					continue;
				}
				if (normalizedRoot.length < bestMatchLength) {
					continue;
				}
				if (normalizedRoot.length > bestMatchLength) {
					bestMatchLength = normalizedRoot.length;
					bestScopes = [scopeName];
					continue;
				}
				bestScopes.push(scopeName);
			}
		}

		if (bestScopes.length === 0) {
			return undefined;
		}
		if (bestScopes.length === 1) {
			return bestScopes[0];
		}
		return [...new Set(bestScopes)].sort().at(0);
	}

	/**
	 * 경로 접두사를 경계 인식 방식으로 정규화해 scope 매핑 판정을 일관되게 수행합니다.
	 */
	private isScopeBoundaryMatch(source: string, root: string): boolean {
		if (!source || !root) {
			return false;
		}
		if (source === root) {
			return true;
		}
		const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
		return source.startsWith(normalizedRoot);
	}

	/**
	 * scope 비교용 canonical 문자열을 정규화하고, 검색 정렬의 fallback rank를 계산합니다.
	 */
	private getScopeRank(
		skill: RawSkill,
		scopeRankByName: Map<string, number>,
		scopeRoots: Record<string, string[]>,
		scopeRankBySkillId?: Map<string, number>,
	): number {
		if (scopeRankBySkillId) {
			const cached = scopeRankBySkillId.get(skill.id);
			if (cached !== undefined) {
				return cached;
			}
		}
		const fallbackScopeLabel = "__unscoped__";
		const resolvedScope = this.getSkillScope(skill, scopeRoots);
		if (!resolvedScope) {
			const fallbackRank = scopeRankByName.get(fallbackScopeLabel) ?? Number.MAX_SAFE_INTEGER;
			scopeRankBySkillId?.set(skill.id, fallbackRank);
			return fallbackRank;
		}
		const rank = scopeRankByName.get(resolvedScope);
		if (typeof rank === "number") {
			scopeRankBySkillId?.set(skill.id, rank);
			return rank;
		}
		const newRank = scopeRankByName.size;
		scopeRankByName.set(resolvedScope, newRank);
		scopeRankBySkillId?.set(skill.id, newRank);
		return newRank;
	}

	/**
	 * scope 경계 비교에서 사용될 경로를 정규화합니다.
	 */
	private normalizeScopePathForBoundary(rawPath: string): string {
		if (!rawPath.trim()) {
			return "";
		}
		const normalized = path.resolve(rawPath);
		return normalized.replace(/[\\/]+$/u, "");
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
						scope: hit.skill.scope,
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
		suggestionLimit = SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT,
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
				scope: skill.scope,
				aliases: skill.aliases,
				requires: skill.requires,
				recommends: skill.recommends,
				preview,
				body: canIncludeBody ? fullBody : undefined,
				omittedByBudget: Boolean(fullBody) && !canIncludeBody,
			} satisfies SkillResolveEntry;
		});
		const suggestions = this.buildResolveSuggestions(index, missing, suggestionLimit);

		return {
			resolved: resolvedEntries,
			missing,
			suggestions,
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
	 * exact miss를 검색 후보로 보완하되, confidence와 payload budget을 함께 적용합니다.
	 */
	private buildResolveSuggestions(index: IndexArtifacts, missing: string[], suggestionLimit: number): SkillResolveSuggestion[] {
		const boundedLimit = Math.max(0, Math.min(suggestionLimit, SKILL_RESOLVE_SUGGESTION_HARD_CAP));
		if (boundedLimit === 0 || missing.length === 0 || index.docCount === 0) {
			return [];
		}

		const candidates = new Map<string, SkillResolveSuggestion>();
		for (const requestedName of missing) {
			const hits = this.searchWithDiagnostics(index, requestedName, SKILL_RESOLVE_SUGGESTION_HARD_CAP).hits;
			for (const hit of hits) {
				const confidence = this.calculateSuggestionConfidence(requestedName, hit.skill);
				if (confidence < SKILL_RESOLVE_SUGGESTION_MIN_CONFIDENCE || candidates.has(hit.skill.canonicalName)) {
					continue;
				}

				candidates.set(hit.skill.canonicalName, {
					name: hit.skill.canonicalName,
					readPath: `skill://${hit.skill.canonicalName}`,
					confidence: Number(confidence.toFixed(3)),
				});
			}
		}

		const ranked = [...candidates.values()]
			.sort((left, right) => {
				if (right.confidence !== left.confidence) {
					return right.confidence - left.confidence;
				}
				return left.name.localeCompare(right.name);
			})
			.slice(0, boundedLimit);
		const accepted: SkillResolveSuggestion[] = [];
		const encoder = new TextEncoder();
		let usedBytes = 0;
		let usedTokens = 0;
		for (const suggestion of ranked) {
			const suggestionText = JSON.stringify(suggestion);
			const suggestionBytes = encoder.encode(suggestionText).byteLength;
			const suggestionTokens = suggestionText.match(/\S+/gu)?.length ?? 0;
			if (
				usedBytes + suggestionBytes > SKILL_RESOLVE_RECOVERY_MAX_BYTES ||
				usedTokens + suggestionTokens > SKILL_RESOLVE_RECOVERY_MAX_TOKENS
			) {
				continue;
			}

			accepted.push(suggestion);
			usedBytes += suggestionBytes;
			usedTokens += suggestionTokens;
		}
		return accepted;
	}

	/**
	 * URI 이름과 canonical/alias의 bounded edit similarity를 confidence로 환산합니다.
	 */
	private calculateSuggestionConfidence(requestedName: string, skill: RawSkill): number {
		const requested = requestedName.trim().toLocaleLowerCase();
		if (!requested || requested.length > 256) {
			return 0;
		}

		return Math.max(
			...[skill.canonicalName, ...skill.aliases].map((candidate) =>
				this.calculateEditSimilarity(requested, candidate.toLocaleLowerCase()),
			),
		);
	}

	/**
	 * 긴 URI 입력이 비교 비용을 폭발시키지 않도록 two-row Levenshtein을 제한합니다.
	 */
	private calculateEditSimilarity(source: string, target: string): number {
		if (!target || target.length > 256) {
			return 0;
		}
		if (source === target) {
			return 1;
		}

		const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
		const current = new Array<number>(target.length + 1).fill(0);
		for (let row = 1; row <= source.length; row += 1) {
			current[0] = row;
			let rowMinimum = current[0];
			for (let column = 1; column <= target.length; column += 1) {
				const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1;
				const value = Math.min(
					(previous[column] ?? Number.MAX_SAFE_INTEGER) + 1,
					(current[column - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
					(previous[column - 1] ?? Number.MAX_SAFE_INTEGER) + substitutionCost,
				);
				current[column] = value;
				rowMinimum = Math.min(rowMinimum, value);
			}
			if (rowMinimum > Math.max(source.length, target.length)) {
				return 0;
			}
			for (let column = 0; column <= target.length; column += 1) {
				previous[column] = current[column] ?? Number.MAX_SAFE_INTEGER;
			}
		}

		const distance = previous[target.length] ?? Math.max(source.length, target.length);
		return Math.max(0, 1 - distance / Math.max(source.length, target.length));
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
	resolveSeedSkills(index: IndexArtifacts, query: string | undefined, names: string[], limit: number, minScore: number): RawSkill[] {
		const namedSeedSkills = this.findSkillsByNames(index, names);
		const querySeedSkills = query ? this.searchByBm25(index, query, limit, minScore).map((hit) => hit.skill) : [];
		return [...namedSeedSkills, ...querySeedSkills].filter(
			(skill, indexPosition, collection) =>
				collection.findIndex((entry) => entry.canonicalName === skill.canonicalName) === indexPosition,
		);
	}
}
