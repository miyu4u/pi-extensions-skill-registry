import { describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";

/** 영어 fuzz matcher direct API 검증입니다. */
describe("english fuzzy matcher service", () => {
	const service = SERVICE.englishFuzzyMatcher;

	/** 인접 전치 오타가 단일 영어 fuzz 후보로 계산되는지 검증합니다. */
	test("builds a fuzzy variant for a transposition typo", () => {
		expect(service.buildVariants(["observability", "planet"], "obesrvability")).toEqual([
			{ token: "observability", source: "en-fuzzy", scoreMultiplier: 0.45 },
		]);
	});

	/** 짧거나 lowercase ASCII 규칙을 벗어난 query token은 무시하는지 검증합니다. */
	test("rejects short or non-lowercase-ascii query tokens", () => {
		expect(service.buildVariants(["planet", "planed"], "plan")).toEqual([]);
		expect(service.buildVariants(["planet", "planed"], "Planet")).toEqual([]);
	});
});
