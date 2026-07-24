import { describe, expect, test } from "@jest/globals";
import type { IndexedStats, RawSkill, ToolContext } from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import { ActiveIndexStore } from "./active-index-store";
import type { SkillDocumentParser } from "./skill-document-parser";
import type { SkillFileScanner } from "./skill-file-scanner";
import { SkillIndexLoader } from "./skill-index-loader";
import type { SkillScopeResolverInterface } from "./skill-scope-resolver.interface";
import { SkillScopeResolverService } from "./skill-scope-resolver.service";
import type {
	SkillSearchDatabaseInterface,
	SkillSearchDocument,
	SkillSearchSnapshot,
	SkillSearchSnapshotInput,
} from "./skill-search-database.interface";
import type { SourceManifestInterface } from "./source-manifest.interface";
import { SourceManifestService } from "./source-manifest.service";

/**
 * SnapshotInput fixture가 재사용할 유효한 64-hex sourceSignature입니다.
 */
const VALID_SOURCE_SIGNATURE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STALE_SOURCE_SIGNATURE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FRESH_SOURCE_SIGNATURE = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function makeSourceFiles(files: readonly string[]): Array<{ path: string; size: number; mtimeMs: number }> {
	return files.map((filePath) => ({ path: filePath, size: 1, mtimeMs: 1 }));
}

function makeStats(): IndexedStats {
	return {
		totalFilesVisited: 0,
		totalParsed: 0,
		skippedMissingRoot: 0,
		parseErrors: 0,
		deduplicated: 0,
		missingFromRequested: [],
		malformedFiles: [],
		duplicateCanonicalEntries: [],
		duplicateAliasEntries: [],
		nameFilterMode: "full",
	};
}

function makeSkill(name: string): RawSkill {
	return {
		id: name,
		canonicalName: name,
		path: `/skills/${name}/SKILL.md`,
		sourceRoot: "/skills",
		rawFrontmatter: { name },
		frontmatter: { name, aliases: [], requires: [], recommends: [] },
		bodyText: `${name} body`,
		title: name,
		category: "test",
		keywords: [],
		tags: [],
		aliases: [],
		requires: [],
		recommends: [],
		text: `${name} body`,
		mtimeMs: 1,
	};
}

function makeContext(databasePath: string, overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		action: "index",
		names: [],
		orderedNames: [],
		scopes: [],
		suggestionLimit: 3,
		roots: ["/skills"],
		fileNames: ["SKILL.md"],
		limit: 10,
		taskSize: "medium",
		refresh: true,
		minScore: 0,
		includeBody: false,
		relationMode: "required",
		graphMode: "outbound",
		budgetChars: 0,
		budgetTokens: 0,
		coverageThreshold: 0.5,
		settings: {
			roots: ["/skills"],
			scopeRoots: {},
			scopePriority: [],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath,
			cacheTtlMs: 60_000,
			maxTopK: 10,
			includePreviewBodyChars: 250,
		},
		...overrides,
	};
}

function makeSnapshot(input: SkillSearchSnapshotInput, token: string, skills = input.skills): SkillSearchSnapshot {
	return {
		snapshotToken: token,
		generatedAt: input.generatedAt,
		ttlMs: input.ttlMs,
		requestKey: input.requestKey,
		sourceSignature: input.sourceSignature,
		settings: input.settings,
		requestedNames: input.requestedNames,
		skills,
		stats: input.stats,
		dfByTerm: new Map(),
		avgLength: 0,
		indexBuildMs: 1,
	};
}

class FakeSearchDatabase implements SkillSearchDatabaseInterface {
	initializedPaths: string[] = [];
	closeCount = 0;
	replaceCount = 0;
	persistedSnapshot: SkillSearchSnapshot | null = null;
	currentToken = "";

	async initialize(databasePath: string): Promise<void> {
		this.initializedPaths.push(databasePath);
	}

	readSnapshot(requestKey: string, _now: number): SkillSearchSnapshot | null {
		if (this.persistedSnapshot?.requestKey !== requestKey) {
			return null;
		}
		return this.persistedSnapshot;
	}

	isSnapshotCurrent(snapshotToken: string): boolean {
		return snapshotToken === this.currentToken;
	}

	replaceSnapshot(input: SkillSearchSnapshotInput, _documents: SkillSearchDocument[]): SkillSearchSnapshot {
		this.replaceCount += 1;
		this.currentToken = `snapshot-${this.replaceCount}`;
		return makeSnapshot(input, this.currentToken);
	}

	searchTerms(): ReadonlyMap<string, []> {
		return new Map();
	}

	close(): void {
		this.closeCount += 1;
		this.currentToken = "";
	}
}

/**
 * createSignature 반환값을 테스트 중간에 바꿀 수 있는 SourceManifest stub입니다.
 */
function makeControllableSourceManifest(initialSignature = VALID_SOURCE_SIGNATURE): SourceManifestInterface & { signature: string } {
	const manifest = {
		signature: initialSignature,
		createSignature(): string {
			return manifest.signature;
		},
	};
	return manifest;
}

function makeLoader(
	database: FakeSearchDatabase,
	store: ActiveIndexStore,
	scanCount: { value: number },
	scannerOverride?: Partial<SkillFileScanner>,
	parserOverride?: Partial<SkillDocumentParser>,
	resolverOverride?: SkillScopeResolverInterface,
	sourceManifestOverride?: SourceManifestInterface,
): SkillIndexLoader {
	const tokenizer = {
		tokenizeDocumentText: () => ({ baseTokens: [], derivedTokens: [], allTokens: [] }),
		tokenizeQueryText: () => ({ baseTokens: [], derivedTokens: [], allTokens: [] }),
		buildQueryVariants: () => [],
	} as SearchTokenizerInterface;
	const scanner = {
		scan: (root: string, fileNames: string[], requestedSet: Set<string>) => {
			scanCount.value += 1;
			if (scannerOverride?.scan) {
				return scannerOverride.scan(root, fileNames, requestedSet);
			}
			return { root, missingRoot: false, mode: "full", files: [], sourceFiles: [] };
		},
	} as unknown as SkillFileScanner;
	const parser = {
		parseSkillFile: (skillFile: string, root: string, parseIssues: string[]) => {
			if (parserOverride?.parseSkillFile) {
				return parserOverride.parseSkillFile(skillFile, root, parseIssues);
			}
			return null;
		},
	} as unknown as SkillDocumentParser;
	return new SkillIndexLoader(
		database,
		tokenizer,
		scanner,
		parser,
		store,
		resolverOverride ?? new SkillScopeResolverService(),
		sourceManifestOverride ?? new SourceManifestService(),
	);
}

describe("SkillIndexLoader lifecycle", () => {
	test("closes the previous database and replaces active state when the database path changes", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const loader = makeLoader(database, store, { value: 0 });

		const first = await loader.loadIndex(makeContext("/tmp/first.sqlite"));
		const second = await loader.loadIndex(makeContext("/tmp/second.sqlite"));

		expect(database.initializedPaths).toEqual(["/tmp/first.sqlite", "/tmp/second.sqlite"]);
		expect(database.closeCount).toBe(1);
		expect(store.cachedDatabasePath).toBe("/tmp/second.sqlite");
		expect(store.cachedIndex).toBe(second);
		expect(store.cachedIndex).not.toBe(first);
		expect(store.activeSnapshotToken).toBe("snapshot-2");
	});

	test("activates a persisted snapshot with its identity in ActiveIndexStore", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const manifest = makeControllableSourceManifest(VALID_SOURCE_SIGNATURE);
		const loader = makeLoader(database, store, { value: 0 }, undefined, undefined, undefined, manifest);
		const context = makeContext("/tmp/persisted.sqlite", { refresh: false });
		const identity = await loader.loadIndex({ ...context, refresh: true });
		store.clear();
		database.replaceCount = 0;
		database.currentToken = "";
		const seedInput: SkillSearchSnapshotInput = {
			generatedAt: Date.now(),
			ttlMs: context.settings.cacheTtlMs,
			requestKey: identity.requestKey,
			sourceSignature: VALID_SOURCE_SIGNATURE,
			settings: context.settings,
			requestedNames: [],
			skills: [makeSkill("persisted")],
			stats: makeStats(),
			buildStartedAt: Date.now(),
		};
		database.persistedSnapshot = makeSnapshot(seedInput, "persisted-token");

		const index = await loader.loadIndex(context);

		expect(index.skills.map((skill) => skill.canonicalName)).toEqual(["persisted"]);
		expect(store.cachedIndex).toBe(index);
		expect(store.activeSnapshotToken).toBe("persisted-token");
		expect(database.replaceCount).toBe(0);
	});

	test("prefers a persisted snapshot after the matching process cache expires", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scans = { value: 0 };
		const manifest = makeControllableSourceManifest(VALID_SOURCE_SIGNATURE);
		const loader = makeLoader(database, store, scans, undefined, undefined, undefined, manifest);
		const context = makeContext("/tmp/cache.sqlite", {
			settings: { ...makeContext("/tmp/cache.sqlite").settings, cacheTtlMs: -1 },
		});
		const initial = await loader.loadIndex(context);
		database.persistedSnapshot = {
			...makeSnapshot(
				{
					generatedAt: Date.now(),
					ttlMs: 60_000,
					requestKey: initial.requestKey,
					sourceSignature: VALID_SOURCE_SIGNATURE,
					settings: context.settings,
					requestedNames: [],
					skills: [makeSkill("persisted")],
					stats: makeStats(),
					buildStartedAt: Date.now(),
				},
				"persisted-after-expiry",
			),
			requestKey: initial.requestKey,
		};

		const restored = await loader.loadIndex({ ...context, refresh: false });

		expect(restored.skills.map((skill) => skill.canonicalName)).toEqual(["persisted"]);
		expect(scans.value).toBe(2);
		expect(database.replaceCount).toBe(1);
		expect(store.activeSnapshotToken).toBe("persisted-after-expiry");
	});

	test("clears database path, snapshot token, and cached index on close", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const loader = makeLoader(database, store, { value: 0 });
		await loader.loadIndex(makeContext("/tmp/close.sqlite"));

		loader.close();

		expect(database.closeCount).toBe(1);
		expect(store.cachedDatabasePath).toBe("");
		expect(store.activeSnapshotToken).toBe("");
		expect(store.cachedIndex).toBeNull();
	});

	test("reuses the same active index on unchanged source with one replace and one scan per load", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scans = { value: 0 };
		const manifest = makeControllableSourceManifest();
		const loader = makeLoader(database, store, scans, undefined, undefined, undefined, manifest);
		const context = makeContext("/tmp/unchanged-source.sqlite");

		const first = await loader.loadIndex(context);
		const second = await loader.loadIndex({ ...context, refresh: false });

		expect(second).toBe(first);
		expect(store.cachedIndex).toBe(first);
		expect(database.replaceCount).toBe(1);
		expect(scans.value).toBe(2);
	});

	test("activates a cold persisted snapshot on signature match without replace and with one scan", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scans = { value: 0 };
		const manifest = makeControllableSourceManifest(VALID_SOURCE_SIGNATURE);
		const loader = makeLoader(database, store, scans, undefined, undefined, undefined, manifest);
		const context = makeContext("/tmp/cold-persisted.sqlite", { refresh: false });
		const identity = await loader.loadIndex({ ...context, refresh: true });
		store.clear();
		database.replaceCount = 0;
		database.currentToken = "";
		scans.value = 0;
		const seedInput: SkillSearchSnapshotInput = {
			generatedAt: Date.now(),
			ttlMs: context.settings.cacheTtlMs,
			requestKey: identity.requestKey,
			sourceSignature: VALID_SOURCE_SIGNATURE,
			settings: context.settings,
			requestedNames: [],
			skills: [makeSkill("cold-persisted")],
			stats: makeStats(),
			buildStartedAt: Date.now(),
		};
		database.persistedSnapshot = makeSnapshot(seedInput, "cold-persisted-token");

		const index = await loader.loadIndex(context);

		expect(index.skills.map((skill) => skill.canonicalName)).toEqual(["cold-persisted"]);
		expect(index.requestKey).toBe(identity.requestKey);
		expect(index.sourceSignature).toBe(VALID_SOURCE_SIGNATURE);
		expect(store.cachedIndex).toBe(index);
		expect(store.activeSnapshotToken).toBe("cold-persisted-token");
		expect(database.replaceCount).toBe(0);
		expect(scans.value).toBe(1);
	});

	test("rebuilds once with a fresh parse when active and persisted signatures both mismatch", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scans = { value: 0 };
		const manifest = makeControllableSourceManifest(STALE_SOURCE_SIGNATURE);
		let parsedSkill = makeSkill("stale");
		const skillFile = "/skills/demo/SKILL.md";
		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root) => ({
				root,
				missingRoot: false,
				mode: "full",
				files: [skillFile],
				sourceFiles: makeSourceFiles([skillFile]),
			}),
		};
		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: () => parsedSkill,
		};
		const loader = makeLoader(database, store, scans, scannerOverride, parserOverride, undefined, manifest);
		const context = makeContext("/tmp/signature-mismatch.sqlite");

		const first = await loader.loadIndex(context);
		expect(first.sourceSignature).toBe(STALE_SOURCE_SIGNATURE);
		expect(first.skills.map((skill) => skill.canonicalName)).toEqual(["stale"]);
		expect(database.replaceCount).toBe(1);

		database.persistedSnapshot = makeSnapshot(
			{
				generatedAt: first.generatedAt,
				ttlMs: first.ttlMs,
				requestKey: first.requestKey,
				sourceSignature: STALE_SOURCE_SIGNATURE,
				settings: context.settings,
				requestedNames: [],
				skills: [makeSkill("persisted-stale")],
				stats: makeStats(),
				buildStartedAt: Date.now(),
			},
			store.activeSnapshotToken,
			[makeSkill("persisted-stale")],
		);
		manifest.signature = FRESH_SOURCE_SIGNATURE;
		parsedSkill = makeSkill("fresh");

		const second = await loader.loadIndex({ ...context, refresh: false });

		expect(database.replaceCount).toBe(2);
		expect(second.sourceSignature).toBe(FRESH_SOURCE_SIGNATURE);
		expect(second.skills.map((skill) => skill.canonicalName)).toEqual(["fresh"]);
		expect(second).not.toBe(first);
		expect(scans.value).toBe(2);
	});
});

type ScopedIndexedStats = IndexedStats & {
	scopeDistribution: Record<string, number>;
};

describe("SkillIndexLoader scope filtering and stats", () => {
	const resolver = new SkillScopeResolverService();

	test("explicit filtering: skips scanning roots not matching explicit requested scopes", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };
		const scannedRoots: string[] = [];

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				scannedRoots.push(root);
				return { root, missingRoot: false, mode: "full", files: [], sourceFiles: [] };
			},
		};

		const settings = {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"global-scope": ["/skills/global-b"],
			},
			scopePriority: ["local-scope", "global-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-filter.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-filter.sqlite", {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopes: ["local-scope"],
			scopesExplicit: true,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, undefined, resolver);
		await loader.loadIndex(context);

		expect(scannedRoots).toEqual(["/skills/local-a"]);
	});

	test("unknown/empty safe-zero: returns empty snapshot without scanning when requested scopes are empty or unknown", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: () => {
				throw new Error("Scanner should not be called in safe-zero mode");
			},
		};

		const settings = {
			roots: ["/skills/local-a"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
			},
			scopePriority: ["local-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-sz.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		// Case 1: empty scopes
		const contextEmpty = makeContext("/tmp/loader-sz.sqlite", {
			roots: ["/skills/local-a"],
			scopes: [],
			scopesExplicit: true,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, undefined, resolver);
		const indexEmpty = await loader.loadIndex(contextEmpty);

		expect(indexEmpty.skills).toEqual([]);
		expect(indexEmpty.stats.totalFilesVisited).toBe(0);

		// Case 2: unknown scopes
		const contextUnknown = makeContext("/tmp/loader-sz.sqlite", {
			roots: ["/skills/local-a"],
			scopes: ["unknown-scope"],
			scopesExplicit: true,
			settings,
		});

		const indexUnknown = await loader.loadIndex(contextUnknown);

		expect(indexUnknown.skills).toEqual([]);
		expect(indexUnknown.stats.totalFilesVisited).toBe(0);
	});

	test("omitted all-scope: scans all roots when scopes are not explicitly requested", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };
		const scannedRoots: string[] = [];

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				scannedRoots.push(root);
				return { root, missingRoot: false, mode: "full", files: [], sourceFiles: [] };
			},
		};

		const settings = {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"global-scope": ["/skills/global-b"],
			},
			scopePriority: ["local-scope", "global-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-omitted.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-omitted.sqlite", {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopes: [],
			scopesExplicit: false,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, undefined, resolver);
		await loader.loadIndex(context);

		expect(scannedRoots).toEqual(["/skills/local-a", "/skills/global-b"]);
	});

	test("request-key variation: scopes, map, priority changes yield different cache keys", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };
		const loader = makeLoader(database, store, scanCount, undefined, undefined, resolver);

		const baseSettings = {
			roots: ["/skills/local-a"],
			scopeRoots: { "local-scope": ["/skills/local-a"] },
			scopePriority: ["local-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-keys.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context1 = makeContext("/tmp/loader-keys.sqlite", {
			scopes: ["local-scope"],
			scopesExplicit: true,
			settings: baseSettings,
		});

		const context2 = makeContext("/tmp/loader-keys.sqlite", {
			scopes: [],
			scopesExplicit: false,
			settings: baseSettings,
		});

		const context3 = makeContext("/tmp/loader-keys.sqlite", {
			scopes: ["local-scope"],
			scopesExplicit: true,
			settings: {
				...baseSettings,
				scopePriority: ["other-priority"],
			},
		});

		const index1 = await loader.loadIndex(context1);
		const index2 = await loader.loadIndex(context2);
		const index3 = await loader.loadIndex(context3);

		expect(index1.requestKey).not.toEqual(index2.requestKey);
		expect(index1.requestKey).not.toEqual(index3.requestKey);
		expect(index2.requestKey).not.toEqual(index3.requestKey);
	});

	test("scope distribution: calculates parsed skill distribution stats correctly", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				if (root === "/skills/local-a") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/local-a/SKILL1.md"],
						sourceFiles: makeSourceFiles(["/skills/local-a/SKILL1.md"]),
					};
				}
				if (root === "/skills/global-b") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/global-b/SKILL2.md"],
						sourceFiles: makeSourceFiles(["/skills/global-b/SKILL2.md"]),
					};
				}
				return { root, missingRoot: false, mode: "full", files: [], sourceFiles: [] };
			},
		};

		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: (skillFile: string, root: string) => {
				const name = skillFile.includes("SKILL1.md") ? "skill-1" : "skill-2";
				return {
					...makeSkill(name),
					path: skillFile,
					sourceRoot: root,
				};
			},
		};

		const settings = {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"global-scope": ["/skills/global-b"],
			},
			scopePriority: ["local-scope", "global-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-dist.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-dist.sqlite", {
			roots: ["/skills/local-a", "/skills/global-b"],
			scopes: ["local-scope", "global-scope"],
			scopesExplicit: false,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const index = await loader.loadIndex(context);

		const stats = index.stats as ScopedIndexedStats;
		expect(stats.scopeDistribution).toEqual({
			"local-scope": 1,
			"global-scope": 1,
		});
	});

	test("category/global duplicate invariants: detects and reports duplicate canonical names and duplicate aliases", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				const files = ["/skills/local-a/SKILL1.md", "/skills/local-a/SKILL1_dup.md", "/skills/local-a/SKILL2.md"];
				return {
					root,
					missingRoot: false,
					mode: "full",
					files,
					sourceFiles: makeSourceFiles(files),
				};
			},
		};

		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: (skillFile: string, _root: string) => {
				if (skillFile.includes("SKILL1.md")) {
					const skill = makeSkill("skill-1");
					skill.path = skillFile;
					skill.mtimeMs = 100;
					skill.frontmatter.aliases = ["duplicate-alias"];
					skill.aliases = ["duplicate-alias"];
					return skill;
				}
				if (skillFile.includes("SKILL1_dup.md")) {
					const skill = makeSkill("skill-1");
					skill.path = skillFile;
					skill.mtimeMs = 200; // newer, should be kept
					skill.frontmatter.aliases = ["duplicate-alias"];
					skill.aliases = ["duplicate-alias"];
					return skill;
				}
				if (skillFile.includes("SKILL2.md")) {
					const skill = makeSkill("skill-2");
					skill.path = skillFile;
					skill.mtimeMs = 150;
					skill.frontmatter.aliases = ["duplicate-alias"]; // conflicting alias
					skill.aliases = ["duplicate-alias"];
					return skill;
				}
				return null;
			},
		};

		const settings = {
			roots: ["/skills/local-a"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
			},
			scopePriority: ["local-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-dups.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-dups.sqlite", {
			roots: ["/skills/local-a"],
			scopes: ["local-scope"],
			scopesExplicit: false,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const index = await loader.loadIndex(context);

		// Verify duplicate canonical entries logic:
		// skill-1 is duplicated. The kept path should be the one with mtimeMs = 200 (/skills/local-a/SKILL1_dup.md)
		// The dropped path should be the one with mtimeMs = 100 (/skills/local-a/SKILL1.md)
		expect(index.stats.duplicateCanonicalEntries).toHaveLength(1);
		expect(index.stats.duplicateCanonicalEntries[0]).toEqual({
			canonicalName: "skill-1",
			keptPath: "/skills/local-a/SKILL1_dup.md",
			droppedPath: "/skills/local-a/SKILL1.md",
		});

		// Verify kept skill in the index
		const keptSkill = index.skills.find((s) => s.canonicalName === "skill-1");
		expect(keptSkill).toBeDefined();
		expect(keptSkill?.path).toBe("/skills/local-a/SKILL1_dup.md");

		// Verify duplicate alias entries logic:
		// "duplicate-alias" is claimed by both skill-1 and skill-2
		expect(index.stats.duplicateAliasEntries).toHaveLength(1);
		expect(index.stats.duplicateAliasEntries[0]).toEqual({
			alias: "duplicate-alias",
			canonicalName: "skill-1",
			conflictingCanonicalName: "skill-2",
		});
	});

	test("regression: prioritizes winner correctly and prevents alias leakage when scan traversal order conflicts with scopePriority", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				if (root === "/skills/global-b") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/global-b/SKILL.md"],
						sourceFiles: makeSourceFiles(["/skills/global-b/SKILL.md"]),
					};
				}
				if (root === "/skills/local-a") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/local-a/SKILL.md"],
						sourceFiles: makeSourceFiles(["/skills/local-a/SKILL.md"]),
					};
				}
				if (root === "/skills/unlisted-b") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/unlisted-b/SKILL.md"],
						sourceFiles: makeSourceFiles(["/skills/unlisted-b/SKILL.md"]),
					};
				}
				if (root === "/skills/unlisted-a") {
					return {
						root,
						missingRoot: false,
						mode: "full",
						files: ["/skills/unlisted-a/SKILL.md"],
						sourceFiles: makeSourceFiles(["/skills/unlisted-a/SKILL.md"]),
					};
				}
				return { root, missingRoot: false, mode: "full", files: [], sourceFiles: [] };
			},
		};

		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: (skillFile: string, root: string) => {
				if (skillFile === "/skills/global-b/SKILL.md") {
					const skill = makeSkill("skill-dup");
					skill.path = skillFile;
					skill.sourceRoot = root;
					skill.mtimeMs = 100;
					skill.frontmatter.aliases = ["global-alias"];
					skill.aliases = ["global-alias"];
					return skill;
				}
				if (skillFile === "/skills/local-a/SKILL.md") {
					const skill = makeSkill("skill-dup");
					skill.path = skillFile;
					skill.sourceRoot = root;
					skill.mtimeMs = 100;
					skill.frontmatter.aliases = ["local-alias"];
					skill.aliases = ["local-alias"];
					return skill;
				}
				if (skillFile === "/skills/unlisted-b/SKILL.md") {
					const skill = makeSkill("skill-fallback");
					skill.path = skillFile;
					skill.sourceRoot = root;
					skill.mtimeMs = 100;
					skill.frontmatter.aliases = ["unlisted-b-alias"];
					skill.aliases = ["unlisted-b-alias"];
					return skill;
				}
				if (skillFile === "/skills/unlisted-a/SKILL.md") {
					const skill = makeSkill("skill-fallback");
					skill.path = skillFile;
					skill.sourceRoot = root;
					skill.mtimeMs = 100;
					skill.frontmatter.aliases = ["unlisted-a-alias"];
					skill.aliases = ["unlisted-a-alias"];
					return skill;
				}
				return null;
			},
		};

		const settings = {
			roots: ["/skills/global-b", "/skills/local-a", "/skills/unlisted-b", "/skills/unlisted-a"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"global-scope": ["/skills/global-b"],
				"unlisted-b": ["/skills/unlisted-b"],
				"unlisted-a": ["/skills/unlisted-a"],
			},
			scopePriority: ["local-scope", "global-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-priority-leakage.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		// Scenario 1: Traversal order starts with global-b (lower priority) then local-a (higher priority)
		// For unlisted scopes, starts with unlisted-b then unlisted-a (unlisted-a path is lexicographically smaller)
		const context1 = makeContext("/tmp/loader-priority-leakage.sqlite", {
			roots: ["/skills/global-b", "/skills/local-a", "/skills/unlisted-b", "/skills/unlisted-a"],
			scopes: ["local-scope", "global-scope", "unlisted-b", "unlisted-a"],
			scopesExplicit: false,
			settings,
		});

		const loader1 = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const index1 = await loader1.loadIndex(context1);

		// Assert listed scope collision winner is local-scope (local-a path)
		const winner1 = index1.skills.find((s) => s.canonicalName === "skill-dup");
		expect(winner1).toBeDefined();
		expect(winner1?.path).toBe("/skills/local-a/SKILL.md");
		expect(winner1?.scope).toBe("local-scope");

		// Assert no alias leakage for the dropped global-scope skill
		expect(index1.aliasToCanonical.get("local-alias")).toBe("skill-dup");
		expect(index1.aliasToCanonical.get("global-alias")).toBeUndefined();

		// Assert unlisted scope collision winner is unlisted-a (lexicographical path fallback /skills/unlisted-a/SKILL.md < /skills/unlisted-b/SKILL.md)
		const fallbackWinner1 = index1.skills.find((s) => s.canonicalName === "skill-fallback");
		expect(fallbackWinner1).toBeDefined();
		expect(fallbackWinner1?.path).toBe("/skills/unlisted-a/SKILL.md");
		expect(fallbackWinner1?.scope).toBe("unlisted-a");

		// Assert no alias leakage for the dropped unlisted-b skill
		expect(index1.aliasToCanonical.get("unlisted-a-alias")).toBe("skill-fallback");
		expect(index1.aliasToCanonical.get("unlisted-b-alias")).toBeUndefined();

		// Scenario 2: Reverse traversal order (local-a first, then global-b)
		// For unlisted scopes, starts with unlisted-a then unlisted-b
		const context2 = makeContext("/tmp/loader-priority-leakage.sqlite", {
			roots: ["/skills/local-a", "/skills/global-b", "/skills/unlisted-a", "/skills/unlisted-b"],
			scopes: ["local-scope", "global-scope", "unlisted-b", "unlisted-a"],
			scopesExplicit: false,
			settings: {
				...settings,
				roots: ["/skills/local-a", "/skills/global-b", "/skills/unlisted-a", "/skills/unlisted-b"],
			},
		});

		const loader2 = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const index2 = await loader2.loadIndex(context2);

		// Winner should still be local-scope (local-a path)
		const winner2 = index2.skills.find((s) => s.canonicalName === "skill-dup");
		expect(winner2).toBeDefined();
		expect(winner2?.path).toBe("/skills/local-a/SKILL.md");
		expect(winner2?.scope).toBe("local-scope");

		// No alias leakage
		expect(index2.aliasToCanonical.get("local-alias")).toBe("skill-dup");
		expect(index2.aliasToCanonical.get("global-alias")).toBeUndefined();

		// Unlisted winner should still be unlisted-a
		const fallbackWinner2 = index2.skills.find((s) => s.canonicalName === "skill-fallback");
		expect(fallbackWinner2).toBeDefined();
		expect(fallbackWinner2?.path).toBe("/skills/unlisted-a/SKILL.md");
		expect(fallbackWinner2?.scope).toBe("unlisted-a");

		// No alias leakage
		expect(index2.aliasToCanonical.get("unlisted-a-alias")).toBe("skill-fallback");
		expect(index2.aliasToCanonical.get("unlisted-b-alias")).toBeUndefined();
	});

	test("regression: ancestor scan root is scanned for explicit nested scope, indexing nested files and excluding sibling/prefix-sibling files", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };
		const scannedRoots: string[] = [];

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => {
				scannedRoots.push(root);
				const files = ["/skills/internal/SKILL.md", "/skills/sibling/SKILL.md", "/skills/internal-tools/SKILL.md"];
				return {
					root,
					missingRoot: false,
					mode: "full",
					files,
					sourceFiles: makeSourceFiles(files),
				};
			},
		};

		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: (skillFile: string, root: string) => {
				let name = "unknown";
				if (skillFile === "/skills/internal/SKILL.md") {
					name = "skill-internal";
				} else if (skillFile === "/skills/sibling/SKILL.md") {
					name = "skill-sibling";
				} else if (skillFile === "/skills/internal-tools/SKILL.md") {
					name = "skill-internal-tools";
				}
				return {
					...makeSkill(name),
					path: skillFile,
					sourceRoot: root,
				};
			},
		};

		const settings = {
			roots: ["/skills"],
			scopeRoots: {
				internal: ["/skills/internal"],
				sibling: ["/skills/sibling"],
				"internal-tools": ["/skills/internal-tools"],
			},
			scopePriority: ["internal", "sibling", "internal-tools"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-ancestor-regression.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-ancestor-regression.sqlite", {
			roots: ["/skills"],
			scopes: ["internal"],
			scopesExplicit: true,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const index = await loader.loadIndex(context);

		// Assert that the ancestor root was indeed scanned
		expect(scannedRoots).toContain("/skills");

		// Assert that the files in the explicit scope "internal" were indexed,
		// and those in "sibling" or "internal-tools" (prefix-sibling boundary) were excluded.
		const canonicalNames = index.skills.map((s) => s.canonicalName);
		expect(canonicalNames).toContain("skill-internal");
		expect(canonicalNames).not.toContain("skill-sibling");
		expect(canonicalNames).not.toContain("skill-internal-tools");
	});

	test("regression: selected-scope ancestor scan ignores sibling metadata drift but rebuilds on selected source change", async () => {
		const database = new FakeSearchDatabase();
		const store = new ActiveIndexStore();
		const scanCount = { value: 0 };
		const selectedIdentity = { path: "/skills/internal/SKILL.md", size: 10, mtimeMs: 100 };
		const siblingIdentity = { path: "/skills/sibling/SKILL.md", size: 20, mtimeMs: 200 };

		const scannerOverride: Partial<SkillFileScanner> = {
			scan: (root: string) => ({
				root,
				missingRoot: false,
				mode: "full",
				files: [selectedIdentity.path, siblingIdentity.path],
				sourceFiles: [
					{ path: selectedIdentity.path, size: selectedIdentity.size, mtimeMs: selectedIdentity.mtimeMs },
					{ path: siblingIdentity.path, size: siblingIdentity.size, mtimeMs: siblingIdentity.mtimeMs },
				],
			}),
		};

		const parserOverride: Partial<SkillDocumentParser> = {
			parseSkillFile: (skillFile: string, root: string) => {
				const name = skillFile === selectedIdentity.path ? "skill-internal" : "skill-sibling";
				return {
					...makeSkill(name),
					path: skillFile,
					sourceRoot: root,
				};
			},
		};

		const settings = {
			roots: ["/skills"],
			scopeRoots: {
				internal: ["/skills/internal"],
				sibling: ["/skills/sibling"],
			},
			scopePriority: ["internal", "sibling"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/loader-sibling-metadata.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};

		const context = makeContext("/tmp/loader-sibling-metadata.sqlite", {
			roots: ["/skills"],
			scopes: ["internal"],
			scopesExplicit: true,
			settings,
		});

		const loader = makeLoader(database, store, scanCount, scannerOverride, parserOverride, resolver);
		const first = await loader.loadIndex(context);

		expect(first.skills.map((skill) => skill.canonicalName)).toEqual(["skill-internal"]);
		expect(database.replaceCount).toBe(1);
		expect(scanCount.value).toBe(1);

		siblingIdentity.size = 999;
		siblingIdentity.mtimeMs = 999;

		const reused = await loader.loadIndex({ ...context, refresh: false });

		expect(reused).toBe(first);
		expect(database.replaceCount).toBe(1);
		expect(scanCount.value).toBe(2);

		selectedIdentity.size = 11;
		selectedIdentity.mtimeMs = 101;

		const rebuilt = await loader.loadIndex({ ...context, refresh: false });

		expect(rebuilt).not.toBe(first);
		expect(rebuilt.skills.map((skill) => skill.canonicalName)).toEqual(["skill-internal"]);
		expect(database.replaceCount).toBe(2);
		expect(scanCount.value).toBe(3);
		expect(rebuilt.sourceSignature).not.toBe(first.sourceSignature);
	});
});
