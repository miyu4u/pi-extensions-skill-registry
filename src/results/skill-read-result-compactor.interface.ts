/**
 * skill-read 결과를 정규화해 다음 단계가 읽을 수 있는 최소 복구 메시지로 바꿉니다.
 */
export interface SkillReadResultCompactorInterface {
	/**
	 * toolResult를 검사해 compaction 대상이면 축약된 복구 출력을 반환합니다.
	 */
	handleToolResult(toolResult: SkillReadResultCompactorToolResult): SkillReadResultCompactorReplacement | undefined;
}

/**
 * text content-like 결과를 표현합니다.
 */
export interface SkillReadResultCompactorTextContent {
	/**
	 * content 항목의 타입입니다.
	 */
	type: "text";

	/**
	 * 텍스트 payload입니다.
	 */
	text: string;
}

/**
 * text/image content-like 결과에서 공통적으로 허용되는 content 항목입니다.
 */
export type SkillReadResultCompactorContentLike = SkillReadResultCompactorTextContent | SkillReadResultCompactorImageContent;

/**
 * image content-like 결과를 표현합니다.
 */
export interface SkillReadResultCompactorImageContent {
	/**
	 * content 항목의 타입입니다.
	 */
	type: "image";

	/**
	 * 이미지 payload입니다.
	 */
	data?: string;

	/**
	 * 이미지 mime type입니다.
	 */
	mimeType?: string;

	/**
	 * 이미지의 설명 텍스트입니다.
	 */
	text?: string;
}

/**
 * tool result 이벤트 입력을 표현합니다.
 */
export interface SkillReadResultCompactorToolResult {
	/**
	 * 호출된 tool 이름입니다.
	 */
	toolName?: string;

	/**
	 * tool input입니다.
	 */
	input?: unknown;

	/**
	 * content-like payload입니다.
	 */
	content?: SkillReadResultCompactorContentLike[];

	/**
	 * tool error 여부입니다.
	 */
	isError?: boolean;
}

/**
 * replacement 출력입니다.
 */
export interface SkillReadResultCompactorReplacement {
	/**
	 * 교체할 content입니다.
	 */
	content: SkillReadResultCompactorTextContent[];

	/**
	 * 에러 여부를 false로 정규화합니다.
	 */
	isError: false;
}
