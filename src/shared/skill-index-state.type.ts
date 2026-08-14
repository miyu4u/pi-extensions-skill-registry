import type { SkillRegistrySettings } from './registry-context.type'
import type { DuplicateAliasEntry, DuplicateCanonicalEntry } from './skill-diagnostics.type'
import type { RawSkill } from './skill-document.type'

/** 인덱스 빌드 통계입니다. */
export type IndexedStats = {
  totalFilesVisited: number
  totalParsed: number
  skippedMissingRoot: number
  parseErrors: number
  deduplicated: number
  missingFromRequested: string[]
  malformedFiles: Array<{ path: string; reason: string }>
  duplicateCanonicalEntries: DuplicateCanonicalEntry[]
  duplicateAliasEntries: DuplicateAliasEntry[]
  nameFilterMode: 'targeted' | 'full'
}

/** 빌드 완료된 인덱스 산출물입니다. */
export type IndexArtifacts = {
  generatedAt: number
  ttlMs: number
  requestKey: string
  /**
   * Filesystem source freshness를 비교하는 deterministic signature입니다.
   */
  sourceSignature: string
  settings: Required<SkillRegistrySettings>
  requestedNames: string[]
  /**
   * 인덱스 조회 또는 갱신 시 전달된 스코프 목록입니다.
   * 요청별 메타데이터로 캐시 키 산정 보조에 활용됩니다.
   */
  requestedScopes?: string[]
  skills: RawSkill[]
  stats: IndexedStats
  docCount: number
  dfByTerm: Map<string, number>
  aliasToCanonical: Map<string, string>
  avgLength: number
  indexBuildMs: number
}
