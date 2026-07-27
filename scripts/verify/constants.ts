import os from "node:os";
import path from "node:path";

/** fixture·operator smoke가 공유하는 planning discovery query입니다. */
export const PLANNING_DISCOVER_QUERY = "planning implementation plans architecture task decomposition";

/**
 * production probe와 동일한 known planning canonical 이름입니다.
 * fixture body는 최소 deterministic text만 유지합니다.
 */
export const KNOWN_PLANNING_CANONICALS = [
	"skill-registry-cache-invalidation-planning",
	"skill-registry-runtime-verification-planning",
	"pi-extension-canonical-planning",
] as const;

/** resolve 요청 순서를 알파벳과 다르게 고정해 order contract를 드러냅니다. */
export const PLANNING_RESOLVE_ORDER = [
	"pi-extension-canonical-planning",
	"skill-registry-cache-invalidation-planning",
	"skill-registry-runtime-verification-planning",
] as const;

/** OMP plugin lock에 기록되는 package name입니다. */
export const PLUGIN_PACKAGE_NAME = "@miyu4u/pi-extensions-skill-registry";

/** 기본 installed plugin 경로입니다. */
export const DEFAULT_INSTALLED_PLUGIN_PATH = path.join(os.homedir(), ".omp", "plugins", "node_modules", PLUGIN_PACKAGE_NAME);

/** 기본 OMP plugin lock 경로입니다. */
export const DEFAULT_PLUGIN_LOCK_PATH = path.join(os.homedir(), ".omp", "plugins", "omp-plugins.lock.json");

/** operator real-corpus smoke의 managed skills root입니다. */
export const DEFAULT_MANAGED_SKILLS_ROOT = path.join(os.homedir(), ".omp", "agent", "managed-skills");
