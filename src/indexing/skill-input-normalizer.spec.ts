import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import type { SettingsLoaderInterface } from "../settings";
import type { ToolInput } from "../shared";
import { SkillInputNormalizer } from "./skill-input-normalizer";
import type { SkillScopeResolverInterface, SkillScopeRootEntry } from "./skill-scope-resolver.interface";

class FakeSettingsLoader implements SettingsLoaderInterface {
	constructor(
		public settings = {
			roots: ["/skills/local-a", "/skills/global-b", "/skills/managed-c", "/skills/other"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"global-scope": ["/skills/global-b"],
				"managed-scope": ["/skills/managed-c"],
			} as Record<string, string[]>,
			scopePriority: ["local-scope", "global-scope", "managed-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/db.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		},
	) {}

	loadSettings() {
		return { ...this.settings };
	}
}

class FakeScopeResolver implements SkillScopeResolverInterface {
	resolveScopeRootEntries(
		scopeRoots: Record<string, string[]>,
		_scopePriority: string[],
		_requestedScopes?: string[] | readonly string[],
	): SkillScopeRootEntry[] {
		const entries: SkillScopeRootEntry[] = [];
		for (const [scope, roots] of Object.entries(scopeRoots)) {
			for (const root of roots) {
				entries.push({ scope, root });
			}
		}
		return entries;
	}

	classifySourcePath(sourcePath: string, scopeRootEntries: readonly SkillScopeRootEntry[]): string {
		for (const entry of scopeRootEntries) {
			if (sourcePath.startsWith(entry.root)) {
				return entry.scope;
			}
		}
		return "unclassified";
	}
}

describe("SkillInputNormalizer", () => {
	const settingsLoader = new FakeSettingsLoader();
	const scopeResolver = new FakeScopeResolver();
	const normalizer = new SkillInputNormalizer(settingsLoader, scopeResolver);

	test("normalizes omitted scopes (all-corpus mode) without filtering roots", () => {
		const input: ToolInput = {
			action: "index",
		};
		const context = normalizer.normalizeToolInput(input);

		expect(context.scopes).toEqual(["local-scope", "global-scope", "managed-scope"]);
		expect(context.scopesExplicit).toBe(false);
		expect(context.roots).toEqual(["/skills/local-a", "/skills/global-b", "/skills/managed-c", "/skills/other"]);
	});

	test("normalizes explicit valid scopes and filters roots to prevent leakage", () => {
		const input: ToolInput = {
			action: "index",
			scopes: ["local-scope", "managed-scope"],
		};
		const context = normalizer.normalizeToolInput(input);

		expect(context.scopes).toEqual(["local-scope", "managed-scope"]);
		expect(context.scopesExplicit).toBe(true);
		expect(context.roots).toEqual(["/skills/local-a", "/skills/managed-c"]);
	});

	test("falls back to safe-zero (empty roots/scopes) on empty or unknown explicit scopes", () => {
		const inputUnknown: ToolInput = {
			action: "index",
			scopes: ["local-scope", "unknown-scope"],
		};
		const contextUnknown = normalizer.normalizeToolInput(inputUnknown);
		expect(contextUnknown.scopes).toEqual([]);
		expect(contextUnknown.roots).toEqual([]);
		expect(contextUnknown.scopesExplicit).toBe(true);

		const inputEmpty: ToolInput = {
			action: "index",
			scopes: [],
		};
		const contextEmpty = normalizer.normalizeToolInput(inputEmpty);
		expect(contextEmpty.scopes).toEqual([]);
		expect(contextEmpty.roots).toEqual([]);
		expect(contextEmpty.scopesExplicit).toBe(true);
	});

	test("supports custom future scopes defined in settings loader", () => {
		const customLoader = new FakeSettingsLoader({
			roots: ["/skills/local-a", "/skills/future-d"],
			scopeRoots: {
				"local-scope": ["/skills/local-a"],
				"future-scope": ["/skills/future-d"],
			},
			scopePriority: ["local-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/db.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		});
		const customNormalizer = new SkillInputNormalizer(customLoader, scopeResolver);

		const input: ToolInput = {
			action: "index",
			scopes: ["future-scope"],
		};
		const context = customNormalizer.normalizeToolInput(input);

		expect(context.scopes).toEqual(["future-scope"]);
		expect(context.scopesExplicit).toBe(true);
		expect(context.roots).toEqual(["/skills/future-d"]);
	});

	test("normalizes scopes: [''] as a safe-zero fallback (empty roots/scopes)", () => {
		const input: ToolInput = {
			action: "index",
			scopes: [""],
		};
		const context = normalizer.normalizeToolInput(input);
		expect(context.scopes).toEqual([]);
		expect(context.roots).toEqual([]);
		expect(context.scopesExplicit).toBe(true);
	});

	test("nested selected scope retains ancestor scan root and matching descendant while excluding unrelated", () => {
		const customLoader = new FakeSettingsLoader({
			roots: ["/skills/parent", "/skills/parent/nested", "/skills/unrelated"],
			scopeRoots: {
				"nested-scope": ["/skills/parent/nested"],
				"parent-scope": ["/skills/parent"],
				"unrelated-scope": ["/skills/unrelated"],
			},
			scopePriority: ["nested-scope", "parent-scope", "unrelated-scope"],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/db.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		});
		const customNormalizer = new SkillInputNormalizer(customLoader, scopeResolver);

		const input: ToolInput = {
			action: "index",
			scopes: ["nested-scope"],
		};
		const context = customNormalizer.normalizeToolInput(input);

		expect(context.roots).toEqual(["/skills/parent", "/skills/parent/nested"]);
	});

	test("does not expand ~archive to home directory but does expand ~/archive", () => {
		const customLoader = new FakeSettingsLoader({
			roots: ["~/archive", "~archive"],
			scopeRoots: {},
			scopePriority: [],
			fileNames: ["SKILL.md"],
			presetSkills: [],
			databasePath: "/tmp/db.sqlite",
			cacheTtlMs: 60_000,
			maxTopK: 50,
			includePreviewBodyChars: 250,
		});
		const customNormalizer = new SkillInputNormalizer(customLoader, scopeResolver);

		const input: ToolInput = {
			action: "index",
		};
		const context = customNormalizer.normalizeToolInput(input);

		const expectedHomeArchive = path.join(os.homedir(), "archive");
		const expectedCwdArchive = path.resolve("~archive");

		expect(context.roots).toContain(expectedHomeArchive);
		expect(context.roots).toContain(expectedCwdArchive);
		expect(context.roots).not.toContain(path.resolve(path.join(os.homedir(), "~archive")));
	});
});
