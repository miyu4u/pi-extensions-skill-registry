import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SettingsLoaderInterface } from "../settings";
import type {
	ComposedSkillEntry,
	IndexArtifacts,
	IndexedStats,
	MissingSkillRelation,
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
	SkillComposePlan,
	SkillCurrentTurnPacketResult,
	SkillDecideEntry,
	SkillDecideResult,
	SkillExecutionPacketResult,
	SkillExplainEntry,
	SkillExplainResult,
	SkillFileReadyPacketResult,
	SkillFrontmatter,
	SkillFrontmatterRecord,
	SkillGapCandidate,
	SkillGapResult,
	SkillGraphMode,
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
	SkillRelationEdgeKind,
	SkillRelationGraph,
	SkillRelationGraphEdge,
	SkillRelationGraphNode,
	SkillRelationMode,
	SkillResolveEntry,
	SkillResolveResult,
	SkillResumePacketResult,
	SkillRoutePhase,
	SkillRouteResult,
	SkillSearchDiagnostics,
	SkillSearchResult,
	SkillSessionPacketResult,
	SkillSessionPacketStep,
	SkillSummaryPacketResult,
	SkillTurnPacketResult,
	SkillTurnPacketTurn,
	SkillValidationIssue,
	SkillValidationReport,
	SkillVerificationPacketResult,
	SkillWriteScriptPacketResult,
	ToolContext,
	ToolInput,
} from "../shared";
import { DEFAULT_FILE_NAMES } from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import type { SkillIndexInterface } from "./skill-index.interface";
import type { SkillSearchDatabaseInterface, SkillSearchDocument, SkillSearchSnapshot } from "./skill-search-database.interface";

/** 스캔 중 제외할 디렉터리 이름 목록입니다. */
const SKIP_DIRECTORY_NAMES: Record<string, true> = {
	".git": true,
	".svn": true,
	node_modules: true,
	".venv": true,
	dist: true,
	build: true,
	out: true,
};

/** 0-result fallback에서 제거할 일반 작업어 lookup 테이블입니다. */
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

/** 작업 크기별 기본 추천 상한입니다. */
const TASK_SIZE_LIMITS = {
	small: 2,
	medium: 5,
} as const;

/** skill-registry 인덱싱/검색 구현체입니다. */
export class SkillIndexService implements SkillIndexInterface {
	private cachedIndex: IndexArtifacts | null = null;
	private cachedDatabasePath = "";
	private activeSnapshotToken = "";

	constructor(
		private readonly searchDatabase: SkillSearchDatabaseInterface,
		private readonly settingsLoader: SettingsLoaderInterface,
		private readonly searchTokenizer: SearchTokenizerInterface,
	) {}

	/**
	 * 열린 SQLite index와 process cache를 닫습니다.
	 */
	close(): void {
		this.searchDatabase.close();
		this.clearActiveIndex();
		this.cachedDatabasePath = "";
	}

	/**
	 * tool 입력을 설정 기반으로 정규화합니다.
	 */
	normalizeToolInput(params: ToolInput): ToolContext {
		const settings = this.settingsLoader.loadSettings();
		const mergedRoots = (params.roots?.length ? params.roots : settings.roots).map((rawRoot) => this.resolvePath(rawRoot));
		const mergedFileNames = params.fileNames?.length ? this.normalizeFileNames(params.fileNames) : settings.fileNames;
		const taskSize = params.taskSize === "large" || params.taskSize === "small" ? params.taskSize : "medium";
		const taskSizeLimit = taskSize === "large" ? settings.maxTopK : TASK_SIZE_LIMITS[taskSize];
		const requestedLimit = params.limit ?? taskSizeLimit;
		const limit = Math.max(1, Math.min(requestedLimit, settings.maxTopK, taskSizeLimit));

		return {
			action: params.action,
			query: params.query?.trim(),
			names: this.normalizeNames(params.names),
			orderedNames: this.normalizeNames(params.names, true),
			roots: mergedRoots,
			fileNames: mergedFileNames,
			limit,
			taskSize,
			refresh: params.refresh ?? false,
			minScore: params.minScore ?? 0,
			includeBody: params.includeBody ?? params.action !== "resolve",
			relationMode: params.relationMode === "required" || taskSize !== "large" ? "required" : "full",
			graphMode:
				params.graphMode === "inbound" || params.graphMode === "cycles" || params.graphMode === "orphans"
					? params.graphMode
					: "outbound",
			budgetChars: params.budgetChars ?? 4_000,
			budgetTokens: params.budgetTokens ?? 1_000,
			coverageThreshold: params.coverageThreshold ?? 0.7,
			settings: {
				...settings,
				fileNames: mergedFileNames,
				includePreviewBodyChars:
					params.includePreviewBodyChars && params.includePreviewBodyChars > 0
						? params.includePreviewBodyChars
						: settings.includePreviewBodyChars,
			},
		};
	}

	/**
	 * 정규화된 context 기준으로 skill index를 로드합니다.
	 */
	async loadIndex(input: ToolContext): Promise<IndexArtifacts> {
		const normalizedPreset = input.settings.presetSkills.map((name) => this.normalizeSkillName(name));
		const shouldUseFullCorpusForQueryDecision =
			(input.action === "compare" ||
				input.action === "decide" ||
				input.action === "plan" ||
				input.action === "route" ||
				input.action === "brief" ||
				input.action === "bundle" ||
				input.action === "handoff" ||
				input.action === "session-packet" ||
				input.action === "turn-packet" ||
				input.action === "recovery-packet" ||
				input.action === "resume-packet" ||
				input.action === "markdown-packet" ||
				input.action === "checklist-packet" ||
				input.action === "commands-packet" ||
				input.action === "file-ready-packet" ||
				input.action === "apply-packet" ||
				input.action === "write-script-packet" ||
				input.action === "execution-packet" ||
				input.action === "verification-packet" ||
				input.action === "summary-packet") &&
			Boolean(input.query);
		const effectiveNames =
			input.action === "validate" ||
			shouldUseFullCorpusForQueryDecision ||
			input.action === "recommend" ||
			input.action === "audit" ||
			input.action === "graph" ||
			input.action === "pack" ||
			input.action === "resolve" ||
			input.action === "gap" ||
			input.action === "explain"
				? []
				: input.names.length > 0
					? input.names
					: normalizedPreset;
		const requestedSet = new Set(effectiveNames);
		const shouldFilterByRequestedNames =
			requestedSet.size > 0 &&
			input.action !== "compose" &&
			input.action !== "validate" &&
			!shouldUseFullCorpusForQueryDecision &&
			input.action !== "recommend" &&
			input.action !== "audit" &&
			input.action !== "graph" &&
			input.action !== "pack" &&
			input.action !== "resolve" &&
			input.action !== "gap" &&
			input.action !== "explain";
		const scanRequestedSet = shouldFilterByRequestedNames ? requestedSet : new Set<string>();
		const stats: IndexedStats = {
			totalFilesVisited: 0,
			totalParsed: 0,
			skippedMissingRoot: 0,
			parseErrors: 0,
			deduplicated: 0,
			missingFromRequested: Array.from(requestedSet),
			malformedFiles: [],
			duplicateCanonicalEntries: [],
			duplicateAliasEntries: [],
			nameFilterMode: shouldFilterByRequestedNames ? "targeted" : "full",
		};

		const requestKey = JSON.stringify({
			roots: input.roots,
			fileNames: input.fileNames,
			names: effectiveNames,
			preset: normalizedPreset,
			nameFilterMode: shouldFilterByRequestedNames ? "targeted" : "full",
			databasePath: input.settings.databasePath,
		});
		const now = Date.now();
		const databasePath = input.settings.databasePath;

		if (this.cachedDatabasePath && this.cachedDatabasePath !== databasePath) {
			this.searchDatabase.close();
			this.clearActiveIndex();
		}
		await this.searchDatabase.initialize(databasePath);
		this.cachedDatabasePath = databasePath;

		if (!input.refresh && this.cachedIndex && this.cachedIndex.requestKey === requestKey) {
			const isUnexpired = now - this.cachedIndex.generatedAt < this.cachedIndex.ttlMs;
			if (isUnexpired && this.searchDatabase.isSnapshotCurrent(this.activeSnapshotToken)) {
				return this.cachedIndex;
			}
			this.clearActiveIndex();
		}

		if (!input.refresh) {
			const persistedSnapshot = this.searchDatabase.readSnapshot(requestKey, now);
			if (persistedSnapshot) {
				return this.activateSnapshot(persistedSnapshot);
			}
		}

		const buildStartedAt = Date.now();
		const bestByCanonical = new Map<string, RawSkill>();
		let indexBuildMode: "targeted" | "full" = shouldFilterByRequestedNames ? "targeted" : "full";

		for (const root of input.roots) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(root);
			} catch {
				stats.skippedMissingRoot += 1;
				continue;
			}
			if (!stat.isDirectory()) {
				stats.skippedMissingRoot += 1;
				continue;
			}

			const { mode, files } = this.collectSkillFiles(root, input.fileNames, scanRequestedSet);
			if (mode === "full") {
				indexBuildMode = "full";
			}
			stats.totalFilesVisited += files.length;

			for (const skillFile of files) {
				const parseIssues: string[] = [];
				const candidate = this.parseSkillFile(skillFile, root, parseIssues);
				if (!candidate) {
					stats.parseErrors += 1;
					stats.malformedFiles.push({
						path: skillFile,
						reason: parseIssues[0] ?? "skill file could not be parsed",
					});
					continue;
				}
				stats.totalParsed += 1;

				const matchedRequestedNames =
					requestedSet.size > 0 ? [candidate.canonicalName, ...candidate.aliases].filter((name) => requestedSet.has(name)) : [];
				if (shouldFilterByRequestedNames && matchedRequestedNames.length === 0) {
					continue;
				}
				const existing = bestByCanonical.get(candidate.canonicalName);
				if (existing) {
					stats.deduplicated += 1;
					stats.duplicateCanonicalEntries.push({
						canonicalName: candidate.canonicalName,
						keptPath: candidate.mtimeMs > existing.mtimeMs ? candidate.path : existing.path,
						droppedPath: candidate.mtimeMs > existing.mtimeMs ? existing.path : candidate.path,
					});
					if (candidate.mtimeMs <= existing.mtimeMs) {
						continue;
					}
				}

				bestByCanonical.set(candidate.canonicalName, candidate);
				stats.missingFromRequested = stats.missingFromRequested.filter((name) => !matchedRequestedNames.includes(name));
			}
		}

		stats.nameFilterMode = indexBuildMode;
		const skills = Array.from(bestByCanonical.values());
		this.buildAliasToCanonical(skills, stats);
		const documents = skills.map((skill) => this.buildSearchDocument(skill));
		const snapshot = this.searchDatabase.replaceSnapshot(
			{
				generatedAt: now,
				ttlMs: input.settings.cacheTtlMs,
				requestKey,
				settings: input.settings,
				requestedNames: effectiveNames,
				skills,
				stats,
				buildStartedAt,
			},
			documents,
		);
		return this.activateSnapshot(snapshot);
	}

	/**
	 * persisted snapshot을 활성 process index로 변환합니다.
	 */
	private activateSnapshot(snapshot: SkillSearchSnapshot): IndexArtifacts {
		const aliasToCanonical = this.buildAliasToCanonical(snapshot.skills);
		const indexData: IndexArtifacts = {
			generatedAt: snapshot.generatedAt,
			ttlMs: snapshot.ttlMs,
			requestKey: snapshot.requestKey,
			settings: snapshot.settings,
			requestedNames: snapshot.requestedNames,
			skills: snapshot.skills,
			docCount: snapshot.skills.length,
			stats: snapshot.stats,
			dfByTerm: snapshot.dfByTerm,
			aliasToCanonical,
			avgLength: snapshot.avgLength,
			indexBuildMs: snapshot.indexBuildMs,
		};

		this.cachedIndex = indexData;
		this.activeSnapshotToken = snapshot.snapshotToken;
		return indexData;
	}

	/**
	 * 단일 skill 파일을 파싱합니다.
	 */
	parseSkillFile(skillPath: string, root: string, issues: string[] = []): RawSkill | null {
		let raw: string;
		try {
			raw = fs.readFileSync(skillPath, "utf-8");
		} catch (error) {
			issues.push(`read failed: ${error instanceof Error ? error.message : "unknown read error"}`);
			return null;
		}

		const parsed = this.readFrontmatter(raw);
		const body = this.stripFrontmatter(raw).trim();
		const frontmatter = this.normalizeFrontmatter(parsed);
		const name = frontmatter.name || this.guessSkillName(skillPath);
		const canonicalName = this.normalizeSkillName(name);
		if (!canonicalName) {
			issues.push("missing canonical skill name");
			return null;
		}

		const title = this.headingTitle(body) || frontmatter.description || canonicalName;
		const keywords = this.extractList(frontmatter.keywords).map((word) => this.normalizeKeyword(word));
		const tags = this.extractList(frontmatter.tags).map((word) => this.normalizeKeyword(word));
		const aliases = this.extractList(frontmatter.aliases)
			.map((name) => this.normalizeSkillName(name))
			.filter(Boolean);
		const requires = this.extractList(frontmatter.requires)
			.map((name) => this.normalizeSkillName(name))
			.filter(Boolean);
		const recommends = this.extractList(frontmatter.recommends)
			.map((name) => this.normalizeSkillName(name))
			.filter(Boolean);
		const category = frontmatter.category || "uncategorized";

		let stat: fs.Stats;
		try {
			stat = fs.statSync(skillPath);
		} catch (error) {
			issues.push(`stat failed: ${error instanceof Error ? error.message : "unknown fs error"}`);
			return null;
		}

		const uniqueAliases = [...new Set(aliases)].filter((name) => name !== canonicalName);
		const uniqueRequires = [...new Set(requires)].filter((name) => name !== canonicalName);
		const uniqueRecommends = [...new Set(recommends)].filter((name) => name !== canonicalName && !uniqueRequires.includes(name));
		return {
			id: canonicalName,
			canonicalName,
			path: path.resolve(skillPath),
			sourceRoot: root,
			rawFrontmatter: parsed,
			frontmatter: {
				...frontmatter,
				name: canonicalName,
				aliases: uniqueAliases,
				requires: uniqueRequires,
				recommends: uniqueRecommends,
			},
			bodyText: body,
			title,
			category,
			keywords: [...new Set(keywords)],
			tags: [...new Set(tags)],
			aliases: uniqueAliases,
			requires: uniqueRequires,
			recommends: uniqueRecommends,
			text: "",
			mtimeMs: stat.mtimeMs,
		};
	}

	/**
	 * BM25 기반으로 검색 hit를 계산합니다.
	 */
	searchByBm25(index: IndexArtifacts, query: string | undefined, limit = index.settings.maxTopK, minScore = 0): SearchHit[] {
		if (index !== this.cachedIndex || !this.activeSnapshotToken) {
			throw new Error("search index is not active; call loadIndex() before searching");
		}

		const queryVariants = this.searchTokenizer.buildQueryVariants(index, query ?? "");
		if (queryVariants.length === 0 || index.docCount === 0) {
			return [];
		}
		const terms = queryVariants.flatMap((queryVariant) => queryVariant.variants.map((variant) => variant.token));
		const matchesByTerm = this.searchDatabase.searchTerms(this.activeSnapshotToken, terms);
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
	 * seed skill과 relation을 확장해 compose 결과를 계산합니다.
	 */
	composeSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit = index.settings.maxTopK,
		relationMode: SkillRelationMode = "full",
		minScore = 0,
	): SkillComposePlan {
		const seedSkills = this.resolveSeedSkills(index, query, names, limit, minScore);
		const bestEntryByName = new Map<string, ComposedSkillEntry>();
		const expandedSignatureByName = new Map<string, string>();
		const missingRelations: MissingSkillRelation[] = [];
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const queue: ComposedSkillEntry[] = seedSkills.map((skill) => ({
			skill,
			reason: "seed",
			depth: 0,
		}));

		for (const entry of queue) {
			bestEntryByName.set(entry.skill.canonicalName, entry);
		}

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) {
				continue;
			}

			const currentBest = bestEntryByName.get(current.skill.canonicalName);
			if (
				!currentBest ||
				currentBest.reason !== current.reason ||
				currentBest.depth !== current.depth ||
				currentBest.via !== current.via
			) {
				continue;
			}

			const currentSignature = [currentBest.reason, String(currentBest.depth), currentBest.via ?? ""].join("|");
			if (expandedSignatureByName.get(current.skill.canonicalName) === currentSignature) {
				continue;
			}
			expandedSignatureByName.set(current.skill.canonicalName, currentSignature);

			const targets: Array<{
				name: string;
				reason: "required" | "recommended";
			}> = current.skill.requires.map((name) => ({
				name,
				reason: "required",
			}));
			if (relationMode === "full") {
				targets.push(
					...current.skill.recommends.map((name) => ({
						name,
						reason: "recommended" as const,
					})),
				);
			}

			for (const target of targets) {
				const resolvedName = index.aliasToCanonical.get(target.name) ?? target.name;
				const relatedSkill = skillByName.get(resolvedName);
				if (!relatedSkill) {
					missingRelations.push({
						name: target.name,
						relation: target.reason,
						via: current.skill.canonicalName,
						depth: current.depth + 1,
					});
					continue;
				}

				const candidate: ComposedSkillEntry = {
					skill: relatedSkill,
					reason: target.reason,
					via: current.skill.canonicalName,
					depth: current.depth + 1,
				};
				const existing = bestEntryByName.get(relatedSkill.canonicalName);
				if (existing && !this.isBetterComposeEntry(candidate, existing)) {
					continue;
				}

				bestEntryByName.set(relatedSkill.canonicalName, candidate);
				queue.push(candidate);
			}
		}

		return {
			seeds: seedSkills,
			entries: Array.from(bestEntryByName.values()).sort((left, right) => {
				if (left.depth !== right.depth) {
					return left.depth - right.depth;
				}
				const priorityDelta = this.composeReasonPriority(right.reason) - this.composeReasonPriority(left.reason);
				if (priorityDelta !== 0) {
					return priorityDelta;
				}
				return left.skill.canonicalName.localeCompare(right.skill.canonicalName);
			}),
			missing: this.dedupeMissingRelations(missingRelations),
			relationMode,
		};
	}

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
		const hits = query ? this.searchByBm25(index, query, limit, minScore) : [];
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
		const seeds = this.resolveSeedSkills(index, query, names, summaryLimit, minScore);
		const seedNames = new Set(seeds.map((skill) => skill.canonicalName));
		const seedCategories = new Map<string, string[]>();
		for (const seed of seeds) {
			const existing = seedCategories.get(seed.category) ?? [];
			existing.push(seed.canonicalName);
			seedCategories.set(seed.category, existing);
		}
		const queryHits = query ? this.searchByBm25(index, query, Math.max(summaryLimit * 4, summaryLimit), minScore) : [];
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const edges = this.buildRelationGraphEdges(index);
		const outboundByCanonical = this.groupEdgesByCanonical(edges, "from");
		const inboundByCanonical = this.groupEdgesByCanonical(edges, "to");
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
		const composePlan = this.composeSkills(index, query, names, limit, relationMode, minScore);
		const graph = this.graphSkills(index, query, names, "outbound", limit, minScore);
		const allowedNodeNames = new Set(composePlan.entries.map((entry) => entry.skill.canonicalName));
		const filteredEdges = graph.edges.filter((edge) => allowedNodeNames.has(edge.from) && (!edge.to || allowedNodeNames.has(edge.to)));
		const filteredResolvedEdges = filteredEdges.filter((edge): edge is SkillRelationGraphEdge & { to: string } => Boolean(edge.to));
		const filteredLayers = this.buildRelationGraphLayers(allowedNodeNames, filteredResolvedEdges);
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
			cycles: this.collectRelationCycles(index, filteredResolvedEdges, allowedNodeNames),
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

		for (const duplicate of this.dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries)) {
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
		const cycleGraph = this.graphSkills(index, query, names, "cycles", summaryLimit, minScore);
		const orphanGraph = this.graphSkills(index, query, names, "orphans", summaryLimit, minScore);
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
	 * canonical index 기준 relation graph slice를 계산합니다.
	 */
	graphSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		graphMode: SkillGraphMode = "outbound",
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillRelationGraph {
		const edges = this.buildRelationGraphEdges(index);
		const outboundByCanonical = this.groupEdgesByCanonical(edges, "from");
		const inboundByCanonical = this.groupEdgesByCanonical(edges, "to");
		const orphanNames = index.skills
			.filter((skill) => {
				const outbound = outboundByCanonical.get(skill.canonicalName) ?? [];
				const inbound = inboundByCanonical.get(skill.canonicalName) ?? [];
				return outbound.length === 0 && inbound.length === 0;
			})
			.map((skill) => skill.canonicalName)
			.sort();
		const seeds = this.resolveSeedSkills(index, query, names, limit, minScore).map((skill) => skill.canonicalName);
		const resolvedEdges = edges.filter((edge): edge is SkillRelationGraphEdge & { to: string } => Boolean(edge.to));

		switch (graphMode) {
			case "inbound": {
				const nodeNames = this.collectReachableNodeNames(seeds, inboundByCanonical, (edge) => edge.from);
				return this.buildRelationGraphSlice(index, graphMode, seeds, nodeNames, edges, resolvedEdges, orphanNames);
			}
			case "cycles": {
				const cycles = this.collectRelationCycles(index, resolvedEdges);
				const filteredCycles = seeds.length > 0 ? cycles.filter((cycle) => cycle.some((name) => seeds.includes(name))) : cycles;
				const cycleNodeNames = new Set(filteredCycles.flat());
				return this.buildRelationGraphSlice(
					index,
					graphMode,
					seeds,
					cycleNodeNames,
					edges,
					resolvedEdges,
					orphanNames,
					filteredCycles,
				);
			}
			case "orphans": {
				const orphanSet = seeds.length > 0 ? new Set(orphanNames.filter((name) => seeds.includes(name))) : new Set(orphanNames);
				return this.buildRelationGraphSlice(index, graphMode, seeds, orphanSet, edges, resolvedEdges, orphanNames);
			}
			default: {
				const nodeNames = this.collectReachableNodeNames(seeds, outboundByCanonical, (edge) => edge.to);
				return this.buildRelationGraphSlice(index, graphMode, seeds, nodeNames, edges, resolvedEdges, orphanNames);
			}
		}
	}

	/**
	 * skill 이름 입력을 정규화하고 dedupe합니다.
	 */
	private normalizeNames(names?: string[], preserveOrder = false): string[] {
		if (!names || names.length === 0) {
			return [];
		}
		const deduped = [...new Set(names.map((name) => this.normalizeSkillName(name)).filter(Boolean))];
		return preserveOrder ? deduped : deduped.sort();
	}

	/**
	 * skill 파일명 후보를 정규화하고 빈 배열이면 기본값을 돌려줍니다.
	 */
	private normalizeFileNames(fileNames: string[]): string[] {
		const deduped = [...new Set(fileNames.map((name) => name.trim()).filter(Boolean))];
		return deduped.length > 0 ? deduped : DEFAULT_FILE_NAMES;
	}

	/**
	 * 홈 디렉터리 약칭을 실제 경로로 확장합니다.
	 */
	private resolvePath(raw: string): string {
		if (!raw) {
			return raw;
		}
		return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
	}

	/**
	 * 요청 이름 유무에 따라 targeted/full 스캔 파일 집합을 계산합니다.
	 */
	private collectSkillFiles(
		root: string,
		fileNames: string[],
		requestedSet: Set<string>,
	): { mode: "targeted" | "full"; files: string[] } {
		if (requestedSet.size === 0) {
			return { mode: "full", files: this.findSkillFiles(root, fileNames) };
		}
		const targeted: string[] = [];
		const dedupe = new Set<string>();
		const directlyResolvedRequestedNames = new Set<string>();
		const extensions = Array.from(new Set(fileNames.map((fileName) => path.extname(fileName).toLowerCase())));

		for (const requestedName of requestedSet) {
			const candidateDir = path.join(root, requestedName);
			let dirEntries: fs.Dirent[];
			try {
				dirEntries = fs.readdirSync(candidateDir, { withFileTypes: true });
			} catch {
				dirEntries = [];
			}

			for (const entry of dirEntries) {
				if (!entry.isFile()) {
					continue;
				}
				if (!fileNames.includes(entry.name)) {
					continue;
				}
				const skillFile = path.join(candidateDir, entry.name);
				if (!dedupe.has(skillFile)) {
					dedupe.add(skillFile);
					targeted.push(skillFile);
				}
				directlyResolvedRequestedNames.add(requestedName);
			}

			for (const ext of extensions) {
				if (!ext) {
					continue;
				}
				const skillFile = path.join(root, `${requestedName}${ext}`);
				try {
					if (fs.statSync(skillFile).isFile()) {
						if (!dedupe.has(skillFile)) {
							dedupe.add(skillFile);
							targeted.push(skillFile);
						}
						directlyResolvedRequestedNames.add(requestedName);
					}
				} catch {
					// not found
				}
			}
		}

		if (targeted.length > 0 && directlyResolvedRequestedNames.size === requestedSet.size) {
			return { mode: "targeted", files: targeted };
		}

		return { mode: "full", files: this.findSkillFiles(root, fileNames) };
	}

	/**
	 * 루트 아래 skill 파일들을 재귀 탐색합니다.
	 */
	private findSkillFiles(root: string, fileNames: string[]): string[] {
		const found: string[] = [];
		const stack = [root];

		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}
			let dirEntries: fs.Dirent[];
			try {
				dirEntries = fs.readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of dirEntries) {
				if (entry.isDirectory()) {
					if (SKIP_DIRECTORY_NAMES[entry.name]) {
						continue;
					}
					stack.push(path.join(current, entry.name));
					continue;
				}

				if (!entry.isFile()) {
					continue;
				}
				if (!fileNames.includes(entry.name)) {
					continue;
				}
				found.push(path.join(current, entry.name));
			}
		}

		return found;
	}

	/**
	 * frontmatter 문자열 레코드를 읽습니다.
	 */
	private readFrontmatter(text: string): SkillFrontmatterRecord {
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) {
			return {};
		}

		const records: SkillFrontmatterRecord = {};
		let pendingListKey = "";
		let pendingListValues: string[] = [];
		const flushPendingList = (): void => {
			if (!pendingListKey) {
				return;
			}
			records[pendingListKey] = [...pendingListValues];
			pendingListKey = "";
			pendingListValues = [];
		};

		for (const line of match[1].split(/\r?\n/)) {
			const matchLine = /^(?<key>[A-Za-z][A-Za-z0-9_-]*):(?:\s*(?<value>.*))?$/.exec(line);
			if (matchLine?.groups) {
				flushPendingList();
				const key = matchLine.groups.key.toLowerCase();
				const rawValue = (matchLine.groups.value ?? "").trim();
				if (!rawValue) {
					pendingListKey = key;
					pendingListValues = [];
					records[key] = "";
					continue;
				}
				records[key] = rawValue;
				continue;
			}

			if (!pendingListKey) {
				continue;
			}

			const listLine = /^\s*-\s*(?<value>.+?)\s*$/.exec(line);
			if (listLine?.groups?.value) {
				pendingListValues.push(this.stripFrontmatterQuotes(listLine.groups.value));
				continue;
			}

			if (/^\s+/.test(line) || !line.trim()) {
				continue;
			}

			flushPendingList();
		}

		flushPendingList();
		return records;
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
	 * frontmatter block을 제외한 body를 반환합니다.
	 */
	private stripFrontmatter(text: string): string {
		const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) {
			return text;
		}
		return text.slice(match[0].length);
	}

	/**
	 * raw frontmatter를 정규화된 skill frontmatter로 변환합니다.
	 */
	private normalizeFrontmatter(raw: SkillFrontmatterRecord): SkillFrontmatter {
		const tags = this.extractList(raw.tags ?? raw.tag);
		const keywords = this.extractList(raw.keywords);
		const aliases = this.extractList(raw.aliases ?? raw.alias);
		const requires = this.extractList(raw.requires ?? raw.require ?? raw.depends_on);
		const recommends = this.extractList(raw.recommends ?? raw.recommend ?? raw.related);
		return {
			name: this.extractScalarValue(raw.name),
			description: this.extractScalarValue(raw.description ?? raw.summary),
			category: this.extractScalarValue(raw.category ?? raw.group ?? raw.type),
			keywords,
			tags,
			aliases,
			requires,
			recommends,
			version: this.extractScalarValue(raw.version ?? raw.skill_version),
		};
	}

	/**
	 * string 또는 string[] 입력을 list로 정규화합니다.
	 */
	private extractList(value?: string | string[]): string[] {
		if (!value) {
			return [];
		}
		if (Array.isArray(value)) {
			return value.map((entry) => entry.trim()).filter(Boolean);
		}
		return this.parseCsv(value);
	}

	/**
	 * CSV 또는 bracket array 문자열을 list로 파싱합니다.
	 */
	private parseCsv(value: string): string[] {
		const source = value.trim();
		if (!source) {
			return [];
		}
		if (source.startsWith("[") && source.endsWith("]")) {
			return source
				.slice(1, -1)
				.split(",")
				.map((entry) => entry.trim().replace(/^"|"$|^'|'$/g, ""))
				.filter(Boolean);
		}
		return source
			.split(/[,;\n]+/g)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	/**
	 * frontmatter scalar 값을 string으로 정규화합니다.
	 */
	private extractScalarValue(value?: string | string[]): string {
		if (Array.isArray(value)) {
			return value[0]?.trim() ?? "";
		}
		return value?.trim() ?? "";
	}

	/**
	 * frontmatter list item 양쪽 quote를 제거합니다.
	 */
	private stripFrontmatterQuotes(value: string): string {
		return value.trim().replace(/^["'`]|["'`]$/g, "");
	}

	/**
	 * keyword/tag 값을 소문자 기준으로 정규화합니다.
	 */
	private normalizeKeyword(value: string): string {
		return value
			.toLowerCase()
			.replace(/^["'`]|["'`]$/g, "")
			.trim();
	}

	/**
	 * 파일 경로 기준 fallback skill 이름을 계산합니다.
	 */
	private guessSkillName(skillPath: string): string {
		return path.basename(path.dirname(skillPath));
	}

	/**
	 * skill 이름을 canonical slug로 정규화합니다.
	 */
	private normalizeSkillName(name: string): string {
		return name
			.trim()
			.replace(/\.md$/i, "")
			.replace(/^skill[-_]/i, "")
			.replace(/\s+/g, "-")
			.toLowerCase();
	}

	/**
	 * 요청 name 순서를 유지하며 인덱스에서 exact match skill을 찾습니다.
	 */
	private findSkillsByNames(index: IndexArtifacts, names: string[]): RawSkill[] {
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
	private resolveSeedSkills(
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
		const namedSkills = this.findSkillsByNames(index, names);
		const queryHits = query ? this.searchByBm25(index, query, limit, minScore) : [];
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
	 * full canonical index에서 relation edge를 계산합니다.
	 */
	private buildRelationGraphEdges(index: IndexArtifacts): SkillRelationGraphEdge[] {
		const edges: SkillRelationGraphEdge[] = [];
		for (const skill of index.skills) {
			this.pushRelationEdges(edges, skill, skill.requires, "requires", index);
			this.pushRelationEdges(edges, skill, skill.recommends, "recommends", index);
		}
		return edges;
	}

	/**
	 * single skill의 relation을 canonical edge로 추가합니다.
	 */
	private pushRelationEdges(
		edges: SkillRelationGraphEdge[],
		skill: RawSkill,
		targets: string[],
		relation: SkillRelationEdgeKind,
		index: IndexArtifacts,
	): void {
		for (const target of targets) {
			const resolvedName = index.aliasToCanonical.get(target);
			edges.push({
				from: skill.canonicalName,
				to: resolvedName,
				target,
				relation,
				resolved: Boolean(resolvedName),
			});
		}
	}

	/**
	 * relation edge를 source/target canonical 기준 map으로 그룹화합니다.
	 */
	private groupEdgesByCanonical(edges: SkillRelationGraphEdge[], direction: "from" | "to"): Map<string, SkillRelationGraphEdge[]> {
		const grouped = new Map<string, SkillRelationGraphEdge[]>();
		for (const edge of edges) {
			const key = direction === "from" ? edge.from : edge.to;
			if (!key) {
				continue;
			}
			const bucket = grouped.get(key) ?? [];
			bucket.push(edge);
			grouped.set(key, bucket);
		}
		return grouped;
	}

	/**
	 * seed에서 adjacency를 따라 도달 가능한 canonical node 집합을 계산합니다.
	 */
	private collectReachableNodeNames(
		seeds: string[],
		adjacency: Map<string, SkillRelationGraphEdge[]>,
		pickNext: (edge: SkillRelationGraphEdge) => string | undefined,
	): Set<string> {
		const visited = new Set<string>(seeds);
		const queue = [...seeds];
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) {
				continue;
			}
			for (const edge of adjacency.get(current) ?? []) {
				const next = pickNext(edge);
				if (!next || visited.has(next)) {
					continue;
				}
				visited.add(next);
				queue.push(next);
			}
		}
		return visited;
	}

	/**
	 * canonical node 집합을 graph payload로 투영합니다.
	 */
	private buildRelationGraphSlice(
		index: IndexArtifacts,
		mode: SkillGraphMode,
		seeds: string[],
		nodeNames: Set<string>,
		edges: SkillRelationGraphEdge[],
		resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
		orphanNames: string[],
		cycles?: string[][],
	): SkillRelationGraph {
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const nodes = Array.from(nodeNames)
			.map((name) => skillByName.get(name))
			.filter((skill): skill is RawSkill => Boolean(skill))
			.sort((left, right) => left.canonicalName.localeCompare(right.canonicalName))
			.map(
				(skill) =>
					({
						name: skill.canonicalName,
						path: skill.path,
						category: skill.category,
						title: skill.title,
						aliases: skill.aliases,
					}) satisfies SkillRelationGraphNode,
			);
		const edgeSlice = edges
			.filter((edge) => nodeNames.has(edge.from) && (!edge.to || nodeNames.has(edge.to)))
			.sort((left, right) => {
				if (left.from !== right.from) {
					return left.from.localeCompare(right.from);
				}
				if ((left.to ?? left.target) !== (right.to ?? right.target)) {
					return (left.to ?? left.target).localeCompare(right.to ?? right.target);
				}
				return left.relation.localeCompare(right.relation);
			});
		const cycleList = cycles ?? this.collectRelationCycles(index, resolvedEdges, nodeNames);
		const { readLayers, applyLayers } =
			mode === "cycles" ? { readLayers: [], applyLayers: [] } : this.buildRelationGraphLayers(nodeNames, resolvedEdges);

		return {
			mode,
			seeds,
			nodes,
			edges: edgeSlice,
			readLayers,
			applyLayers,
			missing: edgeSlice
				.filter((edge) => !edge.resolved)
				.map((edge) => ({
					name: edge.target,
					relation: edge.relation === "requires" ? "required" : "recommended",
					via: edge.from,
					depth: 1,
				})),
			cycles: cycleList,
			orphans: orphanNames.filter((name) => nodeNames.has(name)),
			diagnostics: {
				duplicateCanonicalEntries: index.stats.duplicateCanonicalEntries,
				duplicateAliasEntries: this.dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries),
			},
		};
	}

	/**
	 * resolved relation graph의 strongly connected component를 계산합니다.
	 */
	private collectStronglyConnectedComponents(
		nodeNames: Set<string>,
		resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
	): string[][] {
		const adjacency = new Map<string, string[]>();
		for (const nodeName of nodeNames) {
			adjacency.set(nodeName, []);
		}
		for (const edge of resolvedEdges) {
			if (!nodeNames.has(edge.from) || !nodeNames.has(edge.to)) {
				continue;
			}
			adjacency.get(edge.from)?.push(edge.to);
		}

		const stack: string[] = [];
		const onStack = new Set<string>();
		const indexByNode = new Map<string, number>();
		const lowLinkByNode = new Map<string, number>();
		const components: string[][] = [];
		let nextIndex = 0;

		const visit = (nodeName: string): void => {
			indexByNode.set(nodeName, nextIndex);
			lowLinkByNode.set(nodeName, nextIndex);
			nextIndex += 1;
			stack.push(nodeName);
			onStack.add(nodeName);

			for (const next of adjacency.get(nodeName) ?? []) {
				if (!indexByNode.has(next)) {
					visit(next);
					lowLinkByNode.set(nodeName, Math.min(lowLinkByNode.get(nodeName) ?? 0, lowLinkByNode.get(next) ?? 0));
					continue;
				}
				if (onStack.has(next)) {
					lowLinkByNode.set(nodeName, Math.min(lowLinkByNode.get(nodeName) ?? 0, indexByNode.get(next) ?? 0));
				}
			}

			if ((lowLinkByNode.get(nodeName) ?? -1) !== (indexByNode.get(nodeName) ?? -2)) {
				return;
			}

			const component: string[] = [];
			while (stack.length > 0) {
				const stacked = stack.pop();
				if (!stacked) {
					continue;
				}
				onStack.delete(stacked);
				component.push(stacked);
				if (stacked === nodeName) {
					break;
				}
			}
			component.sort();
			components.push(component);
		};

		for (const nodeName of Array.from(nodeNames).sort()) {
			if (!indexByNode.has(nodeName)) {
				visit(nodeName);
			}
		}

		return components.sort((left, right) => this.compareGraphComponents(left, right));
	}

	/**
	 * pack entry 우선순위 비교자입니다.
	 */
	private comparePackEntries(left: SkillPackEntry, right: SkillPackEntry): number {
		const reasonDelta = this.composeReasonPriority(right.reason) - this.composeReasonPriority(left.reason);
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
	 * graph slice에서 cycle component를 계산합니다.
	 */
	private collectRelationCycles(
		index: IndexArtifacts,
		resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
		nodeNames?: Set<string>,
	): string[][] {
		const scopedNodeNames = nodeNames ?? new Set(index.skills.map((skill) => skill.canonicalName));
		const components = this.collectStronglyConnectedComponents(scopedNodeNames, resolvedEdges);
		return components.filter((component) => {
			if (component.length > 1) {
				return true;
			}
			const nodeName = component[0];
			return resolvedEdges.some((edge) => edge.from === nodeName && edge.to === nodeName && scopedNodeNames.has(nodeName));
		});
	}

	/**
	 * graph slice의 dependency layer order를 계산합니다.
	 */
	private buildRelationGraphLayers(
		nodeNames: Set<string>,
		resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
	): { readLayers: string[][]; applyLayers: string[][] } {
		const components = this.collectStronglyConnectedComponents(nodeNames, resolvedEdges);
		const componentIndexByNode = new Map<string, number>();
		components.forEach((component, index) => {
			for (const nodeName of component) {
				componentIndexByNode.set(nodeName, index);
			}
		});

		const dependencyEdges = new Set<string>();
		const applyEdges = new Set<string>();
		for (const edge of resolvedEdges) {
			if (!nodeNames.has(edge.from) || !nodeNames.has(edge.to)) {
				continue;
			}
			const fromIndex = componentIndexByNode.get(edge.from);
			const toIndex = componentIndexByNode.get(edge.to);
			if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) {
				continue;
			}
			dependencyEdges.add(`${toIndex}:${fromIndex}`);
			applyEdges.add(`${fromIndex}:${toIndex}`);
		}

		return {
			readLayers: this.buildTopologicalLayers(components, dependencyEdges),
			applyLayers: this.buildTopologicalLayers(components, applyEdges),
		};
	}

	/**
	 * component DAG를 layer 순서로 정렬합니다.
	 */
	private buildTopologicalLayers(components: string[][], serializedEdges: Set<string>): string[][] {
		const outgoing = new Map<number, Set<number>>();
		const indegree = new Map<number, number>();
		for (let index = 0; index < components.length; index += 1) {
			outgoing.set(index, new Set<number>());
			indegree.set(index, 0);
		}
		for (const serialized of serializedEdges) {
			const [fromRaw, toRaw] = serialized.split(":");
			const fromIndex = Number(fromRaw);
			const toIndex = Number(toRaw);
			const bucket = outgoing.get(fromIndex);
			if (!bucket || bucket.has(toIndex)) {
				continue;
			}
			bucket.add(toIndex);
			indegree.set(toIndex, (indegree.get(toIndex) ?? 0) + 1);
		}

		const remaining = new Set<number>(components.map((_, index) => index));
		const layers: string[][] = [];
		while (remaining.size > 0) {
			const currentLayer = Array.from(remaining)
				.filter((index) => (indegree.get(index) ?? 0) === 0)
				.sort((left, right) => this.compareGraphComponents(components[left] ?? [], components[right] ?? []));
			if (currentLayer.length === 0) {
				layers.push(
					Array.from(remaining)
						.sort((left, right) => this.compareGraphComponents(components[left] ?? [], components[right] ?? []))
						.flatMap((index) => components[index] ?? []),
				);
				break;
			}
			layers.push(currentLayer.flatMap((index) => components[index] ?? []));
			for (const index of currentLayer) {
				remaining.delete(index);
				for (const next of outgoing.get(index) ?? []) {
					indegree.set(next, (indegree.get(next) ?? 0) - 1);
				}
			}
		}
		return layers;
	}

	/**
	 * graph component 정렬 비교자입니다.
	 */
	private compareGraphComponents(left: string[], right: string[]): number {
		return (left[0] ?? "").localeCompare(right[0] ?? "");
	}

	/**
	 * duplicate alias conflict를 dedupe합니다.
	 */
	private dedupeDuplicateAliasEntries(entries: IndexedStats["duplicateAliasEntries"]): IndexedStats["duplicateAliasEntries"] {
		const deduped = new Map<string, IndexedStats["duplicateAliasEntries"][number]>();
		for (const entry of entries) {
			deduped.set(`${entry.alias}:${entry.canonicalName}:${entry.conflictingCanonicalName}`, entry);
		}
		return Array.from(deduped.values()).sort((left, right) => {
			if (left.alias !== right.alias) {
				return left.alias.localeCompare(right.alias);
			}
			if (left.canonicalName !== right.canonicalName) {
				return left.canonicalName.localeCompare(right.canonicalName);
			}
			return left.conflictingCanonicalName.localeCompare(right.conflictingCanonicalName);
		});
	}

	/**
	 * compose 엔트리의 우선순위를 비교합니다.
	 */
	private isBetterComposeEntry(candidate: ComposedSkillEntry, existing: ComposedSkillEntry): boolean {
		const priorityDelta = this.composeReasonPriority(candidate.reason) - this.composeReasonPriority(existing.reason);
		if (priorityDelta !== 0) {
			return priorityDelta > 0;
		}
		if (candidate.depth !== existing.depth) {
			return candidate.depth < existing.depth;
		}
		return (candidate.via ?? "").localeCompare(existing.via ?? "") < 0;
	}

	/**
	 * compose relation 강도 우선순위를 반환합니다.
	 */
	private composeReasonPriority(reason: ComposedSkillEntry["reason"]): number {
		switch (reason) {
			case "seed":
				return 3;
			case "required":
				return 2;
			case "recommended":
				return 1;
			default:
				return 0;
		}
	}

	/**
	 * 중복 missing relation을 제거하고 정렬합니다.
	 */
	private dedupeMissingRelations(relations: MissingSkillRelation[]): MissingSkillRelation[] {
		const deduped = new Map<string, MissingSkillRelation>();
		for (const relation of relations) {
			deduped.set(`${relation.relation}:${relation.name}:${relation.via}:${relation.depth}`, relation);
		}
		return Array.from(deduped.values()).sort((left, right) => {
			if (left.depth !== right.depth) {
				return left.depth - right.depth;
			}
			if (left.relation !== right.relation) {
				return left.relation.localeCompare(right.relation);
			}
			if (left.via !== right.via) {
				return left.via.localeCompare(right.via);
			}
			return left.name.localeCompare(right.name);
		});
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
		for (const edge of this.buildRelationGraphEdges(index)) {
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

	/**
	 * markdown 본문에서 첫 heading title을 추출합니다.
	 */
	private headingTitle(body: string): string {
		for (const line of body.split(/\r?\n/)) {
			const hit = /^(#+)\s*(.+)$/.exec(line.trim());
			if (hit) {
				return hit[2].trim().slice(0, 80);
			}
		}
		return "";
	}

	/**
	 * skill의 검색 필드를 기존 tokenizer로 정규화합니다.
	 */
	private buildSearchDocument(skill: RawSkill): SkillSearchDocument {
		return {
			skillId: skill.id,
			canonicalName: this.serializeSearchText(skill.canonicalName),
			aliases: this.serializeSearchText(skill.aliases.join(" ")),
			title: this.serializeSearchText(skill.title),
			description: this.serializeSearchText(skill.frontmatter.description ?? ""),
			category: this.serializeSearchText(skill.category),
			keywords: this.serializeSearchText(skill.keywords.join(" ")),
			tags: this.serializeSearchText(skill.tags.join(" ")),
			bodyText: this.serializeSearchText(skill.bodyText),
		};
	}

	/**
	 * base token을 유지하면서 한국어 derived token을 보강합니다.
	 */
	private serializeSearchText(text: string): string {
		if (!text) {
			return "";
		}
		const tokenization = this.searchTokenizer.tokenizeDocumentText(text);
		return [...tokenization.baseTokens, ...tokenization.derivedTokens.map((token) => token.token)].join(" ");
	}

	/**
	 * canonical name 우선, 첫 alias 우선 순서로 exact lookup을 구성합니다.
	 */
	private buildAliasToCanonical(skills: RawSkill[], stats?: IndexedStats): Map<string, string> {
		const aliasToCanonical = new Map<string, string>();
		for (const skill of skills) {
			aliasToCanonical.set(skill.canonicalName, skill.canonicalName);
		}
		for (const skill of skills) {
			for (const alias of skill.aliases) {
				const existingCanonical = aliasToCanonical.get(alias);
				if (!existingCanonical) {
					aliasToCanonical.set(alias, skill.canonicalName);
					continue;
				}
				if (existingCanonical !== skill.canonicalName) {
					stats?.duplicateAliasEntries.push({
						alias,
						canonicalName: existingCanonical,
						conflictingCanonicalName: skill.canonicalName,
					});
				}
			}
		}
		return aliasToCanonical;
	}

	/**
	 * process-local active snapshot 상태를 초기화합니다.
	 */
	private clearActiveIndex(): void {
		this.cachedIndex = null;
		this.activeSnapshotToken = "";
	}
}
