import type { BeforeAgentStartEventLike, SystemPromptOverrideResult } from "../shared";

/** before_agent_start prompt slim 처리 계약입니다. */
export interface PromptGuidanceInterface {
	/**
	 * before_agent_start 시점의 system prompt를 slim guidance로 치환합니다.
	 *
	 * @param event before_agent_start event payload
	 */
	handleBeforeAgentStart(event: BeforeAgentStartEventLike): SystemPromptOverrideResult | undefined;

	/**
	 * provider-bound payload 안의 첫 skills block을 slim guidance로 치환합니다.
	 *
	 * @param payload provider별 request payload
	 */
	handleBeforeProviderRequest(payload: unknown): unknown | undefined;
}
