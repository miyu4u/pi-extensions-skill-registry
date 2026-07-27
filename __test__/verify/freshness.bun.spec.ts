import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_PACKAGE_NAME } from "../../scripts/verify/constants";
import { VerificationFailure } from "../../scripts/verify/diagnostics";
import { checkInstalledFreshness, checksumFile, classifyInstall } from "../../scripts/verify/freshness";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * repository/lock/installed version drift와 symlink/copy identity 분류를 검증합니다.
 */
describe("installed freshness checker", () => {
	test("fails when lock version drifts from repository package version", () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-freshness-"));
		const fakeRepo = path.join(workspace, "repo");
		const installed = path.join(workspace, "installed");
		const lockPath = path.join(workspace, "omp-plugins.lock.json");

		fs.mkdirSync(path.join(fakeRepo, "dist"), { recursive: true });
		fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
		fs.writeFileSync(path.join(fakeRepo, "package.json"), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: "0.1.5" }));
		fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: "0.1.5" }));
		fs.writeFileSync(path.join(fakeRepo, "dist", "main.js"), "export default function register() {}");
		fs.writeFileSync(path.join(installed, "dist", "main.js"), "export default function register() {}");
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				plugins: {
					[PLUGIN_PACKAGE_NAME]: {
						version: "0.1.1",
						enabled: true,
					},
				},
			}),
		);

		try {
			expect(() =>
				checkInstalledFreshness({
					repositoryRoot: fakeRepo,
					installedPluginPath: installed,
					pluginLockPath: lockPath,
				}),
			).toThrow(VerificationFailure);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("classifies symlink installs and compares copied checksums", () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-freshness-kind-"));
		const fakeRepo = path.join(workspace, "repo");
		const linked = path.join(workspace, "linked");
		const copied = path.join(workspace, "copied");

		fs.mkdirSync(path.join(fakeRepo, "dist"), { recursive: true });
		fs.writeFileSync(path.join(fakeRepo, "dist", "main.js"), "bundle-a");
		fs.symlinkSync(fakeRepo, linked, "dir");

		fs.mkdirSync(path.join(copied, "dist"), { recursive: true });
		fs.writeFileSync(path.join(copied, "dist", "main.js"), "bundle-b");

		try {
			expect(classifyInstall(linked, fakeRepo)).toBe("symlink");
			expect(classifyInstall(copied, fakeRepo)).toBe("copy");
			expect(checksumFile(path.join(fakeRepo, "dist", "main.js"))).not.toBe(checksumFile(path.join(copied, "dist", "main.js")));
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("passes when repository, installed package, and lock versions match for this checkout", () => {
		const lockPath = path.join(os.homedir(), ".omp", "plugins", "omp-plugins.lock.json");
		const installedPath = path.join(os.homedir(), ".omp", "plugins", "node_modules", PLUGIN_PACKAGE_NAME);
		if (!fs.existsSync(lockPath) || !fs.existsSync(installedPath)) {
			return;
		}

		const result = checkInstalledFreshness({
			repositoryRoot: REPOSITORY_ROOT,
			installedPluginPath: installedPath,
			pluginLockPath: lockPath,
		});
		expect(result.ok).toBe(true);
		expect(result.diagnostics.repositoryVersion).toBe(result.diagnostics.lockVersion);
		expect(result.diagnostics.repositoryVersion).toBe(result.diagnostics.installedVersion);
	});
});
