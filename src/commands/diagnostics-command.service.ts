import type { SkillIndexDiagnostics, SkillIndexLoader, SkillInputNormalizer } from '../indexing'
import { buildAuditResult, buildMetricsResult, buildValidateResult } from '../results'
import type { SkillRegistryToolResult } from '../shared'
import type { RegistryCommandContract } from './registry-command.interface'
import type { RegistryCommandRequest, RegistryCommandResult } from './registry-command.schema'

/**
 * 현재 loaded artifact의 health projection에 필요한 기존 domain owner 계약입니다.
 */
export interface DiagnosticsCommandDependencies {
  /** 설정과 effective scope를 동일한 tool execution context로 정규화합니다. */
  inputNormalizer: Pick<SkillInputNormalizer, 'normalizeToolInput'>
  /** Cache freshness 정책을 유지하며 현재 artifact를 load합니다. */
  indexLoader: Pick<SkillIndexLoader, 'loadIndex'>
  /** 기존 audit와 validation 판정을 재사용합니다. */
  indexDiagnostics: Pick<SkillIndexDiagnostics, 'auditSkills' | 'validateIndex'>
}

/**
 * Audit, validation, metrics 결과를 하나의 compact command summary로 투영합니다.
 */
export class DiagnosticsCommandService implements RegistryCommandContract {
  constructor(private readonly deps: DiagnosticsCommandDependencies) {}

  async execute(_request: RegistryCommandRequest): Promise<RegistryCommandResult> {
    try {
      const normalized = this.deps.inputNormalizer.normalizeToolInput({ action: 'audit' })
      const index = await this.deps.indexLoader.loadIndex(normalized)
      const audit = buildAuditResult(
        index,
        this.deps.indexDiagnostics.auditSkills(index, undefined, [], normalized.limit, normalized.minScore),
      )
      const validation = buildValidateResult(index, this.deps.indexDiagnostics.validateIndex(index))
      const metrics = buildMetricsResult(index)

      return {
        kind: 'diagnostics',
        status: 'success',
        message: [this.textOf(audit), this.textOf(validation), this.textOf(metrics)].join('\n\n'),
        details: {
          audit: audit.details,
          validation: validation.details,
          metrics: metrics.details,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'diagnostics',
        status: 'error',
        message: `diagnostics 실행 오류: ${message}. skill roots와 index 설정을 확인한 후 다시 시도하십시오.`,
      }
    }
  }

  /**
   * 기존 result builder의 text projection만 runtime 표시용으로 선택합니다.
   */
  private textOf(result: SkillRegistryToolResult): string {
    return result.content.find((content) => content.type === 'text')?.text ?? 'diagnostics 결과가 없습니다.'
  }
}
