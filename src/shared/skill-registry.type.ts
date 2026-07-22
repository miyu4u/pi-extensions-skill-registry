import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** skill-registry action 후보입니다. */
export type SkillRegistryAction =
	| "discover"
	| "index"
	| "search"
	| "select"
	| "resolve"
	| "compose"
	| "pack"
	| "graph"
	| "gap"
	| "explain"
	| "decide"
	| "plan"
	| "route"
	| "brief"
	| "bundle"
	| "handoff"
	| "session-packet"
	| "turn-packet"
	| "recovery-packet"
	| "resume-packet"
	| "current-turn-packet"
	| "instruction-packet"
	| "summary-packet"
	| "markdown-packet"
	| "checklist-packet"
	| "commands-packet"
	| "file-ready-packet"
	| "apply-packet"
	| "write-script-packet"
	| "execution-packet"
	| "verification-packet"
	| "compare"
	| "recommend"
	| "audit"
	| "validate"
	| "metrics";
/** relation compose 범위입니다. */
export type SkillRelationMode = "required" | "full";

/** relation graph 조회 모드입니다. */
export type SkillGraphMode = "outbound" | "inbound" | "cycles" | "orphans";

/** skill-registry 설정 shape입니다. */
export type SkillRegistrySettings = {
	roots?: string[];
	fileNames?: string[];
	presetSkills?: string[];
	databasePath?: string;
	cacheTtlMs?: number;
	maxTopK?: number;
	includePreviewBodyChars?: number;
};

/** 작업 크기 기반 추천 폭 힌트입니다. */
export type SkillTaskSize = "small" | "medium" | "large";

/** tool input payload입니다. */
export type ToolInput = {
	action: SkillRegistryAction;
	query?: string;
	names?: string[];
	roots?: string[];
	fileNames?: string[];
	limit?: number;
	taskSize?: SkillTaskSize;
	refresh?: boolean;
	minScore?: number;
	includeBody?: boolean;
	includePreviewBodyChars?: number;
	relationMode?: SkillRelationMode;
	graphMode?: SkillGraphMode;
	budgetChars?: number;
	budgetTokens?: number;
	coverageThreshold?: number;
};

/** 정규화된 tool 실행 context입니다. */
export type ToolContext = {
	action: SkillRegistryAction;
	query?: string;
	names: string[];
	orderedNames: string[];
	roots: string[];
	fileNames: string[];
	limit: number;
	taskSize: SkillTaskSize;
	refresh: boolean;
	minScore: number;
	includeBody: boolean;
	relationMode: SkillRelationMode;
	graphMode: SkillGraphMode;
	budgetChars: number;
	budgetTokens: number;
	coverageThreshold: number;
	settings: Required<SkillRegistrySettings>;
};

/** raw frontmatter field 값 후보입니다. */
export type SkillFrontmatterValue = string | string[];

/** raw frontmatter record shape입니다. */
export type SkillFrontmatterRecord = Record<string, SkillFrontmatterValue>;

/** skill frontmatter 정규화 결과입니다. */
export type SkillFrontmatter = {
	name: string;
	description?: string;
	category?: string;
	keywords?: string[];
	tags?: string[];
	aliases?: string[];
	requires?: string[];
	recommends?: string[];
	version?: string;
};

/** 파싱 완료된 skill 문서 모델입니다. */
export type RawSkill = {
	id: string;
	canonicalName: string;
	path: string;
	sourceRoot: string;
	rawFrontmatter: SkillFrontmatterRecord;
	frontmatter: SkillFrontmatter;
	bodyText: string;
	title: string;
	category: string;
	keywords: string[];
	tags: string[];
	aliases: string[];
	requires: string[];
	recommends: string[];
	text: string;
	mtimeMs: number;
};

/** compose에 포함된 skill 엔트리입니다. */
export type ComposedSkillEntry = {
	skill: RawSkill;
	reason: "seed" | "required" | "recommended";
	via?: string;
	depth: number;
};

/** compose에서 해소되지 않은 relation 엔트리입니다. */
export type MissingSkillRelation = {
	name: string;
	relation: "required" | "recommended";
	via: string;
	depth: number;
};

/** compose 실행 결과입니다. */
export type SkillComposePlan = {
	seeds: RawSkill[];
	entries: ComposedSkillEntry[];
	missing: MissingSkillRelation[];
	relationMode: SkillRelationMode;
};

/** relation edge 종류입니다. */
export type SkillRelationEdgeKind = "requires" | "recommends";

/** canonicalized relation edge입니다. */
export type SkillRelationGraphEdge = {
	from: string;
	to?: string;
	target: string;
	relation: SkillRelationEdgeKind;
	resolved: boolean;
};

/** graph node payload입니다. */
export type SkillRelationGraphNode = {
	name: string;
	path: string;
	category: string;
	title: string;
	aliases: string[];
};

/** graph 조회 결과 payload입니다. */
export type SkillRelationGraph = {
	mode: SkillGraphMode;
	seeds: string[];
	nodes: SkillRelationGraphNode[];
	edges: SkillRelationGraphEdge[];
	readLayers: string[][];
	applyLayers: string[][];
	missing: MissingSkillRelation[];
	cycles: string[][];
	orphans: string[];
	diagnostics: {
		duplicateCanonicalEntries: DuplicateCanonicalEntry[];
		duplicateAliasEntries: DuplicateAliasEntry[];
	};
};

/** resolve 결과 엔트리입니다. */
export type SkillResolveEntry = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	requires: string[];
	recommends: string[];
	preview: string;
	body?: string;
	omittedByBudget: boolean;
};

/** resolve 결과 payload입니다. */
export type SkillResolveResult = {
	resolved: SkillResolveEntry[];
	missing: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
};

/** gap 후보 skill 요약입니다. */
export type SkillGapCandidate = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	score: number;
	coverage: number;
	matchedTerms: string[];
	preview: string;
};

/** gap scaffold 제안입니다. */
export type SkillGapScaffold = {
	name: string;
	category: string;
	keywords: string[];
	description: string;
	body: string;
};

/** gap 결과 payload입니다. */
export type SkillGapResult = {
	ok: boolean;
	query: string;
	coverageThreshold: number;
	coveredTerms: string[];
	uncoveredTerms: string[];
	candidates: SkillGapCandidate[];
	recommendedAction: "use-existing" | "add-alias" | "create-skill";
	scaffold?: SkillGapScaffold;
};

/** explain 결과 엔트리입니다. */
export type SkillExplainEntry = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	reason: "seed" | "required" | "recommended";
	via?: string;
	depth: number;
	readLayer: number | null;
	applyLayer: number | null;
	score?: number;
	coverage?: number;
	matchedTerms: string[];
	matchPreview: string;
};

/** explain 결과 payload입니다. */
export type SkillExplainResult = {
	query?: string;
	relationMode: SkillRelationMode;
	seeds: string[];
	entries: SkillExplainEntry[];
	missing: MissingSkillRelation[];
	cycles: string[][];
	diagnostics: {
		duplicateCanonicalEntries: DuplicateCanonicalEntry[];
		duplicateAliasEntries: DuplicateAliasEntry[];
	};
};

/** decide 결과 엔트리입니다. */
export type SkillDecideEntry = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	score: number;
	queryScore?: number;
	queryCoverage?: number;
	explicitName: boolean;
	peerRequiredBy: string[];
	peerRecommendedBy: string[];
	requiredPeers: string[];
	unresolvedRequires: string[];
	reasons: string[];
	preview: string;
};

/** decide 결과 payload입니다. */
export type SkillDecideResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	winner: string | null;
	ordered: SkillDecideEntry[];
};

/** plan step reason입니다. */
export type SkillPlanStepReason = "winner" | "unblocks-required-peer" | "unblocks-recommended-peer" | "alternative";

/** plan step entry입니다. */
export type SkillPlanStep = {
	order: number;
	phase: "first" | "next" | "later";
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	reason: SkillPlanStepReason;
	via?: string;
	score?: number;
	queryScore?: number;
	preview: string;
};

/** plan 결과 payload입니다. */
export type SkillPlanResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	steps: SkillPlanStep[];
	deferred: string[];
};

/** route phase 종류입니다. */
export type SkillRoutePhaseKind = "start" | "read-layer" | "apply-layer" | "fallback";

/** route phase entry입니다. */
export type SkillRoutePhase = {
	order: number;
	kind: SkillRoutePhaseKind;
	layer: number | null;
	names: string[];
	readPaths: string[];
	rationale: string[];
};

/** route 결과 payload입니다. */
export type SkillRouteResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	phases: SkillRoutePhase[];
	deferred: string[];
};

/** brief packet entry입니다. */
export type SkillBriefEntry = {
	phaseOrder: number;
	phaseKind: SkillRoutePhaseKind;
	layer: number | null;
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	preview: string;
	body?: string;
	omittedByBudget: boolean;
};

/** brief 결과 payload입니다. */
export type SkillBriefResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	phases: SkillRoutePhase[];
	entries: SkillBriefEntry[];
	deferred: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
};

/** bundle 결과 payload입니다. */
export type SkillBundleResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	phases: SkillRoutePhase[];
	entries: Array<Omit<SkillBriefEntry, "body">>;
	entriesWithBody?: SkillBriefEntry[];
	deferred: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
};

/** handoff 결과 payload입니다. */
export type SkillHandoffResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	sourcePath: string | null;
	nextCommand: string | null;
	applyHint?: string;
	phases: SkillRoutePhase[];
	entries: Array<Omit<SkillBriefEntry, "body">>;
	entriesWithBody?: SkillBriefEntry[];
	deferred: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
};

/** session-packet step entry입니다. */
export type SkillSessionPacketStep = {
	order: number;
	name: string;
	sourcePath: string;
	nextCommand: string;
	phaseKind: SkillRoutePhaseKind;
	layer: number | null;
	omittedByBudget: boolean;
};

/** session-packet 결과 payload입니다. */
export type SkillSessionPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	sourcePaths: string[];
	nextCommands: string[];
	applyHint?: string;
	recoveryGuidance: string[];
	steps: SkillSessionPacketStep[];
};

/** turn-packet turn entry입니다. */
export type SkillTurnPacketTurn = {
	order: number;
	phaseKind: SkillRoutePhaseKind;
	layer: number | null;
	names: string[];
	readPaths: string[];
	sourcePaths: string[];
	nextCommands: string[];
	objective: string;
	checklist: string[];
	exitCriteria: string[];
	blockedByBudget: boolean;
};

/** turn-packet 결과 payload입니다. */
export type SkillTurnPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	sourcePaths: string[];
	nextCommands: string[];
	applyHint?: string;
	recoveryGuidance: string[];
	deferred: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turns: SkillTurnPacketTurn[];
};

/** recovery-packet blocked turn entry입니다. */
export type SkillRecoveryPacketTurn = {
	order: number;
	phaseKind: SkillRoutePhaseKind;
	layer: number | null;
	names: string[];
	omittedReadPaths: string[];
	sourcePaths: string[];
	recoveryCommands: string[];
	objective: string;
	unblockCriteria: string[];
};

/** recovery-packet 결과 payload입니다. */
export type SkillRecoveryPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	omittedReadPaths: string[];
	sourcePaths: string[];
	recoveryCommands: string[];
	deferred: string[];
	resumeTurnOrder: number | null;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	blockedTurns: SkillRecoveryPacketTurn[];
};

/** resume-packet 결과 payload입니다. */
export type SkillResumePacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	omittedReadPaths: string[];
	recoveryCommands: string[];
	sourcePaths: string[];
	nextCommands: string[];
	deferred: string[];
	resumeTurnOrder: number | null;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turns: SkillTurnPacketTurn[];
	blockedTurns: SkillRecoveryPacketTurn[];
};

/** current-turn-packet 결과 payload입니다. */
export type SkillCurrentTurnPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	omittedReadPaths: string[];
	recoveryCommands: string[];
	sourcePaths: string[];
	nextCommands: string[];
	deferred: string[];
	activeTurnOrder: number | null;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
	blockedTurns: SkillRecoveryPacketTurn[];
};

/** instruction-packet 결과 payload입니다. */
export type SkillInstructionPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	sourcePaths: string[];
	nextCommands: string[];
	instructionText: string;
	checklistText: string;
	commandBlock: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** markdown-packet 결과 payload입니다. */
export type SkillMarkdownPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	sourcePaths: string[];
	nextCommands: string[];
	markdown: string;
	commandBlock: string;
	checklistItems: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** checklist-packet 결과 payload입니다. */
export type SkillChecklistPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	sourcePaths: string[];
	nextCommands: string[];
	checklistItems: string[];
	checklistText: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** commands-packet 결과 payload입니다. */
export type SkillCommandsPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	sourcePaths: string[];
	nextCommands: string[];
	commandBlock: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** file-ready-packet 파일 엔트리입니다. */
export type SkillFileReadyPacketFile = {
	kind: "markdown" | "checklist" | "commands";
	suggestedPath: string;
	mediaType: "text/markdown" | "text/plain";
	content: string;
};

/** file-ready-packet 결과 payload입니다. */
export type SkillFileReadyPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	baseName: string;
	sourcePaths: string[];
	nextCommands: string[];
	files: SkillFileReadyPacketFile[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** apply-packet write 엔트리입니다. */
export type SkillApplyPacketWrite = {
	kind: "write";
	sourceKind: SkillFileReadyPacketFile["kind"];
	path: string;
	mediaType: SkillFileReadyPacketFile["mediaType"];
	content: string;
};

/** apply-packet 결과 payload입니다. */
export type SkillApplyPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	baseName: string;
	sourcePaths: string[];
	nextCommands: string[];
	writes: SkillApplyPacketWrite[];
	applyText: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** write-script-packet 결과 payload입니다. */
export type SkillWriteScriptPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	baseName: string;
	sourcePaths: string[];
	nextCommands: string[];
	writes: SkillApplyPacketWrite[];
	scriptPath: string;
	scriptContent: string;
	commandBlock: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** execution-packet 실행 파일 엔트리입니다. */
export type SkillExecutionPacketFile = {
	kind: "script";
	path: string;
	mediaType: "text/typescript";
	content: string;
};

/** execution-packet 결과 payload입니다. */
export type SkillExecutionPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	baseName: string;
	sourcePaths: string[];
	nextCommands: string[];
	files: SkillExecutionPacketFile[];
	runCommands: string[];
	executionText: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** verification-packet 결과 payload입니다. */
export type SkillVerificationPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	baseName: string;
	sourcePaths: string[];
	nextCommands: string[];
	files: SkillExecutionPacketFile[];
	runCommands: string[];
	verificationCommands: string[];
	verificationItems: string[];
	verificationText: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** summary-packet 결과 payload입니다. */
export type SkillSummaryPacketResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	relationMode: SkillRelationMode;
	winner: string | null;
	ready: boolean;
	applyHint?: string;
	recoveryGuidance: string[];
	activeTurnOrder: number | null;
	sourcePaths: string[];
	nextCommands: string[];
	summaryText: string;
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	turn: SkillTurnPacketTurn | null;
};

/** compare skill pair의 directional relation입니다. */
export type SkillCompareRelation = "requires" | "recommends";

/** compare 후보 엔트리입니다. */
export type SkillCompareEntry = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	score?: number;
	coverage?: number;
	matchedTerms: string[];
	requires: string[];
	recommends: string[];
	preview: string;
};

/** compare pairwise 결과입니다. */
export type SkillComparePair = {
	left: string;
	right: string;
	sameCategory: boolean;
	sharedAliases: string[];
	sharedMatchedTerms: string[];
	leftOnlyMatchedTerms: string[];
	rightOnlyMatchedTerms: string[];
	sharedRequires: string[];
	sharedRecommends: string[];
	leftToRight?: SkillCompareRelation;
	rightToLeft?: SkillCompareRelation;
	scoreDelta?: number;
};

/** compare 결과 payload입니다. */
export type SkillCompareResult = {
	query?: string;
	basis: "query" | "names" | "query+names";
	entries: SkillCompareEntry[];
	pairs: SkillComparePair[];
};

/** recommend relation signal입니다. */
export type SkillRecommendRelationSignal = {
	via: string;
	relation: "required" | "recommended";
};

/** recommend 결과 엔트리입니다. */
export type SkillRecommendEntry = {
	name: string;
	readPath: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	score: number;
	queryScore?: number;
	queryCoverage?: number;
	matchedTerms: string[];
	outboundSignals: SkillRecommendRelationSignal[];
	inboundSignals: SkillRecommendRelationSignal[];
	sharedCategorySeeds: string[];
	preview: string;
};

/** recommend 결과 payload입니다. */
export type SkillRecommendResult = {
	query?: string;
	relationMode: SkillRelationMode;
	seeds: string[];
	recommendations: SkillRecommendEntry[];
};

/** pack 결과 엔트리입니다. */
export type SkillPackEntry = {
	name: string;
	path: string;
	title: string;
	category: string;
	aliases: string[];
	requires: string[];
	recommends: string[];
	reason: "seed" | "required" | "recommended";
	via?: string;
	depth: number;
	readLayer: number | null;
	applyLayer: number | null;
	preview: string;
	body?: string;
	readPath: string;
	omittedByBudget: boolean;
};

/** pack 결과 payload입니다. */
export type SkillPack = {
	ok: boolean;
	relationMode: SkillRelationMode;
	seeds: string[];
	entries: SkillPackEntry[];
	readLayers: string[][];
	applyLayers: string[][];
	missing: MissingSkillRelation[];
	cycles: string[][];
	orphans: string[];
	omittedReadPaths: string[];
	budget: {
		requestedChars: number;
		requestedTokens: number;
		effectiveChars: number;
		usedChars: number;
	};
	compose: SkillComposePlan;
	graph: SkillRelationGraph;
	validate: SkillValidationReport;
	diagnostics: {
		duplicateCanonicalEntries: DuplicateCanonicalEntry[];
		duplicateAliasEntries: DuplicateAliasEntry[];
	};
};

/** duplicate canonical conflict 기록입니다. */
export type DuplicateCanonicalEntry = {
	canonicalName: string;
	keptPath: string;
	droppedPath: string;
};

/** duplicate alias conflict 기록입니다. */
export type DuplicateAliasEntry = {
	alias: string;
	canonicalName: string;
	conflictingCanonicalName: string;
};

/** 인덱스 빌드 통계입니다. */
export type IndexedStats = {
	totalFilesVisited: number;
	totalParsed: number;
	skippedMissingRoot: number;
	parseErrors: number;
	deduplicated: number;
	missingFromRequested: string[];
	malformedFiles: Array<{ path: string; reason: string }>;
	duplicateCanonicalEntries: DuplicateCanonicalEntry[];
	duplicateAliasEntries: DuplicateAliasEntry[];
	nameFilterMode: "targeted" | "full";
};
/** 검색 token 파생 출처입니다. */
export type SearchTokenSource = "base" | "ko-morph" | "en-fuzzy";

/** 검색용 base/derived token 엔트리입니다. */
export type SearchToken = {
	token: string;
	source: SearchTokenSource;
	scoreMultiplier: number;
};

/** base token과 파생 token을 함께 담는 토큰화 결과입니다. */
export type SearchTokenizationResult = {
	baseTokens: string[];
	derivedTokens: SearchToken[];
};

/** query 원문 token별 variant 묶음입니다. */
export type LanguageAwareQueryVariant = {
	sourceToken: string;
	variants: SearchToken[];
};

/** BM25 검색 hit입니다. */
export type SearchHit = {
	skill: RawSkill;
	score: number;
	coverage: number;
	matchedTerms: string[];
};

/** 검색 query fallback 및 miss 판단을 위한 compact diagnostics입니다. */
export type SkillSearchDiagnostics = {
	normalizedQuery: string;
	matchedAliases: string[];
	fallbackMode: "none" | "query-rewrite" | "safe-zero";
	whyThisTop1?: string;
	whyZero?: string;
};

/** 검색 hit와 diagnostics를 함께 반환하는 결과입니다. */
export type SkillSearchResult = {
	hits: SearchHit[];
	diagnostics: SkillSearchDiagnostics;
};

/** retrospective complaint 집계 class입니다. */
export type SkillComplaintClass = "miss" | "overload" | "drift" | "low-value";

/** skill-registry retrospective telemetry snapshot입니다. */
export type SkillRegistryComplaintTelemetry = {
	query?: string;
	returnedSkills: string[];
	actuallyUsedSkills: string[];
	complaintClass: SkillComplaintClass;
};

/** 빌드 완료된 인덱스 산출물입니다. */
export type IndexArtifacts = {
	generatedAt: number;
	ttlMs: number;
	requestKey: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	skills: RawSkill[];
	stats: IndexedStats;
	docCount: number;
	dfByTerm: Map<string, number>;
	aliasToCanonical: Map<string, string>;
	avgLength: number;
	indexBuildMs: number;
};

/** validate issue 심각도입니다. */
export type SkillValidationSeverity = "error" | "warning";

/** validate issue 종류입니다. */
export type SkillValidationIssueKind =
	| "malformed-frontmatter"
	| "duplicate-canonical-name"
	| "duplicate-alias"
	| "broken-required-relation"
	| "broken-recommended-relation";

/** validate issue payload입니다. */
export type SkillValidationIssue = {
	severity: SkillValidationSeverity;
	kind: SkillValidationIssueKind;
	message: string;
	skillName?: string;
	path?: string;
	via?: string;
	target?: string;
};

/** validate 결과 payload입니다. */
export type SkillValidationReport = {
	ok: boolean;
	counts: {
		errors: number;
		warnings: number;
	};
	issues: SkillValidationIssue[];
};

/** audit issue 심각도입니다. */
export type SkillAuditIssueSeverity = SkillValidationSeverity | "info";

/** audit issue 종류입니다. */
export type SkillAuditIssueKind = "validation" | "cycle" | "orphan";

/** audit issue payload입니다. */
export type SkillAuditIssue = {
	severity: SkillAuditIssueSeverity;
	kind: SkillAuditIssueKind;
	message: string;
	skillName?: string;
	path?: string;
	sourceKind?: SkillValidationIssueKind;
	relatedSkills?: string[];
};

/** relation hub 요약입니다. */
export type SkillAuditDegreeSummary = {
	name: string;
	path: string;
	inbound: number;
	outbound: number;
	requires: number;
	recommends: number;
};

/** audit 결과 payload입니다. */
export type SkillAuditReport = {
	ok: boolean;
	counts: {
		totalSkills: number;
		errors: number;
		warnings: number;
		info: number;
		cycles: number;
		orphans: number;
		unresolvedRelations: number;
	};
	issues: SkillAuditIssue[];
	topInbound: SkillAuditDegreeSummary[];
	topOutbound: SkillAuditDegreeSummary[];
	validate: SkillValidationReport;
	cycles: string[][];
	orphans: string[];
};

/** tool result payload 타입입니다. */
export type SkillRegistryToolResult = AgentToolResult<Record<string, unknown>>;

/** before_agent_start event 후보입니다. */
export interface BeforeAgentStartEventLike {
	/** OMP runtime이 전달하는 system prompt 본문 또는 block 배열입니다. */
	systemPrompt?: string | readonly string[];
}

/** 변환된 system prompt 반환 payload입니다. */
export interface SystemPromptOverrideResult {
	/** provider 요청에 사용할 slim 처리된 system prompt입니다. */
	readonly systemPrompt: string;
}
