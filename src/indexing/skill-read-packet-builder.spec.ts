import { describe, expect, test } from "@jest/globals";
import type { IndexArtifacts, IndexedStats, RawSkill, SkillRouteResult } from "../shared";
import type { SkillDecisionEngine } from "./skill-decision-engine";
import type { SkillIndexDiagnostics } from "./skill-index-diagnostics";
import { SkillReadPacketBuilder } from "./skill-read-packet-builder";
import type { SkillRelationEngine, SkillRelationProjection } from "./skill-relation-engine";

type FixturePackRow = {
	name: string;
	path: string;
	body: string;
	reason: "seed" | "required" | "recommended";
	readLayer: number | null;
	applyLayer: number | null;
	depth: number;
};

function makeSettings() {
	return {
		roots: ["./skills"],
		fileNames: ["SKILL.md"],
		presetSkills: [],
		databasePath: "/tmp/skill-registry-read-packet.sqlite",
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

function makeIndex(fixtures: FixturePackRow[]): IndexArtifacts {
	return {
		generatedAt: 1_700_000_000_000,
		ttlMs: 60_000,
		requestKey: "read-packet-spec",
		settings: makeSettings(),
		requestedNames: [],
		skills: fixtures.map(
			(fixture, index): RawSkill => ({
				id: `skill-${index}`,
				canonicalName: fixture.name,
				path: fixture.path,
				sourceRoot: "/tmp/source",
				rawFrontmatter: {
					name: fixture.name,
				},
				frontmatter: {
					name: fixture.name,
					category: "runtime",
					requires: [],
					recommends: [],
					aliases: [],
				},
				bodyText: fixture.body,
				title: fixture.name,
				category: "runtime",
				keywords: ["pack", "test"],
				tags: ["routing"],
				aliases: [],
				requires: [],
				recommends: [],
				text: `${fixture.name} ${fixture.body}`,
				mtimeMs: Date.now(),
			}),
		),
		stats: makeStats(),
		docCount: fixtures.length,
		dfByTerm: new Map(),
		aliasToCanonical: new Map(fixtures.map((fixture) => [fixture.name, fixture.name] as const)),
		avgLength: 1,
		indexBuildMs: 1,
	};
}

function makeProjection(fixtures: FixturePackRow[]): SkillRelationProjection {
	const skills = makeIndex(fixtures).skills;
	const entries = fixtures.map((fixture, index) => ({
		skill: skills[index],
		reason: fixture.reason,
		depth: fixture.depth,
		readLayer: fixture.readLayer,
		applyLayer: fixture.applyLayer,
	}));

	return {
		relationMode: "full",
		seeds: fixtures.map((fixture) => fixture.name),
		entries,
		readLayers: fixtures.map((fixture) => [fixture.name]),
		applyLayers: fixtures.map((fixture) => [fixture.name]),
		missing: [],
		cycles: [],
		orphans: [],
		compose: {
			relationMode: "full",
			seeds: [],
			entries: [],
			missing: [],
		},
		graph: {
			mode: "outbound",
			seeds: fixtures.map((fixture) => fixture.name),
			nodes: entries.map(({ skill }) => ({
				name: skill.canonicalName,
				path: skill.path,
				title: skill.title,
				category: skill.category,
				aliases: skill.aliases,
			})),
			edges: [],
			readLayers: fixtures.map((fixture) => [fixture.name]),
			applyLayers: fixtures.map((fixture) => [fixture.name]),
			missing: [],
			cycles: [],
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
	} as SkillRelationProjection;
}

function makeRouteResult(
	phases: Array<{ kind: "start" | "read-layer" | "apply-layer" | "fallback"; layer: number | null; names: string[] }>,
): SkillRouteResult {
	return {
		query: "packet",
		basis: "query",
		relationMode: "full",
		winner: phases[0]?.names[0] ?? null,
		phases: phases.map((phase, order) => ({
			order: order + 1,
			kind: phase.kind,
			layer: phase.layer,
			names: [...phase.names],
			readPaths: phase.names.map((name) => `skill://${name}`),
			rationale: ["fixture"],
		})),
		deferred: [],
	} as SkillRouteResult;
}

function makeBuilder(_index: IndexArtifacts, route: SkillRouteResult, projection: SkillRelationProjection): SkillReadPacketBuilder {
	const relationEngine = {
		projectSkills: (_index: IndexArtifacts) => projection,
	} as unknown as SkillRelationEngine;
	const decisionEngine = {
		routeSkills: () => route,
	} as unknown as SkillDecisionEngine;
	const indexDiagnostics = {
		validateIndex: () => ({
			ok: true,
			counts: {
				errors: 0,
				warnings: 0,
			},
			issues: [],
		}),
	} as unknown as SkillIndexDiagnostics;
	return new SkillReadPacketBuilder(relationEngine, indexDiagnostics, decisionEngine);
}

describe("skill-read-packet-builder", () => {
	test("keeps read/apply phase order with layer context", () => {
		const fixtures: FixturePackRow[] = [
			{
				name: "starter",
				path: "/tmp/read-layer/starter.md",
				body: "Starter",
				reason: "seed",
				readLayer: 0,
				applyLayer: 0,
				depth: 0,
			},
			{
				name: "reader",
				path: "/tmp/read-layer/reader.md",
				body: "Reader",
				reason: "required",
				readLayer: 0,
				applyLayer: 3,
				depth: 0,
			},
			{
				name: "planner",
				path: "/tmp/read-layer/planner.md",
				body: "Planner",
				reason: "required",
				readLayer: 1,
				applyLayer: 0,
				depth: 1,
			},
			{
				name: "extender",
				path: "/tmp/read-layer/extender.md",
				body: "Extender",
				reason: "recommended",
				readLayer: 2,
				applyLayer: 4,
				depth: 2,
			},
		];
		const index = makeIndex(fixtures);
		const projection = makeProjection(fixtures);
		const route = makeRouteResult([
			{ kind: "start", layer: null, names: ["starter"] },
			{ kind: "read-layer", layer: 0, names: ["reader", "planner"] },
			{ kind: "apply-layer", layer: 4, names: ["extender"] },
		]);
		const builder = makeBuilder(index, route, projection);

		const result = builder.turnPacketSkills(index, "routing", ["starter"]);

		expect(result.turns.map((turn) => turn.phaseKind)).toEqual(["start", "read-layer", "apply-layer"]);
		expect(result.turns.map((turn) => turn.layer)).toEqual([null, 0, 4]);
		expect(result.turns[1].sourcePaths).toEqual(["/tmp/read-layer/reader.md", "/tmp/read-layer/planner.md"]);
		expect(result.turns[2].sourcePaths).toEqual(["/tmp/read-layer/extender.md"]);
		expect(result.sourcePaths).toEqual([
			"/tmp/read-layer/starter.md",
			"/tmp/read-layer/reader.md",
			"/tmp/read-layer/planner.md",
			"/tmp/read-layer/extender.md",
		]);
		expect(result.nextCommands).toEqual([
			'read("/tmp/read-layer/starter.md")',
			'read("/tmp/read-layer/reader.md")',
			'read("/tmp/read-layer/planner.md")',
			'read("/tmp/read-layer/extender.md")',
		]);
		expect(result.turns.every((turn) => turn.blockedByBudget)).toBe(false);
	});

	test("omits entry bodies by budget and reports omittedReadPaths", () => {
		const fixtures: FixturePackRow[] = [
			{
				name: "seed",
				path: "/tmp/budget/seed.md",
				body: "AA",
				reason: "seed",
				readLayer: 0,
				applyLayer: 0,
				depth: 0,
			},
			{
				name: "required-small",
				path: "/tmp/budget/required-small.md",
				body: "BBBB",
				reason: "required",
				readLayer: 0,
				applyLayer: 0,
				depth: 1,
			},
			{
				name: "required-big",
				path: "/tmp/budget/required-big.md",
				body: "CCCCCC",
				reason: "required",
				readLayer: 1,
				applyLayer: 1,
				depth: 1,
			},
			{
				name: "optional-tail",
				path: "/tmp/budget/optional-tail.md",
				body: "Z",
				reason: "recommended",
				readLayer: 2,
				applyLayer: 2,
				depth: 2,
			},
		];
		const index = makeIndex(fixtures);
		const projection = makeProjection(fixtures);
		const route = makeRouteResult([
			{ kind: "start", layer: null, names: ["seed"] },
			{ kind: "read-layer", layer: 0, names: ["required-small", "required-big"] },
			{ kind: "apply-layer", layer: 2, names: ["optional-tail"] },
		]);
		const builder = makeBuilder(index, route, projection);

		const result = builder.briefSkills(index, "budget", ["seed"], "full", true, 7, 3);
		const byName = new Map(result.entries.map((entry) => [entry.name, entry] as const));

		expect(result.budget.usedChars).toBe(7);
		expect(result.omittedReadPaths).toEqual(["skill://required-big"]);
		expect(byName.get("seed")?.body).toBe("AA");
		expect(byName.get("required-small")?.body).toBe("BBBB");
		expect(byName.get("required-big")?.body).toBeUndefined();
		expect(byName.get("required-big")?.omittedByBudget).toBe(true);
		expect(byName.get("optional-tail")?.body).toBe("Z");
		expect(byName.get("optional-tail")?.omittedByBudget).toBe(false);
	});

	test("preserves source path strings in handoff read command", () => {
		const fixtures: FixturePackRow[] = [
			{
				name: "winner",
				path: "/tmp/preserved read/source path.md",
				body: "Seed body",
				reason: "seed",
				readLayer: 0,
				applyLayer: 0,
				depth: 0,
			},
		];
		const index = makeIndex(fixtures);
		const projection = makeProjection(fixtures);
		const route = makeRouteResult([{ kind: "start", layer: null, names: ["winner"] }]);
		const builder = makeBuilder(index, route, projection);

		const result = builder.handoffSkills(index, "handoff", ["winner"]);

		expect(result.sourcePath).toBe("/tmp/preserved read/source path.md");
		expect(result.nextCommand).toBe('read("/tmp/preserved read/source path.md")');
	});

	test("routes recovery -> resume -> current-turn from first blocked phase", () => {
		const fixtures: FixturePackRow[] = [
			{
				name: "winner",
				path: "/tmp/recovery/current.md",
				body: "S",
				reason: "seed",
				readLayer: 0,
				applyLayer: 0,
				depth: 0,
			},
			{
				name: "blocked",
				path: "/tmp/recovery/block file.md",
				body: "BLOCKED BODY",
				reason: "required",
				readLayer: 1,
				applyLayer: 1,
				depth: 1,
			},
			{
				name: "follow-up",
				path: "/tmp/recovery/follow-up.md",
				body: "K",
				reason: "recommended",
				readLayer: 2,
				applyLayer: 2,
				depth: 2,
			},
		];
		const index = makeIndex(fixtures);
		const projection = makeProjection(fixtures);
		const route = makeRouteResult([
			{ kind: "start", layer: null, names: ["winner"] },
			{ kind: "read-layer", layer: 1, names: ["blocked"] },
			{ kind: "apply-layer", layer: 2, names: ["follow-up"] },
		]);
		const builder = makeBuilder(index, route, projection);

		const recovery = builder.recoveryPacketSkills(index, "recovery", ["winner"], "full", 2, 100);
		const resume = builder.resumePacketSkills(index, "recovery", ["winner"], "full", 2, 100);
		const current = builder.currentTurnPacketSkills(index, "recovery", ["winner"], "full", 2, 100);

		expect(recovery.resumeTurnOrder).toBe(2);
		expect(recovery.blockedTurns).toHaveLength(1);
		expect(recovery.blockedTurns[0]).toMatchObject({
			order: 2,
			phaseKind: "read-layer",
			sourcePaths: ["/tmp/recovery/block file.md"],
			recoveryCommands: ['read("/tmp/recovery/block file.md")'],
			names: ["blocked"],
		});
		expect(recovery.recoveryCommands).toEqual(['read("/tmp/recovery/block file.md")']);

		expect(resume.resumeTurnOrder).toBe(2);
		expect(resume.turns.map((turn) => turn.order)).toEqual([2, 3]);
		expect(resume.turns[0].blockedByBudget).toBe(true);
		expect(resume.turns[0].phaseKind).toBe("read-layer");
		expect(resume.turns[1].blockedByBudget).toBe(false);
		expect(resume.turns[1].phaseKind).toBe("apply-layer");
		expect(resume.nextCommands).toEqual(['read("/tmp/recovery/block file.md")', 'read("/tmp/recovery/follow-up.md")']);

		expect(current.activeTurnOrder).toBe(2);
		expect(current.turn).toMatchObject({
			order: 2,
			phaseKind: "read-layer",
			blockedByBudget: true,
			sourcePaths: ["/tmp/recovery/block file.md"],
		});
		expect(current.ready).toBe(false);
		expect(current.sourcePaths).toEqual(["/tmp/recovery/block file.md"]);
		expect(current.nextCommands).toEqual(['read("/tmp/recovery/block file.md")']);
		expect(current.recoveryCommands).toEqual(recovery.recoveryCommands);
		expect(current.sourcePaths).toEqual(resume.turns[0]?.sourcePaths ?? []);
	});
});
