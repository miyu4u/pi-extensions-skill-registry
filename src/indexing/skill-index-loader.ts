import type { IndexArtifacts, IndexedStats, RawSkill, ToolContext } from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import type { ActiveIndexStore } from "./active-index-store";
import type { SkillDocumentParser } from "./skill-document-parser";
import type { SkillFileScanner } from "./skill-file-scanner";
import { normalizeSkillName } from "./skill-name-normalizer";
import type { SkillSearchDatabaseInterface, SkillSearchDocument, SkillSearchSnapshot } from "./skill-search-database.interface";

/** Skill index 생성, cache, snapshot lifecycle의 concrete owner입니다. */
export class SkillIndexLoader {
	constructor(
		private readonly searchDatabase: SkillSearchDatabaseInterface,
		private readonly searchTokenizer: SearchTokenizerInterface,
		private readonly fileScanner: SkillFileScanner,
		private readonly documentParser: SkillDocumentParser,
		private readonly activeIndexStore: ActiveIndexStore,
	) {}

	/**
	 * 열린 SQLite index와 process cache를 닫습니다.
	 */
	close(): void {
		this.searchDatabase.close();
		this.activeIndexStore.clear();
		this.activeIndexStore.cachedDatabasePath = "";
	}

	/**
	 * 정규화된 context 기준으로 skill index를 로드합니다.
	 */
	async loadIndex(input: ToolContext): Promise<IndexArtifacts> {
		const normalizedPreset = input.settings.presetSkills.map((name) => normalizeSkillName(name));
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

		if (this.activeIndexStore.cachedDatabasePath && this.activeIndexStore.cachedDatabasePath !== databasePath) {
			this.searchDatabase.close();
			this.activeIndexStore.clear();
		}
		await this.searchDatabase.initialize(databasePath);
		this.activeIndexStore.cachedDatabasePath = databasePath;

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
		const bestByCanonical = new Map<string, RawSkill>();
		let indexBuildMode: "targeted" | "full" = shouldFilterByRequestedNames ? "targeted" : "full";

		for (const root of input.roots) {
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
}
