import type { SearchToken } from "../shared";
import type { EnglishFuzzyMatcherInterface } from "./english-fuzzy-matcher.interface";

const ASCII_LATIN_TOKEN_RE = /^[a-z][a-z0-9_]*$/;
const ENGLISH_FUZZY_VARIANT_LIMIT = 5;
const ENGLISH_DISTANCE_SCORE_MULTIPLIER: Record<1 | 2, number> = {
	1: 0.45,
	2: 0.25,
};

/** 영어 오타 기반 검색 후보 계산 구현체입니다. */
export class EnglishFuzzyMatcherService implements EnglishFuzzyMatcherInterface {
	/**
	 * token 길이에 따라 Damerau-Levenshtein 기반 fuzz 후보를 계산합니다.
	 */
	buildVariants(indexedTokens: Iterable<string>, token: string): SearchToken[] {
		const maxDistance = token.length >= 7 ? 2 : token.length >= 5 ? 1 : 0;
		if (maxDistance === 0 || !ASCII_LATIN_TOKEN_RE.test(token)) {
			return [];
		}

		const candidates: Array<{ token: string; distance: 1 | 2 }> = [];

		for (const indexedToken of indexedTokens) {
			if (!ASCII_LATIN_TOKEN_RE.test(indexedToken)) {
				continue;
			}
			if (indexedToken[0] !== token[0]) {
				continue;
			}
			if (Math.abs(indexedToken.length - token.length) > maxDistance) {
				continue;
			}

			const distance = this.computeDamerauLevenshteinDistance(token, indexedToken, maxDistance);
			if (distance === null) {
				continue;
			}

			candidates.push({ token: indexedToken, distance });
		}

		return candidates
			.sort((left, right) => {
				if (left.distance !== right.distance) {
					return left.distance - right.distance;
				}
				if (left.token.length !== right.token.length) {
					return left.token.length - right.token.length;
				}
				return left.token.localeCompare(right.token);
			})
			.slice(0, ENGLISH_FUZZY_VARIANT_LIMIT)
			.map((candidate) => ({
				token: candidate.token,
				source: "en-fuzzy",
				scoreMultiplier: ENGLISH_DISTANCE_SCORE_MULTIPLIER[candidate.distance],
			}));
	}

	/**
	 * Damerau-Levenshtein distance를 계산하고 허용 거리 초과 시 null을 반환합니다.
	 */
	private computeDamerauLevenshteinDistance(source: string, target: string, maxDistance: number): 1 | 2 | null {
		if (source === target) {
			return null;
		}

		const rowCount = source.length + 1;
		const columnCount = target.length + 1;
		const matrix = Array.from({ length: rowCount }, () => new Array<number>(columnCount).fill(0));

		for (let row = 0; row < rowCount; row += 1) {
			const matrixRow = matrix[row];
			if (!matrixRow) {
				return null;
			}

			matrixRow[0] = row;
		}

		const firstRow = matrix[0];
		if (!firstRow) {
			return null;
		}
		for (let column = 0; column < columnCount; column += 1) {
			firstRow[column] = column;
		}

		for (let row = 1; row < rowCount; row += 1) {
			const matrixRow = matrix[row];
			if (!matrixRow) {
				return null;
			}

			let bestInRow = Number.POSITIVE_INFINITY;
			for (let column = 1; column < columnCount; column += 1) {
				const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1;
				let cell = Math.min(
					(matrix[row - 1]?.[column] ?? 0) + 1,
					(matrixRow[column - 1] ?? 0) + 1,
					(matrix[row - 1]?.[column - 1] ?? 0) + substitutionCost,
				);

				if (row > 1 && column > 1 && source[row - 1] === target[column - 2] && source[row - 2] === target[column - 1]) {
					cell = Math.min(cell, (matrix[row - 2]?.[column - 2] ?? 0) + 1);
				}

				matrixRow[column] = cell;
				if (cell < bestInRow) {
					bestInRow = cell;
				}
			}

			if (bestInRow > maxDistance) {
				return null;
			}
		}

		const distance = matrix[source.length]?.[target.length] ?? Number.MAX_SAFE_INTEGER;
		if (distance === 1 || distance === 2) {
			return distance;
		}
		return null;
	}
}
