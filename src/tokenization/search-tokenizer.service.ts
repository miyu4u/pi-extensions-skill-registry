import type { IndexArtifacts, LanguageAwareQueryVariant, SearchToken, SearchTokenizationResult } from '../shared'
import { NON_WORD_BOUNDARY_RE, STOP_WORDS } from '../shared'
import { englishFuzzyMatcher } from './english/english-fuzzy-matcher.service'
import type { TokenizerContract } from './interface'
import { koreanMorphologyAnalyzer } from './korean/korean-morphology-analyzer.service'

const ASCII_LATIN_TOKEN_RE = /^[a-z][a-z0-9_]*$/
const PREFIX_VARIANT_LIMIT = 8
const PREFIX_SCORE_MULTIPLIER = 0.7
const HANGUL_RE = /[가-힣]/u

/** 검색용 공통 토큰화 구현체입니다. */
export class SearchTokenizerService implements TokenizerContract {
  /**
   * 문서 본문을 공통 토큰화 경로로 처리해 기본 토큰과 파생 토큰을 계산합니다.
   *
   * 문서와 질의가 동일한 정규화·파생 규칙을 사용하도록 내부 토큰화 메서드에 위임합니다.
   *
   * @param text 토큰화할 문서 본문입니다.
   * @returns 문서의 기본 토큰과 파생 토큰을 담은 결과입니다.
   */
  tokenizeDocumentText(text: string): SearchTokenizationResult {
    return this.tokenizeText(text)
  }

  /**
   * 질의 텍스트를 공통 토큰화 경로로 처리해 기본 토큰과 파생 토큰을 계산합니다.
   *
   * 문서 토큰화와 동일한 규칙을 적용해 검색 질의와 색인 문서의 토큰 기준을 일치시킵니다.
   *
   * @param text 토큰화할 검색 질의입니다.
   * @returns 질의의 기본 토큰과 파생 토큰을 담은 결과입니다.
   */
  tokenizeQueryText(text: string): SearchTokenizationResult {
    return this.tokenizeText(text)
  }

  /**
   * 질의를 토큰별로 정규화한 뒤 정확 일치, 접두사, 영어 오타 후보 순서로 검색 후보를 선택합니다.
   *
   * 앞선 우선순위에서 후보가 발견되면 다음 단계로 내려가지 않으며, 영어 lowercase ASCII
   * 토큰에만 오타 후보를 적용한 뒤 후보가 없는 결과를 제거합니다.
   *
   * @param index 검색 후보를 확인할 현재 색인입니다.
   * @param query exact/prefix/fuzzy 후보를 계산할 원본 질의입니다.
   * @returns 원본 토큰별로 우선순위가 결정된 검색 후보 목록입니다.
   */
  buildQueryVariants(index: IndexArtifacts, query: string): LanguageAwareQueryVariant[] {
    const baseTokens = [...new Set(this.normalizeTokens(query))]

    return baseTokens
      .map((sourceToken) => {
        const exactVariants = this.buildExactVariants(index, sourceToken)
        if (exactVariants.length > 0) {
          return {
            sourceToken,
            variants: exactVariants,
          }
        }

        const prefixVariants = this.buildPrefixVariants(index, sourceToken)
        if (prefixVariants.length > 0) {
          return {
            sourceToken,
            variants: prefixVariants,
          }
        }

        return {
          sourceToken,
          variants: ASCII_LATIN_TOKEN_RE.test(sourceToken) ? englishFuzzyMatcher.buildVariants(index.dfByTerm.keys(), sourceToken) : [],
        }
      })
      .filter((entry) => entry.variants.length > 0)
  }

  /**
   * 텍스트를 기본 토큰으로 정규화하고 한글 토큰에서 파생 토큰을 계산합니다.
   *
   * 한글 토큰에 대해서만 형태소 분석을 실행하며, 같은 파생 토큰이 여러 번 나오면
   * 더 높은 점수 보정값을 유지하고 기본 토큰과 중복되는 파생 결과는 제외합니다.
   *
   * @param text 기본·파생 토큰으로 변환할 원본 텍스트입니다.
   * @returns 기본 토큰과 중복이 제거된 파생 토큰을 함께 담은 결과입니다.
   */
  private tokenizeText(text: string): SearchTokenizationResult {
    const baseTokens = this.normalizeTokens(text)
    const derivedByToken: Record<string, SearchToken> = {}

    for (const token of baseTokens) {
      if (!HANGUL_RE.test(token)) {
        continue
      }

      for (const derivedToken of koreanMorphologyAnalyzer.deriveTokens(token)) {
        const existing = derivedByToken[derivedToken.token]
        if (existing && existing.scoreMultiplier >= derivedToken.scoreMultiplier) {
          continue
        }

        derivedByToken[derivedToken.token] = derivedToken
      }
    }

    return {
      baseTokens,
      derivedTokens: Object.values(derivedByToken).filter((token) => !baseTokens.includes(token.token)),
    }
  }

  /**
   * 검색 텍스트를 소문자화하고 구분자 기준으로 나눠 검색용 기본 토큰 배열로 정규화합니다.
   *
   * 토큰 양끝의 밑줄을 제거한 뒤 한 글자 이하 토큰과 불용어를 제외해 검색에 사용할
   * 최소 단위만 남깁니다.
   *
   * @param text 기본 토큰으로 정규화할 원본 텍스트입니다.
   * @returns 불용어와 유효하지 않은 토큰을 제외한 기본 토큰 배열입니다.
   */
  private normalizeTokens(text: string): string[] {
    const raw = text.toLowerCase().match(NON_WORD_BOUNDARY_RE) ?? []
    if (!raw.length) {
      return []
    }

    return raw.map((value) => value.replace(/^_+|_+$/g, '')).filter((token) => token.length > 1 && !STOP_WORDS[token])
  }

  /**
   * 기본 토큰과 한글 파생 토큰 중 현재 색인에 실제로 존재하는 정확 일치 후보를 선별합니다.
   *
   * 기본 후보와 한글 형태소 후보를 합친 뒤 색인에 없는 항목을 제거하고, 같은 토큰은
   * 더 높은 점수 보정값을 유지하며 점수·출처·토큰 순서로 결정적으로 정렬합니다.
   *
   * @param index 후보의 실제 존재 여부를 확인할 현재 색인입니다.
   * @param token 정확 일치 후보를 계산할 기본 토큰입니다.
   * @returns 색인에 존재하는 정확 일치 후보를 우선순위 순으로 반환합니다.
   */
  private buildExactVariants(index: IndexArtifacts, token: string): SearchToken[] {
    const candidates: SearchToken[] = [
      {
        token,
        source: 'base',
        scoreMultiplier: 1,
      },
    ]

    if (HANGUL_RE.test(token)) {
      candidates.push(...koreanMorphologyAnalyzer.deriveTokens(token))
    }

    const exactByToken: Record<string, SearchToken> = {}
    for (const candidate of candidates) {
      if (!index.dfByTerm.has(candidate.token)) {
        continue
      }

      const existing = exactByToken[candidate.token]
      if (existing && existing.scoreMultiplier >= candidate.scoreMultiplier) {
        continue
      }

      exactByToken[candidate.token] = candidate
    }

    return Object.values(exactByToken).sort((left, right) => {
      if (right.scoreMultiplier !== left.scoreMultiplier) {
        return right.scoreMultiplier - left.scoreMultiplier
      }
      if (left.source !== right.source) {
        return left.source === 'base' ? -1 : 1
      }
      return left.token.localeCompare(right.token)
    })
  }

  /**
   * 현재 색인에서 입력 토큰으로 시작하는 접두사 후보를 최대 개수까지 계산합니다.
   *
   * 네 글자 미만 토큰은 후보를 만들지 않으며, 색인 순서를 유지하면서 최대 8개를
   * 수집하고 한글 여부에 따라 후보 출처를 구분합니다.
   *
   * @param index 접두사 후보를 탐색할 현재 색인입니다.
   * @param token 접두사로 사용할 기본 토큰입니다.
   * @returns 접두사 조건을 만족하는 후보 목록이며 조건을 만족하지 않으면 빈 배열입니다.
   */
  private buildPrefixVariants(index: IndexArtifacts, token: string): SearchToken[] {
    if (token.length < 4) {
      return []
    }

    const prefixVariants: SearchToken[] = []
    for (const indexedToken of index.dfByTerm.keys()) {
      if (!indexedToken.startsWith(token)) {
        continue
      }

      prefixVariants.push({
        token: indexedToken,
        source: HANGUL_RE.test(indexedToken) ? 'ko-morph' : 'base',
        scoreMultiplier: PREFIX_SCORE_MULTIPLIER,
      })
      if (prefixVariants.length >= PREFIX_VARIANT_LIMIT) {
        break
      }
    }

    return prefixVariants
  }
}
