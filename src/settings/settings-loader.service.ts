import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillRegistrySettings } from "../shared";
import {
	DEFAULT_SCOPE_PRIORITY,
	DEFAULT_SCOPE_ROOTS,
	DEFAULT_SETTINGS,
	SETTING_GROUP_KEY,
	SKILL_REGISTRY_SETTINGS_FILE,
	SKILL_REGISTRY_SETTINGS_FILE_PATHS,
} from "../shared";
import type { SettingsLoaderInterface } from "./settings-loader.interface";

type ScopeRoots = Record<string, string[]>;

/** skill-registry 설정 로더 구현체입니다. */
export class SettingsLoaderService implements SettingsLoaderInterface {
	/**
	 * 프로젝트/전역 설정 파일을 순서대로 조회해 기본 설정을 반환합니다.
	 */
	loadSettings(): Required<SkillRegistrySettings> & { scopeRoots: ScopeRoots; scopePriority: string[] } {
		const projectRoot = process.cwd();
		const defaultDatabasePath = this.resolveDefaultDatabasePath();
		const candidateFiles = this.collectSettingFileCandidates(projectRoot);
		const scopeRoots = this.normalizeScopeRoots(DEFAULT_SCOPE_ROOTS, DEFAULT_SCOPE_ROOTS);
		let scopePriority: string[] = [...DEFAULT_SCOPE_PRIORITY];

		for (const file of candidateFiles) {
			if (!fs.existsSync(file)) {
				continue;
			}
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
				const value = raw?.[SETTING_GROUP_KEY] ?? raw;
				const configuredScopeRoots = this.normalizeScopeRoots(value?.scopeRoots, DEFAULT_SCOPE_ROOTS);
				const customScopeRoots = this.toScopeRootsRecord(value?.scopeRoots);
				const configuredScopePriority = this.normalizeScopePriority(value?.scopePriority, DEFAULT_SCOPE_PRIORITY);
				scopePriority = configuredScopePriority;
				const effectiveScopeRoots = this.mergeScopeRoots(scopeRoots, configuredScopeRoots, scopePriority);
				const normalizedRoots = this.normalizeStringArrayWithExpansion(value?.roots, [
					...DEFAULT_SETTINGS.roots,
					...this.flattenScopeRoots(customScopeRoots, configuredScopePriority),
				]);

				return {
					roots: normalizedRoots,
					scopeRoots: effectiveScopeRoots,
					scopePriority: configuredScopePriority,
					fileNames: this.validateStringArray(value?.fileNames, DEFAULT_SETTINGS.fileNames),
					presetSkills: this.validateStringArray(value?.presetSkills, DEFAULT_SETTINGS.presetSkills),
					databasePath: this.validateDatabasePath(value?.databasePath, defaultDatabasePath, projectRoot),
					cacheTtlMs: this.validatePositiveNumber(value?.cacheTtlMs, DEFAULT_SETTINGS.cacheTtlMs),
					maxTopK: this.validatePositiveNumber(value?.maxTopK, DEFAULT_SETTINGS.maxTopK),
					includePreviewBodyChars: this.validatePositiveNumber(
						value?.includePreviewBodyChars,
						DEFAULT_SETTINGS.includePreviewBodyChars,
					),
				};
			} catch {
				// 무시 가능한 설정 파일 오류이며 다음 후보 파일로 대체 진행
			}
		}

		const defaultScopeRoots = this.mergeScopeRoots(scopeRoots, scopeRoots, scopePriority);

		return {
			...DEFAULT_SETTINGS,
			scopeRoots: defaultScopeRoots,
			scopePriority,
			databasePath: defaultDatabasePath,
		};
	}

	/**
	 * 프로젝트/전역 설정 파일 경로를 우선순위로 계산합니다.
	 */
	private collectSettingFileCandidates(projectRoot: string): string[] {
		const projectScoped = SKILL_REGISTRY_SETTINGS_FILE_PATHS.flatMap((baseDir) => [
			path.join(projectRoot, baseDir, SKILL_REGISTRY_SETTINGS_FILE),
			path.join(projectRoot, `${baseDir}.json`),
		]);

		const piAgentDir = this.resolveAgentDirectory(process.env.PI_CODING_AGENT_DIR?.trim(), path.join(os.homedir(), ".pi", "agent"));
		const ompAgentDir = this.resolveAgentDirectory(
			process.env.OMP_AGENT_DIR?.trim() || process.env.OMP_AGENT_HOME?.trim(),
			path.join(os.homedir(), ".omp", "agent"),
		);

		const globalScoped = [
			path.join(piAgentDir, "settings", "skill-registry", SKILL_REGISTRY_SETTINGS_FILE),
			path.join(piAgentDir, "settings", `${SETTING_GROUP_KEY}.json`),
			path.join(ompAgentDir, "settings", "skill-registry", SKILL_REGISTRY_SETTINGS_FILE),
			path.join(ompAgentDir, "settings", `${SETTING_GROUP_KEY}.json`),
		];

		return this.dedupePaths([...projectScoped, ...globalScoped]);
	}

	/**
	 * scopeRoot 설정 블록을 정규화해 기본값과 병합합니다.
	 * 미래 scope 이름까지 유지할 수 있도록 동적 키를 모두 보존합니다.
	 */
	private normalizeScopeRoots(scopeRoots: unknown, fallback: Record<string, readonly string[]>): ScopeRoots {
		const normalized = this.toScopeRootsRecord(scopeRoots);
		for (const [name, roots] of Object.entries(fallback)) {
			if (!Object.hasOwn(normalized, name)) {
				normalized[name] = [...roots].map((root) => this.resolvePath(root));
			}
		}
		return normalized;
	}

	/**
	 * scope 이름 우선순위를 정규화합니다.
	 * 문자열이 아닌 항목이 한 개라도 있으면 기본 우선순위를 사용합니다.
	 */
	private normalizeScopePriority(value: unknown, fallback: readonly string[]): string[] {
		if (!Array.isArray(value)) {
			return [...fallback];
		}
		const nextPriority: string[] = [];
		const seen = new Set<string>();
		for (const scope of value) {
			if (typeof scope !== "string") {
				return [...fallback];
			}
			const trimmed = scope.trim();
			if (trimmed.length === 0 || seen.has(trimmed)) {
				continue;
			}
			seen.add(trimmed);
			nextPriority.push(trimmed);
		}
		return nextPriority;
	}

	/**
	 * 기본 scopeRoots와 사용자 scopeRoots를 병합해 precedence를 반영한 최종 맵을 만듭니다.
	 * 미래 scope 키는 기본 맵에 없더라도 보존됩니다.
	 */
	private mergeScopeRoots(baseScopeRoots: ScopeRoots, overrideScopeRoots: ScopeRoots, scopePriority: string[]): ScopeRoots {
		const merged: ScopeRoots = {};
		for (const [scope, roots] of Object.entries(baseScopeRoots)) {
			merged[scope] = roots;
		}
		for (const [scope, roots] of Object.entries(overrideScopeRoots)) {
			merged[scope] = roots;
		}

		for (const scope of scopePriority) {
			const roots = merged[scope];
			if (Array.isArray(roots)) {
				// no-op, 순서 유지 목적
				void roots;
			}
		}

		return merged;
	}

	/**
	 * scopeRoots를 우선순위 기준으로 펼쳐 단일 roots 배열을 만듭니다.
	 * 등록되지 않은 scope는 기본적으로 우선순위 목록 뒤로 붙여 보존합니다.
	 */
	private flattenScopeRoots(scopeRoots: ScopeRoots, scopePriority: string[]): string[] {
		const orderedScopeNames = [...scopePriority, ...Object.keys(scopeRoots)];
		const normalizedNames: string[] = [];
		const seen = new Set<string>();
		for (const scopeName of orderedScopeNames) {
			if (seen.has(scopeName)) {
				continue;
			}
			seen.add(scopeName);
			normalizedNames.push(scopeName);
		}

		const roots: string[] = [];
		for (const scopeName of normalizedNames) {
			const scopeRoot = scopeRoots[scopeName];
			if (Array.isArray(scopeRoot)) {
				roots.push(...scopeRoot);
			}
		}
		return roots;
	}

	/**
	 * 배열인 scope root 블록을 문자열 배열로 정규화하고 `~` 경로를 확장합니다.
	 * 기존 동작과 동일하게 빈 배열도 유효한 값으로 허용합니다.
	 */
	private normalizeScopeRootArray(value: unknown): string[] | undefined {
		if (!Array.isArray(value)) {
			return undefined;
		}
		if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
			return undefined;
		}
		return value.map((entry) => this.resolvePath(entry));
	}

	/**
	 * scopeRoot 설정 map을 정규화하고, 비정상 키/값을 제거합니다.
	 */
	private toScopeRootsRecord(value: unknown): ScopeRoots {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return {};
		}
		const source = value as Record<string, unknown>;
		const result: ScopeRoots = {};
		for (const [scopeName, roots] of Object.entries(source)) {
			const normalized = this.normalizeScopeRootArray(roots);
			if (normalized !== undefined) {
				result[scopeName] = normalized;
			}
		}
		return result;
	}

	/**
	 * 후보 리스트의 빈 항목과 중복 항목을 제거합니다.
	 */
	private dedupePaths(values: string[]): string[] {
		const deduped = new Set<string>();
		const output: string[] = [];
		for (const value of values) {
			if (!value || deduped.has(value)) {
				continue;
			}
			deduped.add(value);
			output.push(value);
		}
		return output;
	}

	/**
	 * agent settings root 후보를 절대 경로로 정규화합니다.
	 */
	private resolveAgentDirectory(candidate: string | undefined, fallback: string): string {
		return this.resolvePath(candidate && candidate.length > 0 ? candidate : fallback);
	}

	/**
	 * SQLite cache 기본 경로를 agent 환경 우선순위에 맞게 계산합니다.
	 */
	private resolveDefaultDatabasePath(): string {
		const agentRoot =
			process.env.OMP_AGENT_DIR?.trim() ||
			process.env.OMP_AGENT_HOME?.trim() ||
			process.env.PI_CODING_AGENT_DIR?.trim() ||
			path.join(os.homedir(), ".omp", "agent");
		const expandedAgentRoot = this.resolvePath(agentRoot);
		const absoluteAgentRoot = path.isAbsolute(expandedAgentRoot) ? expandedAgentRoot : path.resolve(expandedAgentRoot);
		return path.join(absoluteAgentRoot, "cache", "skill-registry", "index.sqlite");
	}

	/**
	 * 경로 placeholder를 홈/현재 작업 디렉터리 기준으로 확장합니다.
	 */
	private resolvePath(raw: string): string {
		if (!raw) {
			return raw;
		}
		if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
			return path.join(os.homedir(), raw.slice(2));
		}
		if (raw === "$home" || raw.startsWith("$home/") || raw.startsWith("$home\\")) {
			return path.join(os.homedir(), raw.slice(6));
		}
		if (raw === "$cwd" || raw.startsWith("$cwd/") || raw.startsWith("$cwd\\")) {
			return raw === "$cwd" ? process.cwd() : path.join(process.cwd(), raw.slice(5));
		}
		return raw;
	}

	/**
	 * 설정된 SQLite 경로를 절대 경로로 검증합니다.
	 */
	private validateDatabasePath(value: unknown, fallback: string, projectRoot: string): string {
		if (typeof value !== "string" || value.trim().length === 0) {
			return fallback;
		}
		const expanded = this.resolvePath(value.trim());
		return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
	}

	/**
	 * string 배열 설정값을 검증하고 fallback을 적용합니다.
	 */
	private validateStringArray(value: unknown, fallback: string[]): string[] {
		return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0) ? value : fallback;
	}

	/**
	 * string 배열 설정값을 검증하고 `~` 경로를 확장합니다.
	 */
	private normalizeStringArrayWithExpansion(value: unknown, fallback: string[]): string[] {
		if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)) {
			return value.map((entry) => this.resolvePath(entry));
		}
		return fallback.map((entry) => this.resolvePath(entry));
	}

	/**
	 * 양수 number 설정값을 검증하고 fallback을 적용합니다.
	 */
	private validatePositiveNumber(value: unknown, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	}
}
