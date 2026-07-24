import type { SkillRegistrySettings } from "../shared";

/** skill-registry 설정 로더 계약입니다. */
export interface SettingsLoaderInterface {
	/**
	 * 프로젝트/전역 설정을 읽고, 병합된 scope 루트 맵을 적용해
	 * 런타임에 필요한 정규화된 settings를 반환합니다.
	 *
	 * - scopeRoots: 범위 기반 루트 정의(예: local/global/managed)를 보관합니다.
	 * - scopePriority: scopeRoots 적용 우선순위 배열입니다.
	 */
	loadSettings(): Required<SkillRegistrySettings> & {
		scopeRoots: Record<string, string[]>;
		scopePriority: string[];
	};
}
