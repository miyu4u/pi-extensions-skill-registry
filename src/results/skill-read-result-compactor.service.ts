import { SKILL_RESOLVE_RECOVERY_MAX_BYTES } from "../shared/skill-registry.constant";
import type {
	SkillReadResultCompactorContentLike,
	SkillReadResultCompactorInterface,
	SkillReadResultCompactorReplacement,
	SkillReadResultCompactorToolResult,
} from "./skill-read-result-compactor.interface";

/**
 * skill-read 실패 응답을 최소 복구 지시로 축약합니다.
 */
export class SkillReadResultCompactorService implements SkillReadResultCompactorInterface {
	/**
	 * skill:// unknown skill 경로를 감지해 recovery 텍스트로 교체합니다.
	 */
	handleToolResult(toolResult: SkillReadResultCompactorToolResult): SkillReadResultCompactorReplacement | undefined {
		if (!this.isTargetToolResult(toolResult)) {
			return undefined;
		}

		const requestedName = this.extractRequestedName(toolResult.input);
		const safeName = this.sanitizeRequestedName(requestedName);
		return { content: [{ type: "text", text: this.buildRecoveryText(safeName) }], isError: false };
	}

	/**
	 * 대상 toolResult인지 판별합니다.
	 */
	private isTargetToolResult(toolResult: SkillReadResultCompactorToolResult): boolean {
		if (toolResult.toolName !== "read" || toolResult.isError !== true) {
			return false;
		}

		if (!this.isSkillPathInput(toolResult.input)) {
			return false;
		}

		return this.hasUnknownSkillAvailability(toolResult.content);
	}

	/**
	 * read 입력에서 skill 경로를 판별합니다.
	 */
	private isSkillPathInput(input: unknown): input is { path: string } {
		if (!input || typeof input !== "object" || !("path" in input)) {
			return false;
		}

		const path = input.path;
		return typeof path === "string" && path.startsWith("skill://");
	}

	/**
	 * unknown skill 메시지와 Available 섹션 여부를 확인합니다.
	 */
	private hasUnknownSkillAvailability(content: readonly SkillReadResultCompactorContentLike[] | undefined): boolean {
		if (!Array.isArray(content)) {
			return false;
		}

		return content.some((part) => {
			if (part.type !== "text") {
				return false;
			}

			return /^Unknown skill:/u.test(part.text) && part.text.includes("\nAvailable:");
		});
	}

	/**
	 * skill 경로에서 requested name slice를 추출합니다.
	 */
	private extractRequestedName(input: unknown): string {
		if (!this.isSkillPathInput(input)) {
			return "";
		}

		return input.path.slice("skill://".length);
	}

	/**
	 * percent decode를 시도하고 control 문자를 제거한 안전한 이름을 만듭니다.
	 */
	private sanitizeRequestedName(requestedName: string): string {
		let decoded = requestedName;
		try {
			decoded = decodeURIComponent(requestedName);
		} catch {
			decoded = requestedName;
		}

		const withoutControls = Array.from(decoded)
			.filter((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint > 31 && (codePoint < 127 || codePoint > 159);
			})
			.join("");
		return this.truncateUtf8Safe(withoutControls, 512);
	}

	/**
	 * UTF-8 byte budget 내에서 Unicode-safe 하게 자릅니다.
	 */
	private truncateUtf8Safe(value: string, maxBytes: number): string {
		const encoder = new TextEncoder();
		if (encoder.encode(value).length <= maxBytes) {
			return value;
		}

		const codePoints = Array.from(value);
		let end = codePoints.length;
		while (end > 0) {
			const candidate = codePoints.slice(0, end).join("");
			if (encoder.encode(candidate).length <= maxBytes) {
				return candidate;
			}
			end -= 1;
		}

		return "";
	}

	/**
	 * 복구용 안내 텍스트를 생성하고 전체 바이트 상한을 맞춥니다.
	 */
	private buildRecoveryText(safeName: string): string {
		const nameText = safeName.length > 0 ? safeName : "(empty)";
		const raw = [
			`Unknown skill: ${nameText}`,
			"recovery: use skill_registry discover/search",
			"then resolve exact canonical name",
			"then read skill://<canonical-name>",
		].join("\n");
		return this.truncateUtf8Safe(raw, SKILL_RESOLVE_RECOVERY_MAX_BYTES);
	}
}
