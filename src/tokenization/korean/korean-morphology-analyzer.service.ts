import type { SearchToken } from '../../shared'
import type { AnalyzerContract } from '../interface'

/**
 * 한글 문자가 포함된 토큰만 한국어 형태소 파생 대상으로 허용하는 정규식입니다.
 */
const HANGUL_RE = /[가-힣]/u
/**
 * 조사나 어미를 제거해 얻은 어근 후보에 적용하는 점수 보정 계수입니다.
 */
const KOREAN_STEM_SCORE_MULTIPLIER = 0.78
/**
 * 복합어를 분해해 얻은 각 부분 후보에 적용하는 점수 보정 계수입니다.
 */
const KOREAN_COMPOUND_SCORE_MULTIPLIER = 0.52
/**
 * 토큰 끝에서 제거를 시도할 대표적인 한국어 조사와 어미 목록입니다.
 */
const KOREAN_SUFFIXES = [
  '으로부터',
  '에서부터',
  '에게서는',
  '에게서',
  '입니다',
  '합니다',
  '했습니다',
  '됩니다',
  '되면서',
  '되었다',
  '되었던',
  '되었다가',
  '되는',
  '된다',
  '되고',
  '했다',
  '했던',
  '하고',
  '하며',
  '하면',
  '하여',
  '해서',
  '하는',
  '하다',
  '처럼',
  '보다',
  '부터',
  '까지',
  '으로',
  '에서',
  '에게',
  '한테',
  '께서',
  '께는',
  '께도',
  '께',
  '이고',
  '이며',
  '이라',
  '로는',
  '로도',
  '와',
  '과',
  '을',
  '를',
  '이',
  '가',
  '은',
  '는',
  '에',
  '도',
  '만',
  '의',
  '로',
] as const

/**
 * 한국어 토큰에서 조사·어미 제거와 복합어 분해로 검색용 파생 토큰을 계산합니다.
 */
export class KoreanMorphologyAnalyzerService implements AnalyzerContract {
  /**
   * 입력 토큰에서 검색에 유용한 어근과 복합어 후보를 생성합니다.
   *
   * 먼저 한글 문자 포함 여부와 최소 길이를 검사하고, 조사·어미를 제거한 어근을
   * 우선 저장한 뒤 복합어 분해 결과를 중복 제거하여 반환합니다.
   *
   * @param token 형태소 파생을 수행할 원본 토큰입니다.
   * @returns 어근 또는 복합어 파생 후보 목록이며 조건을 만족하지 않으면 빈 배열입니다.
   */
  deriveTokens(token: string): SearchToken[] {
    if (!HANGUL_RE.test(token) || token.length < 2) {
      return []
    }

    const derived = new Map<string, SearchToken>()
    const strippedStem = this.stripSuffix(token)

    if (strippedStem && strippedStem !== token) {
      this.upsertDerivedToken(derived, {
        token: strippedStem,
        source: 'ko-morph',
        scoreMultiplier: KOREAN_STEM_SCORE_MULTIPLIER,
      })
    }

    for (const part of this.deriveCompoundParts(strippedStem ?? token)) {
      this.upsertDerivedToken(derived, part)
    }

    return [...derived.values()]
  }

  /**
   * 토큰 끝에 붙은 접미사 목록을 확인해 조사·어미가 제거된 어근을 계산합니다.
   *
   * 접미사를 제거한 뒤 공백을 정리하고, 검색 후보로 사용할 수 있도록 길이 2 이상의
   * 어근만 반환합니다. 일치하는 접미사가 없거나 어근이 너무 짧으면 `null`을 반환합니다.
   *
   * @param token 조사·어미 제거를 시도할 원본 토큰입니다.
   * @returns 유효한 어근 또는 제거할 접미사가 없을 때 `null`입니다.
   */
  private stripSuffix(token: string): string | null {
    for (const suffix of KOREAN_SUFFIXES) {
      if (!token.endsWith(suffix)) {
        continue
      }

      const stem = token.slice(0, token.length - suffix.length).trim()
      if (stem.length < 2) {
        continue
      }

      return stem
    }

    return null
  }

  /**
   * 길이가 긴 입력 토큰을 가능한 좌우 구간으로 나누어 복합어 검색 후보를 생성합니다.
   *
   * 각 분할점에서 양쪽 구간 길이가 2~4이고 길이 차이가 2 이하인 경우만 선택해,
   * 좌우 부분을 동일한 복합어 점수 보정 계수로 결과에 추가합니다.
   *
   * @param token 복합어 분해를 시도할 입력 토큰입니다.
   * @returns 조건을 만족하는 좌우 복합어 후보 목록이며 없으면 빈 배열입니다.
   */
  private deriveCompoundParts(token: string): SearchToken[] {
    if (token.length < 4) {
      return []
    }

    const result: SearchToken[] = []

    for (let splitIndex = 2; splitIndex <= token.length - 2; splitIndex += 1) {
      const left = token.slice(0, splitIndex)
      const right = token.slice(splitIndex)

      if (left.length < 2 || right.length < 2) {
        continue
      }
      if (left.length > 4 || right.length > 4) {
        continue
      }
      if (Math.abs(left.length - right.length) > 2) {
        continue
      }

      result.push({
        token: left,
        source: 'ko-morph',
        scoreMultiplier: KOREAN_COMPOUND_SCORE_MULTIPLIER,
      })
      result.push({
        token: right,
        source: 'ko-morph',
        scoreMultiplier: KOREAN_COMPOUND_SCORE_MULTIPLIER,
      })
    }

    return result
  }

  /**
   * 파생 후보를 토큰 기준으로 저장하고, 중복 토큰은 더 높은 점수 보정값으로 갱신합니다.
   *
   * 기존 후보의 점수가 새 후보 이상이면 기존 결과를 유지하고, 새 후보의 점수가 더 높을
   * 때만 결과 맵의 값을 교체해 최종 결과의 중복과 낮은 점수 후보를 줄입니다.
   *
   * @param derived 토큰별 파생 후보를 보관하는 결과 맵입니다.
   * @param candidate 추가하거나 기존 값과 비교할 파생 후보입니다.
   * @returns 반환값은 없으며 필요한 경우 결과 맵을 갱신합니다.
   */
  private upsertDerivedToken(derived: Map<string, SearchToken>, candidate: SearchToken): void {
    const existing = derived.get(candidate.token)
    if (existing && existing.scoreMultiplier >= candidate.scoreMultiplier) {
      return
    }

    derived.set(candidate.token, candidate)
  }
}
/**
 * 한국어 형태소 분석기를 애플리케이션 전역에서 공유하는 singleton입니다.
 */
export const koreanMorphologyAnalyzer = new KoreanMorphologyAnalyzerService()
