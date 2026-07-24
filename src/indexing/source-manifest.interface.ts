/**
 * 하나의 source file을 filesystem metadata로 식별하는 값입니다.
 */
export type SkillSourceFileIdentity = {
	/** 정규화 전 실제 filesystem path입니다. */
	path: string;
	/** byte 단위 file 크기입니다. */
	size: number;
	/** filesystem이 제공하는 최종 수정 시각입니다. */
	mtimeMs: number;
};

/**
 * 단일 root traversal에서 관측한 source 상태입니다.
 */
export type SkillSourceScanResult = {
	/** scan 대상 root입니다. */
	root: string;
	/** root가 없거나 directory가 아닐 때 true입니다. */
	missingRoot: boolean;
	/** targeted 탐색 성공 여부를 포함한 실제 traversal mode입니다. */
	mode: "targeted" | "full";
	/** parser가 그대로 재사용할 candidate path입니다. */
	files: string[];
	/** signature 계산에 사용하는 file stat identity입니다. */
	sourceFiles: SkillSourceFileIdentity[];
};

/**
 * 동일한 source 상태를 process와 restart 사이에서 비교하는 contract입니다.
 */
export interface SourceManifestInterface {
	/**
	 * root와 file identity를 deterministic 순서로 직렬화해 signature를 생성합니다.
	 */
	createSignature(scans: readonly SkillSourceScanResult[]): string;
}
