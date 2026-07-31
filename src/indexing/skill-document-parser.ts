import fs from 'node:fs'
import path from 'node:path'
import type { RawSkill, SkillFrontmatter, SkillFrontmatterRecord } from '../shared'
import { normalizeSkillName } from './skill-name-normalizer'

interface BuildRawSkillParams {
  canonicalName: string
  skillPath: string
  root: string
  parsed: SkillFrontmatterRecord
  frontmatter: SkillFrontmatter
  body: string
  stat: fs.Stats
}
/** Skill markdown와 frontmatter를 RawSkill 문서로 변환합니다. */
export class SkillDocumentParser {
  parseSkillFile(skillPath: string, root: string, issues: string[] = []): RawSkill | null {
    const raw = this.readRawFile(skillPath, issues)
    if (raw === null) return null

    const parsed = this.readFrontmatter(raw)
    const body = this.stripFrontmatter(raw).trim()
    const frontmatter = this.normalizeFrontmatter(parsed)
    const name = frontmatter.name || this.guessSkillName(skillPath)
    const canonicalName = normalizeSkillName(name)
    if (!canonicalName) {
      issues.push('missing canonical skill name')
      return null
    }

    const stat = this.statFile(skillPath, issues)
    if (stat === null) return null

    return this.buildRawSkill({
      canonicalName,
      skillPath,
      root,
      parsed,
      frontmatter,
      body,
      stat,
    })
  }

  private readFrontmatter(text: string): SkillFrontmatterRecord {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (!match) return {}
    return this.parseFrontmatterLines(match[1].split(/\r?\n/))
  }

  private parseFrontmatterLines(lines: string[]): SkillFrontmatterRecord {
    const records: SkillFrontmatterRecord = {}
    let pendingKey = '',
      pendingValues: string[] = []
    const flush = () => {
      if (pendingKey) records[pendingKey] = [...pendingValues]
      pendingKey = ''
      pendingValues = []
    }
    for (const line of lines) {
      const match = /^(?<key>[A-Za-z][A-Za-z0-9_-]*):(?:\s*(?<value>.*))?$/.exec(line)
      if (match?.groups) {
        flush()
        const key = match.groups.key.toLowerCase()
        const rawVal = (match.groups.value ?? '').trim()
        records[key] = rawVal
        if (!rawVal) pendingKey = key
        continue
      }
      if (!pendingKey) continue
      const listLine = /^\s*-\s*(?<value>.+?)\s*$/.exec(line)
      if (listLine?.groups?.value) {
        pendingValues.push(this.stripFrontmatterQuotes(listLine.groups.value))
      } else if (!/^\s+/.test(line) && line.trim()) {
        flush()
      }
    }
    flush()
    return records
  }

  private readRawFile(skillPath: string, issues: string[]): string | null {
    try {
      return fs.readFileSync(skillPath, 'utf-8')
    } catch (error) {
      issues.push(`read failed: ${error instanceof Error ? error.message : 'unknown read error'}`)
      return null
    }
  }

  private statFile(skillPath: string, issues: string[]): fs.Stats | null {
    try {
      return fs.statSync(skillPath)
    } catch (error) {
      issues.push(`stat failed: ${error instanceof Error ? error.message : 'unknown fs error'}`)
      return null
    }
  }

  private buildRelations(canonicalName: string, frontmatter: SkillFrontmatter) {
    const aliases = this.extractList(frontmatter.aliases).map(normalizeSkillName).filter(Boolean)
    const requires = this.extractList(frontmatter.requires).map(normalizeSkillName).filter(Boolean)
    const recommends = this.extractList(frontmatter.recommends).map(normalizeSkillName).filter(Boolean)
    const uniqueAliases = [...new Set(aliases)].filter((entry) => entry !== canonicalName)
    const uniqueRequires = [...new Set(requires)].filter((entry) => entry !== canonicalName)
    const uniqueRecommends = [...new Set(recommends)].filter((entry) => entry !== canonicalName && !uniqueRequires.includes(entry))
    return { uniqueAliases, uniqueRequires, uniqueRecommends }
  }

  private buildMetadata(frontmatter: SkillFrontmatter, body: string, canonicalName: string) {
    const title = this.headingTitle(body) || frontmatter.description || canonicalName
    const keywords = this.extractList(frontmatter.keywords).map((word) => this.normalizeKeyword(word))
    const tags = this.extractList(frontmatter.tags).map((word) => this.normalizeKeyword(word))
    return {
      title,
      category: frontmatter.category || 'uncategorized',
      keywords: [...new Set(keywords)],
      tags: [...new Set(tags)],
    }
  }

  private buildRawSkill(params: BuildRawSkillParams): RawSkill {
    const { canonicalName, skillPath, root, parsed, frontmatter, body, stat } = params
    const rel = this.buildRelations(canonicalName, frontmatter)
    const meta = this.buildMetadata(frontmatter, body, canonicalName)
    const { uniqueAliases: uA, uniqueRequires: uRq, uniqueRecommends: uRc } = rel
    return {
      id: canonicalName,
      canonicalName,
      path: path.resolve(skillPath),
      sourceRoot: root,
      rawFrontmatter: parsed,
      bodyText: body,
      title: meta.title,
      category: meta.category,
      keywords: meta.keywords,
      tags: meta.tags,
      aliases: uA,
      requires: uRq,
      recommends: uRc,
      text: '',
      mtimeMs: stat.mtimeMs,
      frontmatter: { ...frontmatter, name: canonicalName, aliases: uA, requires: uRq, recommends: uRc },
    }
  }

  private stripFrontmatter(text: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
    return match ? text.slice(match[0].length) : text
  }

  private normalizeFrontmatter(raw: SkillFrontmatterRecord): SkillFrontmatter {
    return {
      name: this.extractScalarValue(raw.name),
      description: this.extractScalarValue(raw.description ?? raw.summary),
      category: this.extractScalarValue(raw.category ?? raw.group ?? raw.type),
      keywords: this.extractList(raw.keywords),
      tags: this.extractList(raw.tags ?? raw.tag),
      aliases: this.extractList(raw.aliases ?? raw.alias),
      requires: this.extractList(raw.requires ?? raw.require ?? raw.depends_on),
      recommends: this.extractList(raw.recommends ?? raw.recommend ?? raw.related),
      version: this.extractScalarValue(raw.version ?? raw.skill_version),
    }
  }

  private extractList(value?: string | string[]): string[] {
    if (!value) {
      return []
    }
    return Array.isArray(value) ? value.map((entry) => entry.trim()).filter(Boolean) : this.parseCsv(value)
  }

  private parseCsv(value: string): string[] {
    const source = value.trim()
    if (!source) {
      return []
    }
    if (source.startsWith('[') && source.endsWith(']')) {
      return source
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim().replace(/^"|"$|^'|'$/g, ''))
        .filter(Boolean)
    }
    return source
      .split(/[,;\n]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  private extractScalarValue(value?: string | string[]): string {
    return Array.isArray(value) ? (value[0]?.trim() ?? '') : (value?.trim() ?? '')
  }

  private stripFrontmatterQuotes(value: string): string {
    return value.trim().replace(/^["'`]|["'`]$/g, '')
  }

  private normalizeKeyword(value: string): string {
    return value
      .toLowerCase()
      .replace(/^["'`]|["'`]$/g, '')
      .trim()
  }

  private guessSkillName(skillPath: string): string {
    return path.basename(path.dirname(skillPath))
  }

  private headingTitle(body: string): string {
    for (const line of body.split(/\r?\n/)) {
      const hit = /^(#+)\s*(.+)$/.exec(line.trim())
      if (hit) {
        return hit[2].trim().slice(0, 80)
      }
    }
    return ''
  }
}
