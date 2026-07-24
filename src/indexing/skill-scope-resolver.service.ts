import os from "node:os";
import path from "node:path";
import type { SkillScopeResolverInterface, SkillScopeRootEntry } from "./skill-scope-resolver.interface";

type RequestedScopeSelection = {
	/**
	 * explicit scope 요청 모드인 경우 정규화된 요청 목록입니다.
	 */
	requestedScopes: string[];
	/**
	 * 요청이 undefined가 아닌 경우 명시 선택 모드임을 나타냅니다.
	 */
	hasExplicitScopes: boolean;
};

/**
 * scopeRoot 경로를 정규화하고 boundary-aware prefix 기준으로 source path를
 * scope 라벨로 매핑하는 service입니다.
 */
export class SkillScopeResolverService implements SkillScopeResolverInterface {
	/**
	 * `resolveScopeRootEntries` 결과에서 경로를 비교해 scope를 선출할 때 사용할 수 있는 fallback 레이블입니다.
	 */
	private readonly unclassifiedLabel = "unclassified";

	/**
	 * 정규화된 scope-root 엔트리 배열을 기준으로 source path를 classification 합니다.
	 */
	classifySourcePath(sourcePath: string, scopeRootEntries: readonly SkillScopeRootEntry[]): string {
		const normalizedSourcePath = this.normalizePathForBoundary(sourcePath);
		let bestScope: string | undefined;
		let bestScopeRank = Number.POSITIVE_INFINITY;
		let bestRootLength = -1;
		let bestRoot = "";

		for (let rank = 0; rank < scopeRootEntries.length; rank += 1) {
			const { scope, root } = scopeRootEntries[rank];
			if (!this.isBoundaryMatch(normalizedSourcePath, root)) {
				continue;
			}
			const candidateRootLength = root.length;
			if (
				candidateRootLength > bestRootLength ||
				(candidateRootLength === bestRootLength &&
					(rank < bestScopeRank || (rank === bestScopeRank && this.comparePathLexicographically(root, bestRoot) < 0)))
			) {
				bestScope = scope;
				bestScopeRank = rank;
				bestRootLength = candidateRootLength;
				bestRoot = root;
			}
		}

		return bestScope ?? this.unclassifiedLabel;
	}

	/**
	 * scope 요청/우선순위를 반영해 scanner에 사용할 scope-root 엔트리를 구성합니다.
	 *
	 * @param scopeRoots - scope 이름별 설정된 root 후보 목록.
	 * @param scopePriority - scope 미지정 요청 시 적용할 우선순위.
	 * @param requestedScopes - explicit 요청 scope 목록. undefined면 모든 scope 사용.
	 * @returns boundary-safe하게 정규화된 scope-root 엔트리 목록.
	 */
	resolveScopeRootEntries(
		scopeRoots: Record<string, string[]>,
		scopePriority: string[],
		requestedScopes?: string[] | readonly string[],
	): SkillScopeRootEntry[] {
		const normalizedScopeRoots = this.normalizeScopeRoots(scopeRoots);
		const requested = this.normalizeRequestedScopes(requestedScopes);

		if (requested === null) {
			return [];
		}
		const { requestedScopes: explicitScopes, hasExplicitScopes } = requested;
		const effectiveScopes = this.resolveEffectiveScopes(normalizedScopeRoots, scopePriority, explicitScopes, hasExplicitScopes);
		const entries: SkillScopeRootEntry[] = [];

		for (const scope of effectiveScopes) {
			const roots = normalizedScopeRoots[scope];
			if (!roots) {
				continue;
			}
			const seenRoots = new Set<string>();
			for (const root of roots) {
				if (!root || seenRoots.has(root)) {
					continue;
				}
				seenRoots.add(root);
				entries.push({ scope, root });
			}
		}

		return entries;
	}

	/**
	 * boundary-aware 비교를 지원하는 정규화 경로 문자열을 반환합니다.
	 */
	private normalizePathForBoundary(rawPath: string): string {
		if (!rawPath) {
			return "";
		}
		const normalizedInput = rawPath.replace(/\\/g, "/");
		const expanded = this.expandPlaceholders(normalizedInput);
		const absolutePath = this.isAbsolutePath(expanded) ? expanded : path.resolve(expanded);
		return this.normalizePath(absolutePath);
	}

	/**
	 * scope 루트 맵의 각 엔트리를 절대 경로 기반으로 정규화합니다.
	 */
	private normalizeScopeRoots(scopeRoots: Record<string, string[]>): Record<string, string[]> {
		const normalized: Record<string, string[]> = {};
		for (const [scope, roots] of Object.entries(scopeRoots)) {
			if (!Array.isArray(roots)) {
				continue;
			}
			normalized[scope] = roots.map((root) => this.normalizePathForBoundary(root)).filter((root): root is string => Boolean(root));
		}
		return normalized;
	}

	/**
	 * explicit/implicit scope 요청을 분기해 requestedScope 목록을 정규화합니다.
	 *
	 * - undefined: scope 미지정으로 간주해 all-scope 모드 진입.
	 * - 빈 배열: 사용자 명시 empty이므로 safe-zero를 유도해 빈 결과를 반환.
	 * - unknown scope 이름: whitelist 없이도 fallback 없이 안전하게 safe-zero.
	 */
	private normalizeRequestedScopes(requestedScopes?: string[] | readonly string[]): RequestedScopeSelection | null {
		if (requestedScopes === undefined) {
			return {
				requestedScopes: [],
				hasExplicitScopes: false,
			};
		}
		const requested = requestedScopes
			.map((scope) => (typeof scope === "string" ? scope.trim() : ""))
			.filter((scope) => scope.length > 0);
		if (requested.length === 0) {
			return null;
		}
		return {
			requestedScopes: [...new Set(requested)],
			hasExplicitScopes: true,
		};
	}

	/**
	 * effective scope 순서를 계산해 명시 요청/미지정 모드를 확정합니다.
	 */
	private resolveEffectiveScopes(
		normalizedScopeRoots: Record<string, string[]>,
		scopePriority: string[],
		requestedScopes: string[],
		hasExplicitScopes: boolean,
	): string[] {
		if (!hasExplicitScopes) {
			const orderedScopeNames = [...scopePriority, ...Object.keys(normalizedScopeRoots)];
			return this.dedupe(orderedScopeNames).filter(
				(scope) => Object.hasOwn(normalizedScopeRoots, scope) && normalizedScopeRoots[scope].length > 0,
			);
		}

		const normalizedRequested = this.validateRequestedScopes(requestedScopes, normalizedScopeRoots);
		if (normalizedRequested === null) {
			return [];
		}
		return normalizedRequested.filter((scope) => Object.hasOwn(normalizedScopeRoots, scope) && normalizedScopeRoots[scope].length > 0);
	}

	/**
	 * 모든 요청 scope이 존재하지 않으면 safe-zero를 위해 null을 반환합니다.
	 */
	private validateRequestedScopes(requested: string[], normalizedScopeRoots: Record<string, string[]>): string[] | null {
		for (const scope of requested) {
			if (!Object.hasOwn(normalizedScopeRoots, scope)) {
				return null;
			}
		}
		return requested;
	}

	/**
	 * 경계 인식을 유지한 prefix 매칭으로 scope 분류 대상 여부를 판단합니다.
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

	/**
	 * 순수 문자열 기반 정규화를 통해 구분자와 trailing slash를 정합적으로 제거합니다.
	 */
	private normalizePath(rawPath: string): string {
		if (!rawPath) {
			return "";
		}
		const normalized = rawPath.replace(/[/\\]+/g, "/");
		return this.trimTrailingSeparator(normalized);
	}

	/**
	 * 경로 마지막 구분자를 제거하되 root 표기는 유지합니다.
	 */
	private trimTrailingSeparator(rawPath: string): string {
		if (rawPath.length <= 1) {
			return rawPath;
		}
		if (/^[A-Za-z]:\/$/u.test(rawPath)) {
			return rawPath;
		}
		return rawPath.replace(/\/+$/g, "");
	}

	/**
	 * `~`, `$home`, `$cwd` placeholder를 홈/현재 작업 디렉토리 경로로
	 * 치환해 절대경로 기반 비교를 가능하게 합니다.
	 */
	private expandPlaceholders(rawPath: string): string {
		if (!rawPath || typeof rawPath !== "string") {
			return rawPath;
		}
		if (rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
			return path.join(os.homedir(), rawPath.slice(1));
		}
		if (rawPath === "$home" || rawPath.startsWith("$home/") || rawPath.startsWith("$home\\")) {
			return path.join(os.homedir(), rawPath.slice(6));
		}
		if (rawPath === "$cwd" || rawPath.startsWith("$cwd/") || rawPath.startsWith("$cwd\\")) {
			return path.join(process.cwd(), rawPath.slice(5));
		}
		return rawPath;
	}

	/**
	 * POSIX/Windows 절대 경로 문자열을 공통 기준으로 판별합니다.
	 */
	private isAbsolutePath(rawPath: string): boolean {
		return path.isAbsolute(rawPath) || /^[A-Za-z]:\//.test(rawPath);
	}

	/**
	 * 값 목록에서 중복을 제거해 요청/우선순위 순서를 보존합니다.
	 */
	private dedupe(values: string[]): string[] {
		const seen = new Set<string>();
		const deduped: string[] = [];
		for (const value of values) {
			if (seen.has(value)) {
				continue;
			}
			seen.add(value);
			deduped.push(value);
		}
		return deduped;
	}

	/**
	 * 경로 문자열을 안정적으로 정렬하기 위한 lexicographic 비교를 제공합니다.
	 */
	private comparePathLexicographically(a: string, b: string): number {
		if (a === b) {
			return 0;
		}
		return a < b ? -1 : 1;
	}
}
