import type { SkillIndexLoader } from '../indexing/skill-index-loader'
import type { SkillInputNormalizer } from '../indexing/skill-input-normalizer'
import { buildIndexResult } from '../results'
import type { RegistryCommandContract } from './registry-command.interface'
import type { RegistryCommandRequest, RegistryCommandResult } from './registry-command.schema'

/**
 * ReindexCommandService가 요구하는 의존성 명세입니다.
 */
export interface ReindexCommandDependencies {
  inputNormalizer: Pick<SkillInputNormalizer, 'normalizeToolInput'>
  indexLoader: Pick<SkillIndexLoader, 'loadIndex'>
}

/**
 * 전체 인덱스를 강제로 갱신하고 결과를 사용자 결과로 매핑하는 slash command service 구현체입니다.
 */
export class ReindexCommandService implements RegistryCommandContract {
  constructor(private readonly deps: ReindexCommandDependencies) {}

  async execute(_request: RegistryCommandRequest): Promise<RegistryCommandResult> {
    try {
      const normalized = this.deps.inputNormalizer.normalizeToolInput({
        action: 'index',
        refresh: true,
      })

      const index = await this.deps.indexLoader.loadIndex(normalized)
      const result = buildIndexResult(index, normalized.limit)
      const textContent = result.content.find((c) => c.type === 'text')?.text || 'skill_registry index 완료'

      return {
        kind: 'reindex',
        status: 'success',
        message: textContent,
        details: result.details,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'reindex',
        status: 'error',
        message: `reindex 실행 오류: ${message}. 설정 파일과 디렉토리 권한을 확인한 후 다시 시도하십시오.`,
      }
    }
  }
}
