import type { IndexArtifacts, LanguageAwareQueryVariant, SearchToken, SearchTokenizationResult } from "../shared";
import { NON_WORD_BOUNDARY_RE, STOP_WORDS } from "../shared";
import type { EnglishFuzzyMatcherInterface } from "./english-fuzzy-matcher.interface";
import type { KoreanMorphologyAnalyzerInterface } from "./korean-morphology-analyzer.interface";
import type { SearchTokenizerInterface } from "./search-tokenizer.interface";

const ASCII_LATIN_TOKEN_RE = /^[a-z][a-z0-9_]*$/;
const PREFIX_VARIANT_LIMIT = 8;
const PREFIX_SCORE_MULTIPLIER = 0.7;
const HANGUL_RE = /[가-힣]/u;

/** 검색용 공통 토큰화 구현체입니다. */
export class SearchTokenizerService implements SearchTokenizerInterface {
	constructor(
		private readonly englishFuzzyMatcher: EnglishFuzzyMatcherInterface,
		private readonly koreanMorphologyAnalyzer: KoreanMorphologyAnalyzerInterface,
	) {}

	/**
	 * 문서 텍스트를 base token과 한국어 파생 token으로 분해합니다.
	 */
	tokenizeDocumentText(text: string): SearchTokenizationResult {
		return this.tokenizeText(text);
	}

	/**
	 * query 텍스트를 base token과 한국어 파생 token으로 분해합니다.
	 */
	tokenizeQueryText(text: string): SearchTokenizationResult {
		return this.tokenizeText(text);
	}

	/**
	 * query 원문 token별로 exact/prefix/fuzzy 후보를 우선순위에 맞게 계산합니다.
	 */
	buildQueryVariants(index: IndexArtifacts, query: string): LanguageAwareQueryVariant[] {
		const baseTokens = [...new Set(this.normalizeTokens(query))];

		return baseTokens
			.map((sourceToken) => {
				const exactVariants = this.buildExactVariants(index, sourceToken);
				if (exactVariants.length > 0) {
					return {
						sourceToken,
						variants: exactVariants,
					};
				}

				const prefixVariants = this.buildPrefixVariants(index, sourceToken);
				if (prefixVariants.length > 0) {
					return {
						sourceToken,
						variants: prefixVariants,
					};
				}

				return {
					sourceToken,
					variants: ASCII_LATIN_TOKEN_RE.test(sourceToken)
						? this.englishFuzzyMatcher.buildVariants(index.dfByTerm.keys(), sourceToken)
						: [],
				};
			})
			.filter((entry) => entry.variants.length > 0);
	}

	/**
	 * base token과 한국어 파생 token을 함께 계산합니다.
	 */
	private tokenizeText(text: string): SearchTokenizationResult {
		const baseTokens = this.normalizeTokens(text);
		const derivedByToken: Record<string, SearchToken> = {};

		for (const token of baseTokens) {
			if (!HANGUL_RE.test(token)) {
				continue;
			}

			for (const derivedToken of this.koreanMorphologyAnalyzer.deriveTokens(token)) {
				const existing = derivedByToken[derivedToken.token];
				if (existing && existing.scoreMultiplier >= derivedToken.scoreMultiplier) {
					continue;
				}

				derivedByToken[derivedToken.token] = derivedToken;
			}
		}

		return {
			baseTokens,
			derivedTokens: Object.values(derivedByToken).filter((token) => !baseTokens.includes(token.token)),
		};
	}

	/**
	 * 텍스트를 검색용 base token 배열로 정규화합니다.
	 */
	private normalizeTokens(text: string): string[] {
		const raw = text.toLowerCase().match(NON_WORD_BOUNDARY_RE) ?? [];
		if (!raw.length) {
			return [];
		}

		return raw.map((value) => value.replace(/^_+|_+$/g, "")).filter((token) => token.length > 1 && !STOP_WORDS[token]);
	}

	/**
	 * base token과 한국어 파생 token 중 인덱스에 실제로 존재하는 exact 후보를 반환합니다.
	 */
	private buildExactVariants(index: IndexArtifacts, token: string): SearchToken[] {
		const candidates: SearchToken[] = [
			{
				token,
				source: "base",
				scoreMultiplier: 1,
			},
		];

		if (HANGUL_RE.test(token)) {
			candidates.push(...this.koreanMorphologyAnalyzer.deriveTokens(token));
		}

		const exactByToken: Record<string, SearchToken> = {};
		for (const candidate of candidates) {
			if (!index.dfByTerm.has(candidate.token)) {
				continue;
			}

			const existing = exactByToken[candidate.token];
			if (existing && existing.scoreMultiplier >= candidate.scoreMultiplier) {
				continue;
			}

			exactByToken[candidate.token] = candidate;
		}

		return Object.values(exactByToken).sort((left, right) => {
			if (right.scoreMultiplier !== left.scoreMultiplier) {
				return right.scoreMultiplier - left.scoreMultiplier;
			}
			if (left.source !== right.source) {
				return left.source === "base" ? -1 : 1;
			}
			return left.token.localeCompare(right.token);
		});
	}

	/**
	 * 현재 인덱스 기준 prefix fallback 후보를 계산합니다.
	 */
	private buildPrefixVariants(index: IndexArtifacts, token: string): SearchToken[] {
		if (token.length < 4) {
			return [];
		}

		const prefixVariants: SearchToken[] = [];
		for (const indexedToken of index.dfByTerm.keys()) {
			if (!indexedToken.startsWith(token)) {
				continue;
			}

			prefixVariants.push({
				token: indexedToken,
				source: HANGUL_RE.test(indexedToken) ? "ko-morph" : "base",
				scoreMultiplier: PREFIX_SCORE_MULTIPLIER,
			});
			if (prefixVariants.length >= PREFIX_VARIANT_LIMIT) {
				break;
			}
		}

		return prefixVariants;
	}
}
