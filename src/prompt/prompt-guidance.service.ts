import type { BeforeAgentStartEventLike, SystemPromptOverrideResult } from "../shared";
import { SKILL_BLOCK_END_MARKER, SKILL_BLOCK_START_MARKER, SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK } from "../shared";
import type { PromptGuidanceInterface } from "./prompt-guidance.interface";

/** before_agent_start prompt slim 처리 구현체입니다. */
export class PromptGuidanceService implements PromptGuidanceInterface {
	/**
	 * before_agent_start 시점의 skills block을 slim guidance로 치환합니다.
	 */
	handleBeforeAgentStart(event: BeforeAgentStartEventLike): SystemPromptOverrideResult | undefined {
		const { systemPrompt } = event;

		if (!systemPrompt) {
			return undefined;
		}

		const transformedPrompt =
			typeof systemPrompt === "string" ? this.rewriteStringSystemPrompt(systemPrompt) : this.rewritePromptBlocks(systemPrompt);

		if (!transformedPrompt) {
			return undefined;
		}

		event.systemPrompt = transformedPrompt;

		return {
			systemPrompt: transformedPrompt,
		};
	}

	/**
	 * before_agent_start 결과가 provider payload에 반영되지 않는 runtime에서도
	 * provider 직전 instructions/messages를 동일한 규칙으로 보정합니다.
	 */
	handleBeforeProviderRequest(payload: unknown): unknown | undefined {
		if (!this.isRecord(payload)) {
			return undefined;
		}

		let replaced = false;
		const next: Record<string, unknown> = { ...payload };

		if ("instructions" in next) {
			const rewrittenInstructions = this.rewriteProviderValue(next.instructions);
			if (rewrittenInstructions.changed) {
				next.instructions = rewrittenInstructions.value;
				replaced = true;
			}
		}

		if (!replaced && Array.isArray(next.messages)) {
			const rewrittenMessages = this.rewriteProviderMessages(next.messages);
			if (rewrittenMessages.changed) {
				next.messages = rewrittenMessages.value;
				replaced = true;
			}
		}

		return replaced ? next : undefined;
	}

	/**
	 * string 형태 system prompt에서 첫 skills block만 치환합니다.
	 */
	private rewriteStringSystemPrompt(systemPrompt: string): string | undefined {
		const startIndex = systemPrompt.indexOf(SKILL_BLOCK_START_MARKER);

		if (startIndex < 0) {
			return undefined;
		}

		const endIndex = systemPrompt.indexOf(SKILL_BLOCK_END_MARKER, startIndex + SKILL_BLOCK_START_MARKER.length);

		if (endIndex < 0) {
			return undefined;
		}

		return [
			systemPrompt.slice(0, startIndex),
			SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK,
			systemPrompt.slice(endIndex + SKILL_BLOCK_END_MARKER.length),
		].join("");
	}

	private rewriteProviderValue(value: unknown): { value: unknown; changed: boolean } {
		if (typeof value === "string") {
			const rewritten = this.rewriteStringSystemPrompt(value);
			return rewritten === undefined ? { value, changed: false } : { value: rewritten, changed: true };
		}

		if (!Array.isArray(value)) {
			if (this.isRecord(value) && typeof value.text === "string") {
				const rewrittenText = this.rewriteStringSystemPrompt(value.text);
				return rewrittenText === undefined
					? { value, changed: false }
					: { value: { ...value, text: rewrittenText }, changed: true };
			}
			return { value, changed: false };
		}

		const next = [...value];
		for (let index = 0; index < next.length; index += 1) {
			const part = next[index];
			const rewritten = this.rewriteProviderValue(part);
			if (!rewritten.changed) {
				continue;
			}
			next[index] = rewritten.value;
			return { value: next, changed: true };
		}

		return { value, changed: false };
	}

	private rewriteProviderMessages(messages: readonly unknown[]): { value: unknown[]; changed: boolean } {
		const next = [...messages];

		for (let index = 0; index < next.length; index += 1) {
			const message = next[index];
			if (!this.isRecord(message) || (message.role !== "system" && message.role !== "developer")) {
				continue;
			}

			const rewrittenContent = this.rewriteProviderValue(message.content);
			if (!rewrittenContent.changed) {
				continue;
			}

			next[index] = { ...message, content: rewrittenContent.value };
			return { value: next, changed: true };
		}

		return { value: next, changed: false };
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/**
	 * block 배열 형태 system prompt에서 첫 skills block만 치환합니다.
	 */
	private rewritePromptBlocks(systemPrompt: readonly string[]): string | undefined {
		// A runtime segment is not necessarily one semantic prompt block. In
		// particular, a single segment can contain the complete system prompt and
		// its <skills> section. Replacing that array element would discard every
		// sibling section and leave only the skill guidance.
		return this.rewriteStringSystemPrompt(systemPrompt.join("\n\n"));
	}
}
