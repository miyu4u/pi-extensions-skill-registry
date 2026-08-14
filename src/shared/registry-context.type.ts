/** skill-registry action 후보입니다. */
export type SkillRegistryAction =
  | 'discover'
  | 'index'
  | 'search'
  | 'select'
  | 'resolve'
  | 'compose'
  | 'pack'
  | 'graph'
  | 'gap'
  | 'explain'
  | 'decide'
  | 'plan'
  | 'route'
  | 'brief'
  | 'bundle'
  | 'handoff'
  | 'session-packet'
  | 'turn-packet'
  | 'recovery-packet'
  | 'resume-packet'
  | 'current-turn-packet'
  | 'instruction-packet'
  | 'summary-packet'
  | 'markdown-packet'
  | 'checklist-packet'
  | 'commands-packet'
  | 'file-ready-packet'
  | 'apply-packet'
  | 'write-script-packet'
  | 'execution-packet'
  | 'verification-packet'
  | 'compare'
  | 'recommend'
  | 'audit'
  | 'validate'
  | 'metrics'

/** relation compose 범위입니다. */
export type SkillRelationMode = 'required' | 'full'

/** relation graph 조회 모드입니다. */
export type SkillGraphMode = 'outbound' | 'inbound' | 'cycles' | 'orphans'

/** skill-registry 설정 shape입니다. */
export type SkillRegistrySettings = {
  roots?: string[]
  /**
   * 결과 스코프를 이름별로 매칭하기 위한 루트 목록입니다.
   * scope 루트는 후속 로더에서 경로 접두사 탐색 정책으로 사용됩니다.
   */
  scopeRoots?: Record<string, string[]>
  /**
   * 스코프 우선순위입니다.
   * 값이 앞에 있을수록 동일 스킬 충돌 시 해당 스코프가 먼저 적용됩니다.
   * 기본 우선순위: user-authored:local > user-authored:global > managed-skills.
   */
  scopePriority?: string[]
  fileNames?: string[]
  presetSkills?: string[]
  databasePath?: string
  cacheTtlMs?: number
  maxTopK?: number
  includePreviewBodyChars?: number
}

/** 작업 크기 기반 추천 폭 힌트입니다. */
export type SkillTaskSize = 'small' | 'medium' | 'large'

/** tool input payload입니다. */
export type ToolInput = {
  action: SkillRegistryAction
  query?: string
  names?: string[]
  /**
   * 스코프 필터 목록입니다.
   * 입력이 생략되면 설정(scopePriority/scopeRoots) 기반으로 전체 스코프를 사용합니다.
   * 입력이 비어 있으면 명시적 조회로 간주해 일치 스코프가 없어 safe-zero 처리됩니다.
   */
  scopes?: string[]
  suggestionLimit?: number
  roots?: string[]
  fileNames?: string[]
  limit?: number
  taskSize?: SkillTaskSize
  refresh?: boolean
  minScore?: number
  includeBody?: boolean
  includePreviewBodyChars?: number
  relationMode?: SkillRelationMode
  graphMode?: SkillGraphMode
  budgetChars?: number
  budgetTokens?: number
  coverageThreshold?: number
}

/** 정규화된 tool 실행 context입니다. */
export type ToolContext = {
  action: SkillRegistryAction
  query?: string
  names: string[]
  orderedNames: string[]
  /**
   * 정규화된 스코프 목록입니다.
   * 스코프가 생략되면 적용 가능한 스코프 전체를 사용하고,
   * 명시적으로 빈 값/미지정 스코프가 주어지면 빈 배열로 유지합니다.
   */
  scopes: string[]
  /**
   * ToolInput.scopes가 명시되었는지 여부입니다.
   * true면 생략이 아닌 요청 기반 필터링으로, 미일치 시 결과가 safe-zero가 될 수 있습니다.
   */
  scopesExplicit?: boolean
  suggestionLimit: number
  roots: string[]
  fileNames: string[]
  limit: number
  taskSize: SkillTaskSize
  refresh: boolean
  minScore: number
  includeBody: boolean
  relationMode: SkillRelationMode
  graphMode: SkillGraphMode
  budgetChars: number
  budgetTokens: number
  coverageThreshold: number
  settings: Required<SkillRegistrySettings>
}
