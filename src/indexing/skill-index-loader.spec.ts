import { describe, expect, test } from "@jest/globals";
import type { IndexedStats, RawSkill, ToolContext } from "../shared";
import type { SearchTokenizerInterface } from "../tokenization";
import { ActiveIndexStore } from "./active-index-store";
import type { SkillDocumentParser } from "./skill-document-parser";
import type { SkillFileScanner } from "./skill-file-scanner";
import { SkillIndexLoader } from "./skill-index-loader";
import type {
	SkillSearchDatabaseInterface,
	SkillSearchDocument,
	SkillSearchSnapshot,
	SkillSearchSnapshotInput,
} from "./skill-search-database.interface";

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

	readSnapshot(): SkillSearchSnapshot | null {
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

function makeLoader(database: FakeSearchDatabase, store: ActiveIndexStore, scanCount: { value: number }): SkillIndexLoader {
	const tokenizer = {
		tokenizeDocumentText: () => ({ baseTokens: [], derivedTokens: [], allTokens: [] }),
		tokenizeQueryText: () => ({ baseTokens: [], derivedTokens: [], allTokens: [] }),
		buildQueryVariants: () => [],
	} as SearchTokenizerInterface;
	const scanner = {
		scan: () => {
			scanCount.value += 1;
			return { missingRoot: false, mode: "full", files: [] };
		},
	} as unknown as SkillFileScanner;
	const parser = { parseSkillFile: () => null } as unknown as SkillDocumentParser;
	return new SkillIndexLoader(database, tokenizer, scanner, parser, store);
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
		const loader = makeLoader(database, store, { value: 0 });
		const context = makeContext("/tmp/persisted.sqlite", { refresh: false });
		const seedInput: SkillSearchSnapshotInput = {
			generatedAt: Date.now(),
			ttlMs: context.settings.cacheTtlMs,
			requestKey: "persisted-request",
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
		const loader = makeLoader(database, store, scans);
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
		expect(scans.value).toBe(1);
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
});
