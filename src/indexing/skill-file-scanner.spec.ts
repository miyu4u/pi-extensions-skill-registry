import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { SkillFileScanner } from "./skill-file-scanner";
import { SourceManifestService } from "./source-manifest.service";

const TMP_ROOT_PREFIX = path.join(process.cwd(), ".tmp-skill-registry-file-scanner-");

describe("skill file scanner", () => {
	let root = "";
	let cleanupDir = "";

	afterEach(() => {
		const target = cleanupDir || root;
		if (target) {
			fs.rmSync(target, { recursive: true, force: true });
		}
		root = "";
		cleanupDir = "";
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
		expect(result.root).toBe(root);
		expect(result.files.map(path.normalize).sort()).toEqual([path.normalize(directDirFile), path.normalize(directExtFile)].sort());
		expect(new Set(result.files).size).toBe(result.files.length);
		expect(result.sourceFiles.map((file) => path.normalize(file.path)).sort()).toEqual(result.files.map(path.normalize).sort());
		for (const identity of result.sourceFiles) {
			const stat = fs.statSync(identity.path);
			expect(identity.size).toBe(stat.size);
			expect(identity.mtimeMs).toBe(stat.mtimeMs);
		}
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
		expect(result.root).toBe(root);
		expect(result.files.map(path.normalize).sort()).toEqual([path.normalize(foundFile), path.normalize(otherFile)].sort());
		expect(result.sourceFiles).toHaveLength(2);
		expect(result.sourceFiles.every((file) => Number.isFinite(file.size) && Number.isFinite(file.mtimeMs))).toBe(true);
	});

	test("skips reserved directories during recursive scan", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();

		const keepDir = path.join(root, "kept");
		fs.mkdirSync(keepDir, { recursive: true });
		const keptFile = path.join(keepDir, "SKILL.md");
		fs.writeFileSync(keptFile, "# kept", "utf-8");

		const skipDirs = [".git", ".svn", "node_modules", ".venv", "dist", "build", "out"];
		for (const skip of skipDirs) {
			const skipDir = path.join(root, skip);
			fs.mkdirSync(skipDir, { recursive: true });
			fs.writeFileSync(path.join(skipDir, "SKILL.md"), "# skipped", "utf-8");
		}

		const result = scanner.scan(root, ["SKILL.md"], new Set());

		expect(result.mode).toBe("full");
		expect(result.files.map(path.normalize)).toEqual([path.normalize(keptFile)]);
		expect(result.sourceFiles.map((file) => path.normalize(file.path))).toEqual([path.normalize(keptFile)]);
		for (const skip of skipDirs) {
			expect(result.files).not.toContain(path.join(root, skip, "SKILL.md"));
		}
	});

	test("marks missing roots with empty source identity", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();
		const missingRoot = path.join(root, "does-not-exist");

		const result = scanner.scan(missingRoot, ["SKILL.md"], new Set());

		expect(result.root).toBe(missingRoot);
		expect(result.missingRoot).toBe(true);
		expect(result.mode).toBe("full");
		expect(result.files).toEqual([]);
		expect(result.sourceFiles).toEqual([]);
	});

	test("keeps manifest signatures stable across sourceFiles enumeration order", () => {
		root = fs.mkdtempSync(TMP_ROOT_PREFIX);
		const scanner = new SkillFileScanner();
		const manifest = new SourceManifestService();

		const firstDir = path.join(root, "zeta");
		const secondDir = path.join(root, "alpha");
		fs.mkdirSync(firstDir, { recursive: true });
		fs.mkdirSync(secondDir, { recursive: true });
		fs.writeFileSync(path.join(firstDir, "SKILL.md"), "# zeta", "utf-8");
		fs.writeFileSync(path.join(secondDir, "SKILL.md"), "# alpha", "utf-8");

		const result = scanner.scan(root, ["SKILL.md"], new Set());
		expect(result.sourceFiles.length).toBeGreaterThanOrEqual(2);

		const reversed = {
			...result,
			sourceFiles: [...result.sourceFiles].reverse(),
			files: [...result.files].reverse(),
		};

		expect(manifest.createSignature([result])).toBe(manifest.createSignature([reversed]));
	});

	test("ignores traversal requested names and keeps full fallback bounded to root", () => {
		cleanupDir = fs.mkdtempSync(TMP_ROOT_PREFIX);
		root = path.join(cleanupDir, "corpus");
		fs.mkdirSync(root, { recursive: true });

		const inRootDir = path.join(root, "shared-name");
		fs.mkdirSync(inRootDir, { recursive: true });
		const inRootFile = path.join(inRootDir, "SKILL.md");
		fs.writeFileSync(inRootFile, "# in-root", "utf-8");

		const outsideDir = path.join(cleanupDir, "shared-name");
		fs.mkdirSync(outsideDir, { recursive: true });
		const outsideFile = path.join(outsideDir, "SKILL.md");
		fs.writeFileSync(outsideFile, "# outside-root", "utf-8");

		const scanner = new SkillFileScanner();
		const normalizedRoot = path.normalize(root);
		const normalizedOutside = path.normalize(outsideFile);
		const normalizedInRoot = path.normalize(inRootFile);

		/**
		 * `../` 요청명: 가드 없이 `path.join(root, name)` 하는 구 구현이 outside 파일을 반환하게 만드는 probe입니다.
		 */
		const parentTraversalNames = ["../shared-name", path.join("..", "shared-name")];
		if (path.sep === "\\") {
			parentTraversalNames.push("..\\shared-name");
		}

		for (const requestedName of parentTraversalNames) {
			const result = scanner.scan(root, ["SKILL.md"], new Set([requestedName]));
			const normalizedFiles = result.files.map(path.normalize);
			const normalizedSourcePaths = result.sourceFiles.map((file) => path.normalize(file.path));

			expect(normalizedFiles).not.toContain(normalizedOutside);
			expect(normalizedSourcePaths).not.toContain(normalizedOutside);
			expect(normalizedFiles).toEqual([normalizedInRoot]);
			expect(normalizedSourcePaths).toEqual([normalizedInRoot]);
			for (const file of normalizedFiles) {
				expect(file === normalizedRoot || file.startsWith(`${normalizedRoot}${path.sep}`)).toBe(true);
			}
		}

		/**
		 * 절대경로 요청명: safe-name 가드로 거부되며, `path.join` 자체가 절대경로 root escape를 만들지는 않습니다.
		 */
		const absoluteProbe = scanner.scan(root, ["SKILL.md"], new Set([path.resolve(outsideDir)]));
		expect(absoluteProbe.files.map(path.normalize)).not.toContain(normalizedOutside);
		expect(absoluteProbe.sourceFiles.map((file) => path.normalize(file.path))).not.toContain(normalizedOutside);
		expect(absoluteProbe.files.map(path.normalize)).toEqual([normalizedInRoot]);

		const separatorNames = new Set(["../shared-name/nested", "shared-name/../shared-name", "..\\shared-name", "/shared-name"]);
		const fallback = scanner.scan(root, ["SKILL.md"], separatorNames);
		expect(fallback.mode).toBe("full");
		expect(fallback.missingRoot).toBe(false);
		expect(fallback.files.map(path.normalize)).toEqual([normalizedInRoot]);
		expect(fallback.sourceFiles.map((file) => path.normalize(file.path))).toEqual([normalizedInRoot]);
		expect(fallback.files.map(path.normalize)).not.toContain(normalizedOutside);

		const targeted = scanner.scan(root, ["SKILL.md"], new Set(["shared-name"]));
		expect(targeted.mode).toBe("targeted");
		expect(targeted.files.map(path.normalize)).toEqual([normalizedInRoot]);
		expect(targeted.files.map(path.normalize)).not.toContain(normalizedOutside);
	});
});
