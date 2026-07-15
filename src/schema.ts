import { Type } from "@sinclair/typebox";

export const SkillRegistryToolInputSchema = Type.Object({
	action: Type.Union([
		Type.Literal("discover"),
		Type.Literal("index"),
		Type.Literal("search"),
		Type.Literal("select"),
		Type.Literal("resolve"),
		Type.Literal("compose"),
		Type.Literal("pack"),
		Type.Literal("graph"),
		Type.Literal("gap"),
		Type.Literal("explain"),
		Type.Literal("decide"),
		Type.Literal("plan"),
		Type.Literal("route"),
		Type.Literal("brief"),
		Type.Literal("bundle"),
		Type.Literal("handoff"),
		Type.Literal("session-packet"),
		Type.Literal("turn-packet"),
		Type.Literal("recovery-packet"),
		Type.Literal("resume-packet"),
		Type.Literal("current-turn-packet"),
		Type.Literal("instruction-packet"),
		Type.Literal("summary-packet"),
		Type.Literal("markdown-packet"),
		Type.Literal("checklist-packet"),
		Type.Literal("commands-packet"),
		Type.Literal("file-ready-packet"),
		Type.Literal("apply-packet"),
		Type.Literal("write-script-packet"),
		Type.Literal("execution-packet"),
		Type.Literal("verification-packet"),
		Type.Literal("compare"),
		Type.Literal("recommend"),
		Type.Literal("audit"),
		Type.Literal("validate"),
		Type.Literal("metrics"),
	]),
	query: Type.Optional(Type.String({ maxLength: 1024 })),
	names: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	roots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	fileNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
	taskSize: Type.Optional(Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")])),
	refresh: Type.Optional(Type.Boolean()),
	minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
	includeBody: Type.Optional(Type.Boolean()),
	includePreviewBodyChars: Type.Optional(Type.Integer({ minimum: 20, maximum: 5000 })),
	relationMode: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("full")])),
	graphMode: Type.Optional(
		Type.Union([Type.Literal("outbound"), Type.Literal("inbound"), Type.Literal("cycles"), Type.Literal("orphans")]),
	),
	budgetChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 200000 })),
	budgetTokens: Type.Optional(Type.Integer({ minimum: 50, maximum: 50000 })),
	coverageThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export const SKILL_REGISTRY_TOOL_NAME = "skill_registry";

export const SKILL_REGISTRY_TOOL_LABEL = "Skill Registry";

export const SKILL_REGISTRY_TOOL_DESCRIPTION =
	"Build/search curated skill index, rank by BM25, recommend adjacent skills, audit corpus health, and collect metrics.";

export const SkillRegistryToolContract = {
	name: SKILL_REGISTRY_TOOL_NAME,
	label: SKILL_REGISTRY_TOOL_LABEL,
	description: SKILL_REGISTRY_TOOL_DESCRIPTION,
	parameters: SkillRegistryToolInputSchema,
} as const;
