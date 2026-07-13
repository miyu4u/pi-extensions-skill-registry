import { describe, expect, test } from "@jest/globals";
import type { IndexArtifacts, IndexedStats, RawSkill, SkillRelationGraph, SkillRelationGraphEdge } from "../shared";
import { SkillIndexDiagnostics } from "./skill-index-diagnostics";
import type { SkillRelationEngine } from "./skill-relation-engine";

function makeSettings() {
	return {
		roots: ["./skills"],
		fileNames: ["SKILL.md"],
		presetSkills: [],
		databasePath: "/tmp/skill-registry-diagnostics.sqlite",
		cacheTtlMs: 60_000,
		maxTopK: 10,
		includePreviewBodyChars: 250,
	};
}

function makeStats(overrides: Partial<IndexedStats> = {}): IndexedStats {
	return {
		totalFilesVisited: 0,
		totalParsed: 0,
		skippedMissingRoot: 0,
		parseErrors: 0,
		deduplicated: 0,
		missingFromRequested: [],
		malformedFiles: [],
		duplicateCanonicalEntries: [],
		duplicateAliasEntries: [],
		nameFilterMode: "full",
		...overrides,
	};
}

function makeSkill(params: {
	id: string;
	canonicalName: string;
	sourceRoot: string;
	path: string;
	title?: string;
	category?: string;
	aliases?: string[];
	requires?: string[];
	recommends?: string[];
}): RawSkill {
	const {
		id,
		canonicalName,
		sourceRoot,
		path,
		title = canonicalName,
		category = "runtime",
		aliases = [],
		requires = [],
		recommends = [],
	} = params;
	return {
		id,
		canonicalName,
		path,
		sourceRoot,
		rawFrontmatter: {
			name: canonicalName,
		},
		frontmatter: {
			name: canonicalName,
			category,
			requires,
			recommends,
			aliases,
		},
		bodyText: `Body for ${canonicalName}`,
		title,
		category,
		keywords: ["indexing", "diagnostics"],
		tags: ["audit", "relations"],
		aliases,
		requires,
		recommends,
		text: `${canonicalName} ${aliases.join(" ")} body for ${canonicalName}`,
		mtimeMs: Date.now(),
	};
}

function makeIndex(params: { skills: RawSkill[]; stats?: Partial<IndexedStats>; aliasToCanonical?: Iterable<[string, string]> }): IndexArtifacts {
	const skills = params.skills;
	const map = new Map<string, string>(
		params.aliasToCanonical ??
			skills.flatMap((skill) => [
				[skill.canonicalName, skill.canonicalName],
				...skill.aliases.map((alias) => [alias, skill.canonicalName] as const),
			]),
	);
	return {
		generatedAt: Date.now(),
		ttlMs: 60_000,
		requestKey: "diagnostics-test",
		settings: makeSettings(),
		requestedNames: [],
		skills,
		stats: makeStats(params.stats),
		docCount: skills.length,
		dfByTerm: new Map(),
		aliasToCanonical: map,
		avgLength: 1,
		indexBuildMs: 1,
	};
}


describe("skill-index diagnostics", () => {

	test("validateIndex reports malformed, duplicate, and unresolved relation issues", () => {
		const alpha = makeSkill({
			id: "alpha",
			canonicalName: "alpha",
			sourceRoot: "/tmp/diag",
			path: "/tmp/diag/alpha.md",
			requires: ["missing-required"],
			recommends: ["missing-recommended"],
		});
		const beta = makeSkill({
			id: "beta",
			canonicalName: "beta",
			sourceRoot: "/tmp/diag",
			path: "/tmp/diag/beta.md",
		});
		const gamma = makeSkill({
			id: "gamma",
			canonicalName: "gamma",
			sourceRoot: "/tmp/diag",
			path: "/tmp/diag/gamma.md",
			aliases: ["shared-alias"],
		});
		const gammaCanonical = "shared";
		const stats = makeStats({
			malformedFiles: [
				{
					path: "/tmp/diag/malformed.md",
					reason: "frontmatter parse failed",
				},
			],
			duplicateCanonicalEntries: [
				{
					canonicalName: gammaCanonical,
					keptPath: "/tmp/diag/kept/shared.md",
					droppedPath: "/tmp/diag/dropped/shared.md",
				},
			],
			duplicateAliasEntries: [
				{
					alias: "shared-alias",
					canonicalName: "gamma",
					conflictingCanonicalName: "delta",
				},
				{
					alias: "shared-alias",
					canonicalName: "gamma",
					conflictingCanonicalName: "delta",
				},
				{
					alias: "legacy",
					canonicalName: "beta",
					conflictingCanonicalName: "epsilon",
				},
			],
		});
		const index = makeIndex({
			skills: [alpha, beta, gamma],
			stats,
		});

		const diagnostics = new SkillIndexDiagnostics({} as unknown as SkillRelationEngine);
		const report = diagnostics.validateIndex(index);

		expect(report.ok).toBe(false);
		expect(report.counts).toEqual({ errors: 3, warnings: 3 });
		expect(report.issues.find((issue) => issue.kind === "malformed-frontmatter")).toMatchObject({
			severity: "error",
			kind: "malformed-frontmatter",
			message: "Malformed SKILL.md: frontmatter parse failed",
			path: "/tmp/diag/malformed.md",
		});
		expect(report.issues.find((issue) => issue.kind === "duplicate-canonical-name")).toMatchObject({
			severity: "error",
			kind: "duplicate-canonical-name",
			skillName: gammaCanonical,
			path: "/tmp/diag/dropped/shared.md",
		});
		expect(report.issues.filter((issue) => issue.kind === "duplicate-alias")).toHaveLength(2);
		expect(
			report.issues.find((issue) => issue.kind === "broken-required-relation")?.message,
		).toBe("Required relation 'missing-required' from 'alpha' does not resolve.");
		expect(
			report.issues.find((issue) => issue.kind === "broken-recommended-relation")?.message,
		).toBe("Recommended relation 'missing-recommended' from 'alpha' does not resolve.");
		expect(report.issues.filter((issue) => issue.kind === "duplicate-alias")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "warning",
					kind: "duplicate-alias",
					message:
						"Alias 'shared-alias' resolves to 'gamma' and conflicts with 'delta'.",
				}),
				expect.objectContaining({
					severity: "warning",
					kind: "duplicate-alias",
					message: "Alias 'legacy' resolves to 'beta' and conflicts with 'epsilon'.",
				}),
			]),
		);
	});

	test("auditSkills returns sorted cycle/orphan findings and degree rankings", () => {
		const edges: SkillRelationGraphEdge[] = [
			{ from: "alpha", to: "beta", target: "beta", relation: "requires", resolved: true },
			{ from: "alpha", to: "gamma", target: "gamma", relation: "recommends", resolved: true },
			{ from: "beta", to: "gamma", target: "gamma", relation: "requires", resolved: true },
			{ from: "gamma", to: "delta", target: "delta", relation: "recommends", resolved: true },
			{ from: "delta", to: "beta", target: "beta", relation: "requires", resolved: true },
			{ from: "epsilon", to: "beta", target: "beta", relation: "recommends", resolved: true },
		];
		const relationEngine = {
			graphSkills: (_index: IndexArtifacts, _query: string | undefined, _names: string[], mode: string): SkillRelationGraph =>
				mode === "cycles"
					? {
						mode: "cycles",
						seeds: [],
						nodes: [],
						edges: [],
						readLayers: [],
						applyLayers: [],
						missing: [],
						cycles: [["beta", "gamma", "delta"]],
						orphans: [],
						diagnostics: {
							duplicateCanonicalEntries: [],
							duplicateAliasEntries: [],
						},
					}
					: {
						mode: "orphans",
						seeds: [],
						nodes: [],
						edges: [],
						readLayers: [],
						applyLayers: [],
						missing: [],
						cycles: [],
						orphans: ["orphan"],
						diagnostics: {
							duplicateCanonicalEntries: [],
							duplicateAliasEntries: [],
						},
					},
			buildRelationGraphEdges: (_index: IndexArtifacts): SkillRelationGraphEdge[] => edges,
		} as unknown as SkillRelationEngine;

		const diagnostics = new SkillIndexDiagnostics(relationEngine);
		const index = makeIndex({
			skills: [
				makeSkill({ id: "alpha", canonicalName: "alpha", sourceRoot: "/tmp/diag", path: "/tmp/diag/alpha.md" }),
				makeSkill({ id: "beta", canonicalName: "beta", sourceRoot: "/tmp/diag", path: "/tmp/diag/beta.md" }),
				makeSkill({ id: "gamma", canonicalName: "gamma", sourceRoot: "/tmp/diag", path: "/tmp/diag/gamma.md" }),
				makeSkill({ id: "delta", canonicalName: "delta", sourceRoot: "/tmp/diag", path: "/tmp/diag/delta.md" }),
				makeSkill({ id: "epsilon", canonicalName: "epsilon", sourceRoot: "/tmp/diag", path: "/tmp/diag/epsilon.md" }),
				makeSkill({ id: "orphan", canonicalName: "orphan", sourceRoot: "/tmp/diag", path: "/tmp/diag/orphan.md" }),
			],
		});

		const report = diagnostics.auditSkills(index, undefined, []);

		expect(report.ok).toBe(false);
		expect(report.counts).toEqual({
			totalSkills: 6,
			errors: 0,
			warnings: 1,
			info: 1,
			cycles: 1,
			orphans: 1,
			unresolvedRelations: 0,
		});
		expect(report.issues).toEqual([
			expect.objectContaining({
				severity: "warning",
				kind: "cycle",
				message: "Relation cycle detected: beta -> gamma -> delta -> beta",
				skillName: "beta",
				relatedSkills: ["beta", "gamma", "delta"],
			}),
			expect.objectContaining({
				severity: "info",
				kind: "orphan",
				message: "Orphan skill 'orphan' has no inbound or outbound relations.",
				skillName: "orphan",
				path: "/tmp/diag/orphan.md",
			}),
		]);
		expect(report.topInbound.map((entry) => entry.name)).toEqual(["beta", "gamma", "delta"]);
		expect(report.topInbound).toEqual([
			{
				name: "beta",
				path: "/tmp/diag/beta.md",
				inbound: 3,
				outbound: 1,
				requires: 1,
				recommends: 0,
			},
			{
				name: "gamma",
				path: "/tmp/diag/gamma.md",
				inbound: 2,
				outbound: 1,
				requires: 0,
				recommends: 1,
			},
			{
				name: "delta",
				path: "/tmp/diag/delta.md",
				inbound: 1,
				outbound: 1,
				requires: 1,
				recommends: 0,
			},
		]);
		expect(report.topOutbound.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
		expect(report.topOutbound).toEqual([
			{
				name: "alpha",
				path: "/tmp/diag/alpha.md",
				inbound: 0,
				outbound: 2,
				requires: 1,
				recommends: 1,
			},
			{
				name: "beta",
				path: "/tmp/diag/beta.md",
				inbound: 3,
				outbound: 1,
				requires: 1,
				recommends: 0,
			},
			{
				name: "gamma",
				path: "/tmp/diag/gamma.md",
				inbound: 2,
				outbound: 1,
				requires: 0,
				recommends: 1,
			},
			{
				name: "delta",
				path: "/tmp/diag/delta.md",
				inbound: 1,
				outbound: 1,
				requires: 1,
				recommends: 0,
			},
			{
				name: "epsilon",
				path: "/tmp/diag/epsilon.md",
				inbound: 0,
				outbound: 1,
				requires: 0,
				recommends: 1,
			},
		]);
	});
});
