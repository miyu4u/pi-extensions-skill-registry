import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * pi extension class가 구현해야 하는 package-local 공통 계약입니다.
 */
export interface PiExtensionContract {
	/**
	 * extension을 식별하는 고유 이름입니다.
	 */
	readonly name: string;

	/**
	 * extension의 역할과 연결 대상을 설명하는 문장입니다.
	 */
	readonly description: string;

	/**
	 * pi runtime이 호출하는 단일 entry method입니다.
	 *
	 * @param pi pi extension API 인스턴스
	 */
	register(pi: ExtensionAPI): void | Promise<void>;

	/**
	 * pi에 custom tool을 등록하는 wiring method입니다.
	 *
	 * @param pi pi extension API 인스턴스
	 */
	wireTools(pi: ExtensionAPI): void | Promise<void>;

	/**
	 * pi에 slash command를 등록하는 wiring method입니다.
	 *
	 * @param pi pi extension API 인스턴스
	 */
	wireCommands(pi: ExtensionAPI): void | Promise<void>;

	/**
	 * pi lifecycle event hook을 등록하는 wiring method입니다.
	 *
	 * @param pi pi extension API 인스턴스
	 */
	wireHooks(pi: ExtensionAPI): void | Promise<void>;
}
