import type { SkillRegistrySettings } from "../shared";

/** skill-registry 설정 로더 계약입니다. */
export interface SettingsLoaderInterface {
	/**
	 * 프로젝트/전역 설정을 읽어 정규화된 기본 설정을 반환합니다.
	 */
	loadSettings(): Required<SkillRegistrySettings>;
}
