/** 사용자/문서 skill 이름을 canonical slug로 정규화합니다. */
export const normalizeSkillName = (name: string): string =>
	name
		.trim()
		.replace(/\.md$/i, "")
		.replace(/^skill[-_]/i, "")
		.replace(/\s+/g, "-")
		.toLowerCase();
