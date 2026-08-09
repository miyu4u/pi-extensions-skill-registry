/**
 * 영어 fuzzy matching에서 사용할 Damerau-Levenshtein 편집 거리를 계산합니다.
 */
export class DamerauLevenshteinDistanceCalculator {
  /**
   * 두 token을 행렬로 비교해 허용 범위 안의 편집 거리를 계산합니다.
   *
   * 삽입, 삭제, 치환, 인접 전치를 반영하고, 동일 token이나 허용 거리를
   * 초과한 결과는 fuzzy 후보에서 제외할 수 있도록 `null`로 반환합니다.
   *
   * @param source 비교 기준이 되는 원본 token입니다.
   * @param target 원본과 비교할 색인 token입니다.
   * @param maxDistance 허용할 최대 편집 거리입니다.
   * @returns 동일 문자열, 1·2가 아닌 거리, 또는 `maxDistance`를 초과한 거리는 `null`이고, 그 외에는 계산된 거리입니다.
   */
  computeDistance(source: string, target: string, maxDistance: number): 1 | 2 | null {
    if (source === target) {
      return null
    }

    const rowCount = source.length + 1
    const columnCount = target.length + 1
    const matrix = this.initDistanceMatrix(rowCount, columnCount)
    if (!matrix) {
      return null
    }

    for (let row = 1; row < rowCount; row += 1) {
      const matrixRow = matrix[row]
      if (!matrixRow) {
        return null
      }

      const bestInRow = this.fillDistanceMatrixRow({
        row,
        matrix,
        matrixRow,
        source,
        target,
        columnCount,
      })
      if (bestInRow > maxDistance) {
        return null
      }
    }

    const distance = matrix[source.length]?.[target.length]
    if (distance !== 1 && distance !== 2) {
      return null
    }
    return distance <= maxDistance ? distance : null
  }

  /**
   * 거리 행렬의 첫 행과 첫 열을 기본 편집 거리로 채워 후속 계산의 시작 상태를 만듭니다.
   *
   * 각 행과 열이 누락되지 않았는지도 확인해, 계산 중 사용할 수 없는 행렬이면
   * 호출자가 안전하게 `null`을 반환할 수 있도록 합니다.
   *
   * @param rowCount 원본 token 길이에 1을 더한 행 개수입니다.
   * @param columnCount 대상 token 길이에 1을 더한 열 개수입니다.
   * @returns 기본값이 채워진 거리 행렬 또는 생성에 필요한 행이 없을 때 `null`입니다.
   */
  private initDistanceMatrix(rowCount: number, columnCount: number): number[][] | null {
    const matrix = Array.from({ length: rowCount }, () => new Array<number>(columnCount).fill(0))

    for (let row = 0; row < rowCount; row += 1) {
      const matrixRow = matrix[row]
      if (!matrixRow) {
        return null
      }

      matrixRow[0] = row
    }

    const firstRow = matrix[0]
    if (!firstRow) {
      return null
    }
    for (let column = 0; column < columnCount; column += 1) {
      firstRow[column] = column
    }

    return matrix
  }

  /**
   * 현재 원본 행의 각 셀을 삽입, 삭제, 치환, 인접 전치 후보 중 최솟값으로 갱신합니다.
   *
   * 행마다 가장 작은 거리를 함께 추적해, 허용 거리보다 작은 경로가 남아 있는지
   * `computeDistance`가 조기에 판단할 수 있도록 합니다.
   *
   * @param row 갱신할 원본 token의 행 번호입니다.
   * @param matrix 지금까지 계산된 전체 거리 행렬입니다.
   * @param matrixRow 현재 갱신 중인 행입니다.
   * @param source 비교 기준이 되는 원본 token입니다.
   * @param target 원본과 비교할 대상 token입니다.
   * @param columnCount 대상 token 길이에 1을 더한 열 개수입니다.
   * @returns 현재 행에서 계산된 최솟값입니다.
   */
  private fillDistanceMatrixRow({
    row,
    matrix,
    matrixRow,
    source,
    target,
    columnCount,
  }: {
    row: number
    matrix: number[][]
    matrixRow: number[]
    source: string
    target: string
    columnCount: number
  }): number {
    let bestInRow = Number.POSITIVE_INFINITY
    for (let column = 1; column < columnCount; column += 1) {
      const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1
      let cell = Math.min(
        (matrix[row - 1]?.[column] ?? 0) + 1,
        (matrixRow[column - 1] ?? 0) + 1,
        (matrix[row - 1]?.[column - 1] ?? 0) + substitutionCost,
      )

      if (row > 1 && column > 1 && source[row - 1] === target[column - 2] && source[row - 2] === target[column - 1]) {
        cell = Math.min(cell, (matrix[row - 2]?.[column - 2] ?? 0) + 1)
      }

      matrixRow[column] = cell
      if (cell < bestInRow) {
        bestInRow = cell
      }
    }
    return bestInRow
  }
}
