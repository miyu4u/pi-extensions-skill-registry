import os from "node:os";
import path from "node:path";
import type { SettingsLoaderInterface } from "../settings";
import {
	DEFAULT_FILE_NAMES,
	SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT,
	SKILL_RESOLVE_SUGGESTION_HARD_CAP,
	type ToolContext,
	type ToolInput,
} from "../shared";
import { normalizeSkillName } from "./skill-name-normalizer";
import type { SkillScopeResolverInterface } from "./skill-scope-resolver.interface";

const TASK_SIZE_LIMITS = {
	small: 2,
	medium: 5,
} as const;

/** Tool 입력을 설정 기반 실행 컨텍스트로 정규화합니다. */
export class SkillInputNormalizer {
	constructor(
		private readonly settingsLoader: SettingsLoaderInterface,
		private readonly scopeResolver: SkillScopeResolverInterface,
	) {}

	normalizeToolInput(params: ToolInput): ToolContext {
		const settings = this.settingsLoader.loadSettings();
		const scopeSelection = this.resolveScopeSelection(params.scopes, settings.scopeRoots, settings.scopePriority);
		const mergedRoots = this.selectConfiguredRoots(
			params.roots?.length ? params.roots : settings.roots,
			settings.scopeRoots,
			settings.scopePriority,
			scopeSelection,
		);
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
			scopes: scopeSelection.scopes,
			scopesExplicit: scopeSelection.explicit,
			suggestionLimit: Math.max(
				0,
				Math.min(params.suggestionLimit ?? SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT, SKILL_RESOLVE_SUGGESTION_HARD_CAP),
			),
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

	/**
	 * 기존 scan root 범위를 유지하면서 명시 scope 요청에 해당하는 root만
	 * boundary-aware 분류 결과로 선택합니다.
	 */
	private selectConfiguredRoots(
		configuredRoots: string[],
		scopeRoots: Record<string, string[]>,
		scopePriority: string[],
		selection: { scopes: string[]; explicit: boolean; roots: string[] },
	): string[] {
		const normalizedRoots = this.normalizeRootList(configuredRoots);
		if (!selection.explicit) {
			return normalizedRoots;
		}
		if (selection.scopes.length === 0) {
			return [];
		}
		const entries = this.scopeResolver.resolveScopeRootEntries(scopeRoots, scopePriority);
		const selectedScopes = new Set(selection.scopes);
		const selectedScopeRoots = selection.roots.length > 0 ? selection.roots : this.flattenScopeRoots(scopeRoots, selection.scopes);
		return normalizedRoots.filter((root) => {
			if (selectedScopes.has(this.scopeResolver.classifySourcePath(root, entries))) {
				return true;
			}
			return this.isBoundaryRelatedToAnySelectedScopeRoot(root, selectedScopeRoots);
		});
	}

	/**
	 * 요청 스코프 입력을 설정 기반 정책으로 정규화해
	 * 생략/명시 여부와 유효성별 루트 대상 목록을 결정합니다.
	 */
	private resolveScopeSelection(
		inputScopes: string[] | undefined,
		scopeRoots: Record<string, string[]>,
		scopePriority: string[],
	): { scopes: string[]; roots: string[]; explicit: boolean } {
		if (inputScopes === undefined) {
			const allScopes = this.orderScopeNames(scopePriority, Object.keys(scopeRoots));
			return {
				scopes: allScopes,
				roots: this.flattenScopeRoots(scopeRoots, allScopes),
				explicit: false,
			};
		}

		const explicitScopes = this.normalizeStrings(inputScopes);
		if (explicitScopes.length === 0) {
			return {
				scopes: [],
				roots: [],
				explicit: true,
			};
		}

		const scopeNameSet = new Set<string>(Object.keys(scopeRoots));
		if (!explicitScopes.every((scopeName) => scopeNameSet.has(scopeName))) {
			return {
				scopes: [],
				roots: [],
				explicit: true,
			};
		}

		const orderedScopes = this.orderScopeNames(scopePriority, explicitScopes);
		const selectedScopes = orderedScopes.filter((scopeName) => scopeNameSet.has(scopeName));
		return {
			scopes: selectedScopes,
			roots: this.flattenScopeRoots(scopeRoots, selectedScopes),
			explicit: true,
		};
	}

	/**
	 * 루트 정렬 우선순위를 scopePriority 기반으로 구성해
	 * priority 뒤편의 미래 스코프 키까지 보존합니다.
	 */
	private orderScopeNames(scopePriority: string[], scopeNames: string[]): string[] {
		const requestedScopes = new Set(scopeNames);
		const orderedScopes = [...scopePriority.filter((scope) => requestedScopes.has(scope)), ...scopeNames];
		const dedupedScopes: string[] = [];
		const seen = new Set<string>();
		for (const scopeName of orderedScopes) {
			if (seen.has(scopeName)) {
				continue;
			}
			seen.add(scopeName);
			dedupedScopes.push(scopeName);
		}
		return dedupedScopes;
	}

	/**
	 * 스코프별 루트 목록을 정규화해 병합하고
	 * 중복 없는 deterministic한 탐색 대상 경로 배열을 반환합니다.
	 */
	private flattenScopeRoots(scopeRoots: Record<string, string[]>, scopeNames: string[]): string[] {
		const dedupedRoots = new Set<string>();
		for (const scopeName of scopeNames) {
			const roots = scopeRoots[scopeName];
			if (!Array.isArray(roots)) {
				continue;
			}
			for (const rawRoot of roots) {
				const normalizedRoot = this.normalizeRoot(rawRoot);
				if (normalizedRoot) {
					dedupedRoots.add(normalizedRoot);
				}
			}
		}

		return [...dedupedRoots];
	}

	/**
	 * 공백 제거, 경로 정규화, 절대경로 확장, 중복 제거를 통해
	 * 경로 리스트를 요청 스캔 입력으로 맞춥니다.
	 */
	private normalizeRootList(rawRoots: string[]): string[] {
		const normalizedRoots = rawRoots
			.map((rawRoot) => this.normalizeRoot(rawRoot))
			.filter((root): root is string => typeof root === "string" && root.length > 0);
		return [...new Set(normalizedRoots)];
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

	/**
	 * 문자열 배열에서 trim + dedupe를 수행해
	 * 값이 빈 항목을 제거하고 순서를 안정적으로 정리합니다.
	 */
	private normalizeStrings(values: string[]): string[] {
		const normalizedValues = values.map((value) => value.trim()).filter(Boolean);
		return [...new Set(normalizedValues)];
	}

	/**
	 * 루트 문자열의 `~`, 상대 경로, 구분자/슬래시 정규화를
	 * 통해 실제 검색에서 사용할 절대 경로 형태로 변환합니다.
	 */
	private normalizeRoot(raw: string): string {
		const normalized = this.resolvePath(raw);
		return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(normalized);
	}

	/**
	 * 사용자 홈(`~`) 확장만 담당하는 기본 경로 보정입니다.
	 */
	private resolvePath(raw: string): string {
		if (!raw) {
			return raw;
		}
		return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(1)) : raw;
	}

	/**
	 * 루트 관계를 boundary 기준으로 판정해 ancestor/descendant 관계를 판정합니다.
	 */
	private isBoundaryRelatedToAnySelectedScopeRoot(candidateRoot: string, scopeRoots: string[]): boolean {
		const normalizedCandidate = this.normalizeBoundaryPath(candidateRoot);
		if (!normalizedCandidate) {
			return false;
		}

		return scopeRoots.some((scopeRoot) => {
			const normalizedScopeRoot = this.normalizeBoundaryPath(scopeRoot);
			if (!normalizedScopeRoot) {
				return false;
			}
			return (
				this.isBoundaryMatch(normalizedCandidate, normalizedScopeRoot) ||
				this.isBoundaryMatch(normalizedScopeRoot, normalizedCandidate)
			);
		});
	}

	/**
	 * boundary 매칭에 사용할 경로 문자열을 슬래시 통일/정규화합니다.
	 */
	private normalizeBoundaryPath(rawPath: string): string {
		if (!rawPath) {
			return "";
		}
		const normalized = rawPath.replace(/\\/g, "/");
		if (normalized.length <= 1) {
			return normalized;
		}
		if (/^[A-Za-z]:\/$/u.test(normalized)) {
			return normalized;
		}
		return normalized.replace(/\/+$/u, "");
	}

	/**
	 * 후보 경로가 root 경계 내부이거나 경계일치일 때 true를 반환합니다.
	 */
	private isBoundaryMatch(candidatePath: string, root: string): boolean {
		if (!candidatePath || !root) {
			return false;
		}
		if (root === "/") {
			return candidatePath.startsWith("/");
		}
		if (/^[A-Za-z]:\/$/u.test(root)) {
			return candidatePath.startsWith(root);
		}
		if (candidatePath === root) {
			return true;
		}
		return candidatePath.startsWith(`${root}/`);
	}
}
