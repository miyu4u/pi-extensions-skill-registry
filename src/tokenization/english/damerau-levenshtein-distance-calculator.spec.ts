import { describe, expect, test } from '@jest/globals'
import { DamerauLevenshteinDistanceCalculator } from './damerau-levenshtein-distance-calculator'

/** Damerau-Levenshtein 거리 계산기 direct API 검증입니다. */
describe('damerau-levenshtein distance calculator', () => {
  const calculator = new DamerauLevenshteinDistanceCalculator()

  /** 삽입, 삭제, 치환, 인접 전치를 모두 단일 거리로 계산하는지 검증합니다. */
  test.each([
    ['insertion', 'cat', 'cats'],
    ['deletion', 'cats', 'cat'],
    ['substitution', 'cat', 'car'],
    ['transposition', 'ab', 'ba'],
  ])('computes a distance of one for %s', (_operation, source, target) => {
    expect(calculator.computeDistance(source, target, 1)).toBe(1)
  })

  /** 두 편집 거리를 계산하고 허용 거리 제한을 적용하는지 검증합니다. */
  test('computes distance two and rejects it when the limit is one', () => {
    expect(calculator.computeDistance('cat', 'cars', 2)).toBe(2)
    expect(calculator.computeDistance('cat', 'cars', 1)).toBeNull()
  })

  /** 동일 token과 허용 거리를 초과하는 token은 null로 반환하는지 검증합니다. */
  test('returns null for identical or over-limit tokens', () => {
    expect(calculator.computeDistance('cat', 'cat', 2)).toBeNull()
    expect(calculator.computeDistance('cat', 'dog', 2)).toBeNull()
  })
})
