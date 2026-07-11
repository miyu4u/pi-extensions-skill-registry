import type { IndexArtifacts, LanguageAwareQueryVariant, SearchTokenizationResult } from "../shared";

/** 검색용 공통 토큰화 계약입니다. */
export interface SearchTokenizerInterface {
	/**
	 * 문서 텍스트를 검색용 base/derived token으로 분해합니다.
	 *
	 * @param text 인덱싱할 원문 텍스트
	 */
	tokenizeDocumentText(text: string): SearchTokenizationResult;

	/**
	 * query 텍스트를 검색용 base/derived token으로 분해합니다.
	 *
	 * @param text 검색 query 원문
	 */
	tokenizeQueryText(text: string): SearchTokenizationResult;

	/**
	 * query 텍스트에 대한 exact/prefix/fuzzy variant 묶음을 계산합니다.
	 *
	 * @param index 검색 대상 인덱스
	 * @param query 사용자 검색어
	 */
	buildQueryVariants(index: IndexArtifacts, query: string): LanguageAwareQueryVariant[];
}
