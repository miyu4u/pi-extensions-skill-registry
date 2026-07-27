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
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
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
