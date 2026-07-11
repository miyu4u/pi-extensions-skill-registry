import type { SearchToken } from "../shared";
import type { KoreanMorphologyAnalyzerInterface } from "./korean-morphology-analyzer.interface";

const HANGUL_RE = /[가-힣]/u;
const KOREAN_STEM_SCORE_MULTIPLIER = 0.78;
const KOREAN_COMPOUND_SCORE_MULTIPLIER = 0.52;
const KOREAN_SUFFIXES = [
	"으로부터",
	"에서부터",
	"에게서는",
	"에게서",
	"입니다",
	"합니다",
	"했습니다",
	"됩니다",
	"되면서",
	"되었다",
	"되었던",
	"되었다가",
	"되는",
	"된다",
	"되고",
	"했다",
	"했던",
	"하고",
	"하며",
	"하면",
	"하여",
	"해서",
	"하는",
	"하다",
	"처럼",
	"보다",
	"부터",
	"까지",
	"으로",
	"에서",
	"에게",
	"한테",
	"께서",
	"께는",
	"께도",
	"께",
	"이고",
	"이며",
	"이라",
	"로는",
	"로도",
	"와",
	"과",
	"을",
	"를",
	"이",
	"가",
	"은",
	"는",
	"에",
	"도",
	"만",
	"의",
	"로",
] as const;

/** 한국어 검색 보조 token 파생 구현체입니다. */
export class KoreanMorphologyAnalyzerService implements KoreanMorphologyAnalyzerInterface {
	/**
	 * 한국어 token에서 조사/어미 제거와 복합어 분해 기반 파생 token을 계산합니다.
	 */
	deriveTokens(token: string): SearchToken[] {
		if (!HANGUL_RE.test(token) || token.length < 2) {
			return [];
		}

		const derived = new Map<string, SearchToken>();
		const strippedStem = this.stripSuffix(token);

		if (strippedStem && strippedStem !== token) {
			this.upsertDerivedToken(derived, {
				token: strippedStem,
				source: "ko-morph",
				scoreMultiplier: KOREAN_STEM_SCORE_MULTIPLIER,
			});
		}

		for (const part of this.deriveCompoundParts(strippedStem ?? token)) {
			this.upsertDerivedToken(derived, part);
		}

		return [...derived.values()];
	}

	/**
	 * token 끝의 대표적인 조사/어미를 제거해 어근 후보를 계산합니다.
	 */
	private stripSuffix(token: string): string | null {
		for (const suffix of KOREAN_SUFFIXES) {
			if (!token.endsWith(suffix)) {
				continue;
			}

			const stem = token.slice(0, token.length - suffix.length).trim();
			if (stem.length < 2) {
				continue;
			}

			return stem;
		}

		return null;
	}

	/**
	 * 긴 한글 token을 좌우 파트로 나눠 복합 명사 검색 후보를 만듭니다.
	 */
	private deriveCompoundParts(token: string): SearchToken[] {
		if (token.length < 4) {
			return [];
		}

		const result: SearchToken[] = [];

		for (let splitIndex = 2; splitIndex <= token.length - 2; splitIndex += 1) {
			const left = token.slice(0, splitIndex);
			const right = token.slice(splitIndex);

			if (left.length < 2 || right.length < 2) {
				continue;
			}
			if (left.length > 4 || right.length > 4) {
				continue;
			}
			if (Math.abs(left.length - right.length) > 2) {
				continue;
			}

			result.push({
				token: left,
				source: "ko-morph",
				scoreMultiplier: KOREAN_COMPOUND_SCORE_MULTIPLIER,
			});
			result.push({
				token: right,
				source: "ko-morph",
				scoreMultiplier: KOREAN_COMPOUND_SCORE_MULTIPLIER,
			});
		}

		return result;
	}

	/**
	 * 같은 token이 중복 파생되면 더 높은 점수 보정값만 유지합니다.
	 */
	private upsertDerivedToken(derived: Map<string, SearchToken>, candidate: SearchToken): void {
		const existing = derived.get(candidate.token);
		if (existing && existing.scoreMultiplier >= candidate.scoreMultiplier) {
			return;
		}

		derived.set(candidate.token, candidate);
	}
}
