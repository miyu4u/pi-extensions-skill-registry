import type { SearchToken } from "../shared";

/** 한국어 검색 토큰 파생 규칙 계약입니다. */
export interface KoreanMorphologyAnalyzerInterface {
	/**
	 * 한국어 token에서 검색 보조용 파생 token을 계산합니다.
	 *
	 * @param token 분석할 한국어 token
	 */
	deriveTokens(token: string): SearchToken[];
}
