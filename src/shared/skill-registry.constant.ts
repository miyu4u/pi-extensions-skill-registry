/** 불용어 lookup 테이블입니다. */
export const STOP_WORDS: Record<string, true> = {
	a: true,
	an: true,
	and: true,
	as: true,
	at: true,
	are: true,
	be: true,
	been: true,
	become: true,
	by: true,
	for: true,
	from: true,
	if: true,
	in: true,
	into: true,
	is: true,
	it: true,
	its: true,
	of: true,
	or: true,
	so: true,
	such: true,
	than: true,
	that: true,
	the: true,
	this: true,
	to: true,
	through: true,
	under: true,
	using: true,
	use: true,
	via: true,
	was: true,
	were: true,
	we: true,
	with: true,
	without: true,
	you: true,
	your: true,
	they: true,
	their: true,
	them: true,
	there: true,
	when: true,
	where: true,
	who: true,
	which: true,
	why: true,
	how: true,
	also: true,
	have: true,
	has: true,
	had: true,
	will: true,
	would: true,
	should: true,
	could: true,
	must: true,
	can: true,
	may: true,
	might: true,
	"mustn't": true,
	not: true,
	no: true,
	yes: true,
};

/** 기본 skill 문서 파일명 후보입니다. */
export const DEFAULT_FILE_NAMES = ["SKILL.md", "skill.md", "Skill.md"];

/** 단어 토큰 분리를 위한 정규식입니다. */
export const NON_WORD_BOUNDARY_RE = /[\p{L}\p{N}_]+/gu;

/** skill-registry 설정 키입니다. */
export const SETTING_GROUP_KEY = "skillRegistry";

/** skill-registry 설정 파일명입니다. */
export const SKILL_REGISTRY_SETTINGS_FILE = "skill-registry.json";

/** OMP runtime settings root 후보를 위한 파일명입니다. */
export const SKILL_REGISTRY_SETTINGS_FILE_PATHS = [".pi/settings/skill-registry", ".pi/settings"] as const;

/** 범위별 기본 skill-root 후보를 정의합니다.
 * local: 현재 작업공간 기준 루트입니다.
 * global: 홈 디렉터리 기준 Agent 루트를 우선 탐색합니다.
 * managed: 관리형 skill 저장소 경로를 마지막에 보강합니다.
 */
export const DEFAULT_SCOPE_ROOTS = {
	"user-authored:local": ["$cwd"],
	"user-authored:global": ["$home"],
	"managed-skills": ["~/.omp/managed-skills"],
} as const;

/** scopeRoot 병합 우선순위를 정의합니다. */
export const DEFAULT_SCOPE_PRIORITY = ["user-authored:local", "user-authored:global", "managed-skills"] as const;

/** 정적 skill-registry 기본 설정입니다. database path는 runtime 환경에서 계산합니다. */
export const DEFAULT_SETTINGS = {
	roots: [
		".pi/skills",
		".omp/skills",
		".agents/skills",
		"~/.pi/agent/skills",
		"~/.omp/agent/skills",
		"~/.agents/skills",
		"~/.omp/managed-skills",
	],
	fileNames: DEFAULT_FILE_NAMES,
	presetSkills: [],
	cacheTtlMs: 60_000,
	maxTopK: 50,
	includePreviewBodyChars: 250,
};

/** skills block 시작 marker입니다. */
export const SKILL_BLOCK_START_MARKER = "<skills>";

/** skills block 종료 marker입니다. */
export const SKILL_BLOCK_END_MARKER = "</skills>";

/** URI miss 복구 후보의 기본 노출 개수입니다. */
export const SKILL_RESOLVE_SUGGESTION_DEFAULT_LIMIT = 3;

/** URI miss 복구 후보가 늘어날 수 있는 최대 개수입니다. */
export const SKILL_RESOLVE_SUGGESTION_HARD_CAP = 5;

/** 낮은 확신의 후보를 자동 복구 경로에서 제외하는 기준입니다. */
export const SKILL_RESOLVE_SUGGESTION_MIN_CONFIDENCE = 0.8;

/** 복구 결과가 provider payload를 키우지 않도록 허용하는 byte 상한입니다. */
export const SKILL_RESOLVE_RECOVERY_MAX_BYTES = 4096;

/** 복구 결과의 대략적인 token 상한입니다. */
export const SKILL_RESOLVE_RECOVERY_MAX_TOKENS = 1024;

/** skill-registry lookup 안내용 compact skills block입니다. */
export const SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK = [
	"<skills>",
	"- Skill catalog omitted from the system prompt to reduce prompt size.",
	'- When a task may need specialized knowledge, use `skill_registry` with `action:"discover"` first for compact auto-discovery.',
	"- Do not guess or directly read an unknown `skill://<name>` URI; use `discover` or `search`, then `resolve`, then read the returned canonical URI.",
	"- Unknown URI recovery is bounded: low-confidence or missing suggestions are safe-zero and must not expand to the full skill catalog.",
	'- Use `action:"search"` when you need broader ranking details, `action:"select"` when you need body content, `action:"resolve"` when you already know exact skill names, `action:"compose"` when related skills should be expanded together, `action:"graph"` when relation structure or ordering matters, `action:"pack"` when you need one bounded agent-ready bundle, `action:"gap"` when you need coverage or scaffold advice, `action:"explain"` when you need deterministic reasoning for why skills were chosen, `action:"decide"` when you need one first-read winner from several candidates, `action:"plan"` when you need a bounded follow-up read sequence, `action:"route"` when you need a layer-aware itinerary, `action:"brief"` when you need a compact body packet, `action:"bundle"` when you need an agent-ready preset bundle, `action:"handoff"` when you need a structured source/next-command packet, `action:"session-packet"` when you need a session-ready ordered packet, `action:"turn-packet"` when you need a turn-scoped execution packet, `action:"recovery-packet"` when you need only blocked-turn recovery guidance, `action:"resume-packet"` when you need recovery 이후 재개할 remaining turn sequence, `action:"current-turn-packet"` when you need 지금 바로 실행할 첫 turn 1개, `action:"instruction-packet"` when you need current turn을 prompt-ready 실행 지시문으로 직렬화, `action:"summary-packet"` when you need current turn 요약 문장, `action:"markdown-packet"` when you need current turn markdown 문서, `action:"checklist-packet"` when you need current turn checklist만 추출, `action:"commands-packet"` when you need current turn command만 추출, `action:"file-ready-packet"` when you need write-ready 파일 payload 묶음, `action:"apply-packet"` when you need write tool-ready apply payload, `action:"write-script-packet"` when you need runnable Bun write script payload, `action:"execution-packet"` when you need an execution packet, `action:"verification-packet"` when you need a verification checklist bundle, `action:"compare"` when you need side-by-side differences between skill candidates, `action:"recommend"` when you want the next related skills to read, `action:"audit"` when you need one corpus-health snapshot, and `action:"validate"` when corpus metadata or relations look suspicious.',
	"- After selecting, resolving, composing, graphing, packing, gap-checking, explaining, deciding, planning, routing, briefing, bundling, handing off, building a session packet, building a turn packet, building a recovery packet, building a resume packet, building a current turn packet, building an instruction packet, building a summary packet, building a markdown packet, building a checklist packet, building a commands packet, building a file-ready packet, building an apply packet, building a write script packet, building an execution packet, building a verification packet, comparing, recommending, auditing, or validating skills, read `skill://<name>` when you need the source content.",
	"</skills>",
].join("\n");
