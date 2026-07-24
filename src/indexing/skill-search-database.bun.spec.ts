import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createSkillSearchDatabaseService } from "../service-registry";
import type { RawSkill, SkillRegistrySettings } from "../shared";
import type { SkillSearchDocument, SkillSearchIndexedStats, SkillSearchSnapshotInput } from "./skill-search-database.interface";
import type { SkillSearchDatabaseService } from "./skill-search-database.service";

const SKIP_PATH = path.join(process.cwd(), ".tmp-skill-registry-search-db-bun-");

const VALID_SOURCE_SIGNATURE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

function makeSettings(
	databasePath: string,
	scopeRoots: Record<string, string[]> = {},
	scopePriority: string[] = [],
): Required<SkillRegistrySettings> {
	return {
		roots: ["./skills"],
		scopeRoots,
		scopePriority,
		fileNames: ["SKILL.md"],
		presetSkills: [],
		databasePath,
		cacheTtlMs: 60_000,
		maxTopK: 50,
		includePreviewBodyChars: 250,
	};
}

function makeStats(scopeDistribution?: Record<string, number>): SkillSearchIndexedStats {
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
		scopeDistribution,
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
	scope?: string;
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
		scope = "unclassified",
	} = params;
	return {
		id,
		canonicalName,
		path: id,
		sourceRoot,
		scope,
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
	settings?: Required<SkillRegistrySettings>,
	stats?: SkillSearchIndexedStats,
): SkillSearchSnapshotInput {
	return {
		generatedAt: Date.now(),
		ttlMs,
		requestKey,
		sourceSignature: VALID_SOURCE_SIGNATURE,
		settings: settings ?? makeSettings(dbPath),
		requestedNames: [],
		skills,
		stats: stats ?? makeStats(),
		buildStartedAt,
	};
}

describe("skill-search-database service bun smoke", () => {
	let root = "";
	let service = createSkillSearchDatabaseService();

	afterEach(() => {
		closeDb(service);
		service = createSkillSearchDatabaseService();
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	test("creates, replaces, searches, closes, reopens, and restores via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "cache", "index.sqlite");
		await service.initialize(databasePath);

		const seed = makeSkill({
			id: "obs-1",
			canonicalName: "observability",
			sourceRoot: root,
			description: "Bun sqlite smoke skill",
			bodyText: "Body content for bun driver smoke.",
			title: "observability",
			keywords: ["observability", "runtime"],
			tags: ["driver", "smoke"],
			requires: ["database"],
			recommends: ["query"],
		});

		const snapshot = service.replaceSnapshot(makeInput(databasePath, "request:bun-smoke", [seed], Date.now() - 40), [
			makeDocument(seed),
		]);

		const ranked = service.searchTerms(snapshot.snapshotToken, ["observability"]).get("observability");
		expect(ranked?.[0]?.skillId).toBe(seed.id);

		service.close();
		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);
		const restored = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);

		expect(restored).not.toBeNull();
		expect(restored?.skills[0]).toEqual(seed);
		expect(restored?.sourceSignature).toBe(VALID_SOURCE_SIGNATURE);
		expect(restored?.settings.databasePath).toBe(path.resolve(databasePath));
	});

	test("proves scope column/snapshot restore and settings/stats round-trip via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "scope-roundtrip.sqlite");
		await service.initialize(databasePath);

		const localSkill = makeSkill({
			id: "s-local",
			canonicalName: "local-skill",
			sourceRoot: root,
			description: "Local scope skill",
			bodyText: "Body text.",
			title: "local-skill",
		});
		localSkill.scope = "user-authored:local";

		const managedSkill = makeSkill({
			id: "s-managed",
			canonicalName: "managed-skill",
			sourceRoot: root,
			description: "Managed scope skill",
			bodyText: "Body text.",
			title: "managed-skill",
		});
		managedSkill.scope = "managed-skills";

		const unclassifiedSkill1 = makeSkill({
			id: "s-unclassified-1",
			canonicalName: "unclassified-skill-1",
			sourceRoot: root,
			description: "Unclassified scope skill 1",
			bodyText: "Body text.",
			title: "unclassified-skill-1",
		});

		const unclassifiedSkill2 = makeSkill({
			id: "s-unclassified-2",
			canonicalName: "unclassified-skill-2",
			sourceRoot: root,
			description: "Unclassified scope skill 2",
			bodyText: "Body text.",
			title: "unclassified-skill-2",
		});

		const skills = [localSkill, managedSkill, unclassifiedSkill1, unclassifiedSkill2];
		const docs = skills.map(makeDocument);

		const scopeRoots = {
			"user-authored:local": [path.resolve(root, "skills/local")],
			"managed-skills": [path.resolve(root, "skills/managed")],
		};
		const scopePriority = ["user-authored:local", "managed-skills"];
		const settings = makeSettings(databasePath, scopeRoots, scopePriority);

		const scopeDistribution = {
			"user-authored:local": 1,
			"managed-skills": 1,
			unclassified: 2,
		};
		const stats = makeStats(scopeDistribution);

		const input = makeInput(databasePath, "request:scope-test", skills, Date.now() - 40, 60_000, settings, stats);
		const snapshot = service.replaceSnapshot(input, docs);

		expect(snapshot.skills[0].scope).toBe("user-authored:local");
		expect(snapshot.skills[1].scope).toBe("managed-skills");
		expect(snapshot.skills[2].scope).toBe("unclassified");
		expect(snapshot.skills[3].scope).toBe("unclassified");
		expect(snapshot.settings.scopeRoots).toEqual(scopeRoots);
		expect(snapshot.settings.scopePriority).toEqual(scopePriority);
		expect(snapshot.stats.scopeDistribution).toEqual(scopeDistribution);

		closeDb(service);
		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);

		const restored = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);
		expect(restored).not.toBeNull();
		if (!restored) {
			throw new Error("restored is null");
		}

		expect(restored.skills[0].scope).toBe("user-authored:local");
		expect(restored.skills[1].scope).toBe("managed-skills");
		expect(restored.skills[2].scope).toBe("unclassified");
		expect(restored.skills[3].scope).toBe("unclassified");
		expect(restored.settings.scopeRoots).toEqual(scopeRoots);
		expect(restored.settings.scopePriority).toEqual(scopePriority);
		expect(restored.stats.scopeDistribution).toEqual(scopeDistribution);
		expect(restored.sourceSignature).toBe(VALID_SOURCE_SIGNATURE);
	});

	test("proves request identity isolation where observable via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "isolation.sqlite");
		await service.initialize(databasePath);

		const skill = makeSkill({
			id: "iso-1",
			canonicalName: "isolation-test",
			sourceRoot: root,
			description: "iso",
			bodyText: "iso body",
			title: "iso",
		});

		const snapshotA = service.replaceSnapshot(makeInput(databasePath, "request:A", [skill], Date.now() - 40), [makeDocument(skill)]);

		const restoredB = service.readSnapshot("request:B", snapshotA.generatedAt + 1);
		expect(restoredB).toBeNull();

		const restoredA = service.readSnapshot("request:A", snapshotA.generatedAt + 1);
		expect(restoredA).not.toBeNull();
		expect(restoredA?.requestKey).toBe("request:A");
	});

	test("recreates owned schema if user_version is old/different but application_id matches via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "recreate-schema.sqlite");

		const setupDb = new Database(databasePath);
		setupDb.run("PRAGMA application_id = 1397445191;");
		setupDb.run("PRAGMA user_version = 3;");
		setupDb.run(`CREATE TABLE cache_metadata (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			snapshot_token TEXT NOT NULL,
			request_key TEXT NOT NULL,
			generated_at INTEGER NOT NULL,
			ttl_ms INTEGER NOT NULL,
			settings_json TEXT NOT NULL,
			requested_names_json TEXT NOT NULL,
			stats_json TEXT NOT NULL,
			index_build_ms INTEGER NOT NULL
		);`);
		setupDb.run("INSERT INTO cache_metadata VALUES (1, 'old-token', 'req-old', 123, 456, '{}', '[]', '{}', 0);");
		setupDb.close();

		await service.initialize(databasePath);

		const checkDb = new Database(databasePath);
		const rows = checkDb.query("SELECT * FROM cache_metadata;").all();
		expect(rows).toHaveLength(0); // must be dropped and recreated empty

		const columns = checkDb
			.query("SELECT name FROM pragma_table_info('cache_metadata') ORDER BY cid;")
			.all()
			.map((row) => {
				if (row && typeof row === "object" && "name" in row) {
					return String(row.name);
				}
				return "";
			});
		expect(columns).toContain("source_signature");

		const userVersion = checkDb.query("PRAGMA user_version;").get();
		let uvValue = 0;
		if (userVersion && typeof userVersion === "object") {
			if ("user_version" in userVersion) {
				uvValue = Number(userVersion.user_version);
			} else if ("value" in userVersion) {
				uvValue = Number(userVersion.value);
			}
		}
		expect(uvValue).toBe(4);
		checkDb.close();
	});

	test("invalid scope metadata triggers schema recreation and returns null via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "invalid-scope.sqlite");
		await service.initialize(databasePath);

		const skill = makeSkill({
			id: "s-invalid",
			canonicalName: "invalid-skill",
			sourceRoot: root,
			description: "Invalid scope skill",
			bodyText: "Body text.",
			title: "invalid-skill",
		});

		const snapshot = service.replaceSnapshot(makeInput(databasePath, "request:invalid", [skill], Date.now() - 40), [
			makeDocument(skill),
		]);

		closeDb(service);

		const corruptDb = new Database(databasePath);
		corruptDb.run("UPDATE skills SET scope = X'2A' WHERE skill_id = 's-invalid';");
		corruptDb.close();

		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);

		const restored = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);
		expect(restored).toBeNull();

		const checkDb = new Database(databasePath);
		const rows = checkDb.query("SELECT * FROM cache_metadata;").all();
		expect(rows).toHaveLength(0);
		checkDb.close();
	});

	test("round-trips sourceSignature metadata via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "signature-roundtrip.sqlite");
		await service.initialize(databasePath);

		const seed = makeSkill({
			id: "bun-sig-1",
			canonicalName: "bun-signature",
			sourceRoot: root,
			description: "bun signature round trip",
			bodyText: "Body for bun signature.",
			title: "bun-signature",
		});
		const signature = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
		const snapshot = service.replaceSnapshot(
			{
				...makeInput(databasePath, "request:bun-signature", [seed], Date.now() - 40),
				sourceSignature: signature,
			},
			[makeDocument(seed)],
		);
		expect(snapshot.sourceSignature).toBe(signature);

		closeDb(service);
		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);
		const restored = service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1);
		expect(restored?.sourceSignature).toBe(signature);
	});

	test("malformed sourceSignature metadata triggers cache miss and owned schema recreation via bun:sqlite", async () => {
		root = createRoot();
		const databasePath = path.join(root, "signature-miss.sqlite");
		await service.initialize(databasePath);

		const seed = makeSkill({
			id: "bun-sig-miss",
			canonicalName: "bun-signature-miss",
			sourceRoot: root,
			description: "bun malformed signature",
			bodyText: "Body for malformed bun signature.",
			title: "bun-signature-miss",
		});
		const snapshot = service.replaceSnapshot(makeInput(databasePath, "request:bun-signature-miss", [seed], Date.now() - 40), [
			makeDocument(seed),
		]);
		expect(service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1)).not.toBeNull();

		closeDb(service);
		const corruptDb = new Database(databasePath);
		corruptDb.run("UPDATE cache_metadata SET source_signature = ? WHERE id = 1;", ["legacy-or-malformed"]);
		corruptDb.close();

		service = createSkillSearchDatabaseService();
		await service.initialize(databasePath);
		expect(service.readSnapshot(snapshot.requestKey, snapshot.generatedAt + 1)).toBeNull();

		const checkDb = new Database(databasePath);
		const rows = checkDb.query("SELECT * FROM cache_metadata;").all();
		const columns = checkDb
			.query("SELECT name FROM pragma_table_info('cache_metadata') ORDER BY cid;")
			.all()
			.map((row) => {
				if (row && typeof row === "object" && "name" in row) {
					return String(row.name);
				}
				return "";
			});
		const userVersion = checkDb.query("PRAGMA user_version;").get();
		let uvValue = 0;
		if (userVersion && typeof userVersion === "object") {
			if ("user_version" in userVersion) {
				uvValue = Number(userVersion.user_version);
			} else if ("value" in userVersion) {
				uvValue = Number(userVersion.value);
			}
		}
		expect(rows).toHaveLength(0);
		expect(columns).toContain("source_signature");
		expect(uvValue).toBe(4);
		checkDb.close();
	});
});
