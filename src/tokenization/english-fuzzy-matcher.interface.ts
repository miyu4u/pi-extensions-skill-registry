import type { SearchToken } from "../shared";

/** 영어 오타 기반 검색 후보 계산 계약입니다. */
export interface EnglishFuzzyMatcherInterface {
	/**
	 * 인덱스 token 집합에서 영어 query token의 fuzz 후보를 계산합니다.
	 *
	 * @param indexedTokens 현재 인덱스에 존재하는 token 집합
	 * @param token 원본 query token
	 */
	buildVariants(indexedTokens: Iterable<string>, token: string): SearchToken[];
}
