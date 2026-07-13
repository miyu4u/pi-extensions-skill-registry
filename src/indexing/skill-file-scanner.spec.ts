import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { SkillFileScanner } from "./skill-file-scanner";

const TMP_ROOT_PREFIX = path.join(process.cwd(), ".tmp-skill-registry-file-scanner-");

describe("skill file scanner", () => {
	let root = "";

	afterEach(() => {
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	test("returns targeted mode for directly resolved requested names", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();

		const directDir = path.join(root, "direct-dir");
		fs.mkdirSync(directDir, { recursive: true });
		const directDirFile = path.join(directDir, "SKILL.md");
		fs.writeFileSync(directDirFile, "# direct directory file", "utf-8");

		const directExtFile = path.join(root, "direct-ext.md");
		fs.writeFileSync(directExtFile, "# direct extension file", "utf-8");

		const result = scanner.scan(root, ["SKILL.md", "SKILL.MD", "skill.md"], new Set(["direct-dir", "direct-ext"]));

		expect(result.mode).toBe("targeted");
		expect(result.missingRoot).toBe(false);
		expect(result.files.map(path.normalize).sort()).toEqual(
			[path.normalize(directDirFile), path.normalize(directExtFile)].sort(),
		);
		expect(new Set(result.files).size).toBe(result.files.length);
	});

	test("falls back to full scan when a requested name cannot be resolved directly", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();

		const foundDir = path.join(root, "found");
		fs.mkdirSync(foundDir, { recursive: true });
		const foundFile = path.join(foundDir, "SKILL.md");
		fs.writeFileSync(foundFile, "# found", "utf-8");

		const otherDir = path.join(root, "other");
		fs.mkdirSync(otherDir, { recursive: true });
		const otherFile = path.join(otherDir, "SKILL.md");
		fs.writeFileSync(otherFile, "# other", "utf-8");

		const result = scanner.scan(root, ["SKILL.md"], new Set(["found", "missing-name"]));

		expect(result.mode).toBe("full");
		expect(result.missingRoot).toBe(false);
		expect(result.files.map(path.normalize).sort()).toEqual(
			[path.normalize(foundFile), path.normalize(otherFile)].sort(),
		);
	});

	test("skips reserved directories during recursive scan", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();

		const keepDir = path.join(root, "kept");
		fs.mkdirSync(keepDir, { recursive: true });
		const keptFile = path.join(keepDir, "SKILL.md");
		fs.writeFileSync(keptFile, "# kept", "utf-8");

		const skipDirs = [
			".git",
			".svn",
			"node_modules",
			".venv",
			"dist",
			"build",
			"out",
		];
		for (const skip of skipDirs) {
			const skipDir = path.join(root, skip);
			fs.mkdirSync(skipDir, { recursive: true });
			fs.writeFileSync(path.join(skipDir, "SKILL.md"), "# skipped", "utf-8");
		}

		const result = scanner.scan(root, ["SKILL.md"], new Set());

		expect(result.mode).toBe("full");
		expect(result.files.map(path.normalize)).toEqual([path.normalize(keptFile)]);
		for (const skip of skipDirs) {
			expect(result.files).not.toContain(path.join(root, skip, "SKILL.md"));
		}
	});
});
