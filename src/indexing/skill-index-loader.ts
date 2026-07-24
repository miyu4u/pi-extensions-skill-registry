import type { IndexArtifacts, IndexedStats, RawSkill, ToolContext } from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import type { ActiveIndexStore } from "./active-index-store";
import type { SkillDocumentParser } from "./skill-document-parser";
import type { SkillFileScanner } from "./skill-file-scanner";
import { normalizeSkillName } from "./skill-name-normalizer";
import type { SkillScopeResolverInterface, SkillScopeRootEntry } from "./skill-scope-resolver.interface";
import type { SkillSearchDatabaseInterface, SkillSearchDocument, SkillSearchSnapshot } from "./skill-search-database.interface";

type ScopedIndexedStats = IndexedStats & {
	scopeDistribution: Record<string, number>;
};
/**
 * scope 선택/필터 상태에서 통계가 의존하는 요청 실행 결과를 기술합니다.
 */

/** Skill index 생성, cache, snapshot lifecycle의 concrete owner입니다. */
export class SkillIndexLoader {
	constructor(
		private readonly searchDatabase: SkillSearchDatabaseInterface,
		private readonly searchTokenizer: SearchTokenizerInterface,
		private readonly fileScanner: SkillFileScanner,
		private readonly documentParser: SkillDocumentParser,
		private readonly activeIndexStore: ActiveIndexStore,
		private readonly scopeResolver?: SkillScopeResolverInterface,
	) {}

	/**
	 * Resolver가 매칭하지 못한 경로를 표현하기 위한 고정 라벨입니다.
	 */
	private readonly unclassifiedScope = "unclassified";

	/**
	 * 열린 SQLite index와 process cache를 닫습니다.
	 */
	close(): void {
		this.searchDatabase.close();
		this.activeIndexStore.clear();
		this.activeIndexStore.setDatabasePath("");
	}

	/**
	 * 정규화된 context 기준으로 skill index를 로드합니다.
	 */
	async loadIndex(input: ToolContext): Promise<IndexArtifacts> {
		const normalizedPreset = input.settings.presetSkills.map((name) => normalizeSkillName(name));
		const explicitScopes = input.scopesExplicit === true;
		const scopeEntries = this.resolveScopeEntries(
			input.settings.scopeRoots,
			input.settings.scopePriority,
			explicitScopes ? input.scopes : undefined,
		);
		const scopeSelection = this.buildScopeSelection(input, explicitScopes, scopeEntries);
		const scopedRootMap = this.buildScopeRootMap(scopeEntries);
		const scopedRoots = this.flattenScopeRoots(scopedRootMap);
		const scopePriority = this.dedupeValues(input.settings.scopePriority);
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
		const stats: ScopedIndexedStats = {
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
			scopeDistribution: {},
		};

		const requestKey = JSON.stringify({
			roots: input.roots,
			fileNames: input.fileNames,
			names: effectiveNames,
			preset: normalizedPreset,
			nameFilterMode: shouldFilterByRequestedNames ? "targeted" : "full",
			databasePath: input.settings.databasePath,
			selectedScopes: scopeSelection.scopes,
			scopesExplicit: explicitScopes,
			effectiveRoots: scopedRoots,
			normalizedScopeMap: scopedRootMap,
			scopePriority,
		});
		const now = Date.now();
		const databasePath = input.settings.databasePath;

		if (this.activeIndexStore.cachedDatabasePath && this.activeIndexStore.cachedDatabasePath !== databasePath) {
			this.searchDatabase.close();
			this.activeIndexStore.clear();
		}
		await this.searchDatabase.initialize(databasePath);
		this.activeIndexStore.setDatabasePath(databasePath);

		if (!input.refresh && this.activeIndexStore.cachedIndex && this.activeIndexStore.cachedIndex.requestKey === requestKey) {
			const isUnexpired = now - this.activeIndexStore.cachedIndex.generatedAt < this.activeIndexStore.cachedIndex.ttlMs;
			if (isUnexpired && this.searchDatabase.isSnapshotCurrent(this.activeIndexStore.activeSnapshotToken)) {
				return this.activeIndexStore.cachedIndex;
			}
			this.activeIndexStore.clear();
		}

		if (!input.refresh) {
			const persistedSnapshot = this.searchDatabase.readSnapshot(requestKey, now);
			if (persistedSnapshot) {
				return this.activateSnapshot(persistedSnapshot);
			}
		}

		const buildStartedAt = Date.now();
		if (scopeSelection.safeZero) {
			const emptySnapshot = this.searchDatabase.replaceSnapshot(
				{
					generatedAt: now,
					ttlMs: input.settings.cacheTtlMs,
					requestKey,
					settings: input.settings,
					requestedNames: effectiveNames,
					skills: [],
					stats,
					buildStartedAt,
				},
				[],
			);
			return this.activateSnapshot(emptySnapshot);
		}
		const bestByCanonical = new Map<string, RawSkill>();
		const scopePriorityRank = this.buildScopeRank(input.settings.scopePriority);
		let indexBuildMode: "targeted" | "full" = shouldFilterByRequestedNames ? "targeted" : "full";

		for (const root of input.roots) {
			if (
				explicitScopes &&
				!scopeSelection.safeZero &&
				!this.isRootAllowedByExplicitScopes(root, scopeSelection.scopeSet, scopeEntries)
			) {
				continue;
			}
			const scanResult = this.fileScanner.scan(root, input.fileNames, scanRequestedSet);
			if (scanResult.missingRoot) {
				stats.skippedMissingRoot += 1;
				continue;
			}

			const { mode, files } = scanResult;
			if (mode === "full") {
				indexBuildMode = "full";
			}
			stats.totalFilesVisited += files.length;

			for (const skillFile of files) {
				const parseIssues: string[] = [];
				const candidate = this.documentParser.parseSkillFile(skillFile, root, parseIssues);
				if (!candidate) {
					stats.parseErrors += 1;
					stats.malformedFiles.push({
						path: skillFile,
						reason: parseIssues[0] ?? "skill file could not be parsed",
					});
					continue;
				}
				stats.totalParsed += 1;
				const skillScope = this.resolveSkillScope(skillFile, scopeEntries);
				candidate.scope = skillScope;
				if (explicitScopes && !scopeSelection.safeZero && !scopeSelection.scopeSet.has(skillScope)) {
					continue;
				}

				const matchedRequestedNames =
					requestedSet.size > 0 ? [candidate.canonicalName, ...candidate.aliases].filter((name) => requestedSet.has(name)) : [];
				if (shouldFilterByRequestedNames && matchedRequestedNames.length === 0) {
					continue;
				}
				const existing = bestByCanonical.get(candidate.canonicalName);
				if (existing) {
					stats.deduplicated += 1;
					const keepExisting = this.isPreferredCanonicalCollision(existing, candidate, scopePriorityRank) <= 0;
					stats.duplicateCanonicalEntries.push({
						canonicalName: candidate.canonicalName,
						keptPath: keepExisting ? existing.path : candidate.path,
						droppedPath: keepExisting ? candidate.path : existing.path,
					});
					if (keepExisting) {
						continue;
					}
				}

				bestByCanonical.set(candidate.canonicalName, candidate);
				stats.missingFromRequested = stats.missingFromRequested.filter((name) => !matchedRequestedNames.includes(name));
			}
		}

		stats.nameFilterMode = indexBuildMode;
		const skills = Array.from(bestByCanonical.values());
		stats.scopeDistribution = this.buildScopeDistribution(skills);
		this.buildAliasToCanonical(skills, stats, scopePriorityRank);
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
		const scopePriorityRank = this.buildScopeRank(snapshot.settings.scopePriority);
		const aliasToCanonical = this.buildAliasToCanonical(snapshot.skills, undefined, scopePriorityRank);
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

		this.activeIndexStore.activate(indexData, snapshot.snapshotToken);
		return indexData;
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
	 * 설정 scopePriority 기준으로 scope를 정수 순위로 정규화합니다.
	 * 목록 앞쪽이 더 높은 우선순위입니다.
	 */
	private buildScopeRank(scopePriority: string[]): Map<string, number> {
		const scopeRankByName = new Map<string, number>();
		for (const scopeName of this.dedupeValues(scopePriority)) {
			if (scopeRankByName.has(scopeName)) {
				continue;
			}
			scopeRankByName.set(scopeName, scopeRankByName.size);
		}
		return scopeRankByName;
	}

	/**
	 * 비교 대상 canonical의 우선순위를 결정합니다.
	 * priority 값이 낮을수록 더 선호되며, 미지정 스코프는 가장 낮은 우선순위로 간주합니다.
	 */
	private getScopePriority(scope: string | undefined, scopePriorityRank: Map<string, number>): number {
		const normalizedScope = scope?.trim();
		if (!normalizedScope) {
			return Number.MAX_SAFE_INTEGER;
		}
		return scopePriorityRank.get(normalizedScope) ?? Number.MAX_SAFE_INTEGER;
	}

	/**
	 * canonical 중복에서 기존 skill이 새 후보보다 우선인지 판단합니다.
	 * 1) scopePriority, 2) 최신 mtime, 3) 경로 사전식 정렬로
	 * traversal 의존성을 제거해 완전 결정적 승자를 만듭니다.
	 */
	private isPreferredCanonicalCollision(existing: RawSkill, candidate: RawSkill, scopePriorityRank: Map<string, number>): number {
		const existingPriority = this.getScopePriority(existing.scope, scopePriorityRank);
		const candidatePriority = this.getScopePriority(candidate.scope, scopePriorityRank);
		if (existingPriority !== candidatePriority) {
			return existingPriority < candidatePriority ? -1 : 1;
		}
		if (existing.mtimeMs !== candidate.mtimeMs) {
			return existing.mtimeMs > candidate.mtimeMs ? -1 : 1;
		}
		if (existing.path === candidate.path) {
			return 0;
		}
		return existing.path.localeCompare(candidate.path) <= 0 ? -1 : 1;
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
	 * scope resolver와 요청 모드에 따라 scope-root 해석 엔트리를 구성합니다.
	 */
	private resolveScopeEntries(
		scopeRoots: Record<string, string[]>,
		scopePriority: string[],
		requestedScopes?: string[] | readonly string[],
	): SkillScopeRootEntry[] {
		if (!this.scopeResolver) {
			return [];
		}
		return this.scopeResolver.resolveScopeRootEntries(scopeRoots, scopePriority, requestedScopes);
	}

	/**
	 * 명시 스코프 모드인지에 따라 요청 스코프, Set, safe-zero 필요 여부를 계산합니다.
	 */
	private buildScopeSelection(
		input: ToolContext,
		explicitScopes: boolean,
		scopeEntries: readonly SkillScopeRootEntry[],
	): {
		scopes: string[];
		scopeSet: Set<string>;
		safeZero: boolean;
	} {
		if (!explicitScopes) {
			const scopes = this.dedupeValues(scopeEntries.map((entry) => entry.scope)).sort((a, b) => a.localeCompare(b));
			return {
				scopes,
				scopeSet: new Set(scopes),
				safeZero: false,
			};
		}

		const selectedScopes = this.dedupeValues(input.scopes);
		if (selectedScopes.length === 0 || scopeEntries.length === 0) {
			return {
				scopes: selectedScopes,
				scopeSet: new Set(),
				safeZero: true,
			};
		}

		return {
			scopes: selectedScopes,
			scopeSet: new Set(selectedScopes),
			safeZero: false,
		};
	}

	/**
	 * resolver가 산출한 scope-root 엔트리를 스코프별 정규화 맵으로 정렬합니다.
	 */
	private buildScopeRootMap(entries: readonly SkillScopeRootEntry[]): Record<string, string[]> {
		const grouped: Record<string, Set<string>> = {};
		for (const { scope, root } of entries) {
			let bucket = grouped[scope];
			if (!bucket) {
				grouped[scope] = new Set();
				bucket = grouped[scope];
			}
			bucket?.add(root);
		}

		const map: Record<string, string[]> = {};
		const scopes = this.dedupeValues(Object.keys(grouped)).sort((a, b) => a.localeCompare(b));
		for (const scope of scopes) {
			const bucket = grouped[scope];
			map[scope] = bucket ? [...bucket].sort((a, b) => a.localeCompare(b)) : [];
		}
		return map;
	}

	/**
	 * 스코프별 루트 맵을 request key에 쓰기 위해 정렬된 단일 루트 배열로 펼칩니다.
	 */
	private flattenScopeRoots(scopeMap: Record<string, string[]>): string[] {
		const flattened: string[] = [];
		for (const scope of Object.keys(scopeMap).sort((a, b) => a.localeCompare(b))) {
			flattened.push(...scopeMap[scope]);
		}
		return flattened;
	}

	/**
	 * explicit 스코프 요청에서 root 단위로 스캔을 생략할지 판정합니다.
	 */
	private isRootAllowedByExplicitScopes(
		root: string,
		requestedScopes: ReadonlySet<string>,
		scopeEntries: readonly SkillScopeRootEntry[],
	): boolean {
		if (!this.scopeResolver || requestedScopes.size === 0) {
			return true;
		}
		const normalizedRoot = this.normalizeBoundaryPathForAncestorFilter(root);
		if (!normalizedRoot) {
			return false;
		}

		for (const { scope, root: resolvedRoot } of scopeEntries) {
			if (!requestedScopes.has(scope)) {
				continue;
			}
			const normalizedScopeRoot = this.normalizeBoundaryPathForAncestorFilter(resolvedRoot);
			if (!normalizedScopeRoot) {
				continue;
			}
			if (this.isBoundaryMatch(normalizedRoot, normalizedScopeRoot) || this.isBoundaryMatch(normalizedScopeRoot, normalizedRoot)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 경계 매칭에 사용할 경로 문자열을 슬래시 통일 및 trailing separator 제거로 정규화합니다.
	 */
	private normalizeBoundaryPathForAncestorFilter(rawPath: string): string {
		if (!rawPath) {
			return "";
		}
		const normalized = rawPath.replace(/\\/g, "/");
		if (normalized.length <= 1) {
			return normalized;
		}
		if (/^[A-Za-z]:\/$/u.test(normalized)) {
			return normalized;
		}
		return normalized.replace(/\/+$/u, "");
	}

	/**
	 * 두 경로가 경계 기준으로 포함 관계인지 판단합니다.
	 */
	private isBoundaryMatch(candidatePath: string, root: string): boolean {
		if (!candidatePath || !root) {
			return false;
		}
		if (root === "/") {
			return candidatePath.startsWith("/");
		}
		if (/^[A-Za-z]:\/$/u.test(root)) {
			return candidatePath.startsWith(root);
		}
		if (candidatePath === root) {
			return true;
		}
		return candidatePath.startsWith(`${root}/`);
	}

	/**
	 * 파싱된 문서를 scope 라벨로 분류해 글로벌 corpus 분할 누수를 차단합니다.
	 */
	private resolveSkillScope(skillPath: string, scopeEntries: readonly SkillScopeRootEntry[]): string {
		if (!this.scopeResolver || scopeEntries.length === 0) {
			return this.unclassifiedScope;
		}
		return this.scopeResolver.classifySourcePath(skillPath, scopeEntries);
	}

	/**
	 * 최종 삽입되는 스킬 목록 기준으로 scope 분포 통계를 계산합니다.
	 */
	private buildScopeDistribution(skills: readonly RawSkill[]): Record<string, number> {
		const distribution: Record<string, number> = {};
		for (const skill of skills) {
			const scope = skill.scope ?? this.unclassifiedScope;
			distribution[scope] = (distribution[scope] ?? 0) + 1;
		}
		return distribution;
	}

	/**
	 * 입력 문자열 배열을 정렬을 유지한 상태로 중복 제거합니다.
	 */
	private dedupeValues(values: readonly string[]): string[] {
		const seen = new Set<string>();
		const result: string[] = [];
		for (const value of values) {
			if (seen.has(value)) {
				continue;
			}
			seen.add(value);
			result.push(value);
		}
		return result;
	}

	/**
	 * canonical name 우선, scopePriority 기반 alias precedence로 exact lookup을 구성합니다.
	 */
	private buildAliasToCanonical(
		skills: RawSkill[],
		stats?: IndexedStats,
		scopePriorityRank: Map<string, number> = new Map(),
	): Map<string, string> {
		const aliasToCanonical = new Map<string, string>();
		const canonicalToSkill = new Map<string, RawSkill>();
		for (const skill of skills) {
			aliasToCanonical.set(skill.canonicalName, skill.canonicalName);
			canonicalToSkill.set(skill.canonicalName, skill);
		}
		for (const skill of skills) {
			for (const alias of skill.aliases) {
				const existingCanonical = aliasToCanonical.get(alias);
				if (!existingCanonical) {
					aliasToCanonical.set(alias, skill.canonicalName);
					continue;
				}
				if (existingCanonical !== skill.canonicalName) {
					const existingSkill = canonicalToSkill.get(existingCanonical);
					const preferredCanonical =
						existingSkill && this.isPreferredCanonicalCollision(existingSkill, skill, scopePriorityRank) > 0
							? skill.canonicalName
							: existingCanonical;
					if (preferredCanonical !== existingCanonical) {
						aliasToCanonical.set(alias, preferredCanonical);
					}
					stats?.duplicateAliasEntries.push({
						alias,
						canonicalName: preferredCanonical,
						conflictingCanonicalName: preferredCanonical === existingCanonical ? skill.canonicalName : existingCanonical,
					});
				}
			}
		}
		return aliasToCanonical;
	}
}
