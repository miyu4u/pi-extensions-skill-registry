import type { SearchToken } from '../../shared'
import type { AnalyzerContract } from '../interface'

const HANGUL_RE = /[가-힣]/u
const KOREAN_INTL_SCORE_MULTIPLIER = 0.78

/**
 * Intl.Segmenter 기반 한국어 검색 보조 token 파생 구현체입니다.
 */
export class KoreanIntlMorphologyAnalyzerService implements AnalyzerContract {
  private readonly segmenter = new Intl.Segmenter('ko', { granularity: 'word' })

  /**
   * 한국어 token을 Intl word segment로 나눠 원본과 다른 검색 후보를 계산합니다.
   *
   * Intl.Segmenter는 조사/어미를 형태소 단위로 분석하지 않으므로,
   * 단일 어절이 하나의 segment로 반환되면 파생 token을 만들지 않습니다.
   */
  deriveTokens(token: string): SearchToken[] {
    if (!HANGUL_RE.test(token) || token.length < 2) {
      return []
    }

    const derived = new Map<string, SearchToken>()
    for (const segment of this.segmenter.segment(token)) {
      if (!segment.isWordLike) {
        continue
      }

      const segmentedToken = segment.segment.trim()
      if (segmentedToken.length < 2 || segmentedToken === token) {
        continue
      }

      derived.set(segmentedToken, {
        token: segmentedToken,
        source: 'ko-morph',
        scoreMultiplier: KOREAN_INTL_SCORE_MULTIPLIER,
      })
    }

    return [...derived.values()]
  }
}
