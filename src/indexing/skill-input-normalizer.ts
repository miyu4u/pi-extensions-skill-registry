import os from "node:os";
import path from "node:path";
import type { SettingsLoaderInterface } from "../settings";
import { DEFAULT_FILE_NAMES, type ToolContext, type ToolInput } from "../shared";
import { normalizeSkillName } from "./skill-name-normalizer";

const TASK_SIZE_LIMITS = {
	small: 2,
	medium: 5,
} as const;

/** Tool 입력을 설정 기반 실행 컨텍스트로 정규화합니다. */
export class SkillInputNormalizer {
	constructor(private readonly settingsLoader: SettingsLoaderInterface) {}

	normalizeToolInput(params: ToolInput): ToolContext {
		const settings = this.settingsLoader.loadSettings();
		const mergedRoots = (params.roots?.length ? params.roots : settings.roots).map((rawRoot) => this.resolvePath(rawRoot));
		const mergedFileNames = params.fileNames?.length ? this.normalizeFileNames(params.fileNames) : settings.fileNames;
		const taskSize = params.taskSize === "large" || params.taskSize === "small" ? params.taskSize : "medium";
		const taskSizeLimit = taskSize === "large" ? settings.maxTopK : TASK_SIZE_LIMITS[taskSize];
		const requestedLimit = params.limit ?? taskSizeLimit;
		const limit = Math.max(1, Math.min(requestedLimit, settings.maxTopK, taskSizeLimit));

		return {
			action: params.action,
			query: params.query?.trim(),
			names: this.normalizeNames(params.names),
			orderedNames: this.normalizeNames(params.names, true),
			roots: mergedRoots,
			fileNames: mergedFileNames,
			limit,
			taskSize,
			refresh: params.refresh ?? false,
			minScore: params.minScore ?? 0,
			includeBody: params.includeBody ?? params.action !== "resolve",
			relationMode: params.relationMode === "required" || taskSize !== "large" ? "required" : "full",
			graphMode:
				params.graphMode === "inbound" || params.graphMode === "cycles" || params.graphMode === "orphans"
					? params.graphMode
					: "outbound",
			budgetChars: params.budgetChars ?? 4_000,
			budgetTokens: params.budgetTokens ?? 1_000,
			coverageThreshold: params.coverageThreshold ?? 0.7,
			settings: {
				...settings,
				fileNames: mergedFileNames,
				includePreviewBodyChars:
					params.includePreviewBodyChars && params.includePreviewBodyChars > 0
						? params.includePreviewBodyChars
						: settings.includePreviewBodyChars,
			},
		};
	}

	private normalizeNames(names?: string[], preserveOrder = false): string[] {
		if (!names || names.length === 0) {
			return [];
		}
		const deduped = [...new Set(names.map(normalizeSkillName).filter(Boolean))];
		return preserveOrder ? deduped : deduped.sort();
	}

	private normalizeFileNames(fileNames: string[]): string[] {
		const deduped = [...new Set(fileNames.map((name) => name.trim()).filter(Boolean))];
		return deduped.length > 0 ? deduped : DEFAULT_FILE_NAMES;
	}

	private resolvePath(raw: string): string {
		if (!raw) {
			return raw;
		}
		return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
	}
}
