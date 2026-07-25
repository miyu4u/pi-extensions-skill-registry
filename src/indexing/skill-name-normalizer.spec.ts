import { describe, expect, test } from "@jest/globals";
import { normalizeSkillName } from "./skill-name-normalizer";

/**
 * `normalizeSkillName` 함수의 정규화 규칙을 검증합니다.
 * 특히 canonical skill name의 선행 `skill-` prefix 보존을 확인합니다.
 */
describe("normalizeSkillName", () => {
	test("canonical skill name에서 선행 'skill-' prefix가 보존되는지 검증합니다.", () => {
		expect(normalizeSkillName("skill-registry-cache-invalidation-planning")).toBe(
			"skill-registry-cache-invalidation-planning",
		);
	});

	test("기타 정규화(trim, .md 제거, 공백 대치, 소문자화) 기존 동작은 유지되어야 합니다.", () => {
		expect(normalizeSkillName("  Some Skill Name.md  ")).toBe("some-skill-name");
	});
});
