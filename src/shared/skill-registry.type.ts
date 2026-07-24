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
	/**
	 * 결과 스코프를 이름별로 매칭하기 위한 루트 목록입니다.
	 * scope 루트는 후속 로더에서 경로 접두사 탐색 정책으로 사용됩니다.
	 */
	scopeRoots?: Record<string, string[]>;
	/**
	 * 스코프 우선순위입니다.
	 * 값이 앞에 있을수록 동일 스킬 충돌 시 해당 스코프가 먼저 적용됩니다.
	 * 기본 우선순위: user-authored:local > user-authored:global > managed-skills.
	 */
	scopePriority?: string[];
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
	/**
	 * 스코프 필터 목록입니다.
	 * 입력이 생략되면 설정(scopePriority/scopeRoots) 기반으로 전체 스코프를 사용합니다.
	 * 입력이 비어 있으면 명시적 조회로 간주해 일치 스코프가 없어 safe-zero 처리됩니다.
	 */
	scopes?: string[];
	suggestionLimit?: number;
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
	/**
	 * 정규화된 스코프 목록입니다.
	 * 스코프가 생략되면 적용 가능한 스코프 전체를 사용하고,
	 * 명시적으로 빈 값/미지정 스코프가 주어지면 빈 배열로 유지합니다.
	 */
	scopes: string[];
	/**
	 * ToolInput.scopes가 명시되었는지 여부입니다.
	 * true면 생략이 아닌 요청 기반 필터링으로, 미일치 시 결과가 safe-zero가 될 수 있습니다.
	 */
	scopesExplicit?: boolean;
	suggestionLimit: number;
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
	/**
	 * skill이 속한 스코프입니다.
	 * scope 정보는 인덱싱 및 결과 메타데이터 전달 시 우선권 해석에 사용됩니다.
	 */
	scope?: string;
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
	/**
	 * graph에서 사용되는 스코프 태그입니다.
	 * 동일 경로 후보가 여러 스코프에 걸칠 때 우선순위 표시용 메타데이터입니다.
	 */
	scope?: string;
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
	/**
	 * resolve 결과 스코프 태그입니다.
	 * 스코프가 없으면 legacy 호환 모드로 간주합니다.
	 */
	scope?: string;
	aliases: string[];
	requires: string[];
	recommends: string[];
	preview: string;
	body?: string;
	omittedByBudget: boolean;
};

/** exact resolve 실패 시 검토할 수 있는 bounded 후보입니다. */
export type SkillResolveSuggestion = {
	name: string;
	readPath: string;
	confidence: number;
};

/** resolve 결과 payload입니다. */
export type SkillResolveResult = {
	resolved: SkillResolveEntry[];
	missing: string[];
	suggestions: SkillResolveSuggestion[];
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
	/**
	 * gap 후보의 스코프입니다.
	 * 후보 스코프를 추적해 동일 스킬 이름의 충돌을 완화합니다.
	 */
	scope?: string;
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
	/**
	 * explain 결과에서 선택된 스코프 태그입니다.
	 * 레이어/경로 기반 후보 선별의 부수 메타데이터입니다.
	 */
	scope?: string;
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
	/**
	 * decide 후보 스코프입니다.
	 * winner 계산 시 충돌 시 가중치 보정에 활용될 수 있습니다.
	 */
	scope?: string;
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
	/**
	 * plan 단계에서 실제 탐색한 스코프입니다.
	 * 비어 있으면 요청 컨텍스트에서의 암묵적 기본 스코프로 처리합니다.
	 */
	scope?: string;
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
	/**
	 * brief 출력에서 포함된 스코프입니다.
	 * 동일 name 충돌 시 스코프 기준 병합/필터에 사용됩니다.
	 */
	scope?: string;
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
	/**
	 * handoff source의 카테고리 메타데이터입니다.
	 * winner 후보를 경로 추적할 때 중복 후보 해소에 사용합니다.
	 */
	sourceCategory?: string;
	/**
	 * handoff source의 스코프 메타데이터입니다.
	 * 동일 이름 충돌/권한 분리 정책을 재현하기 위한 provenance입니다.
	 */
	sourceScope?: string;
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
	/**
	 * step 기반 source의 스코프 메타데이터입니다.
	 * 같은 경로 후보가 다중 소스에서 유입되더라도 재구성 가능하게 합니다.
	 */
	sourceScope?: string;
	/**
	 * step 기반 category 메타데이터입니다.
	 */
	sourceCategory?: string;
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
	/**
	 * sourcePaths 항목 단위 스코프 정렬입니다.
	 * sourcePaths와 동일 순서로 정렬되어야 합니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * sourcePaths 항목 단위 category 정렬입니다.
	 * sourcePaths와 동일 순서로 정렬되어야 합니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * turn sourcePaths의 스코프 정렬입니다.
	 * phase 단위로 정렬되어 sourcePaths와 정합이 필요합니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * turn sourcePaths의 category 정렬입니다.
	 * phase 단위로 정렬되어 sourcePaths와 정합이 필요합니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * 모든 turn.sourcePaths를 phase 순으로 펼친 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * 모든 turn.sourcePaths를 phase 순으로 펼친 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * recovery turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * recovery turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * blocked turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * blocked turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * resume 대상 turns의 sourcePaths 정렬 스코프입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * resume 대상 turns의 sourcePaths 정렬 category입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * 현재 turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * 현재 turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * current-turn sourcePaths의 스코프 정렬입니다.
	 */
	sourcePathScopes?: Array<string | undefined>;
	/**
	 * current-turn sourcePaths의 category 정렬입니다.
	 */
	sourcePathCategories?: string[];
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
	/**
	 * compare 항목의 스코프 라벨입니다.
	 * 서로 다른 스코프 간 카테고리/별칭 비교를 위해 보관합니다.
	 */
	scope?: string;
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
	/**
	 * recommend 후보 스코프입니다.
	 * 추천 후보의 출처 추적에 사용됩니다.
	 */
	scope?: string;
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
	/**
	 * pack 결과에서 전달되는 스코프 태그입니다.
	 * 동일 canonical에 대한 스코프 충돌 해소 힌트로 사용합니다.
	 */
	scope?: string;
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
	/**
	 * Filesystem source freshness를 비교하는 deterministic signature입니다.
	 */
	sourceSignature: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	/**
	 * 인덱스 조회 또는 갱신 시 전달된 스코프 목록입니다.
	 * 요청별 메타데이터로 캐시 키 산정 보조에 활용됩니다.
	 */
	requestedScopes?: string[];
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
