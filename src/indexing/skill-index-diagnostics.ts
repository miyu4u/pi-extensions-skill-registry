import type {
	IndexArtifacts,
	SkillAuditDegreeSummary,
	SkillAuditIssue,
	SkillAuditReport,
	SkillValidationIssue,
	SkillValidationReport,
} from "../shared";
import { dedupeDuplicateAliasEntries } from "./dedupe-duplicate-alias-entries";
import type { SkillRelationEngine } from "./skill-relation-engine";

/** index validation과 audit report의 concrete owner입니다. */
export class SkillIndexDiagnostics {
	constructor(private readonly relationEngine: SkillRelationEngine) {}

	/**
	 * 인덱스 기반 validation issue를 계산합니다.
	 */
	validateIndex(index: IndexArtifacts): SkillValidationReport {
		const issues: SkillValidationIssue[] = [];

		for (const malformed of index.stats.malformedFiles) {
			issues.push({
				severity: "error",
				kind: "malformed-frontmatter",
				message: `Malformed SKILL.md: ${malformed.reason}`,
				path: malformed.path,
			});
		}

		for (const duplicate of index.stats.duplicateCanonicalEntries) {
			issues.push({
				severity: "error",
				kind: "duplicate-canonical-name",
				message: `Duplicate canonical name '${duplicate.canonicalName}' keeps ${duplicate.keptPath} and drops ${duplicate.droppedPath}.`,
				skillName: duplicate.canonicalName,
				path: duplicate.droppedPath,
			});
		}

		for (const duplicate of dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries)) {
			issues.push({
				severity: "warning",
				kind: "duplicate-alias",
				message: `Alias '${duplicate.alias}' resolves to '${duplicate.canonicalName}' and conflicts with '${duplicate.conflictingCanonicalName}'.`,
				skillName: duplicate.canonicalName,
				target: duplicate.conflictingCanonicalName,
			});
		}

		for (const skill of index.skills) {
			for (const target of skill.requires) {
				if (index.aliasToCanonical.has(target)) {
					continue;
				}
				issues.push({
					severity: "error",
					kind: "broken-required-relation",
					message: `Required relation '${target}' from '${skill.canonicalName}' does not resolve.`,
					skillName: skill.canonicalName,
					via: skill.canonicalName,
					target,
					path: skill.path,
				});
			}

			for (const target of skill.recommends) {
				if (index.aliasToCanonical.has(target)) {
					continue;
				}
				issues.push({
					severity: "warning",
					kind: "broken-recommended-relation",
					message: `Recommended relation '${target}' from '${skill.canonicalName}' does not resolve.`,
					skillName: skill.canonicalName,
					via: skill.canonicalName,
					target,
					path: skill.path,
				});
			}
		}

		const errors = issues.filter((issue) => issue.severity === "error").length;
		const warnings = issues.length - errors;

		return {
			ok: errors === 0,
			counts: {
				errors,
				warnings,
			},
			issues,
		};
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
		const summaryLimit = Math.max(1, Math.min(limit, 20));
		const validate = this.validateIndex(index);
		const cycleGraph = this.relationEngine.graphSkills(index, query, names, "cycles", summaryLimit, minScore);
		const orphanGraph = this.relationEngine.graphSkills(index, query, names, "orphans", summaryLimit, minScore);
		const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const));
		const issues: SkillAuditIssue[] = [
			...validate.issues.map((issue) => ({
				severity: issue.severity,
				kind: "validation" as const,
				message: issue.message,
				skillName: issue.skillName,
				path: issue.path,
				sourceKind: issue.kind,
			})),
			...cycleGraph.cycles.map((cycle) => ({
				severity: "warning" as const,
				kind: "cycle" as const,
				message: `Relation cycle detected: ${[...cycle, cycle[0]].join(" -> ")}`,
				skillName: cycle[0],
				path: skillByName.get(cycle[0])?.path,
				relatedSkills: cycle,
			})),
			...orphanGraph.orphans.map((name) => ({
				severity: "info" as const,
				kind: "orphan" as const,
				message: `Orphan skill '${name}' has no inbound or outbound relations.`,
				skillName: name,
				path: skillByName.get(name)?.path,
				relatedSkills: [name],
			})),
		].sort((left, right) => {
			const severityDelta = this.auditIssueSeverityPriority(right.severity) - this.auditIssueSeverityPriority(left.severity);
			if (severityDelta !== 0) {
				return severityDelta;
			}
			if (left.kind !== right.kind) {
				return left.kind.localeCompare(right.kind);
			}
			if ((left.skillName ?? "") !== (right.skillName ?? "")) {
				return (left.skillName ?? "").localeCompare(right.skillName ?? "");
			}
			return left.message.localeCompare(right.message);
		});
		const counts = issues.reduce(
			(summary, issue) => {
				if (issue.severity === "error") {
					summary.errors += 1;
				} else if (issue.severity === "warning") {
					summary.warnings += 1;
				} else {
					summary.info += 1;
				}
				return summary;
			},
			{ errors: 0, warnings: 0, info: 0 },
		);
		const unresolvedRelations = validate.issues.filter(
			(issue) => issue.kind === "broken-required-relation" || issue.kind === "broken-recommended-relation",
		).length;
		const degreeSummary = this.buildAuditDegreeSummaries(index, summaryLimit);
		return {
			ok: counts.errors === 0 && cycleGraph.cycles.length === 0,
			counts: {
				totalSkills: index.docCount,
				errors: counts.errors,
				warnings: counts.warnings,
				info: counts.info,
				cycles: cycleGraph.cycles.length,
				orphans: orphanGraph.orphans.length,
				unresolvedRelations,
			},
			issues,
			topInbound: degreeSummary.topInbound,
			topOutbound: degreeSummary.topOutbound,
			validate,
			cycles: cycleGraph.cycles,
			orphans: orphanGraph.orphans,
		};
	}

	/**
	 * audit issue 심각도 우선순위를 반환합니다.
	 */
	private auditIssueSeverityPriority(severity: SkillAuditIssue["severity"]): number {
		switch (severity) {
			case "error":
				return 3;
			case "warning":
				return 2;
			case "info":
				return 1;
			default:
				return 0;
		}
	}

	/**
	 * relation degree 기준 상위 inbound/outbound skill을 계산합니다.
	 */
	private buildAuditDegreeSummaries(
		index: IndexArtifacts,
		limit: number,
	): {
		topInbound: SkillAuditDegreeSummary[];
		topOutbound: SkillAuditDegreeSummary[];
	} {
		const summaryByName = new Map(
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
		);
		for (const edge of this.relationEngine.buildRelationGraphEdges(index)) {
			const sourceSummary = summaryByName.get(edge.from);
			if (sourceSummary) {
				sourceSummary.outbound += 1;
				if (edge.relation === "requires") {
					sourceSummary.requires += 1;
				} else {
					sourceSummary.recommends += 1;
				}
			}
			if (!edge.to) {
				continue;
			}
			const targetSummary = summaryByName.get(edge.to);
			if (!targetSummary) {
				continue;
			}
			targetSummary.inbound += 1;
		}
		const summaries = Array.from(summaryByName.values());
		return {
			topInbound: summaries
				.filter((entry) => entry.inbound > 0)
				.sort((left, right) => {
					if (left.inbound !== right.inbound) {
						return right.inbound - left.inbound;
					}
					if (left.outbound !== right.outbound) {
						return right.outbound - left.outbound;
					}
					return left.name.localeCompare(right.name);
				})
				.slice(0, limit),
			topOutbound: summaries
				.filter((entry) => entry.outbound > 0)
				.sort((left, right) => {
					if (left.outbound !== right.outbound) {
						return right.outbound - left.outbound;
					}
					if (left.inbound !== right.inbound) {
						return right.inbound - left.inbound;
					}
					return left.name.localeCompare(right.name);
				})
				.slice(0, limit),
		};
	}

}
