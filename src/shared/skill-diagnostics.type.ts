/** duplicate canonical conflict 기록입니다. */
export type DuplicateCanonicalEntry = {
  canonicalName: string
  keptPath: string
  droppedPath: string
}

/** duplicate alias conflict 기록입니다. */
export type DuplicateAliasEntry = {
  alias: string
  canonicalName: string
  conflictingCanonicalName: string
}

/** retrospective complaint 집계 class입니다. */
export type SkillComplaintClass = 'miss' | 'overload' | 'drift' | 'low-value'

/** skill-registry retrospective telemetry snapshot입니다. */
export type SkillRegistryComplaintTelemetry = {
  query?: string
  returnedSkills: string[]
  actuallyUsedSkills: string[]
  complaintClass: SkillComplaintClass
}

/** validate issue 심각도입니다. */
export type SkillValidationSeverity = 'error' | 'warning'

/** validate issue 종류입니다. */
export type SkillValidationIssueKind =
  | 'malformed-frontmatter'
  | 'duplicate-canonical-name'
  | 'duplicate-alias'
  | 'broken-required-relation'
  | 'broken-recommended-relation'

/** validate issue payload입니다. */
export type SkillValidationIssue = {
  severity: SkillValidationSeverity
  kind: SkillValidationIssueKind
  message: string
  skillName?: string
  path?: string
  via?: string
  target?: string
}

/** validate 결과 payload입니다. */
export type SkillValidationReport = {
  ok: boolean
  counts: {
    errors: number
    warnings: number
  }
  issues: SkillValidationIssue[]
}

/** audit issue 심각도입니다. */
export type SkillAuditIssueSeverity = SkillValidationSeverity | 'info'

/** audit issue 종류입니다. */
export type SkillAuditIssueKind = 'validation' | 'cycle' | 'orphan'

/** audit issue payload입니다. */
export type SkillAuditIssue = {
  severity: SkillAuditIssueSeverity
  kind: SkillAuditIssueKind
  message: string
  skillName?: string
  path?: string
  sourceKind?: SkillValidationIssueKind
  relatedSkills?: string[]
}

/** relation hub 요약입니다. */
export type SkillAuditDegreeSummary = {
  name: string
  path: string
  inbound: number
  outbound: number
  requires: number
  recommends: number
}

/** audit 결과 payload입니다. */
export type SkillAuditReport = {
  ok: boolean
  counts: {
    totalSkills: number
    errors: number
    warnings: number
    info: number
    cycles: number
    orphans: number
    unresolvedRelations: number
  }
  issues: SkillAuditIssue[]
  topInbound: SkillAuditDegreeSummary[]
  topOutbound: SkillAuditDegreeSummary[]
  validate: SkillValidationReport
  cycles: string[][]
  orphans: string[]
}
