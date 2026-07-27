import fs from "node:fs";
import { createEmptyDiagnostics, type VerificationDiagnostics } from "./diagnostics";
import { loadDistHarness } from "./dist-harness";
import type { FreshProcessRequest, FreshProcessResponse } from "./fresh-process";
import { runPlanningCorpusContract } from "./planning-contract";

/**
 * child Bun process entrypoint입니다.
 * stdin JSON 요청을 읽고 installed/requested bundle을 import한 뒤 planning contract를 실행합니다.
 */
async function main(): Promise<void> {
	const raw = await readStdin();
	const request = JSON.parse(raw) as FreshProcessRequest;
	process.env.OMP_AGENT_DIR = request.agentDir;
	process.env.OMP_AGENT_HOME = "";
	process.env.PI_CODING_AGENT_DIR = "";

	const settingsDirectory = `${request.agentDir}/settings/skill-registry`;
	fs.mkdirSync(settingsDirectory, { recursive: true });
	fs.writeFileSync(
		`${settingsDirectory}/skill-registry.json`,
		JSON.stringify(
			{
				skillRegistry: {
					roots: request.roots,
					databasePath: request.databasePath,
					fileNames: ["SKILL.md"],
					cacheTtlMs: 60_000,
					maxTopK: 50,
					includePreviewBodyChars: 120,
				},
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		if (!fs.existsSync(request.bundlePath)) {
			writeResponse({
				ok: false,
				diagnostics: createEmptyDiagnostics({
					repositoryBundle: request.bundlePath,
					freshProcess: false,
					errors: [`bundle missing: ${request.bundlePath}`],
				}),
				error: `bundle missing: ${request.bundlePath}`,
			});
			return;
		}

		const harness = await loadDistHarness(request.bundlePath);
		const { diagnostics } = await runPlanningCorpusContract({
			execute: harness.execute,
			roots: request.roots,
			requireExactKnownResolve: request.requireExactKnownResolve ?? true,
		});
		diagnostics.freshProcess = true;
		diagnostics.repositoryBundle = request.bundlePath;
		writeResponse({ ok: true, diagnostics });
	} catch (error) {
		const diagnostics = extractDiagnostics(error);
		diagnostics.freshProcess = false;
		diagnostics.repositoryBundle = request.bundlePath;
		writeResponse({
			ok: false,
			diagnostics,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function writeResponse(response: FreshProcessResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function extractDiagnostics(error: unknown): VerificationDiagnostics {
	if (error && typeof error === "object" && "diagnostics" in error && (error as { diagnostics?: VerificationDiagnostics }).diagnostics) {
		return (error as { diagnostics: VerificationDiagnostics }).diagnostics;
	}
	return createEmptyDiagnostics({
		errors: [error instanceof Error ? error.message : String(error)],
	});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

await main();
