import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../../src/main";
import { SERVICE } from "../../src/service-registry";
import { SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK } from "../../src/shared";

type EnvSnapshot = NodeJS.ProcessEnv;

type SkillRegistryToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

type RegisteredTool = {
	name?: string;
	parameters?: unknown;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: ((partial: SkillRegistryToolResult) => void) | undefined,
		ctx?: unknown,
	) => Promise<SkillRegistryToolResult>;
};

type BeforeAgentStartHandler = (event: { systemPrompt?: string | readonly string[] }) => Promise<{ systemPrompt: string } | undefined>;

const temporaryDirectories: string[] = [];
let envSnapshot: EnvSnapshot = {};

afterEach(async () => {
	SERVICE.skillIndexLoader.close();
	restoreEnvironment(envSnapshot);
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

/**
 * 등록된 tool의 text payload를 추출합니다.
 *
 * @param result tool 실행 결과
 */
function textFromResult(result: SkillRegistryToolResult): string {
	return result.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text ?? "";
}

/**
 * e2e workspace에 skill-registry settings 파일을 씁니다.
 *
 * @param workspace workspace root
 * @param settings skillRegistry 설정값
 */
async function writeSkillRegistrySettings(workspace: string, settings: Record<string, unknown>): Promise<void> {
	const settingsDirectory = join(workspace, ".pi", "settings", "skill-registry");
	await mkdir(settingsDirectory, { recursive: true });
	await writeFile(join(settingsDirectory, "skill-registry.json"), JSON.stringify({ skillRegistry: settings }, null, 2), "utf8");
}

/**
 * e2e workspace에 skill fixture를 작성합니다.
 *
 * @param root skill root directory
 * @param name canonical skill name
 * @param body skill 본문
 * @param extraFrontmatter 추가 frontmatter 행
 */
async function writeSkill(root: string, name: string, body: string, extraFrontmatter: string[] = []): Promise<void> {
	const skillDirectory = join(root, name);
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		["---", `name: ${name}`, "description: observability skill fixture", ...extraFrontmatter, "---", `# ${name}`, "", body].join("\n"),
		"utf8",
	);
}

/**
 * workspace 기준 cwd를 임시 전환해 실행하고 복구합니다.
 *
 * @param workspace workspace root
 * @param run 실행할 비동기 함수
 */
async function withWorkspaceCwd(workspace: string, run: () => Promise<void>): Promise<void> {
	const previousCwd = process.cwd();
	const previousEnv = { ...process.env };
	process.chdir(workspace);
	process.env.OMP_AGENT_DIR = join(workspace, ".omp-agent-cache");
	process.env.OMP_AGENT_HOME = "";
	process.env.PI_CODING_AGENT_DIR = "";
	try {
		await run();
	} finally {
		restoreEnvironment(previousEnv);
		process.chdir(previousCwd);
	}
}

/**
 * public entrypoint 등록 결과를 수집하는 harness입니다.
 */
function registerHarness(): {
	tools: Map<string, RegisteredTool>;
	events: Map<string, BeforeAgentStartHandler>;
} {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, BeforeAgentStartHandler>();

	const pi = {
		registerTool(tool: unknown) {
			const registeredTool = tool as RegisteredTool;
			if (registeredTool.name) {
				tools.set(registeredTool.name, registeredTool);
			}
		},
		on(eventName: string, handler: unknown) {
			events.set(eventName, handler as BeforeAgentStartHandler);
		},
	} as unknown as ExtensionAPI;

	register(pi);

	return { tools, events };
}

describe("skill-registry extension entrypoint e2e", () => {
	it("registers the public tool surface and discovers skills from project-local settings", async () => {
		envSnapshot = { ...process.env };
		const workspace = await mkdtemp(join(tmpdir(), "skill-registry-e2e-"));
		temporaryDirectories.push(workspace);
		const customSkillRoot = join(workspace, ".pi", "custom-skills");
		await writeSkill(customSkillRoot, "observability", "Observability workflow and telemetry review guidance for runtime teams.");
		await writeSkillRegistrySettings(workspace, {
			roots: [".pi/custom-skills"],
			fileNames: ["SKILL.md"],
			cacheTtlMs: 60_000,
			maxTopK: 10,
			includePreviewBodyChars: 120,
		});

		const { tools, events } = registerHarness();
		expect([...tools.keys()]).toEqual(["skill_registry"]);
		expect(events.has("before_agent_start")).toBe(true);

		const tool = tools.get("skill_registry");
		if (!tool?.execute) {
			throw new Error("expected skill_registry execute handler");
		}

		await withWorkspaceCwd(workspace, async () => {
			const result = await tool.execute?.(
				"tool-call-1",
				{
					action: "discover",
					query: "obesrvability",
					refresh: true,
				},
				undefined,
				undefined,
				undefined,
			);
			if (!result) {
				throw new Error("expected discover result");
			}

			const resultText = textFromResult(result);
			const detailsJson = JSON.stringify(result.details);
			expect(`${resultText}\n${detailsJson}`).toContain("observability");
			expect(detailsJson).toContain("skill://observability");
		});
	});

	it("rewrites the first skills block in before_agent_start prompts", async () => {
		envSnapshot = { ...process.env };
		const { events } = registerHarness();
		const beforeAgentStart = events.get("before_agent_start");
		if (!beforeAgentStart) {
			throw new Error("expected before_agent_start handler");
		}

		const secondSkillsBlock = "<skills>\n- second catalog entry\n</skills>";
		const event = {
			systemPrompt: [
				"System intro",
				"",
				"<skills>\n- old catalog entry\n</skills>",
				"",
				"Trailing instructions",
				"",
				secondSkillsBlock,
			].join("\n"),
		};

		const result = await beforeAgentStart(event);
		const rewrittenPrompt = result?.systemPrompt ?? "";
		expect(rewrittenPrompt).toContain(SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK);
		expect(event.systemPrompt).toBe(rewrittenPrompt);
		expect(rewrittenPrompt).not.toContain("old catalog entry");
		expect(rewrittenPrompt).toContain("System intro");
		expect(rewrittenPrompt).toContain("Trailing instructions");
		expect(rewrittenPrompt).toContain(secondSkillsBlock);
		expect(rewrittenPrompt.match(/<skills>/g)?.length).toBe(2);
	});
});

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
