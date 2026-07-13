import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import register from "./main";
import { SkillRegistryToolContract } from "./schema";
import { SERVICE } from "./service-registry";

type EnvSnapshot = NodeJS.ProcessEnv;

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

type RegisteredTool = {
	name?: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	execute?: (...args: unknown[]) => Promise<ToolResult>;
};

/** 등록된 tool text payload 추출 helper입니다. */
function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text ?? "";
}

/** 임시 skill 문서를 작성합니다. */
function writeSkill(root: string, name: string, body: string): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		["---", `name: ${name}`, "description: test skill", "---", `# ${name}`, "", body].join("\n"),
		"utf-8",
	);
}

function registerHarness(): {
	tools: Array<RegisteredTool>;
	beforeAgentStart: ((event: { systemPrompt?: string | readonly string[] }) => unknown) | undefined;
} {
	const tools: Array<RegisteredTool> = [];
	let beforeAgentStart: ((event: { systemPrompt?: string | readonly string[] }) => unknown) | undefined;

	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		on(eventName: string, handler: unknown) {
			if (eventName === "before_agent_start") {
				beforeAgentStart = handler as (event: { systemPrompt?: string | readonly string[] }) => unknown;
			}
		},
	} as unknown as ExtensionAPI;

	register(pi);

	return { tools, beforeAgentStart };
}

function closeSkillIndex(): void {
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

describe("main entrypoint integration", () => {
	let root = "";
	let envSnapshot: EnvSnapshot = {};

	afterEach(() => {
		closeSkillIndex();
		restoreEnvironment(envSnapshot);
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
	});

	test("registers the skill_registry tool and before_agent_start hook directly", () => {
		envSnapshot = { ...process.env };
		const { tools, beforeAgentStart } = registerHarness();

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe(SkillRegistryToolContract.name);
		expect(tools[0]?.label).toBe(SkillRegistryToolContract.label);
		expect(tools[0]?.description).toBe(SkillRegistryToolContract.description);
		expect(JSON.stringify(tools[0]?.parameters)).toContain('"discover"');
		expect(JSON.stringify(tools[0]?.parameters)).toContain('"verification-packet"');
		expect(beforeAgentStart).toBeDefined();
		expect(typeof beforeAgentStart).toBe("function");
	});

	test("executes discover action through the registered tool", async () => {
		envSnapshot = { ...process.env };
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-main-"));
		process.env.OMP_AGENT_DIR = path.join(root, "agent-cache");
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";
		writeSkill(root, "alpha", "Security review guidance for runtime teams.");
		const { tools } = registerHarness();
		const tool = tools[0];
		if (!tool?.execute) {
			throw new Error("expected registered tool execute handler");
		}

		const result = await tool.execute(
			"tool-call-1",
			{
				action: "discover",
				query: "security review",
				roots: [root],
				fileNames: ["SKILL.md"],
				refresh: true,
			},
			undefined,
			undefined,
			undefined,
		);

		expect(textFromResult(result)).toContain("skill://alpha");
	});

	test("blocks query-only actions on small/medium taskSize and skips loadIndex", async () => {
		envSnapshot = { ...process.env };
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-main-"));
		process.env.OMP_AGENT_DIR = path.join(root, "agent-cache");
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";
		let loadIndexCalled = false;
		const expectedDbPath = path.join(process.env.OMP_AGENT_DIR, "cache", "skill-registry", "index.sqlite");
		const originalLoadIndex = SERVICE.skillIndexLoader.loadIndex;
		SERVICE.skillIndexLoader.loadIndex = async () => {
			loadIndexCalled = true;
			return {
				docCount: 0,
				skills: [],
				aliasToCanonical: new Map(),
				dfByTerm: new Map(),
				stats: {
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
				},
				generatedAt: Date.now(),
				ttlMs: 0,
				requestKey: "",
				settings: {
					roots: [],
					fileNames: [],
					maxTopK: 100,
					cacheTtlMs: 0,
					includePreviewBodyChars: 100,
					presetSkills: [],
					databasePath: expectedDbPath,
				},
				requestedNames: [],
				avgLength: 0,
				indexBuildMs: 0,
			};
		};

		try {
			const { tools } = registerHarness();
			const tool = tools[0];
			if (!tool?.execute) {
				throw new Error("expected registered tool execute handler");
			}

			const blockedActions = ["decide", "plan", "route", "current-turn-packet", "session-packet", "turn-packet"] as const;
			for (const action of blockedActions) {
				loadIndexCalled = false;
				const result = await tool.execute(
					`tool-call-${action}`,
					{
						action,
						query: "security review",
						taskSize: "medium",
						roots: ["/non-existent-path"],
						refresh: true,
					},
					undefined,
					undefined,
					undefined,
				);
				expect(loadIndexCalled).toBe(false);
				expect(textFromResult(result)).toContain('query-only 확장은 taskSize:"large"에서만 허용됩니다');
			}
		} finally {
			SERVICE.skillIndexLoader.loadIndex = originalLoadIndex;
		}
	});
});
