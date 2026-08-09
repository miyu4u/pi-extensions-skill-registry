import type { SearchToken } from '../../shared'
import type { MatcherContract } from '../interface'
import { DamerauLevenshteinDistanceCalculator } from './damerau-levenshtein-distance-calculator'

/**
 * 영어 fuzzy 후보로 비교할 수 있는 lowercase ASCII token 형식입니다.
 */
const ASCII_LATIN_TOKEN_RE = /^[a-z][a-z0-9_]*$/
/**
 * 하나의 query token에 대해 반환할 fuzzy 후보의 최대 개수입니다.
 */
const ENGLISH_FUZZY_VARIANT_LIMIT = 5
/**
 * Damerau-Levenshtein 거리에 따라 후보 점수에 적용할 multiplier입니다.
 */
const ENGLISH_DISTANCE_SCORE_MULTIPLIER: Record<1 | 2, number> = {
  1: 0.45,
  2: 0.25,
}

/**
 * 영어 query token과 index vocabulary를 비교해 오타 후보를 계산합니다.
 */
export class EnglishFuzzyMatcherService implements MatcherContract {
  /**
   * 후보 탐색과 편집 거리 계산을 분리하기 위해 거리 계산을 위임합니다.
   */
  private readonly distanceCalculator = new DamerauLevenshteinDistanceCalculator()

  /**
   * query token의 길이와 허용 형식을 기준으로 fuzzy 후보를 선별하고 순위를 정합니다.
   *
   * 짧은 token, lowercase ASCII 형식이 아닌 token은 검색하지 않습니다. 이후 첫 글자와
   * 길이 차이를 빠르게 확인하고, 거리 계산 결과를 거리·길이·locale 순으로 정렬해
   * 제한된 개수의 `SearchToken`으로 변환합니다.
   *
   * @param indexedTokens index vocabulary에서 비교할 token 집합입니다.
   * @param token fuzzy 후보를 찾을 query token입니다.
   * @returns 허용 거리 안에서 정렬된 fuzzy 후보 목록이며, 조건을 만족하는 후보가 없으면 빈 배열입니다.
   */
  buildVariants(indexedTokens: Iterable<string>, token: string): SearchToken[] {
    const maxDistance = token.length >= 7 ? 2 : token.length >= 5 ? 1 : 0
    if (maxDistance === 0 || !ASCII_LATIN_TOKEN_RE.test(token)) {
      return []
    }

    const candidates: Array<{ token: string; distance: 1 | 2 }> = []

    for (const indexedToken of indexedTokens) {
      if (!ASCII_LATIN_TOKEN_RE.test(indexedToken)) {
        continue
      }
      if (indexedToken[0] !== token[0]) {
        continue
      }
      if (Math.abs(indexedToken.length - token.length) > maxDistance) {
        continue
      }

      const distance = this.distanceCalculator.computeDistance(token, indexedToken, maxDistance)
      if (distance === null) {
        continue
      }

      candidates.push({ token: indexedToken, distance })
    }

    return candidates
      .sort((left, right) => {
        if (left.distance !== right.distance) {
          return left.distance - right.distance
        }
        if (left.token.length !== right.token.length) {
          return left.token.length - right.token.length
        }
        return left.token.localeCompare(right.token)
      })
      .slice(0, ENGLISH_FUZZY_VARIANT_LIMIT)
      .map((candidate) => ({
        token: candidate.token,
        source: 'en-fuzzy',
        scoreMultiplier: ENGLISH_DISTANCE_SCORE_MULTIPLIER[candidate.distance],
      }))
  }
}
/**
 * 영어 fuzzy matcher를 애플리케이션 전역에서 공유하는 singleton입니다.
 */
export const englishFuzzyMatcher = new EnglishFuzzyMatcherService()
