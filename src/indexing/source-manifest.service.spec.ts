import { describe, expect, test } from "@jest/globals";
import type { SkillSourceScanResult } from "./source-manifest.interface";
import { SourceManifestService } from "./source-manifest.service";

function makeScan(
	root: string,
	files: Array<{ path: string; size: number; mtimeMs: number }>,
	overrides: Partial<SkillSourceScanResult> = {},
): SkillSourceScanResult {
	return {
		root,
		missingRoot: false,
		mode: "full",
		files: files.map((file) => file.path),
		sourceFiles: files,
		...overrides,
	};
}

describe("SourceManifestService", () => {
	const service = new SourceManifestService();

	test("creates deterministic signatures regardless of scan and file enumeration order", () => {
		const left = [
			makeScan("/skills/b", [
				{ path: "/skills/b/zeta/SKILL.md", size: 20, mtimeMs: 200 },
				{ path: "/skills/b/alpha/SKILL.md", size: 10, mtimeMs: 100 },
			]),
			makeScan("/skills/a", [{ path: "/skills/a/one/SKILL.md", size: 5, mtimeMs: 50 }]),
		];
		const right = [
			makeScan("/skills/a", [{ path: "/skills/a/one/SKILL.md", size: 5, mtimeMs: 50 }]),
			makeScan("/skills/b", [
				{ path: "/skills/b/alpha/SKILL.md", size: 10, mtimeMs: 100 },
				{ path: "/skills/b/zeta/SKILL.md", size: 20, mtimeMs: 200 },
			]),
		];

		expect(service.createSignature(left)).toBe(service.createSignature(right));
	});

	test("includes missing-root identity in the source signature", () => {
		const present = [makeScan("/skills/gone", [])];
		const missing = [makeScan("/skills/gone", [], { missingRoot: true, files: [], sourceFiles: [] })];

		expect(service.createSignature(present)).not.toBe(service.createSignature(missing));
	});

	test("changes signature when mode changes", () => {
		const full = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 10, mtimeMs: 100 }], { mode: "full" })];
		const targeted = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 10, mtimeMs: 100 }], { mode: "targeted" })];

		expect(service.createSignature(full)).not.toBe(service.createSignature(targeted));
	});

	test("changes signature when file size changes", () => {
		const before = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 10, mtimeMs: 100 }])];
		const after = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 11, mtimeMs: 100 }])];

		expect(service.createSignature(before)).not.toBe(service.createSignature(after));
	});

	test("changes signature when file mtime changes", () => {
		const before = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 10, mtimeMs: 100 }])];
		const after = [makeScan("/skills", [{ path: "/skills/a/SKILL.md", size: 10, mtimeMs: 101 }])];

		expect(service.createSignature(before)).not.toBe(service.createSignature(after));
	});

	test("creates a stable signature for empty scans", () => {
		const emptyRoots = [makeScan("/skills", [], { files: [], sourceFiles: [] })];
		const noScans: SkillSourceScanResult[] = [];

		expect(service.createSignature(emptyRoots)).toBe(service.createSignature(emptyRoots));
		expect(service.createSignature(noScans)).toBe(service.createSignature(noScans));
		expect(service.createSignature(emptyRoots)).not.toBe(service.createSignature(noScans));
	});
});
