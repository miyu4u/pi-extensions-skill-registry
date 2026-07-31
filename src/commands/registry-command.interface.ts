import type { RegistryCommandRequest, RegistryCommandResult } from './registry-command.schema'

/**
 * Slash command service가 runtime adapter와 공유하는 단일 실행 경계입니다.
 */
export interface RegistryCommandContract {
  /**
   * 원문 command 인자를 domain service 입력으로 정규화하고 표시 가능한 결과로 반환합니다.
   */
  execute(request: RegistryCommandRequest): Promise<RegistryCommandResult>
}
