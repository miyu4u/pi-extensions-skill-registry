import type {
  IndexArtifacts,
  SkillAuditDegreeSummary,
  SkillAuditIssue,
  SkillAuditReport,
  SkillValidationIssue,
  SkillValidationReport,
} from '../shared'
import { dedupeDuplicateAliasEntries } from './dedupe-duplicate-alias-entries'
import type { SkillRelationEngine } from './skill-relation-engine'

/** index validation과 audit report의 concrete owner입니다. */
export class SkillIndexDiagnostics {
  constructor(private readonly relationEngine: SkillRelationEngine) {}

  /**
   * 인덱스 기반 validation issue를 계산합니다.
   */
  validateIndex(index: IndexArtifacts): SkillValidationReport {
    const issues: SkillValidationIssue[] = []

    this.validateMalformedFiles(index, issues)
    this.validateDuplicateCanonicalEntries(index, issues)
    this.validateDuplicateAliasEntries(index, issues)
    this.validateSkillRelations(index, issues)

    const errors = issues.filter((issue) => issue.severity === 'error').length
    const warnings = issues.length - errors

    return {
      ok: errors === 0,
      counts: {
        errors,
        warnings,
      },
      issues,
    }
  }

  /**
   * validation/graph/degree summary를 묶어 corpus health audit를 계산합니다.
   */
  auditSkills(
    index: IndexArtifacts,
    query: string | undefined,
    names: string[],
    limit = Math.min(index.settings.maxTopK, 10),
    minScore = 0,
  ): SkillAuditReport {
    const summaryLimit = Math.max(1, Math.min(limit, 20))
    const validate = this.validateIndex(index)
    const cycles = this.relationEngine.graphSkills({ index, query, names, graphMode: 'cycles', limit: summaryLimit, minScore }).cycles
    const orphans = this.relationEngine.graphSkills({ index, query, names, graphMode: 'orphans', limit: summaryLimit, minScore }).orphans
    const issues = this.compileAndSortAuditIssues(index, validate, cycles, orphans)
    const unresolved = validate.issues.filter(
      (issue) => issue.kind === 'broken-required-relation' || issue.kind === 'broken-recommended-relation',
    ).length
    return this.buildAuditReport({
      index,
      validate,
      cycles,
      orphans,
      issues,
      counts: this.countAuditSeverities(issues),
      unresolvedRelations: unresolved,
      degreeSummary: this.buildAuditDegreeSummaries(index, summaryLimit),
    })
  }

  private buildAuditReport(params: {
    index: IndexArtifacts
    validate: SkillValidationReport
    cycles: string[][]
    orphans: string[]
    issues: SkillAuditIssue[]
    counts: { errors: number; warnings: number; info: number }
    unresolvedRelations: number
    degreeSummary: { topInbound: SkillAuditDegreeSummary[]; topOutbound: SkillAuditDegreeSummary[] }
  }): SkillAuditReport {
    return {
      ok: params.counts.errors === 0 && params.cycles.length === 0,
      counts: {
        totalSkills: params.index.docCount,
        errors: params.counts.errors,
        warnings: params.counts.warnings,
        info: params.counts.info,
        cycles: params.cycles.length,
        orphans: params.orphans.length,
        unresolvedRelations: params.unresolvedRelations,
      },
      issues: params.issues,
      topInbound: params.degreeSummary.topInbound,
      topOutbound: params.degreeSummary.topOutbound,
      validate: params.validate,
      cycles: params.cycles,
      orphans: params.orphans,
    }
  }

  private validateMalformedFiles(index: IndexArtifacts, issues: SkillValidationIssue[]): void {
    for (const malformed of index.stats.malformedFiles) {
      issues.push({
        severity: 'error',
        kind: 'malformed-frontmatter',
        message: `Malformed SKILL.md: ${malformed.reason}`,
        path: malformed.path,
      })
    }
  }

  private validateDuplicateCanonicalEntries(index: IndexArtifacts, issues: SkillValidationIssue[]): void {
    for (const duplicate of index.stats.duplicateCanonicalEntries) {
      issues.push({
        severity: 'error',
        kind: 'duplicate-canonical-name',
        message: `Duplicate canonical name '${duplicate.canonicalName}' keeps ${duplicate.keptPath} and drops ${duplicate.droppedPath}.`,
        skillName: duplicate.canonicalName,
        path: duplicate.droppedPath,
      })
    }
  }

  private validateDuplicateAliasEntries(index: IndexArtifacts, issues: SkillValidationIssue[]): void {
    for (const duplicate of dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries)) {
      issues.push({
        severity: 'warning',
        kind: 'duplicate-alias',
        message: `Alias '${duplicate.alias}' resolves to '${duplicate.canonicalName}' and conflicts with '${duplicate.conflictingCanonicalName}'.`,
        skillName: duplicate.canonicalName,
        target: duplicate.conflictingCanonicalName,
      })
    }
  }

  private validateSkillRelations(index: IndexArtifacts, issues: SkillValidationIssue[]): void {
    for (const skill of index.skills) {
      this.validateSkillRequires(index, skill, issues)
      this.validateSkillRecommends(index, skill, issues)
    }
  }

  private validateSkillRequires(index: IndexArtifacts, skill: IndexArtifacts['skills'][number], issues: SkillValidationIssue[]): void {
    for (const target of skill.requires) {
      if (!index.aliasToCanonical.has(target)) {
        issues.push({
          severity: 'error',
          kind: 'broken-required-relation',
          message: `Required relation '${target}' from '${skill.canonicalName}' does not resolve.`,
          skillName: skill.canonicalName,
          via: skill.canonicalName,
          target,
          path: skill.path,
        })
      }
    }
  }

  private validateSkillRecommends(index: IndexArtifacts, skill: IndexArtifacts['skills'][number], issues: SkillValidationIssue[]): void {
    for (const target of skill.recommends) {
      if (!index.aliasToCanonical.has(target)) {
        issues.push({
          severity: 'warning',
          kind: 'broken-recommended-relation',
          message: `Recommended relation '${target}' from '${skill.canonicalName}' does not resolve.`,
          skillName: skill.canonicalName,
          via: skill.canonicalName,
          target,
          path: skill.path,
        })
      }
    }
  }

  private compileAndSortAuditIssues(
    index: IndexArtifacts,
    validate: SkillValidationReport,
    cycles: string[][],
    orphans: string[],
  ): SkillAuditIssue[] {
    const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const))
    const issues: SkillAuditIssue[] = [
      ...validate.issues.map((issue) => ({
        severity: issue.severity,
        kind: 'validation' as const,
        message: issue.message,
        skillName: issue.skillName,
        path: issue.path,
        sourceKind: issue.kind,
      })),
      ...this.mapCycleIssues(cycles, skillByName),
      ...this.mapOrphanIssues(orphans, skillByName),
    ]

    return issues.sort((left, right) => this.compareAuditIssues(left, right))
  }

  private mapCycleIssues(cycles: string[][], skillByName: Map<string, IndexArtifacts['skills'][number]>): SkillAuditIssue[] {
    return cycles.map((cycle) => ({
      severity: 'warning',
      kind: 'cycle',
      message: `Relation cycle detected: ${[...cycle, cycle[0]].join(' -> ')}`,
      skillName: cycle[0],
      path: skillByName.get(cycle[0])?.path,
      relatedSkills: cycle,
    }))
  }

  private mapOrphanIssues(orphans: string[], skillByName: Map<string, IndexArtifacts['skills'][number]>): SkillAuditIssue[] {
    return orphans.map((name) => ({
      severity: 'info',
      kind: 'orphan',
      message: `Orphan skill '${name}' has no inbound or outbound relations.`,
      skillName: name,
      path: skillByName.get(name)?.path,
      relatedSkills: [name],
    }))
  }

  private compareAuditIssues(left: SkillAuditIssue, right: SkillAuditIssue): number {
    const severityDelta = this.auditIssueSeverityPriority(right.severity) - this.auditIssueSeverityPriority(left.severity)
    if (severityDelta !== 0) {
      return severityDelta
    }
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind)
    }
    if ((left.skillName ?? '') !== (right.skillName ?? '')) {
      return (left.skillName ?? '').localeCompare(right.skillName ?? '')
    }
    return left.message.localeCompare(right.message)
  }

  private countAuditSeverities(issues: SkillAuditIssue[]): { errors: number; warnings: number; info: number } {
    return issues.reduce(
      (summary, issue) => {
        if (issue.severity === 'error') {
          summary.errors += 1
        } else if (issue.severity === 'warning') {
          summary.warnings += 1
        } else {
          summary.info += 1
        }
        return summary
      },
      { errors: 0, warnings: 0, info: 0 },
    )
  }

  /**
   * audit issue 심각도 우선순위를 반환합니다.
   */
  private auditIssueSeverityPriority(severity: SkillAuditIssue['severity']): number {
    switch (severity) {
      case 'error':
        return 3
      case 'warning':
        return 2
      case 'info':
        return 1
      default:
        return 0
    }
  }

  /**
   * relation degree 기준 상위 inbound/outbound skill을 계산합니다.
   */
  private buildAuditDegreeSummaries(
    index: IndexArtifacts,
    limit: number,
  ): {
    topInbound: SkillAuditDegreeSummary[]
    topOutbound: SkillAuditDegreeSummary[]
  } {
    const summaryByName = this.initDegreeSummaries(index)
    this.populateDegreeSummaries(index, summaryByName)
    const summaries = Array.from(summaryByName.values())
    return {
      topInbound: this.getTopInbound(summaries, limit),
      topOutbound: this.getTopOutbound(summaries, limit),
    }
  }

  private initDegreeSummaries(index: IndexArtifacts): Map<string, SkillAuditDegreeSummary> {
    return new Map(
      index.skills.map(
        (skill) =>
          [
            skill.canonicalName,
            {
              name: skill.canonicalName,
              path: skill.path,
              inbound: 0,
              outbound: 0,
              requires: 0,
              recommends: 0,
            } satisfies SkillAuditDegreeSummary,
          ] as const,
      ),
    )
  }

  private populateDegreeSummaries(index: IndexArtifacts, summaryByName: Map<string, SkillAuditDegreeSummary>): void {
    for (const edge of this.relationEngine.buildRelationGraphEdges(index)) {
      const sourceSummary = summaryByName.get(edge.from)
      if (sourceSummary) {
        sourceSummary.outbound += 1
        if (edge.relation === 'requires') {
          sourceSummary.requires += 1
        } else {
          sourceSummary.recommends += 1
        }
      }
      if (edge.to) {
        const targetSummary = summaryByName.get(edge.to)
        if (targetSummary) {
          targetSummary.inbound += 1
        }
      }
    }
  }

  private getTopInbound(summaries: SkillAuditDegreeSummary[], limit: number): SkillAuditDegreeSummary[] {
    return summaries
      .filter((entry) => entry.inbound > 0)
      .sort((left, right) => {
        if (left.inbound !== right.inbound) {
          return right.inbound - left.inbound
        }
        if (left.outbound !== right.outbound) {
          return right.outbound - left.outbound
        }
        return left.name.localeCompare(right.name)
      })
      .slice(0, limit)
  }

  private getTopOutbound(summaries: SkillAuditDegreeSummary[], limit: number): SkillAuditDegreeSummary[] {
    return summaries
      .filter((entry) => entry.outbound > 0)
      .sort((left, right) => {
        if (left.outbound !== right.outbound) {
          return right.outbound - left.outbound
        }
        if (left.inbound !== right.inbound) {
          return right.inbound - left.inbound
        }
        return left.name.localeCompare(right.name)
      })
      .slice(0, limit)
  }
}
