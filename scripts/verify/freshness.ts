import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_INSTALLED_PLUGIN_PATH, DEFAULT_PLUGIN_LOCK_PATH, PLUGIN_PACKAGE_NAME } from "./constants";
import { createEmptyDiagnostics, type VerificationDiagnostics, VerificationFailure } from "./diagnostics";

/** freshness checker 입력 경로입니다. */
export type FreshnessCheckOptions = {
	repositoryRoot: string;
	installedPluginPath?: string;
	pluginLockPath?: string;
};

/** installed artifact가 symlink인지 copy인지 분류한 결과입니다. */
export type InstallKind = "symlink" | "copy" | "missing";

/** freshness check 상세 결과입니다. */
export type FreshnessCheckResult = {
	ok: boolean;
	installKind: InstallKind;
	diagnostics: VerificationDiagnostics;
	remediation: string[];
};

/**
 * repository package / plugin lock / installed package version과
 * bundle identity를 대조합니다. mismatch 시 자동 수정하지 않습니다.
 */
export function checkInstalledFreshness(options: FreshnessCheckOptions): FreshnessCheckResult {
	const installedPluginPath = options.installedPluginPath ?? DEFAULT_INSTALLED_PLUGIN_PATH;
	const pluginLockPath = options.pluginLockPath ?? DEFAULT_PLUGIN_LOCK_PATH;
	const repositoryPackagePath = path.join(options.repositoryRoot, "package.json");
	const repositoryBundle = path.join(options.repositoryRoot, "dist", "main.js");
	const installedPackagePath = path.join(installedPluginPath, "package.json");
	const installedBundle = path.join(installedPluginPath, "dist", "main.js");

	const diagnostics = createEmptyDiagnostics({
		repositoryBundle,
		installedBundle,
	});
	const remediation: string[] = [];
	const errors: string[] = [];

	const repositoryVersion = readPackageVersion(repositoryPackagePath);
	const installedVersion = readPackageVersion(installedPackagePath);
	const lockVersion = readLockVersion(pluginLockPath, PLUGIN_PACKAGE_NAME);
	diagnostics.repositoryVersion = repositoryVersion;
	diagnostics.installedVersion = installedVersion;
	diagnostics.lockVersion = lockVersion;

	if (!repositoryVersion) {
		errors.push(`repository package.json missing or unreadable: ${repositoryPackagePath}`);
	}
	if (!installedVersion) {
		errors.push(`installed package.json missing or unreadable: ${installedPackagePath}`);
	}
	if (!lockVersion) {
		errors.push(`plugin lock version missing for ${PLUGIN_PACKAGE_NAME} at ${pluginLockPath}`);
	}

	if (repositoryVersion && installedVersion && repositoryVersion !== installedVersion) {
		errors.push(`repositoryVersion ${repositoryVersion} != installedVersion ${installedVersion}`);
		remediation.push(`omp plugin link ${options.repositoryRoot}`);
	}
	if (repositoryVersion && lockVersion && repositoryVersion !== lockVersion) {
		errors.push(`repositoryVersion ${repositoryVersion} != lockVersion ${lockVersion}`);
		remediation.push(`omp plugin link ${options.repositoryRoot}`);
		remediation.push("Restart OMP session so the plugin manager reloads lock metadata.");
	}
	if (installedVersion && lockVersion && installedVersion !== lockVersion) {
		errors.push(`installedVersion ${installedVersion} != lockVersion ${lockVersion}`);
		remediation.push(`omp plugin link ${options.repositoryRoot}`);
	}

	const installKind = classifyInstall(installedPluginPath, options.repositoryRoot);
	let installedRealpath: string | null = null;
	try {
		installedRealpath = fs.existsSync(installedPluginPath) ? fs.realpathSync(installedPluginPath) : null;
	} catch {
		installedRealpath = null;
	}
	diagnostics.installedRealpath = installedRealpath;

	if (installKind === "missing") {
		errors.push(`installed plugin path missing: ${installedPluginPath}`);
		remediation.push(`omp plugin link ${options.repositoryRoot}`);
	}

	if (installKind === "symlink") {
		const expectedRealpath = fs.realpathSync(options.repositoryRoot);
		if (installedRealpath !== expectedRealpath) {
			errors.push(`symlink realpath ${installedRealpath} != repository ${expectedRealpath}`);
			remediation.push(`omp plugin link ${options.repositoryRoot}`);
		}
		if (!fs.existsSync(repositoryBundle)) {
			errors.push(`repository bundle missing: ${repositoryBundle}`);
			remediation.push("bun run build");
		}
		if (!fs.existsSync(installedBundle)) {
			errors.push(`installed bundle missing via symlink: ${installedBundle}`);
			remediation.push("bun run build");
		}
		diagnostics.bundleChecksumMatch =
			fs.existsSync(repositoryBundle) && fs.existsSync(installedBundle)
				? checksumFile(repositoryBundle) === checksumFile(installedBundle)
				: false;
	}

	if (installKind === "copy") {
		if (!fs.existsSync(repositoryBundle) || !fs.existsSync(installedBundle)) {
			errors.push("copied install requires both repository and installed dist/main.js");
			remediation.push("bun run build && omp plugin link <repo> or reinstall the plugin package");
			diagnostics.bundleChecksumMatch = false;
		} else {
			const match = checksumFile(repositoryBundle) === checksumFile(installedBundle);
			diagnostics.bundleChecksumMatch = match;
			if (!match) {
				errors.push("copied install bundle checksum mismatch between repository and installed dist/main.js");
				remediation.push("Rebuild and reinstall/link the plugin so installed dist matches repository dist.");
				remediation.push("Restart OMP session after reinstall; build alone does not reload in-memory plugins.");
			}
		}
	}

	diagnostics.errors = errors;
	const ok = errors.length === 0;
	if (!ok) {
		const uniqueRemediation = [...new Set(remediation)];
		throw new VerificationFailure(
			[
				"installed artifact freshness check failed",
				...errors,
				uniqueRemediation.length ? "remediation:" : "",
				...uniqueRemediation.map((item) => `  - ${item}`),
			]
				.filter(Boolean)
				.join("\n"),
			diagnostics,
		);
	}

	return {
		ok: true,
		installKind,
		diagnostics,
		remediation: [],
	};
}

/** installed path가 repository symlink인지 독립 copy인지 분류합니다. */
export function classifyInstall(installedPluginPath: string, repositoryRoot: string): InstallKind {
	if (!fs.existsSync(installedPluginPath)) {
		return "missing";
	}
	const absoluteInstalled = path.resolve(installedPluginPath);
	const absoluteRepository = fs.realpathSync(repositoryRoot);
	try {
		if (fs.lstatSync(absoluteInstalled).isSymbolicLink()) {
			return "symlink";
		}
		const realInstalled = fs.realpathSync(absoluteInstalled);
		if (realInstalled === absoluteRepository) {
			return "symlink";
		}
	} catch {
		return "missing";
	}
	return "copy";
}

function readPackageVersion(packageJsonPath: string): string | null {
	try {
		const raw = fs.readFileSync(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function readLockVersion(lockPath: string, packageName: string): string | null {
	try {
		const raw = fs.readFileSync(lockPath, "utf8");
		const parsed = JSON.parse(raw) as {
			plugins?: Record<string, { version?: unknown }>;
		};
		const version = parsed.plugins?.[packageName]?.version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

/** 파일 전체 SHA-256 hex digest를 계산합니다. */
export function checksumFile(filePath: string): string {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}
