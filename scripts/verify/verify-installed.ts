import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INSTALLED_PLUGIN_PATH, DEFAULT_MANAGED_SKILLS_ROOT } from "./constants";
import { formatDiagnostics, VerificationFailure } from "./diagnostics";
import { runFreshProcessContract } from "./fresh-process";
import { checkInstalledFreshness } from "./freshness";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * release/operator 환경용 installed verification입니다.
 * plugin metadata/artifact identity와 fresh-process real-corpus smoke를 검증합니다.
 */
async function main(): Promise<void> {
	const managedRoot = process.env.SKILL_REGISTRY_MANAGED_ROOT ?? DEFAULT_MANAGED_SKILLS_ROOT;
	const installedPluginPath = process.env.SKILL_REGISTRY_INSTALLED_PATH ?? DEFAULT_INSTALLED_PLUGIN_PATH;
	const installedBundle = path.join(installedPluginPath, "dist", "main.js");

	try {
		const freshness = checkInstalledFreshness({
			repositoryRoot: REPOSITORY_ROOT,
			installedPluginPath,
		});

		if (!fs.existsSync(managedRoot)) {
			throw new VerificationFailure(`managed skills root missing: ${managedRoot}`, {
				...freshness.diagnostics,
				requestedRoots: [managedRoot],
				errors: [`managed skills root missing: ${managedRoot}`],
			});
		}

		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-verify-installed-"));
		try {
			const fresh = await runFreshProcessContract({
				bundlePath: installedBundle,
				roots: [managedRoot],
				requireExactKnownResolve: true,
				workspaceRoot: workspace,
			});

			console.log("verify:installed OK");
			console.log(
				formatDiagnostics({
					...fresh.diagnostics,
					repositoryVersion: freshness.diagnostics.repositoryVersion,
					lockVersion: freshness.diagnostics.lockVersion,
					installedVersion: freshness.diagnostics.installedVersion,
					installedRealpath: freshness.diagnostics.installedRealpath,
					bundleChecksumMatch: freshness.diagnostics.bundleChecksumMatch,
					installedBundle,
					repositoryBundle: path.join(REPOSITORY_ROOT, "dist", "main.js"),
					freshProcess: true,
				}),
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	} catch (error) {
		if (error instanceof VerificationFailure) {
			console.error("verify:installed FAILED");
			console.error(formatDiagnostics(error.diagnostics));
			console.error(error.message);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
}

await main();
