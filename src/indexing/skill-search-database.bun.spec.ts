import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createSkillSearchDatabaseService } from "../service-registry";
import type { IndexedStats, RawSkill } from "../shared";
import type { SkillSearchDocument, SkillSearchSnapshotInput } from "./skill-search-database.interface";
import type { SkillSearchDatabaseService } from "./skill-search-database.service";

const SKIP_PATH = path.join(process.cwd(), ".tmp-skill-registry-search-db-bun-");

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
		expect(restored?.settings.databasePath).toBe(path.resolve(databasePath));
	});
});
