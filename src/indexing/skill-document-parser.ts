import fs from "node:fs";
import path from "node:path";
import type { RawSkill, SkillFrontmatter, SkillFrontmatterRecord } from "../shared";
import { normalizeSkillName } from "./skill-name-normalizer";

/** Skill markdown와 frontmatter를 RawSkill 문서로 변환합니다. */
export class SkillDocumentParser {
	parseSkillFile(skillPath: string, root: string, issues: string[] = []): RawSkill | null {
		let raw: string;
		try {
			raw = fs.readFileSync(skillPath, "utf-8");
		} catch (error) {
			issues.push(`read failed: ${error instanceof Error ? error.message : "unknown read error"}`);
			return null;
		}

		const parsed = this.readFrontmatter(raw);
		const body = this.stripFrontmatter(raw).trim();
		const frontmatter = this.normalizeFrontmatter(parsed);
		const name = frontmatter.name || this.guessSkillName(skillPath);
		const canonicalName = normalizeSkillName(name);
		if (!canonicalName) {
			issues.push("missing canonical skill name");
			return null;
		}

		const title = this.headingTitle(body) || frontmatter.description || canonicalName;
		const keywords = this.extractList(frontmatter.keywords).map((word) => this.normalizeKeyword(word));
		const tags = this.extractList(frontmatter.tags).map((word) => this.normalizeKeyword(word));
		const aliases = this.extractList(frontmatter.aliases).map(normalizeSkillName).filter(Boolean);
		const requires = this.extractList(frontmatter.requires).map(normalizeSkillName).filter(Boolean);
		const recommends = this.extractList(frontmatter.recommends).map(normalizeSkillName).filter(Boolean);
		const category = frontmatter.category || "uncategorized";

		let stat: fs.Stats;
		try {
			stat = fs.statSync(skillPath);
		} catch (error) {
			issues.push(`stat failed: ${error instanceof Error ? error.message : "unknown fs error"}`);
			return null;
		}

		const uniqueAliases = [...new Set(aliases)].filter((entry) => entry !== canonicalName);
		const uniqueRequires = [...new Set(requires)].filter((entry) => entry !== canonicalName);
		const uniqueRecommends = [...new Set(recommends)].filter(
			(entry) => entry !== canonicalName && !uniqueRequires.includes(entry),
		);
		return {
			id: canonicalName,
			canonicalName,
			path: path.resolve(skillPath),
			sourceRoot: root,
			rawFrontmatter: parsed,
			frontmatter: {
				...frontmatter,
				name: canonicalName,
				aliases: uniqueAliases,
				requires: uniqueRequires,
				recommends: uniqueRecommends,
			},
			bodyText: body,
			title,
			category,
			keywords: [...new Set(keywords)],
			tags: [...new Set(tags)],
			aliases: uniqueAliases,
			requires: uniqueRequires,
			recommends: uniqueRecommends,
			text: "",
			mtimeMs: stat.mtimeMs,
		};
	}

	private readFrontmatter(text: string): SkillFrontmatterRecord {
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) {
			return {};
		}
		const records: SkillFrontmatterRecord = {};
		let pendingListKey = "";
		let pendingListValues: string[] = [];
		const flushPendingList = (): void => {
			if (!pendingListKey) {
				return;
			}
			records[pendingListKey] = [...pendingListValues];
			pendingListKey = "";
			pendingListValues = [];
		};
		for (const line of match[1].split(/\r?\n/)) {
			const matchLine = /^(?<key>[A-Za-z][A-Za-z0-9_-]*):(?:\s*(?<value>.*))?$/.exec(line);
			if (matchLine?.groups) {
				flushPendingList();
				const key = matchLine.groups.key.toLowerCase();
				const rawValue = (matchLine.groups.value ?? "").trim();
				if (!rawValue) {
					pendingListKey = key;
					pendingListValues = [];
					records[key] = "";
					continue;
				}
				records[key] = rawValue;
				continue;
			}
			if (!pendingListKey) {
				continue;
			}
			const listLine = /^\s*-\s*(?<value>.+?)\s*$/.exec(line);
			if (listLine?.groups?.value) {
				pendingListValues.push(this.stripFrontmatterQuotes(listLine.groups.value));
				continue;
			}
			if (/^\s+/.test(line) || !line.trim()) {
				continue;
			}
			flushPendingList();
		}
		flushPendingList();
		return records;
	}

	private stripFrontmatter(text: string): string {
		const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
		return match ? text.slice(match[0].length) : text;
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
		};
	}

	private extractList(value?: string | string[]): string[] {
		if (!value) {
			return [];
		}
		return Array.isArray(value) ? value.map((entry) => entry.trim()).filter(Boolean) : this.parseCsv(value);
	}

	private parseCsv(value: string): string[] {
		const source = value.trim();
		if (!source) {
			return [];
		}
		if (source.startsWith("[") && source.endsWith("]")) {
			return source
				.slice(1, -1)
				.split(",")
				.map((entry) => entry.trim().replace(/^"|"$|^'|'$/g, ""))
				.filter(Boolean);
		}
		return source
			.split(/[,;\n]+/g)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	private extractScalarValue(value?: string | string[]): string {
		return Array.isArray(value) ? (value[0]?.trim() ?? "") : (value?.trim() ?? "");
	}

	private stripFrontmatterQuotes(value: string): string {
		return value.trim().replace(/^["'`]|["'`]$/g, "");
	}

	private normalizeKeyword(value: string): string {
		return value
			.toLowerCase()
			.replace(/^["'`]|["'`]$/g, "")
			.trim();
	}

	private guessSkillName(skillPath: string): string {
		return path.basename(path.dirname(skillPath));
	}

	private headingTitle(body: string): string {
		for (const line of body.split(/\r?\n/)) {
			const hit = /^(#+)\s*(.+)$/.exec(line.trim());
			if (hit) {
				return hit[2].trim().slice(0, 80);
			}
		}
		return "";
	}
}
