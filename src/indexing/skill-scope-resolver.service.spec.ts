import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import type { SkillScopeRootEntry } from "./skill-scope-resolver.interface";
import { SkillScopeResolverService } from "./skill-scope-resolver.service";

describe("SkillScopeResolverService", () => {
	const resolver = new SkillScopeResolverService();

	describe("resolveScopeRootEntries", () => {
		test("resolves placeholders $cwd, $home, ~ correctly and resolves to absolute paths", () => {
			const scopeRoots = {
				"user-authored:local": ["$cwd/skills"],
				"user-authored:global": ["$home/skills"],
				"managed-skills": ["~/managed"],
			};
			const scopePriority = ["user-authored:local", "user-authored:global", "managed-skills"];

			const entries = resolver.resolveScopeRootEntries(scopeRoots, scopePriority);

			const expectedLocal = path.resolve(path.join(process.cwd(), "skills")).replace(/\\/g, "/");
			const expectedGlobal = path.resolve(path.join(os.homedir(), "skills")).replace(/\\/g, "/");
			const expectedManaged = path.resolve(path.join(os.homedir(), "managed")).replace(/\\/g, "/");

			expect(entries).toContainEqual({ scope: "user-authored:local", root: expectedLocal });
			expect(entries).toContainEqual({ scope: "user-authored:global", root: expectedGlobal });
			expect(entries).toContainEqual({ scope: "managed-skills", root: expectedManaged });
		});

		test("preserves deterministic order of scopes based on priority list", () => {
			const scopeRoots = {
				"managed-skills": ["/managed"],
				"user-authored:local": ["/local"],
				"user-authored:global": ["/global"],
			};
			// different priority from alphabetical order
			const scopePriority = ["user-authored:global", "managed-skills", "user-authored:local"];

			const entries = resolver.resolveScopeRootEntries(scopeRoots, scopePriority);

			expect(entries.map((e) => e.scope)).toEqual(["user-authored:global", "managed-skills", "user-authored:local"]);
		});

		test("supports explicit requested scopes and handles unknown/empty explicit gracefully", () => {
			const scopeRoots = {
				"scope-a": ["/path/a"],
				"scope-b": ["/path/b"],
			};
			const scopePriority = ["scope-a", "scope-b"];

			// 1. Explicit request for valid scope
			const entriesA = resolver.resolveScopeRootEntries(scopeRoots, scopePriority, ["scope-a"]);
			expect(entriesA).toEqual([{ scope: "scope-a", root: "/path/a" }]);

			// 2. Explicit request with unknown scope -> safe-zero (returns empty array)
			const entriesUnknown = resolver.resolveScopeRootEntries(scopeRoots, scopePriority, ["scope-a", "scope-unknown"]);
			expect(entriesUnknown).toEqual([]);

			// 3. Explicit request is empty array -> safe-zero
			const entriesEmpty = resolver.resolveScopeRootEntries(scopeRoots, scopePriority, []);
			expect(entriesEmpty).toEqual([]);
		});
	});

	describe("classifySourcePath", () => {
		const scopeEntries: SkillScopeRootEntry[] = [
			{ scope: "scope-a", root: "/skills" },
			{ scope: "scope-b", root: "/skills/nested" },
			{ scope: "scope-c", root: "/skills-extra" },
		];

		test("distinguishes boundary correctly (/skills vs /skills-extra)", () => {
			// /skills/a.md -> scope-a
			expect(resolver.classifySourcePath("/skills/a.md", scopeEntries)).toBe("scope-a");
			// /skills-extra/a.md -> scope-c
			expect(resolver.classifySourcePath("/skills-extra/a.md", scopeEntries)).toBe("scope-c");
			// /skills-extraordinary/a.md -> unclassified (boundary checks prevent partial match without slash)
			expect(resolver.classifySourcePath("/skills-extraordinary/a.md", scopeEntries)).toBe("unclassified");
		});

		test("resolves longest nested prefix correctly (longest match wins)", () => {
			// /skills/nested/a.md matches both /skills and /skills/nested. The latter is longer (14 vs 7), so it wins.
			expect(resolver.classifySourcePath("/skills/nested/a.md", scopeEntries)).toBe("scope-b");
			// /skills/other/a.md only matches /skills -> scope-a
			expect(resolver.classifySourcePath("/skills/other/a.md", scopeEntries)).toBe("scope-a");
		});

		test("returns 'unclassified' for paths outside any scope root boundary", () => {
			expect(resolver.classifySourcePath("/other-path/a.md", scopeEntries)).toBe("unclassified");
		});

		test("handles trailing slashes and backslashes in paths normalization", () => {
			const winEntries: SkillScopeRootEntry[] = [{ scope: "scope-win", root: "C:/projects/skills" }];
			// Backslashes normalization
			expect(resolver.classifySourcePath("C:\\projects\\skills\\nested\\a.md", winEntries)).toBe("scope-win");
			expect(resolver.classifySourcePath("C:/projects/skills/", winEntries)).toBe("scope-win");
		});
	});
});
