import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";

type EnvSnapshot = NodeJS.ProcessEnv;

/** 임시 skill 문서를 작성합니다. */
function writeSkill(
	root: string,
	name: string,
	body: string,
	frontmatter: Partial<{ aliases: string; requires: string; recommends: string; category: string }> = {},
): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			"description: indexing test skill",
			frontmatter.category ? `category: ${frontmatter.category}` : "",
			frontmatter.aliases ? `aliases: ${frontmatter.aliases}` : "",
			frontmatter.requires ? `requires: ${frontmatter.requires}` : "",
			frontmatter.recommends ? `recommends: ${frontmatter.recommends}` : "",
			"---",
			`# ${name}`,
			"",
			body,
		]
			.filter(Boolean)
			.join("\n"),
		"utf-8",
	);
}

function closeSkillIndex(): void {
	SERVICE.skillIndexLoader.close();
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

/** skill-index service 핵심 동작 검증입니다. */
describe("skill-index service", () => {
	let root: string;
	let envSnapshot: EnvSnapshot = {};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-index-"));
		envSnapshot = { ...process.env };
		process.env.OMP_AGENT_DIR = path.join(root, "agent-cache");
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";

		writeSkill(root, "alpha", "Security review tooling with strict coverage metrics and ranking.");
		writeSkill(root, "beta", "Documentation templates for workflow and notes.");
		writeSkill(root, "gamma", "Runtime metrics and indexing diagnostics for harness plugins.");
	});

	afterEach(() => {
		closeSkillIndex();
		restoreEnvironment(envSnapshot);
		fs.rmSync(root, { recursive: true, force: true });
		root = "";
	});

	/** 인덱스가 문서 수와 통계를 계산하는지 검증합니다. */
	test("indexes all skills and computes doc and file stats", async () => {
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "index",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);

		expect(artifacts.docCount).toBe(3);
		expect(artifacts.stats.totalParsed).toBe(3);
		expect(artifacts.stats.totalFilesVisited).toBe(3);
	});

	/** exact resolve가 canonical name과 alias를 request order대로 유지하는지 검증합니다. */
	test("resolves exact names and aliases in request order", async () => {
		writeSkill(root, "review", "Review guide body.", { aliases: "review-guide" });
		writeSkill(root, "typescript-developer", "TypeScript guide body.", { aliases: "tsdev" });
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const result = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["review-guide", "typescript-developer"], false, 400, 400);

		expect(result.resolved.map((entry) => entry.name)).toEqual(["review", "typescript-developer"]);
		expect(result.resolved.map((entry) => entry.readPath)).toEqual(["skill://review", "skill://typescript-developer"]);
		expect(result.missing).toEqual([]);
		expect(result.suggestions).toEqual([]);
	});

	/** Unicode canonical/alias와 비정상 long name이 exact 및 bounded miss 경계를 지키는지 검증합니다. */
	test("preserves Unicode exact resolution and bounds long-name misses", async () => {
		writeSkill(root, "한국어-검토", "한국어 검토 guide body.", { aliases: "검토-가이드" });
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const unicode = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["검토-가이드"], false, 400, 400);
		const longName = `unknown-${"x".repeat(10_000)}`;
		const longMiss = SERVICE.skillSearchEngine.resolveSkills(artifacts, [longName], false, 400, 400);

		expect(unicode.resolved.map((entry) => entry.name)).toEqual(["한국어-검토"]);
		expect(unicode.resolved[0]?.readPath).toBe("skill://한국어-검토");
		expect(unicode.suggestions).toEqual([]);
		expect(longMiss.missing).toEqual([longName]);
		expect(longMiss.suggestions).toEqual([]);
	});

	/** close typo miss는 기본 한도 3 이하, canonical skill:// path, confidence >= 0.80 후보만 반환하는지 검증합니다. */
	test("suggests at most three high-confidence canonical skill:// paths for close typos by default", async () => {
		writeSkill(root, "observability", "Observability operations and monitoring for production teams.");
		writeSkill(root, "typescript-guide", "TypeScript guide body with ranking details.");
		writeSkill(root, "documentation-notes", "Documentation notes body for workflow authors.");
		writeSkill(root, "runtime-metrics", "Runtime metrics body for harness plugins.");
		writeSkill(root, "workflow-templates", "Workflow templates body for notes and checklists.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const result = SERVICE.skillSearchEngine.resolveSkills(
			artifacts,
			["observabilty", "typescript-guied", "documentation-notez", "runtime-metricz", "workflow-templatez"],
			false,
			400,
			400,
		);

		expect(result.resolved).toEqual([]);
		expect(result.suggestions.length).toBeGreaterThan(0);
		expect(result.suggestions.length).toBeLessThanOrEqual(3);
		expect(result.suggestions.every((suggestion) => suggestion.readPath === `skill://${suggestion.name}`)).toBe(true);
		expect(result.suggestions.every((suggestion) => suggestion.confidence >= 0.8)).toBe(true);
		expect(ctx.suggestionLimit).toBe(3);
	});

	/** 무관/저신뢰 이름과 empty corpus는 suggestion 없이 safe-zero로 남는지 검증합니다. */
	test("returns no suggestions for unrelated low-confidence names and empty corpus", async () => {
		writeSkill(root, "observability", "Observability operations and monitoring for production teams.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const unrelated = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["definitely-not-a-real-skill"], false, 400, 400);

		expect(unrelated.missing).toEqual(["definitely-not-a-real-skill"]);
		expect(unrelated.suggestions).toEqual([]);

		const emptyRoot = path.join(root, "empty-corpus");
		fs.mkdirSync(emptyRoot, { recursive: true });
		const emptyCtx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [emptyRoot],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const emptyArtifacts = await SERVICE.skillIndexLoader.loadIndex(emptyCtx);
		const empty = SERVICE.skillSearchEngine.resolveSkills(emptyArtifacts, ["observabilty"], false, 400, 400);

		expect(emptyArtifacts.docCount).toBe(0);
		expect(empty.missing).toEqual(["observabilty"]);
		expect(empty.suggestions).toEqual([]);
	});

	/** 명시적 suggestionLimit 5는 hard cap으로 상한되며 그 이상을 반환하지 않는지 검증합니다. */
	test("caps explicit suggestionLimit 5 at the hard suggestion ceiling", async () => {
		writeSkill(root, "observability", "Observability operations and monitoring for production teams.");
		writeSkill(root, "typescript-guide", "TypeScript guide body with ranking details.");
		writeSkill(root, "documentation-notes", "Documentation notes body for workflow authors.");
		writeSkill(root, "runtime-metrics", "Runtime metrics body for harness plugins.");
		writeSkill(root, "workflow-templates", "Workflow templates body for notes and checklists.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			suggestionLimit: 5,
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const typos = ["observabilty", "typescript-guied", "documentation-notez", "runtime-metricz", "workflow-templatez"];
		const result = SERVICE.skillSearchEngine.resolveSkills(artifacts, typos, false, 400, 400, ctx.suggestionLimit);
		const overLimit = SERVICE.skillSearchEngine.resolveSkills(artifacts, typos, false, 400, 400, 99);

		expect(ctx.suggestionLimit).toBe(5);
		expect(result.suggestions).toHaveLength(5);
		expect(result.suggestions.every((suggestion) => suggestion.readPath.startsWith("skill://"))).toBe(true);
		expect(result.suggestions.every((suggestion) => suggestion.confidence >= 0.8)).toBe(true);
		expect(overLimit.suggestions).toHaveLength(5);
	});

	/** compose가 alias seed와 requires relation을 확장하는지 검증합니다. */
	test("expands compose relations from alias seeds", async () => {
		writeSkill(root, "review", "Review guide body.", { aliases: "review-guide" });
		writeSkill(root, "typescript-developer", "TypeScript guide body.", { aliases: "tsdev", requires: "review-guide" });
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "compose",
			roots: [root],
			fileNames: ["SKILL.md"],
			names: ["tsdev"],
			relationMode: "full",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const plan = SERVICE.skillRelationEngine.composeSkills(artifacts, ctx.query, ctx.names, ctx.limit, ctx.relationMode, ctx.minScore);

		expect(plan.seeds.map((skill) => skill.canonicalName)).toEqual(["typescript-developer"]);
		expect(plan.entries.map((entry) => entry.skill.canonicalName)).toEqual(expect.arrayContaining(["typescript-developer", "review"]));
	});

	/** observability 정확 canonical/title 매치가 약한 body-only 매치보다 먼저 정렬되는지 검증합니다. */
	test("returns canonical title match first", async () => {
		writeSkill(root, "observability", "Observability is discussed only in this body text.", { aliases: "ops-observability" });
		writeSkill(root, "runtime-playbook", "A detailed runtime playbook with observability references for operations.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

		expect(hits[0]?.skill.canonicalName).toBe("observability");
		expect(hits[0]?.score).toBeGreaterThan(0);
	});

	/** typo 조회가 en-fuzzy 후보로 동일 canonical에 도달하지만 exact 점수보다 낮은지 검증합니다. */
	test("keeps typo observations lower than exact score", async () => {
		writeSkill(root, "observability", "Observability body with strict ranking details.");
		const exact = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		});
		const exactArtifacts = await SERVICE.skillIndexLoader.loadIndex(exact);
		const exactHits = SERVICE.skillSearchEngine.searchByBm25(exactArtifacts, exact.query, exact.limit, exact.minScore);

		const typo = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observabilty",
			refresh: false,
		});
		const typoArtifacts = await SERVICE.skillIndexLoader.loadIndex(typo);
		const typoHits = SERVICE.skillSearchEngine.searchByBm25(typoArtifacts, typo.query, typo.limit, typo.minScore);

		expect(exactHits[0]?.skill.canonicalName).toBe("observability");
		expect(typoHits[0]?.skill.canonicalName).toBe("observability");
		expect(typoHits[0]?.score).toBeLessThan(exactHits[0]?.score ?? Number.POSITIVE_INFINITY);
	});

	/** 4자 prefix fallback가 동작하는지 검증합니다. */
	test("resolves through four-character prefix fallback", async () => {
		writeSkill(root, "observability", "Observability operations and monitoring for production teams.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "obse",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

		expect(hits[0]?.skill.canonicalName).toBe("observability");
		expect(hits[0]?.score).toBeGreaterThan(0);
	});

	/** 동률일 때 canonical name 정렬 규칙이 적용되는지 검증합니다. */
	test("sorts equal-scoring hits by canonical name", async () => {
		writeSkill(root, "zeta-alpha", "alpha");
		writeSkill(root, "alpha-zeta", "alpha");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "alpha",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

		expect(hits[0]?.skill.canonicalName).toBe("alpha-zeta");
		expect(hits[1]?.skill.canonicalName).toBe("zeta-alpha");
		expect(hits[0]?.score).toBe(hits[1]?.score);
		expect(hits[0]?.coverage).toBe(hits[1]?.coverage);
	});

	/** minScore 상한값 바로 위에서 결과가 제거되는지 검증합니다. */
	test("removes score below minScore threshold", async () => {
		writeSkill(root, "observability", "Observability and ranking guidance.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);
		const top = hits[0];
		expect(top).toBeDefined();
		expect(top?.score).toBeGreaterThan(0);

		const filtered = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, (top?.score ?? 0) + 0.0001);
		expect(filtered).toHaveLength(0);
	});

	/** close + source 제거 이후 refresh:false로도 DB에서 전체 skill 본문과 관계를 복원하는지 검증합니다. */
	test("restores full body and relations after source removal", async () => {
		const corpusRoot = path.join(root, "persistent-corpus");
		writeSkill(corpusRoot, "review", "Canonical review body.", { aliases: "review-skill", requires: "observability" });
		writeSkill(corpusRoot, "observability", "Observability body with deep operational details.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [corpusRoot],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const restoredReview = artifacts.skills.find((skill) => skill.canonicalName === "review");
		expect(restoredReview).toBeDefined();
		expect(restoredReview?.bodyText).toContain("Canonical review body");
		expect(restoredReview?.requires).toEqual(["observability"]);
		expect(restoredReview?.aliases).toEqual(["review-skill"]);
		expect(artifacts.docCount).toBe(2);

		closeSkillIndex();
		fs.rmSync(corpusRoot, { recursive: true, force: true });

		const fromCache = await SERVICE.skillIndexLoader.loadIndex({ ...ctx, refresh: false });
		const cachedReview = fromCache.skills.find((skill) => skill.canonicalName === "review");
		expect(fromCache.docCount).toBe(2);
		expect(cachedReview).toBeDefined();
		expect(cachedReview?.bodyText).toContain("Canonical review body");
		expect(cachedReview?.requires).toEqual(["observability"]);
		expect(cachedReview?.aliases).toEqual(["review-skill"]);
	});

	/** refresh true가 snapshot을 무시하고 source rewrite를 반영하는지 검증합니다. */
	test("refresh:true ignores cache and reflects rewritten source content", async () => {
		writeSkill(root, "observability", "Original source body.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		});
		const initial = await SERVICE.skillIndexLoader.loadIndex(ctx);
		expect(initial.skills.find((skill) => skill.canonicalName === "observability")?.bodyText).toContain("Original source body.");

		writeSkill(root, "observability", "Rewritten source body for refresh rebuild.");
		const rebuilt = await SERVICE.skillIndexLoader.loadIndex({ ...ctx, refresh: true });
		expect(rebuilt.skills.find((skill) => skill.canonicalName === "observability")?.bodyText).toContain(
			"Rewritten source body for refresh rebuild.",
		);
	});

	test("selected local/global/managed never leaks in indexing and search", async () => {
		const originalLoadSettings = SERVICE.settingsLoader.loadSettings;
		const localRoot = path.join(root, "local");
		const globalRoot = path.join(root, "global");
		const managedRoot = path.join(root, "managed");

		fs.mkdirSync(localRoot, { recursive: true });
		fs.mkdirSync(globalRoot, { recursive: true });
		fs.mkdirSync(managedRoot, { recursive: true });

		writeSkill(localRoot, "local-skill", "Local body content.", { aliases: "local-alias", category: "indexing test skill" });
		writeSkill(globalRoot, "global-skill", "Global body content.", { aliases: "global-alias", category: "indexing test skill" });
		writeSkill(managedRoot, "managed-skill", "Managed body content.", { aliases: "managed-alias", category: "indexing test skill" });

		const mockSettings = {
			roots: [localRoot, globalRoot, managedRoot],
			scopeRoots: {
				"user-authored:local": [localRoot],
				"user-authored:global": [globalRoot],
				"managed-skills": [managedRoot],
			},
			scopePriority: ["user-authored:local", "user-authored:global", "managed-skills"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: path.join(root, "db-leak.sqlite"),
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};
		SERVICE.settingsLoader.loadSettings = () => mockSettings;

		try {
			// case 1: explicitly select only "user-authored:local"
			const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				scopes: ["user-authored:local"],
				query: "body",
				refresh: true,
			});
			const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
			const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

			// Assert only local-skill is returned
			expect(hits.map((h) => h.skill.canonicalName)).toEqual(["local-skill"]);
			expect(hits.every((h) => h.skill.scope === "user-authored:local")).toBe(true);

			// Check category remains separate metadata field
			expect(hits[0]?.skill.category).toBe("indexing test skill");

			// Check exact resolve doesn't resolve from other scopes
			const resolved = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["global-alias", "local-alias"], false, 400, 400);
			expect(resolved.resolved.map((entry) => entry.name)).toEqual(["local-skill"]);
			expect(resolved.missing).toContain("global-alias");
		} finally {
			SERVICE.settingsLoader.loadSettings = originalLoadSettings;
		}
	});

	test("omitted scope sees all and equal relevance follows configurable priority; custom priority works", async () => {
		const originalLoadSettings = SERVICE.settingsLoader.loadSettings;
		const localRoot = path.join(root, "local");
		const globalRoot = path.join(root, "global");
		const managedRoot = path.join(root, "managed");

		fs.mkdirSync(localRoot, { recursive: true });
		fs.mkdirSync(globalRoot, { recursive: true });
		fs.mkdirSync(managedRoot, { recursive: true });

		// Writing skills with identical content to force score/coverage ties
		writeSkill(localRoot, "local-skill", "Identical test content for tie-breaker.");
		writeSkill(globalRoot, "global-skill", "Identical test content for tie-breaker.");
		writeSkill(managedRoot, "managed-skill", "Identical test content for tie-breaker.");

		const mockSettings = {
			roots: [localRoot, globalRoot, managedRoot],
			scopeRoots: {
				"user-authored:local": [localRoot],
				"user-authored:global": [globalRoot],
				"managed-skills": [managedRoot],
			},
			scopePriority: ["user-authored:local", "user-authored:global", "managed-skills"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: path.join(root, "db-priority.sqlite"),
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};
		SERVICE.settingsLoader.loadSettings = () => mockSettings;

		try {
			// Case 1: Omitted scopes sees all, default priority: local > global > managed
			const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				query: "Identical",
				refresh: true,
			});
			const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
			const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

			expect(hits.map((h) => h.skill.canonicalName)).toEqual(["local-skill", "global-skill", "managed-skill"]);
			expect(hits[0]?.skill.scope).toBe("user-authored:local");
			expect(hits[1]?.skill.scope).toBe("user-authored:global");
			expect(hits[2]?.skill.scope).toBe("managed-skills");

			// Case 2: Custom priority: managed > global > local
			const customSettings = {
				...mockSettings,
				scopePriority: ["managed-skills", "user-authored:global", "user-authored:local"],
				databasePath: path.join(root, "db-priority-custom.sqlite"),
			};
			SERVICE.settingsLoader.loadSettings = () => customSettings;

			const ctxCustom = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				query: "Identical",
				refresh: true,
			});
			const artifactsCustom = await SERVICE.skillIndexLoader.loadIndex(ctxCustom);
			const hitsCustom = SERVICE.skillSearchEngine.searchByBm25(
				artifactsCustom,
				ctxCustom.query,
				ctxCustom.limit,
				ctxCustom.minScore,
			);

			expect(hitsCustom.map((h) => h.skill.canonicalName)).toEqual(["managed-skill", "global-skill", "local-skill"]);
			expect(hitsCustom[0]?.skill.scope).toBe("managed-skills");
			expect(hitsCustom[1]?.skill.scope).toBe("user-authored:global");
			expect(hitsCustom[2]?.skill.scope).toBe("user-authored:local");
		} finally {
			SERVICE.settingsLoader.loadSettings = originalLoadSettings;
		}
	});

	test("unknown or empty explicit scopes return safe-zero results safely", async () => {
		const originalLoadSettings = SERVICE.settingsLoader.loadSettings;
		const localRoot = path.join(root, "local");
		fs.mkdirSync(localRoot, { recursive: true });
		writeSkill(localRoot, "local-skill", "Local body content.");

		const mockSettings = {
			roots: [localRoot],
			scopeRoots: {
				"user-authored:local": [localRoot],
			},
			scopePriority: ["user-authored:local"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: path.join(root, "db-sz.sqlite"),
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};
		SERVICE.settingsLoader.loadSettings = () => mockSettings;

		try {
			// empty explicit scopes
			const ctxEmpty = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				scopes: [],
				query: "content",
				refresh: true,
			});
			const artifactsEmpty = await SERVICE.skillIndexLoader.loadIndex(ctxEmpty);
			expect(artifactsEmpty.docCount).toBe(0);

			// unknown explicit scopes
			const ctxUnknown = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				scopes: ["non-existent-scope"],
				query: "content",
				refresh: true,
			});
			const artifactsUnknown = await SERVICE.skillIndexLoader.loadIndex(ctxUnknown);
			expect(artifactsUnknown.docCount).toBe(0);
		} finally {
			SERVICE.settingsLoader.loadSettings = originalLoadSettings;
		}
	});

	test("custom future scope works correctly when explicitly requested", async () => {
		const originalLoadSettings = SERVICE.settingsLoader.loadSettings;
		const futureRoot = path.join(root, "future");

		fs.mkdirSync(futureRoot, { recursive: true });

		writeSkill(futureRoot, "future-skill", "Future scope content.", { category: "future-category" });

		const mockSettings = {
			roots: [futureRoot],
			scopeRoots: {
				"future-scope": [futureRoot],
			},
			scopePriority: [],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: path.join(root, "db-future.sqlite"),
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};
		SERVICE.settingsLoader.loadSettings = () => mockSettings;

		try {
			const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				scopes: ["future-scope"],
				query: "Future",
				refresh: true,
			});
			const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
			const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

			expect(hits.map((h) => h.skill.canonicalName)).toEqual(["future-skill"]);
			expect(hits[0]?.skill.scope).toBe("future-scope");
			expect(hits[0]?.skill.category).toBe("future-category");
		} finally {
			SERVICE.settingsLoader.loadSettings = originalLoadSettings;
		}
	});

	test("gap, resolve, and search projections retain scope and category separately and do not leak under explicit selected scope", async () => {
		const originalLoadSettings = SERVICE.settingsLoader.loadSettings;
		const localRoot = path.join(root, "local-scoped");
		const globalRoot = path.join(root, "global-scoped");

		fs.mkdirSync(localRoot, { recursive: true });
		fs.mkdirSync(globalRoot, { recursive: true });

		writeSkill(localRoot, "local-skill", "Local content code search.", {
			aliases: "local-alias",
			category: "local-category",
		});
		writeSkill(globalRoot, "global-skill", "Global content code search.", {
			aliases: "global-alias",
			category: "global-category",
		});

		const mockSettings = {
			roots: [localRoot, globalRoot],
			scopeRoots: {
				"user-authored:local": [localRoot],
				"user-authored:global": [globalRoot],
			},
			scopePriority: ["user-authored:local", "user-authored:global"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: path.join(root, "db-scope-retains-and-leaks.sqlite"),
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		};
		SERVICE.settingsLoader.loadSettings = () => mockSettings;

		try {
			// Explicitly select only "user-authored:local"
			const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
				action: "search",
				scopes: ["user-authored:local"],
				query: "content search",
				refresh: true,
			});
			const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);

			// 1. Search projection verification:
			// - Check that global-skill is NOT leaked (not in search results)
			// - Check that scope and category are retained separately
			const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);
			expect(hits.map((h) => h.skill.canonicalName)).toEqual(["local-skill"]);
			expect(hits[0]?.skill.scope).toBe("user-authored:local");
			expect(hits[0]?.skill.category).toBe("local-category");

			// 2. Resolve projection verification:
			// - Check that resolving with global-alias/global-skill does NOT leak the global candidates (they must be in missing)
			// - Check that resolved local-skill has separate scope and category
			const resolved = SERVICE.skillSearchEngine.resolveSkills(
				artifacts,
				["local-alias", "global-alias", "global-skill"],
				false,
				400,
				400,
			);
			expect(resolved.resolved.map((entry) => entry.name)).toEqual(["local-skill"]);
			expect(resolved.resolved[0]?.scope).toBe("user-authored:local");
			expect(resolved.resolved[0]?.category).toBe("local-category");
			expect(resolved.missing).toContain("global-alias");
			expect(resolved.missing).toContain("global-skill");

			// 3. Gap projection verification:
			// - Check that global-skill is NOT leaked in gap candidates
			// - Check that scope and category are retained separately in gap candidates
			const gapResult = SERVICE.skillSearchEngine.gapSkills(artifacts, "content search", [], 0.5, ctx.limit, ctx.minScore);
			expect(gapResult.candidates.map((c) => c.name)).toEqual(["local-skill"]);
			expect(gapResult.candidates[0]?.scope).toBe("user-authored:local");
			expect(gapResult.candidates[0]?.category).toBe("local-category");
		} finally {
			SERVICE.settingsLoader.loadSettings = originalLoadSettings;
		}
	});
});
