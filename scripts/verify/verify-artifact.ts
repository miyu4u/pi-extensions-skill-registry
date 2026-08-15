import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDiagnostics, VerificationFailure } from "./diagnostics";
import { loadDistHarness } from "./dist-harness";
import { runFreshProcessContract } from "./fresh-process";
import { runPlanningCorpusContract } from "./planning-contract";
import { writePlanningFixtureCorpus } from "./planning-fixture";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_BUNDLE = path.join(REPOSITORY_ROOT, "dist", "main.js");
/** Built artifact가 노출해야 하는 namespaced slash command 목록입니다. */
const EXPECTED_COMMAND_NAMES = ["skill-registry:reindex", "skill-registry:discover", "skill-registry:diagnostics"] as const;
const SKILLS_START_MARKER = "<skills>";
const SKILLS_END_MARKER = "</skills>";
const BUILT_IN_GUIDANCE_MARKER = "Skill catalog omitted from the system prompt";
const CUSTOM_GUIDANCE = "Artifact custom guidance";

/**
 * built registration에서 prompt settings와 두 lifecycle hook의 observable contract를 확인합니다.
 *
 * @param harness built bundle에서 capture한 registration handler 묶음입니다.
 * @param settingsPath 임시 prompt settings fixture 경로입니다.
 */
async function runPromptHookContract(
	harness: Awaited<ReturnType<typeof loadDistHarness>>,
	settingsPath: string,
): Promise<void> {
	const writeSettings = (value: Record<string, unknown>): void => {
		fs.writeFileSync(settingsPath, JSON.stringify(value), "utf-8");
	};
	const requireCondition = (condition: boolean, message: string): void => {
		if (!condition) {
			throw new Error(`verify:artifact prompt hook assertion failed: ${message}`);
		}
	};

	writeSettings({ skillsPromptEnabled: true });
	const defaultAgentEvent = { systemPrompt: `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} suffix` };
	const defaultAgentResult = await harness.beforeAgentStart(defaultAgentEvent);
	requireCondition(defaultAgentResult?.systemPrompt.includes(BUILT_IN_GUIDANCE_MARKER) === true, "default guidance body");
	requireCondition(defaultAgentEvent.systemPrompt === defaultAgentResult?.systemPrompt, "before_agent_start event update");

	writeSettings({
		skillsPromptEnabled: true,
		skillsPrompt: CUSTOM_GUIDANCE,
		promptSkillNames: [" alpha ", 42, "alpha", " beta "],
		presetSkills: ["indexing-only"],
	});
	const providerPayload = {
		instructions: `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} middle ${SKILLS_START_MARKER}second${SKILLS_END_MARKER} suffix`,
	};
	const providerResult = await harness.beforeProviderRequest({ payload: providerPayload });
	requireCondition(typeof providerResult === "object" && providerResult !== null, "provider replacement result");
	const providerInstructions = (providerResult as { instructions?: unknown }).instructions;
	requireCondition(typeof providerInstructions === "string", "provider instructions replacement");
	requireCondition(providerInstructions.includes(CUSTOM_GUIDANCE), "custom guidance body");
	requireCondition(providerInstructions.includes("- Configured prompt skills: alpha, beta"), "ordered deduped prompt names");
	requireCondition(providerInstructions.startsWith("prefix "), "provider prefix preservation");
	requireCondition(providerInstructions.endsWith(` middle ${SKILLS_START_MARKER}second${SKILLS_END_MARKER} suffix`), "first-block-only replacement");

	writeSettings({ skillsPromptEnabled: false, skillsPrompt: CUSTOM_GUIDANCE, promptSkillNames: ["disabled"] });
	const disabledAgentEvent = { systemPrompt: `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} suffix` };
	const disabledAgentResult = await harness.beforeAgentStart(disabledAgentEvent);
	requireCondition(disabledAgentResult === undefined, "disabled before_agent_start result");
	requireCondition(
		disabledAgentEvent.systemPrompt === `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} suffix`,
		"disabled before_agent_start payload preservation",
	);

	const disabledProviderPayload = {
		instructions: `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} suffix`,
	};
	const disabledProviderResult = await harness.beforeProviderRequest({ payload: disabledProviderPayload });
	requireCondition(disabledProviderResult === undefined, "disabled before_provider_request result");
	requireCondition(
		disabledProviderPayload.instructions === `prefix ${SKILLS_START_MARKER}stale${SKILLS_END_MARKER} suffix`,
		"disabled provider payload preservation",
	);
}

/**
 * PR gate용 artifact verification입니다.
 * build된 dist/main.js registration과 fixture planning corpus를 검증합니다.
 * 이 스크립트는 dist를 암묵적으로 build하지 않습니다.
 */
async function main(): Promise<void> {
	if (!fs.existsSync(DIST_BUNDLE)) {
		throw new Error(`verify:artifact requires built dist first: missing ${DIST_BUNDLE}. Run bun run build.`);
	}

	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-verify-artifact-"));
	const corpusRoot = path.join(workspace, "corpus");
	const agentDir = path.join(workspace, "agent");
	const databasePath = path.join(agentDir, "cache", "skill-registry", "index.sqlite");
	const settingsPath = path.join(agentDir, "settings", "skill-registry", "skill-registry.json");
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	writePlanningFixtureCorpus(corpusRoot);

	process.env.OMP_AGENT_DIR = agentDir;
	process.env.OMP_AGENT_HOME = "";
	process.env.PI_CODING_AGENT_DIR = "";

	try {
		const harness = await loadDistHarness(DIST_BUNDLE);
		for (const commandName of EXPECTED_COMMAND_NAMES) {
			if (!harness.commandNames.includes(commandName)) {
				throw new Error(`verify:artifact missing command registration: ${commandName}`);
			}
		}
		await runPromptHookContract(harness, settingsPath);
		const sameProcess = await runPlanningCorpusContract({
			execute: harness.execute,
			roots: [corpusRoot],
			requireExactKnownResolve: true,
		});
		sameProcess.diagnostics.repositoryBundle = DIST_BUNDLE;
		sameProcess.diagnostics.freshProcess = false;

		const fresh = await runFreshProcessContract({
			bundlePath: DIST_BUNDLE,
			roots: [corpusRoot],
			requireExactKnownResolve: true,
			workspaceRoot: path.join(workspace, "fresh"),
		});

		console.log("verify:artifact OK");
		console.log(
			formatDiagnostics({
				...fresh.diagnostics,
				repositoryBundle: DIST_BUNDLE,
				discoveredNames: sameProcess.diagnostics.discoveredNames,
				resolvedNames: sameProcess.diagnostics.resolvedNames,
				missingNames: sameProcess.diagnostics.missingNames,
				indexed: sameProcess.diagnostics.indexed,
				parsed: sameProcess.diagnostics.parsed,
				requestedRoots: sameProcess.diagnostics.requestedRoots,
				queriedRoots: sameProcess.diagnostics.queriedRoots,
				freshProcess: true,
			}),
		);
	} catch (error) {
		if (error instanceof VerificationFailure) {
			console.error("verify:artifact FAILED");
			console.error(formatDiagnostics(error.diagnostics));
			console.error(error.message);
			process.exitCode = 1;
			return;
		}
		throw error;
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
}

await main();
