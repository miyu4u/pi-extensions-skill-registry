import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VerificationFailure } from "../../scripts/verify/diagnostics";
import { assertStaleFailsAndRebuiltSucceeds, runFreshProcessContract } from "../../scripts/verify/fresh-process";
import { writePlanningFixtureCorpus } from "../../scripts/verify/planning-fixture";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REBUILT_BUNDLE = path.join(REPOSITORY_ROOT, "dist", "main.js");

/**
 * fresh-process gate가 process boundary를 지키고
 * stale bundle에서 실패·최신 bundle에서 성공하는지 검증합니다.
 */
describe("fresh-process verification", () => {
	test("fails on stale fixture bundle and succeeds on rebuilt dist", async () => {
		if (!fs.existsSync(REBUILT_BUNDLE)) {
			throw new Error(`rebuilt dist missing: ${REBUILT_BUNDLE}. Run bun run build before test:verify.`);
		}

		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-fresh-process-spec-"));
		const corpusRoot = path.join(workspace, "corpus");
		const staleBundle = path.join(workspace, "stale-main.js");
		writePlanningFixtureCorpus(corpusRoot);
		fs.writeFileSync(
			staleBundle,
			["export default function register() {", "  // intentionally stale: no skill_registry tool registration", "}", ""].join("\n"),
			"utf8",
		);

		try {
			await assertStaleFailsAndRebuiltSucceeds({
				staleBundlePath: staleBundle,
				rebuiltBundlePath: REBUILT_BUNDLE,
				roots: [corpusRoot],
			});
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("isolates active index with a dedicated child process workspace", async () => {
		if (!fs.existsSync(REBUILT_BUNDLE)) {
			throw new Error(`rebuilt dist missing: ${REBUILT_BUNDLE}. Run bun run build before test:verify.`);
		}

		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-fresh-isolation-"));
		const corpusRoot = path.join(workspace, "corpus");
		writePlanningFixtureCorpus(corpusRoot);

		try {
			const result = await runFreshProcessContract({
				bundlePath: REBUILT_BUNDLE,
				roots: [corpusRoot],
				requireExactKnownResolve: true,
				workspaceRoot: path.join(workspace, "child"),
			});
			expect(result.ok).toBe(true);
			expect(result.diagnostics.freshProcess).toBe(true);
			expect(result.diagnostics.missingNames).toEqual([]);
			expect(result.diagnostics.resolvedNames).toHaveLength(3);
		} catch (error) {
			if (error instanceof VerificationFailure) {
				throw new Error(error.message);
			}
			throw error;
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
