import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";

type EnvSnapshot = NodeJS.ProcessEnv;

/** 임시 skill 문서를 작성합니다. */
function writeSkill(root: string, name: string, body: string, keywords = "review,security,metrics"): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		["---", `name: ${name}`, "description: tokenization test skill", `keywords: ${keywords}`, "---", `# ${name}`, "", body].join("\n"),
		"utf-8",
	);
}

function closeSkillIndexService(): void {
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

/** search-tokenizer direct API 검증입니다. */
describe("search tokenizer service", () => {
	let root: string;
	let envSnapshot: EnvSnapshot = {};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-tokenization-"));
		envSnapshot = { ...process.env };
		process.env.OMP_AGENT_DIR = path.join(root, "agent-cache");
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";
	});

	afterEach(() => {
		closeSkillIndexService();
		restoreEnvironment(envSnapshot);
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	/** query tokenization이 stop word를 제거하는지 검증합니다. */
	test("drops stop-word-only tokens during query tokenization", () => {
		const result = SERVICE.searchTokenizer.tokenizeQueryText("the security and review");

		expect(result.baseTokens).toEqual(["security", "review"]);
	});

	/** fuzzy query variant가 영어 전치 오타 후보를 계산하는지 검증합니다. */
	test("builds fuzzy query variants for English transposition typos", async () => {
		writeSkill(
			root,
			"observability-transposition",
			"Observability workflow and telemetry review guidance.",
			"observability, telemetry",
		);
		const ctx = {
			action: "search" as const,
			roots: [root],
			fileNames: ["SKILL.md"],
			query: "observability",
			refresh: true,
		};
		const normalized = SERVICE.skillInputNormalizer.normalizeToolInput(ctx);
		const artifacts = await SERVICE.skillIndexLoader.loadIndex(normalized);
		const variants = SERVICE.searchTokenizer.buildQueryVariants(artifacts, "obesrvability");

		expect(variants[0]?.variants.some((entry) => entry.token === "observability" && entry.source === "en-fuzzy")).toBe(true);
	});

	/** 한국어 복합명사 문서 tokenization이 파생 토큰을 생성하는지 검증합니다. */
	test("derives Korean compound noun tokens from document text", () => {
		const result = SERVICE.searchTokenizer.tokenizeDocumentText("형태소분석 파이프라인 설계");
		const derived = result.derivedTokens.map((entry) => entry.token);

		expect(derived).toEqual(expect.arrayContaining(["형태소", "분석"]));
	});
});
