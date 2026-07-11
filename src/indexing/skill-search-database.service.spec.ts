import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { createSkillSearchDatabaseService } from "../service-registry";
import type { IndexedStats, RawSkill } from "../shared";
import type { SkillSearchDocument, SkillSearchSnapshotInput } from "./skill-search-database.interface";
import type { SkillSearchDatabaseService } from "./skill-search-database.service";

const SKIP_PATH = path.join(process.cwd(), ".tmp-skill-registry-search-db-");

type EnvSnapshot = NodeJS.ProcessEnv;

function createRoot(): string {
	return fs.mkdtempSync(SKIP_PATH);
}

function closeDb(service: SkillSearchDatabaseService): void {
	try {
		service.close();
	} catch {
		// best-effort close
	}
}

function restoreEnvironment(snapshot: EnvSnapshot): void {
	const keys = new Set([...Object.keys(process.env), ...Object.keys(snapshot)]);
	for (const key of keys) {
		const value = snapshot[key];
		if (typeof value === "undefined") {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function makeSettings(databasePath: string) {
	return {
		roots: ["./skills"],
		fileNames: ["SKILL.md"],
		presetSkills: [],
		databasePath,
		cacheTtlMs: 60_000,
		maxTopK: 50,
		includePreviewBodyChars: 250,
	};
}

function makeStats(): IndexedStats {
	return {
		totalFilesVisited: 1,
		totalParsed: 1,
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

function makeSkill(params: {
	id: string;
	canonicalName: string;
	sourceRoot: string;
	description: string;
	bodyText: string;
	title: string;
	category?: string;
	keywords?: string[];
	tags?: string[];
	aliases?: string[];
	requires?: string[];
	recommends?: string[];
	mtimeMs?: number;
}): RawSkill {
	const {
		id,
		canonicalName,
		sourceRoot,
		description,
		bodyText,
		title,
		category = "engineering",
		keywords = [],
		tags = [],
		aliases = [],
		requires = [],
		recommends = [],
		mtimeMs = Date.now(),
	} = params;
	return {
		id,
		canonicalName,
		path: id,
		sourceRoot,
		rawFrontmatter: {
			name: canonicalName,
			description,
			a: description,
		},
		frontmatter: {
			name: canonicalName,
			description,
			category,
			keywords,
			tags,
			aliases,
			requires,
			recommends,
		},
		bodyText,
		title,
		category,
		keywords,
		tags,
		aliases,
		requires,
		recommends,
		text: `${canonicalName} ${aliases.join(" ")} ${description} ${title} ${keywords.join(" ")} ${tags.join(" ")} ${bodyText}`,
		mtimeMs,
	};
}

function makeDocument(skill: RawSkill): SkillSearchDocument {
	return {
		skillId: skill.id,
		canonicalName: skill.canonicalName,
		aliases: skill.aliases.join(" "),
		title: skill.title,
		description: skill.frontmatter.description ?? "",
		category: skill.category,
		keywords: skill.keywords.join(" "),
		tags: skill.tags.join(" "),
		bodyText: skill.bodyText,
	};
}

function makeInput(
	dbPath: string,
	requestKey: string,
	skills: RawSkill[],
	buildStartedAt: number,
	ttlMs = 60_000,
): SkillSearchSnapshotInput {
	return {
		generatedAt: Date.now(),
		ttlMs,
		requestKey,
		settings: makeSettings(dbPath),
		requestedNames: [],
		skills,
		stats: makeStats(),
		buildStartedAt,
	};
}

describe("skill-search-database service", () => {
	let root = "";
	let envSnapshot: EnvSnapshot = {};
	let service = createSkillSearchDatabaseService();

	afterEach(() => {
		restoreEnvironment(envSnapshot);
		closeDb(service);
		service = createSkillSearchDatabaseService();
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	test("creates an owned sqlite snapshot and replaces with fresh rows", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "cache", "index.sqlite");
		await service.initialize(databasePath);

		expect(fs.existsSync(databasePath)).toBe(true);

		const seed = makeSkill({
			id: "obs-1",
			canonicalName: "observability",
			sourceRoot: root,
			description: "observability skill",
			bodyText: "Observability is a systems engineering practice.",
			title: "observability",
			tags: ["metrics"],
			keywords: ["observability", "diagnostics"],
		});
		const snapshot = service.replaceSnapshot(makeInput(databasePath, "request:owned", [seed], Date.now() - 40), [makeDocument(seed)]);

		expect(snapshot.skills).toHaveLength(1);
		expect(snapshot.snapshotToken).toBeTruthy();

		const matches = service.searchTerms(snapshot.snapshotToken, ["observability"]).get("observability");
		expect(matches?.map((entry) => entry.skillId)).toEqual(["obs-1"]);
	});

	test("keeps an unowned sqlite file unchanged when initialization is rejected", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "foreign.sqlite");
		// Boundary: Node-only raw driver access for an intentionally unowned SQLite file.
		const requireNodeSqlite = createRequire(import.meta.url);
		type NodeSqliteModule = {
			DatabaseSync: new (
				filename: string,
			) => {
				exec: (sql: string) => void;
				prepare: (sql: string) => {
					all: <T = Record<string, unknown>>() => T[];
					get: <T = Record<string, unknown>>() => T | null;
				};
				close: () => void;
			};
		};
		const { DatabaseSync } = requireNodeSqlite("node:sqlite") as NodeSqliteModule;
		const setupDb = new DatabaseSync(databasePath);
		setupDb.exec("CREATE TABLE foreign_marker(id INTEGER);");
		setupDb.exec("INSERT INTO foreign_marker VALUES (7);");
		setupDb.exec("PRAGMA application_id = 1;");
		setupDb.exec("PRAGMA user_version = 0;");
		setupDb.close();

		const beforeBytes = fs.readFileSync(databasePath);
		await expect(service.initialize(databasePath)).rejects.toThrow(
			`databasePath is not a skill-registry cache database: ${path.resolve(databasePath)}`,
		);
		const afterBytes = fs.readFileSync(databasePath);
		expect(afterBytes.equals(beforeBytes)).toBe(true);

		const probe = new DatabaseSync(databasePath);
		const markerRows = probe.prepare("SELECT id FROM foreign_marker ORDER BY id;").all();
		const cacheMetadata = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name='cache_metadata';").get();
		probe.close();
		expect(markerRows).toEqual([{ id: 7 }]);
		expect(cacheMetadata).toBeUndefined();
	});

	test("keeps canonical/title weighted bm25 above body-only matches", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "weighted.sqlite");
		await service.initialize(databasePath);

		const canonicalMatch = makeSkill({
			id: "s1",
			canonicalName: "observability",
			sourceRoot: root,
			description: "Canonical observability entry with rich metadata.",
			title: "observability",
			bodyText: "Body content unrelated to term.",
			keywords: ["observability", "runtime"],
		});

		const bodyOnlyMatch = makeSkill({
			id: "s2",
			canonicalName: "runtime-playbook",
			sourceRoot: root,
			description: "Guide for runtime operations.",
			title: "runtime-playbook",
			bodyText: "This body mentions observability and telemetry together.",
			keywords: ["operability"],
		});

		const snapshot = service.replaceSnapshot(
			makeInput(databasePath, "request:weights", [canonicalMatch, bodyOnlyMatch], Date.now() - 40),
			[makeDocument(canonicalMatch), makeDocument(bodyOnlyMatch)],
		);
		const rows = service.searchTerms(snapshot.snapshotToken, ["observability"]).get("observability");

		expect(rows).toBeDefined();
		if (!rows) {
			throw new Error("expected matches for observability");
		}
		expect(rows).toHaveLength(2);
		expect(rows.map((entry) => entry.skillId)).toEqual([canonicalMatch.id, bodyOnlyMatch.id]);
		expect(rows[0].bm25Rank).toBeLessThan(rows[1].bm25Rank);
	});

	test("restores full parsed fields from readSnapshot across reopen", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "restore.sqlite");
		await service.initialize(databasePath);

		const seed = makeSkill({
			id: "restore-1",
			canonicalName: "observability",
			sourceRoot: root,
			description: "Observability skill with relations",
			title: "Observability",
			bodyText: "Full body text for restore contract.",
			aliases: ["obs", "telemetry-eye"],
			requires: ["runtime", "quality"],
			recommends: ["dashboard", "tracing"],
			keywords: ["monitoring", "metrics"],
			tags: ["platform", "ops"],
		});

		const snapshot = service.replaceSnapshot(makeInput(databasePath, "request:restore", [seed], Date.now() - 40), [makeDocument(seed)]);
		const first = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);
		expect(first).not.toBeNull();
		expect(first?.skills[0]).toEqual(seed);
		expect(first?.settings).toEqual(makeSettings(databasePath));
		expect(first?.stats).toEqual(makeStats());

		closeDb(service);
		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);
		const second = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);

		expect(second).not.toBeNull();
		expect(second?.skills).toHaveLength(1);
		expect(second?.skills[0]).toEqual(seed);
		expect(second?.settings.databasePath).toBe(path.resolve(databasePath));
		expect(second?.dfByTerm).toBeInstanceOf(Map);
	});

	test("returns null for wrong request key or expired snapshot", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "ttl.sqlite");
		await service.initialize(databasePath);

		const skill = makeSkill({
			id: "exp-1",
			canonicalName: "observability",
			sourceRoot: root,
			description: "short",
			title: "observability",
			bodyText: "Body text.",
		});
		const requestKey = "request:ttl";
		const snapshot = service.replaceSnapshot(
			{
				generatedAt: Date.now() - 100,
				ttlMs: 10,
				requestKey,
				settings: makeSettings(databasePath),
				requestedNames: [],
				skills: [skill],
				stats: makeStats(),
				buildStartedAt: Date.now() - 40,
			},
			[makeDocument(skill)],
		);

		expect(service.readSnapshot(requestKey, snapshot.generatedAt + 5)).not.toBeNull();
		expect(service.readSnapshot("different-request", snapshot.generatedAt + 5)).toBeNull();
		expect(service.readSnapshot(requestKey, snapshot.generatedAt + 20)).toBeNull();
	});

	test("throws on stale snapshot token during term search", async () => {
		root = createRoot();
		envSnapshot = { ...process.env };
		const databasePath = path.join(root, "stale-token.sqlite");
		await service.initialize(databasePath);

		const seedA = makeSkill({
			id: "one",
			canonicalName: "observability",
			sourceRoot: root,
			description: "seed A",
			title: "observability",
			bodyText: "Body A.",
		});
		const seedB = makeSkill({
			id: "two",
			canonicalName: "metrics",
			sourceRoot: root,
			description: "seed B",
			title: "metrics",
			bodyText: "Body B.",
		});
		const first = service.replaceSnapshot(makeInput(databasePath, "request:stale", [seedA], Date.now() - 20), [makeDocument(seedA)]);
		void service.searchTerms(first.snapshotToken, ["observability"]);

		service.replaceSnapshot(
			{
				generatedAt: Date.now(),
				ttlMs: 60_000,
				requestKey: "request:stale",
				settings: makeSettings(databasePath),
				requestedNames: [],
				skills: [seedB],
				stats: makeStats(),
				buildStartedAt: Date.now() - 10,
			},
			[makeDocument(seedB)],
		);

		expect(() => {
			service.searchTerms(first.snapshotToken, ["observability"]);
		}).toThrow("SQLite skill index snapshot changed; call loadIndex() before searching");
	});
});
