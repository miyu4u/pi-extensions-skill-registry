/**
 * scope 분류와 scope-root 해석에 필요한 엔트리 shape을 정의합니다.
 * 하위 객체는 resolver가 scope 라벨과 정규화 경로를 함께 전달할 때 사용됩니다.
 */
export type SkillScopeRootEntry = {
	/**
	 * 분류된 scope 이름입니다.
	 */
	readonly scope: string;
	/**
	 * scope 기준으로 정규화된 절대 경로입니다.
	 */
	readonly root: string;
};

/**
 * 파일 경로를 scope-root 맵으로 분류하고 scope-root 엔트리를 해석하기 위한
 * 정규화 계약입니다.
 */
export interface SkillScopeResolverInterface {
	/**
	 * 입력된 scope 후보를 정규화해 scanner에 전달할 scope-root 엔트리 배열로 해석합니다.
	 *
	 * @param scopeRoots - scope 이름별 루트 후보 목록.
	 * @param scopePriority - scope 미지정 요청에 사용할 fallback 우선순위.
	 * @param requestedScopes - explicit scope 요청 목록. undefined면 모든 scope를 대상으로 합니다.
	 * @returns 정규화·절대경로화·중복 제거 후 deterministic 순서로 정렬된 scope-root 엔트리 목록.
	 */
	resolveScopeRootEntries(
		scopeRoots: Record<string, string[]>,
		scopePriority: string[],
		requestedScopes?: string[] | readonly string[],
	): SkillScopeRootEntry[];

	/**
	 * 정규화된 scope-root 엔트리를 사용해 단일 path를 scope로 분류합니다.
	 *
	 * @param sourcePath - 분류 대상 파일 경로.
	 * @param scopeRootEntries - resolveScopeRootEntries에서 얻은 scope-root 엔트리.
	 * @returns 매칭 scope 또는 경계 밖이면 `unclassified`.
	 */
	classifySourcePath(sourcePath: string, scopeRootEntries: readonly SkillScopeRootEntry[]): string;
}
