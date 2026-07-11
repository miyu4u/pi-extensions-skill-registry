import { describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";

/** 한국어 형태소 분석 direct API 검증입니다. */
describe("korean morphology analyzer service", () => {
	const service = SERVICE.koreanMorphologyAnalyzer;

	/** 조사/어미를 제거한 뒤 어근과 복합명사 파생 token을 함께 계산하는지 검증합니다. */
	test("derives stem and compound tokens after stripping suffixes", () => {
		expect(service.deriveTokens("형태소분석합니다")).toEqual([
			{ token: "형태소분석", source: "ko-morph", scoreMultiplier: 0.78 },
			{ token: "형태", source: "ko-morph", scoreMultiplier: 0.52 },
			{ token: "소분석", source: "ko-morph", scoreMultiplier: 0.52 },
			{ token: "형태소", source: "ko-morph", scoreMultiplier: 0.52 },
			{ token: "분석", source: "ko-morph", scoreMultiplier: 0.52 },
		]);
	});

	/** 비한글 또는 너무 짧은 token은 파생하지 않는지 검증합니다. */
	test("rejects non-hangul or one-character tokens", () => {
		expect(service.deriveTokens("a")).toEqual([]);
		expect(service.deriveTokens("리")).toEqual([]);
	});
});
