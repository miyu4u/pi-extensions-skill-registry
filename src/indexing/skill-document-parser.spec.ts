import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { SkillDocumentParser } from "./skill-document-parser";

const TMP_ROOT_PREFIX = path.join(process.cwd(), ".tmp-skill-registry-document-parser-");

describe("skill document parser", () => {
	let root = "";

	afterEach(() => {
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	test("normalizes representative frontmatter into canonicalized RawSkill fields", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const parser = new SkillDocumentParser();
		const skillDir = path.join(root, "observability-guide");
		fs.mkdirSync(skillDir, { recursive: true });
		const skillFile = path.join(skillDir, "SKILL.md");

		fs.writeFileSync(
			skillFile,
			[
				"---",
				"name: My Observability Guide.md",
				"description: Observability diagnostics and readiness checks.",
				"group: Runtime",
				'tag: Ops, "Reliability"',
				'keywords: [Tracing, SLO, "Latency"]',
				"aliases:",
				"- OBS-GUIDE",
				"- my-observability-guide",
				"requires:",
				"- runtime-tooling",
				"- tracing-stack",
				"recommends: related-reads, my-observability-guide",
				"---",
				"# Operational Observability",
				"",
				"This skill documents practical rollout checks for stable telemetry.",
			].join("\n"),
			"utf-8",
		);

		const issues: string[] = [];
		const parsed = parser.parseSkillFile(skillFile, root, issues);

		expect(parsed).not.toBeNull();
		expect(issues).toHaveLength(0);
		expect(parsed?.id).toBe("my-observability-guide");
		expect(parsed?.canonicalName).toBe("my-observability-guide");
		expect(parsed?.sourceRoot).toBe(root);
		expect(parsed?.path).toBe(path.resolve(skillFile));
		expect(parsed?.frontmatter).toMatchObject({
			name: "my-observability-guide",
			description: "Observability diagnostics and readiness checks.",
			category: "Runtime",
			keywords: ["Tracing", "SLO", "Latency"],
			tags: ["Ops", '"Reliability"'],
			aliases: ["obs-guide"],
			requires: ["runtime-tooling", "tracing-stack"],
			recommends: ["related-reads"],
		});
		expect(parsed?.keywords).toEqual(["tracing", "slo", "latency"]);
		expect(parsed?.tags).toEqual(["ops", "reliability"]);
		expect(parsed?.aliases).toEqual(["obs-guide"]);
		expect(parsed?.requires).toEqual(["runtime-tooling", "tracing-stack"]);
		expect(parsed?.recommends).toEqual(["related-reads"]);
		expect(parsed?.title).toBe("Operational Observability");
		expect(parsed?.bodyText).toBe("# Operational Observability\n\nThis skill documents practical rollout checks for stable telemetry.");
		expect(parsed?.category).toBe("Runtime");
	});

	test("tolerates malformed frontmatter lines and falls back to path-derived names", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const parser = new SkillDocumentParser();
		const skillDir = path.join(root, "legacy-guide");
		fs.mkdirSync(skillDir, { recursive: true });
		const skillFile = path.join(skillDir, "notes.md");

		fs.writeFileSync(
			skillFile,
			[
				"---",
				"name:",
				"description: malformed and still parseable",
				"aliases:",
				"- legacy-alias",
				"this is intentionally malformed frontmatter",
				"requires:",
				"- legacy-guide",
				"recommends: legacy-guide, related-skill",
				'tags: [Ops, "Runtime"]',
				"---",
				"# Legacy recovery title",
				"",
				"Body text should still parse even when frontmatter has noise.",
			].join("\n"),
			"utf-8",
		);

		const issues: string[] = [];
		const parsed = parser.parseSkillFile(skillFile, root, issues);

		expect(parsed).not.toBeNull();
		expect(issues).toHaveLength(0);
		expect(parsed?.canonicalName).toBe("legacy-guide");
		expect(parsed?.frontmatter.name).toBe("legacy-guide");
		expect(parsed?.frontmatter.category).toBe("");
		expect(parsed?.category).toBe("uncategorized");
		expect(parsed?.aliases).toEqual(["legacy-alias"]);
		expect(parsed?.requires).toEqual([]);
		expect(parsed?.recommends).toEqual(["related-skill"]);
		expect(parsed?.title).toBe("Legacy recovery title");
		expect(parsed?.bodyText).toBe("# Legacy recovery title\n\nBody text should still parse even when frontmatter has noise.");
	});

	test("records read failures instead of throwing", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const parser = new SkillDocumentParser();
		const missingFile = path.join(root, "missing", "SKILL.md");

		const issues: string[] = [];
		const parsed = parser.parseSkillFile(missingFile, root, issues);

		expect(parsed).toBeNull();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatch(/^read failed:/);
	});
});
