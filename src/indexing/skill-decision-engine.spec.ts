import { describe, expect, test } from "@jest/globals";
import type { IndexArtifacts, IndexedStats, RawSkill, SearchHit } from "../shared";
import { SkillDecisionEngine } from "./skill-decision-engine";
import type { SkillRelationEngine } from "./skill-relation-engine";
import type { SkillSearchEngine } from "./skill-search-engine";

/** compact hit fixture helper */
type FixtureHit = {
	canonicalName: string;
	score: number;
	coverage: number;
	matchedTerms: string[];
};

/** relation pack entry helper */
type PackEntry = {
	name: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	requires: string[];
	recommends: string[];
	reason: "seed" | "required" | "recommended";
	via?: string;
	depth: number;
	readLayer: number | null;
	applyLayer: number | null;
	preview: string;
	readPath: string;
};

function makeSettings() {
	return {
		roots: ["./skills"],
		scopeRoots: {},
		scopePriority: [],
		fileNames: ["SKILL.md"],
		presetSkills: [],
		databasePath: "/tmp/skill-registry-decision.sqlite",
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
		keywords: ["decision", "test"],
		tags: ["routing"],
		aliases,
		requires,
		recommends,
		text: `${canonicalName} ${aliases.join(" ")} body for ${canonicalName}`,
		mtimeMs: Date.now(),
	};
}

function makeIndex(skills: RawSkill[]): IndexArtifacts {
	return {
		generatedAt: Date.now(),
		ttlMs: 60_000,
		requestKey: "decision-test",
		settings: makeSettings(),
		requestedNames: [],
		skills,
		stats: makeStats(),
		docCount: skills.length,
		dfByTerm: new Map(),
		aliasToCanonical: new Map(
			skills.flatMap((skill) => [
				[skill.canonicalName, skill.canonicalName],
				...skill.aliases.map((alias) => [alias, skill.canonicalName] as const),
			]),
		),
		avgLength: 1,
		indexBuildMs: 1,
	};
}

function createSearchEngine(config: { hitsByQuery?: Record<string, FixtureHit[]> }): SkillSearchEngine {
	const byQuery = new Map<string, FixtureHit[]>(Object.entries(config.hitsByQuery ?? {}));
	const resolveByName = (index: IndexArtifacts, names: string[]): RawSkill[] => {
		const byCanonical = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const seen = new Set<string>();
		return names
			.map((name) => byCanonical.get(index.aliasToCanonical.get(name) ?? name))
			.filter((skill): skill is RawSkill => {
				if (!skill || seen.has(skill.canonicalName)) {
					return false;
				}
				seen.add(skill.canonicalName);
				return true;
			});
	};
	const resolveQueryHits = (index: IndexArtifacts, query: string, limit: number, minScore: number): SearchHit[] => {
		const fixtures = byQuery.get(query);
		if (!fixtures) {
			return [];
		}
		const byCanonical = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		return fixtures
			.map((fixture) => {
				const found = byCanonical.get(fixture.canonicalName);
				if (!found || fixture.score < minScore) {
					return null;
				}
				return {
					skill: found,
					score: fixture.score,
					coverage: fixture.coverage,
					matchedTerms: fixture.matchedTerms,
				};
			})
			.filter((hit): hit is SearchHit => hit !== null)
			.slice(0, limit);
	};

	return {
		searchByBm25: (index: IndexArtifacts, query: string | undefined, limit = index.settings.maxTopK, minScore = 0): SearchHit[] => {
			if (!query) {
				return [];
			}
			return resolveQueryHits(index, query, limit, minScore);
		},
		findSkillsByNames: (index: IndexArtifacts, names: string[]) => resolveByName(index, names),
		resolveSeedSkills: (
			index: IndexArtifacts,
			query: string | undefined,
			names: string[],
			limit: number = index.settings.maxTopK,
			minScore: number = 0,
		) => {
			const namedSeedSkills = resolveByName(index, names);
			const querySeedSkills = query ? resolveQueryHits(index, query, limit, minScore).map((hit) => hit.skill) : [];
			return [...namedSeedSkills, ...querySeedSkills].filter(
				(skill: RawSkill, indexPosition: number, collection: RawSkill[]) =>
					collection.findIndex((entry) => entry.canonicalName === skill.canonicalName) === indexPosition,
			);
		},
	} as unknown as SkillSearchEngine;
}

function createRelationEngine(config: {
	relationMode?: "required" | "full";
	projection?: {
		seeds: string[];
		entries: PackEntry[];
		missing?: Array<{ name: string; relation: "required" | "recommended"; via: string; depth: number }>;
		cycles?: string[][];
		readLayers?: string[][];
		applyLayers?: string[][];
	};
	edges?: Array<{
		from: string;
		to?: string;
		target: string;
		relation: "requires" | "recommends";
		resolved: boolean;
	}>;
}) {
	const relationMode = config.relationMode ?? "full";
	const projection = config.projection ?? { seeds: [], entries: [] };
	const readLayers = projection.readLayers ?? [];
	const applyLayers = projection.applyLayers ?? [];
	const edges = config.edges ?? [];
	const byFrom = new Map<string, typeof edges>();
	const byTo = new Map<string, typeof edges>();
	for (const edge of edges) {
		const fromBucket = byFrom.get(edge.from) ?? [];
		fromBucket.push(edge);
		byFrom.set(edge.from, fromBucket);
		if (edge.to) {
			const toBucket = byTo.get(edge.to) ?? [];
			toBucket.push(edge);
			byTo.set(edge.to, toBucket);
		}
	}
	return {
		projectSkills: () => ({
			relationMode,
			seeds: projection.seeds,
			entries: projection.entries.map((entry) => ({
				skill: {
					...makeSkill({
						id: entry.name,
						canonicalName: entry.name,
						sourceRoot: "/tmp/decision",
						path: entry.path,
						title: entry.title,
						category: entry.category,
						aliases: entry.aliases,
						requires: entry.requires,
						recommends: entry.recommends,
					}),
					bodyText: entry.preview,
				},
				reason: entry.reason,
				via: entry.via,
				depth: entry.depth,
				readLayer: entry.readLayer,
				applyLayer: entry.applyLayer,
			})),
			readLayers,
			applyLayers,
			missing: projection.missing ?? [],
			cycles: projection.cycles ?? [],
			orphans: projection.cycles ? projection.cycles.flat() : [],
			compose: {
				relationMode,
				seeds: [],
				entries: [],
				missing: [],
			},
			graph: {
				mode: "outbound",
				seeds: projection.seeds,
				nodes: [],
				edges,
				readLayers,
				applyLayers,
				missing: projection.missing ?? [],
				cycles: projection.cycles ?? [],
				orphans: [],
				diagnostics: {
					duplicateCanonicalEntries: [],
					duplicateAliasEntries: [],
				},
			},
			diagnostics: {
				duplicateCanonicalEntries: [],
				duplicateAliasEntries: [],
			},
		}),
		buildRelationGraphEdges: () => edges,
		groupEdgesByCanonical: (
			edgesList: Array<{ from: string; to?: string; target: string; relation: "requires" | "recommends"; resolved: boolean }>,
			direction: "from" | "to",
		) => {
			const grouped = new Map<string, typeof edgesList>();
			for (const edge of edgesList) {
				const key = direction === "from" ? edge.from : edge.to;
				if (!key) {
					continue;
				}
				const bucket = grouped.get(key) ?? [];
				bucket.push(edge);
				grouped.set(key, bucket);
			}
			return grouped;
		},
	} as unknown as SkillRelationEngine;
}

describe("skill-decision-engine", () => {
	test("decideSkills orders tied winners deterministically", () => {
		const index = makeIndex([
			makeSkill({
				id: "skill-alpha",
				canonicalName: "alpha",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/alpha.md",
			}),
			makeSkill({
				id: "skill-beta",
				canonicalName: "beta",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/beta.md",
			}),
		]);
		const searchEngine = createSearchEngine({
			hitsByQuery: {
				focus: [
					{ canonicalName: "alpha", score: 3, coverage: 2, matchedTerms: ["focus"] },
					{ canonicalName: "beta", score: 3, coverage: 2, matchedTerms: ["focus"] },
				],
			},
		});
		const engine = new SkillDecisionEngine(searchEngine, {} as unknown as SkillRelationEngine);

		const byQuery = engine.decideSkills(index, "focus", [], 10, 0);
		expect(byQuery.basis).toBe("query");
		expect(byQuery.winner).toBe("alpha");
		expect(byQuery.ordered.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
		expect(byQuery.ordered[0]).toMatchObject({
			name: "alpha",
			explicitName: false,
			score: 3.5,
			queryScore: 3,
			queryCoverage: 2,
		});

		const byNames = engine.decideSkills(index, undefined, ["beta", "alpha"], 10, 0);
		expect(byNames.basis).toBe("names");
		expect(byNames.winner).toBe("alpha");
		expect(byNames.ordered.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
	});

	test("planSkills and routeSkills layer read/apply phases from relation signals", () => {
		const index = makeIndex([
			makeSkill({
				id: "core-skill",
				canonicalName: "alpha",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/alpha.md",
			}),
			makeSkill({
				id: "required-by-alpha",
				canonicalName: "beta",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/beta.md",
				requires: ["alpha"],
			}),
			makeSkill({
				id: "recommended-by-alpha",
				canonicalName: "gamma",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/gamma.md",
				recommends: ["alpha"],
			}),
		]);
		const searchEngine = createSearchEngine({});
		const relationEngine = createRelationEngine({
			relationMode: "full",
			projection: {
				seeds: ["alpha"],
				entries: [
					{
						name: "alpha",
						path: "/tmp/decision/alpha.md",
						title: "Alpha",
						category: "runtime",
						aliases: [],
						requires: [],
						recommends: [],
						reason: "seed",
						depth: 0,
						readLayer: 0,
						applyLayer: 0,
						preview: "alpha body",
						readPath: "skill://alpha",
					},
					{
						name: "beta",
						path: "/tmp/decision/beta.md",
						title: "Beta",
						category: "runtime",
						aliases: [],
						requires: ["alpha"],
						recommends: [],
						reason: "required",
						via: "alpha",
						depth: 1,
						readLayer: 1,
						applyLayer: 1,
						preview: "beta body",
						readPath: "skill://beta",
					},
					{
						name: "gamma",
						path: "/tmp/decision/gamma.md",
						title: "Gamma",
						category: "runtime",
						aliases: [],
						requires: [],
						recommends: ["alpha"],
						reason: "recommended",
						via: "alpha",
						depth: 1,
						readLayer: 2,
						applyLayer: 3,
						preview: "gamma body",
						readPath: "skill://gamma",
					},
				],
			},
		});
		const engine = new SkillDecisionEngine(searchEngine, relationEngine);

		const plan = engine.planSkills(index, undefined, ["alpha", "beta", "gamma"], "full", 10, 0);
		expect(plan.winner).toBe("alpha");
		expect(plan.steps.map((step) => ({ name: step.name, reason: step.reason, phase: step.phase, via: step.via }))).toEqual([
			{ name: "alpha", reason: "winner", phase: "first", via: undefined },
			{ name: "beta", reason: "unblocks-required-peer", phase: "next", via: "alpha" },
			{ name: "gamma", reason: "unblocks-recommended-peer", phase: "later", via: "alpha" },
		]);

		const route = engine.routeSkills(index, undefined, ["alpha", "beta", "gamma"], "full", 10, 0);
		expect(route.winner).toBe("alpha");
		expect(route.phases).toEqual([
			{
				order: 1,
				kind: "start",
				layer: null,
				names: ["alpha"],
				readPaths: ["skill://alpha"],
				rationale: ["decide winner"],
			},
			{
				order: 2,
				kind: "read-layer",
				layer: 1,
				names: ["beta"],
				readPaths: ["skill://beta"],
				rationale: ["pack read layer 1"],
			},
			{
				order: 3,
				kind: "apply-layer",
				layer: 3,
				names: ["gamma"],
				readPaths: ["skill://gamma"],
				rationale: ["pack apply layer 3"],
			},
		]);

		const relationModeRequired = engine.routeSkills(index, undefined, ["alpha", "beta", "gamma"], "required", 10, 0);
		expect(relationModeRequired.phases).toEqual([
			{
				order: 1,
				kind: "start",
				layer: null,
				names: ["alpha"],
				readPaths: ["skill://alpha"],
				rationale: ["decide winner"],
			},
			{
				order: 2,
				kind: "read-layer",
				layer: 1,
				names: ["beta"],
				readPaths: ["skill://beta"],
				rationale: ["pack read layer 1"],
			},
			{
				order: 3,
				kind: "fallback",
				layer: null,
				names: ["gamma"],
				readPaths: ["skill://gamma"],
				rationale: ["remaining planned steps"],
			},
		]);
	});

	test("explainSkills reflects relation seed causes and relation-mode projection", () => {
		const index = makeIndex([
			makeSkill({
				id: "core-skill",
				canonicalName: "core",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/core.md",
			}),
			makeSkill({
				id: "required-skill",
				canonicalName: "addon",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/addon.md",
				requires: ["core"],
			}),
			makeSkill({
				id: "recommended-skill",
				canonicalName: "plugin",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/plugin.md",
				recommends: ["core"],
			}),
		]);
		const searchEngine = createSearchEngine({
			hitsByQuery: {
				routing: [
					{ canonicalName: "core", score: 2.4, coverage: 1, matchedTerms: ["routing"] },
					{ canonicalName: "addon", score: 1.1, coverage: 1, matchedTerms: ["routing"] },
				],
			},
		});
		const relationEngine = createRelationEngine({
			relationMode: "full",
			projection: {
				seeds: ["core", "addon"],
				entries: [
					{
						name: "core",
						path: "/tmp/decision/core.md",
						title: "Core",
						category: "runtime",
						aliases: [],
						requires: [],
						recommends: [],
						reason: "seed",
						depth: 0,
						readLayer: null,
						applyLayer: null,
						preview: "core body",
						readPath: "skill://core",
					},
					{
						name: "addon",
						path: "/tmp/decision/addon.md",
						title: "Addon",
						category: "runtime",
						aliases: [],
						requires: ["core"],
						recommends: [],
						reason: "required",
						via: "core",
						depth: 1,
						readLayer: 0,
						applyLayer: 0,
						preview: "addon body",
						readPath: "skill://addon",
					},
					{
						name: "plugin",
						path: "/tmp/decision/plugin.md",
						title: "Plugin",
						category: "runtime",
						aliases: [],
						requires: [],
						recommends: ["core"],
						reason: "recommended",
						via: "core",
						depth: 1,
						readLayer: 1,
						applyLayer: 1,
						preview: "plugin body",
						readPath: "skill://plugin",
					},
				],
				missing: [{ name: "missing-addon", relation: "required", via: "addon", depth: 1 }],
				cycles: [["core", "addon"]],
			},
		});
		const engine = new SkillDecisionEngine(searchEngine, relationEngine);
		const explain = engine.explainSkills(index, "routing", [], "full", 10, 0);

		expect(explain.relationMode).toBe("full");
		expect(explain.seeds).toEqual(["core", "addon"]);
		expect(explain.missing).toEqual([{ name: "missing-addon", relation: "required", via: "addon", depth: 1 }]);
		expect(explain.cycles).toEqual([["core", "addon"]]);
		expect(explain.entries[0]).toMatchObject({
			name: "core",
			reason: "seed",
			via: undefined,
			depth: 0,
			score: 2.4,
			coverage: 1,
			matchedTerms: ["routing"],
		});
		expect(explain.entries[1]).toMatchObject({
			name: "addon",
			reason: "required",
			via: "core",
			depth: 1,
		});
		expect(explain.entries[2]).toMatchObject({
			name: "plugin",
			reason: "recommended",
			via: "core",
			depth: 1,
		});
	});

	test("recommendSkills emits relation signals and honors required-only mode", () => {
		const index = makeIndex([
			makeSkill({
				id: "seed-skill",
				canonicalName: "core",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/core.md",
				category: "runtime",
			}),
			makeSkill({
				id: "required-skill",
				canonicalName: "beta",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/beta.md",
				category: "runtime",
			}),
			makeSkill({
				id: "recommend-skill",
				canonicalName: "gamma",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/gamma.md",
				category: "platform",
			}),
			makeSkill({
				id: "inbound-required",
				canonicalName: "delta",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/delta.md",
				category: "runtime",
			}),
			makeSkill({
				id: "inbound-recommended",
				canonicalName: "epsilon",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/epsilon.md",
				category: "platform",
			}),
		]);
		const searchEngine = createSearchEngine({
			hitsByQuery: {
				throughput: [{ canonicalName: "core", score: 3.5, coverage: 1, matchedTerms: ["throughput"] }],
			},
		});
		const relationEngine = createRelationEngine({
			edges: [
				{ from: "core", to: "beta", target: "beta", relation: "requires", resolved: true },
				{ from: "core", to: "gamma", target: "gamma", relation: "recommends", resolved: true },
				{ from: "delta", to: "core", target: "core", relation: "requires", resolved: true },
				{ from: "epsilon", to: "core", target: "core", relation: "recommends", resolved: true },
			],
		});
		const engine = new SkillDecisionEngine(searchEngine, relationEngine);

		const fullMode = engine.recommendSkills(index, "throughput", ["core"], "full", 10, 0);
		const full = new Map(fullMode.recommendations.map((item) => [item.name, item]));
		expect(fullMode.seeds).toEqual(["core"]);
		expect(Array.from(full.keys())).toEqual(["beta", "gamma", "delta", "epsilon"]);
		expect(full.get("gamma")?.outboundSignals).toEqual([{ relation: "recommended", via: "core" }]);
		expect(full.get("delta")?.inboundSignals).toEqual([{ relation: "required", via: "core" }]);
		expect(full.get("epsilon")?.inboundSignals).toEqual([{ relation: "recommended", via: "core" }]);
		expect(full.get("delta")?.sharedCategorySeeds).toEqual(["core"]);

		const requiredOnly = engine.recommendSkills(index, "throughput", ["core"], "required", 10, 0);
		const required = new Map(requiredOnly.recommendations.map((item) => [item.name, item]));
		expect(required.get("gamma")).toBeUndefined();
		expect(required.get("epsilon")).toBeUndefined();
		expect(required.get("delta")?.inboundSignals).toEqual([{ relation: "required", via: "core" }]);
	});

	test("compareSkills emits directional relation pairs with compact fixtures", () => {
		const index = makeIndex([
			makeSkill({
				id: "alpha-skill",
				canonicalName: "alpha",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/alpha.md",
				category: "runtime",
				aliases: ["alpha-a"],
				requires: ["beta-alt"],
			}),
			makeSkill({
				id: "beta-skill",
				canonicalName: "beta",
				sourceRoot: "/tmp/decision",
				path: "/tmp/decision/beta.md",
				category: "runtime",
				aliases: ["beta-alt", "beta-side"],
				recommends: ["alpha"],
			}),
		]);
		const searchEngine = createSearchEngine({
			hitsByQuery: {
				dependency: [
					{ canonicalName: "alpha", score: 4.7, coverage: 2, matchedTerms: ["dependency", "runtime"] },
					{ canonicalName: "beta", score: 2.8, coverage: 1, matchedTerms: ["runtime", "telemetry"] },
				],
			},
		});
		const engine = new SkillDecisionEngine(searchEngine, {} as unknown as SkillRelationEngine);
		const result = engine.compareSkills(index, "dependency", [], 10, 0);

		expect(result.basis).toBe("query");
		expect(result.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]).toMatchObject({
			left: "alpha",
			right: "beta",
			sameCategory: true,
			sharedMatchedTerms: ["runtime"],
			leftOnlyMatchedTerms: ["dependency"],
			rightOnlyMatchedTerms: ["telemetry"],
			leftToRight: "requires",
			rightToLeft: "recommends",
		});
		expect(result.pairs[0]?.scoreDelta).toBe(1.9);
	});
});
