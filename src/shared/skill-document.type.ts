/** raw frontmatter field 값 후보입니다. */
export type SkillFrontmatterValue = string | string[]

/** raw frontmatter record shape입니다. */
export type SkillFrontmatterRecord = Record<string, SkillFrontmatterValue>

/** skill frontmatter 정규화 결과입니다. */
export type SkillFrontmatter = {
  name: string
  description?: string
  category?: string
  keywords?: string[]
  tags?: string[]
  aliases?: string[]
  requires?: string[]
  recommends?: string[]
  version?: string
}

/** 파싱 완료된 skill 문서 모델입니다. */
export type RawSkill = {
  id: string
  canonicalName: string
  path: string
  /**
   * skill이 속한 스코프입니다.
   * scope 정보는 인덱싱 및 결과 메타데이터 전달 시 우선권 해석에 사용됩니다.
   */
  scope?: string
  sourceRoot: string
  rawFrontmatter: SkillFrontmatterRecord
  frontmatter: SkillFrontmatter
  bodyText: string
  title: string
  category: string
  keywords: string[]
  tags: string[]
  aliases: string[]
  requires: string[]
  recommends: string[]
  text: string
  mtimeMs: number
}
