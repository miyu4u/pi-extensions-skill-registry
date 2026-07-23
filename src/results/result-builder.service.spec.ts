import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";
import { buildDiscoverResult, buildMetricsResult, buildResolveResult } from "./result-builder.service";

type EnvSnapshot = NodeJS.ProcessEnv;

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

/** text payload 추출 helper입니다. */
function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text ?? "";
}

/** 임시 skill 문서를 작성합니다. */
function writeSkill(root: string, name: string, body: string, aliases = ""): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			"description: result builder test skill",
			aliases ? `aliases: ${aliases}` : "",
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

/** result-builder 동작 검증입니다. */
describe("result builder", () => {
	let root: string;
	let envSnapshot: EnvSnapshot = {};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-results-"));
		envSnapshot = { ...process.env };
		process.env.OMP_AGENT_DIR = path.join(root, "agent-cache");
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";
		writeSkill(root, "alpha", "Security review tooling with strict coverage metrics and ranking.");
		writeSkill(root, "beta", "Documentation templates for workflow and notes.");
	});

	afterEach(() => {
		closeSkillIndex();
		restoreEnvironment(envSnapshot);
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** discover builder가 ranked hit를 text/details payload로 직렬화하는지 검증합니다. */
	test("builds discover payloads from ranked hits", async () => {
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "discover",
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "security review",
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const hits = SERVICE.skillSearchEngine.searchByBm25(artifacts, ctx.query, ctx.limit, ctx.minScore);
		const result = buildDiscoverResult(artifacts, hits, ctx);

		expect(textFromResult(result)).toContain("skill://alpha");
		expect(result.details).toMatchObject({ kind: "discover" });
	});

	/** resolve builder가 exact resolve 결과를 request order와 함께 직렬화하는지 검증합니다. */
	test("builds resolve payloads from exact resolve results", async () => {
		writeSkill(root, "review", "Review guide body.", "review-guide");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const resolved = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["review-guide"], false, 200, 200);
		const result = buildResolveResult(artifacts, resolved);

		expect(textFromResult(result)).toContain("review");
		expect(textFromResult(result)).toContain("skill://review");
		expect(result.details).toMatchObject({ kind: "resolve", suggestions: [] });
	});

	/** suggestion이 없는 miss는 compact discover/search recovery만 안내하고 catalog를 펼치지 않는지 검증합니다. */
	test("emits compact discover/search recovery when resolve has no suggestions", async () => {
		writeSkill(root, "alpha", "Security review tooling with strict coverage metrics and ranking.");
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const unrelated = SERVICE.skillSearchEngine.resolveSkills(artifacts, ["definitely-not-a-real-skill"], false, 200, 200);
		const unrelatedResult = buildResolveResult(artifacts, unrelated);
		const unrelatedText = textFromResult(unrelatedResult);

		expect(unrelated.suggestions).toEqual([]);
		expect(unrelatedText).toContain(
			"recovery: use skill_registry discover/search, then resolve the exact canonical name before reading.",
		);
		expect(unrelatedText).not.toContain("bounded suggestions:");
		expect(unrelatedText).not.toContain("Available:");
		expect(unrelatedResult.details).toMatchObject({ kind: "resolve", suggestions: [], missing: ["definitely-not-a-real-skill"] });

		const emptyRoot = path.join(root, "empty-corpus");
		fs.mkdirSync(emptyRoot, { recursive: true });
		const emptyCtx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "resolve",
			roots: [emptyRoot],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const emptyArtifacts = await SERVICE.skillIndexLoader.loadIndex(emptyCtx);
		const empty = SERVICE.skillSearchEngine.resolveSkills(emptyArtifacts, ["observabilty"], false, 200, 200);
		const emptyResult = buildResolveResult(emptyArtifacts, empty);
		const emptyText = textFromResult(emptyResult);

		expect(emptyArtifacts.docCount).toBe(0);
		expect(empty.suggestions).toEqual([]);
		expect(emptyText).toContain("recovery: use skill_registry discover/search, then resolve the exact canonical name before reading.");
		expect(emptyText).not.toContain("bounded suggestions:");

		const longName = `unknown-${"x".repeat(10_000)}`;
		const longMiss = SERVICE.skillSearchEngine.resolveSkills(emptyArtifacts, [longName], false, 200, 200);
		const longResult = buildResolveResult(artifacts, longMiss);
		const longText = textFromResult(longResult);
		expect(new TextEncoder().encode(longText).byteLength).toBeLessThanOrEqual(4096);
		expect(longText).toContain("recovery: use skill_registry discover/search");
	});

	/** metrics builder가 corpus summary를 text/details로 노출하는지 검증합니다. */
	test("builds metrics summary payloads", async () => {
		const ctx = SERVICE.skillInputNormalizer.normalizeToolInput({
			action: "metrics",
			roots: [root],
			fileNames: ["SKILL.md"],
			refresh: true,
		});
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(ctx);
		const result = buildMetricsResult(artifacts);

		expect(textFromResult(result)).toContain("skill_registry metrics summary");
		expect(result.details).toMatchObject({ kind: "metrics" });
	});
});
