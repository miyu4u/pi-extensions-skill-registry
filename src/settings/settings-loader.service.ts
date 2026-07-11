import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillRegistrySettings } from "../shared";
import { DEFAULT_SETTINGS, SETTING_GROUP_KEY, SKILL_REGISTRY_SETTINGS_FILE, SKILL_REGISTRY_SETTINGS_FILE_PATHS } from "../shared";
import type { SettingsLoaderInterface } from "./settings-loader.interface";

/** skill-registry 설정 로더 구현체입니다. */
export class SettingsLoaderService implements SettingsLoaderInterface {
	/**
	 * 프로젝트/전역 설정 파일을 순서대로 조회해 기본 설정을 반환합니다.
	 */
	loadSettings(): Required<SkillRegistrySettings> {
		const projectRoot = process.cwd();
		const defaultDatabasePath = this.resolveDefaultDatabasePath();
		const candidateFiles = this.collectSettingFileCandidates(projectRoot);

		for (const file of candidateFiles) {
			if (!fs.existsSync(file)) {
				continue;
			}
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
				const value = raw?.[SETTING_GROUP_KEY] ?? raw;
				return {
					roots: this.validateStringArray(value?.roots, DEFAULT_SETTINGS.roots),
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

		return {
			...DEFAULT_SETTINGS,
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
	 * `~` prefix를 홈 디렉터리 기준 경로로 확장합니다.
	 */
	private resolvePath(raw: string): string {
		if (!raw) {
			return raw;
		}
		return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
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
	 * 양수 number 설정값을 검증하고 fallback을 적용합니다.
	 */
	private validatePositiveNumber(value: unknown, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	}
}
