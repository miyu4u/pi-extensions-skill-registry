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
	frontmatter: Partial<{ aliases: string; requires: string; recommends: string }> = {},
): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			"description: indexing test skill",
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

function closeSkillIndexService(): void {
	const indexedService = SERVICE.skillIndex as { close?: () => void };
	if (indexedService.close) {
		indexedService.close();
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
		closeSkillIndexService();
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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);

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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const result = SERVICE.skillIndex.resolveSkills(artifacts, ["review-guide", "typescript-developer"], false, 400, 400);

		expect(result.resolved.map((entry) => entry.name)).toEqual(["review", "typescript-developer"]);
		expect(result.missing).toEqual([]);
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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const plan = SERVICE.skillIndex.composeSkills(artifacts, ctx.query, ctx.names, ctx.limit, ctx.relationMode, ctx.minScore);

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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const hits = SERVICE.skillIndex.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

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
		const exactArtifacts = await SERVICE.skillIndex.loadIndex(exact);
		const exactHits = SERVICE.skillIndex.searchByBm25(exactArtifacts, exact.query, exact.limit, exact.minScore);

		const typo = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "search",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observabilty",
			refresh: false,
		});
		const typoArtifacts = await SERVICE.skillIndex.loadIndex(typo);
		const typoHits = SERVICE.skillIndex.searchByBm25(typoArtifacts, typo.query, typo.limit, typo.minScore);

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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const hits = SERVICE.skillIndex.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const hits = SERVICE.skillIndex.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);

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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const hits = SERVICE.skillIndex.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);
		const top = hits[0];
		expect(top).toBeDefined();
		expect(top?.score).toBeGreaterThan(0);

		const filtered = SERVICE.skillIndex.searchByBm25(artifacts, ctx.query, ctx.limit, (top?.score ?? 0) + 0.0001);
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
		const artifacts = await SERVICE.skillIndex.loadIndex(ctx);
		const restoredReview = artifacts.skills.find((skill) => skill.canonicalName === "review");
		expect(restoredReview).toBeDefined();
		expect(restoredReview?.bodyText).toContain("Canonical review body");
		expect(restoredReview?.requires).toEqual(["observability"]);
		expect(restoredReview?.aliases).toEqual(["review-skill"]);
		expect(artifacts.docCount).toBe(2);

		closeSkillIndexService();
		fs.rmSync(corpusRoot, { recursive: true, force: true });

		const fromCache = await SERVICE.skillIndex.loadIndex({ ...ctx, refresh: false });
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
		const initial = await SERVICE.skillIndex.loadIndex(ctx);
		expect(initial.skills.find((skill) => skill.canonicalName === "observability")?.bodyText).toContain("Original source body.");

		writeSkill(root, "observability", "Rewritten source body for refresh rebuild.");
		const rebuilt = await SERVICE.skillIndex.loadIndex({ ...ctx, refresh: true });
		expect(rebuilt.skills.find((skill) => skill.canonicalName === "observability")?.bodyText).toContain(
			"Rewritten source body for refresh rebuild.",
		);
	});
});
