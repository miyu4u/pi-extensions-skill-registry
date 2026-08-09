import type { IndexArtifacts, LanguageAwareQueryVariant, SearchToken, SearchTokenizationResult } from '../shared'

/**
 * 문서와 query를 검색용 token 및 query variant로 변환하는 계약입니다.
 */
export interface TokenizerContract {
  /**
   * 색인 대상 문서를 base token과 derived token으로 변환합니다.
   */
  tokenizeDocumentText(text: string): SearchTokenizationResult
  /**
   * query를 base token과 derived token으로 변환합니다.
   */
  tokenizeQueryText(text: string): SearchTokenizationResult
  /**
   * index vocabulary를 기준으로 query token별 검색 후보를 계산합니다.
   */
  buildQueryVariants(index: IndexArtifacts, query: string): LanguageAwareQueryVariant[]
}

/**
 * 검색 보조용 derived token을 계산하는 계약입니다.
 */
export interface AnalyzerContract {
  /**
   * 원본 token에서 검색에 사용할 파생 token을 계산합니다.
   */
  deriveTokens(token: string): SearchToken[]
}

/**
 * query token에 대한 추가 매칭 후보를 계산하는 계약입니다.
 */
export interface MatcherContract {
  /**
   * 인덱스 token 집합에서 query token의 후보 variant를 계산합니다.
   */
  buildVariants(indexedTokens: Iterable<string>, token: string): SearchToken[]
}
