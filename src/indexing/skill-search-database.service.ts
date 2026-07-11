import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { IndexedStats, RawSkill, SkillFrontmatter, SkillFrontmatterRecord, SkillRegistrySettings } from "../shared";
import type {
	SkillSearchDatabaseInterface,
	SkillSearchDatabaseMatch,
	SkillSearchDocument,
	SkillSearchSnapshot,
	SkillSearchSnapshotInput,
} from "./skill-search-database.interface";

const SKILL_REGISTRY_APPLICATION_ID = 1397445191;
const SKILL_REGISTRY_USER_VERSION = 1;
const DEFAULT_POSIX_DIR_MODE = 0o700;
const DEFAULT_POSIX_FILE_MODE = 0o600;

interface SqliteStatement {
	run: (...params: unknown[]) => void;
	all: <T = Record<string, unknown>>(...params: unknown[]) => T[];
	get: <T = Record<string, unknown>>(...params: unknown[]) => T | null;
}

interface SqliteSyncConnection {
	exec: (sql: string) => void;
	prepare: (sql: string) => SqliteStatement;
	close: () => void;
}

interface CacheMetadataRow {
	snapshot_token: string;
	request_key: string;
	generated_at: number;
	ttl_ms: number;
	settings_json: string;
	requested_names_json: string;
	stats_json: string;
	index_build_ms: number;
}

interface SkillRow {
	skill_id: string;
	canonical_name: string;
	path: string;
	source_root: string;
	raw_frontmatter_json: string;
	frontmatter_json: string;
	body_text: string;
	title: string;
	category: string;
	keywords_json: string;
	tags_json: string;
	aliases_json: string;
	requires_json: string;
	recommends_json: string;
	text: string;
	mtime_ms: number;
}

interface DfRow {
	term: string;
	document_count: number;
}

interface CountRow {
	value: number;
}

const SCHEMA_SQL = `
CREATE TABLE cache_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_token TEXT NOT NULL,
  request_key TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  requested_names_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  index_build_ms INTEGER NOT NULL
);

CREATE TABLE skills (
  ordinal INTEGER NOT NULL UNIQUE,
  skill_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  source_root TEXT NOT NULL,
  raw_frontmatter_json TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  body_text TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  requires_json TEXT NOT NULL,
  recommends_json TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime_ms REAL NOT NULL
);

CREATE VIRTUAL TABLE skill_fts USING fts5(
  skill_id UNINDEXED,
  canonical_name,
  aliases,
  title,
  description,
  category,
  keywords,
  tags,
  body_text,
  tokenize = 'unicode61 tokenchars _'
);

CREATE VIRTUAL TABLE skill_fts_vocab USING fts5vocab(skill_fts, 'instance');
`;

const SEARCH_SQL =
	"SELECT skill_id,\n	       bm25(skill_fts, 0.0, 3.0, 2.6, 2.2, 2.0, 1.4, 1.2, 1.1, 1.0) AS bm25_rank\n	FROM skill_fts\n	WHERE skill_fts MATCH ?\n	ORDER BY bm25_rank ASC, skill_id ASC;";

/**
 * SQLite 기반 skill 검색 인덱스 영속성 계층입니다.
 */
export class SkillSearchDatabaseService implements SkillSearchDatabaseInterface {
	private db: SqliteSyncConnection | null = null;
	private resolvedPath: string | null = null;

	public async initialize(databasePath: string): Promise<void> {
		const resolvedPath = path.resolve(databasePath);
		const previouslyExisted = fs.existsSync(resolvedPath);
		const createdByThisCall = !previouslyExisted;

		if (this.resolvedPath === resolvedPath && this.db !== null) {
			return;
		}

		if (this.resolvedPath !== resolvedPath) {
			this.close();
		}

		try {
			if (!previouslyExisted) {
				const parent = path.dirname(resolvedPath);
				if (process.platform !== "win32") {
					fs.mkdirSync(parent, { recursive: true, mode: DEFAULT_POSIX_DIR_MODE });
				} else {
					fs.mkdirSync(parent, { recursive: true });
				}
			}

			const openDatabase = await this.loadSqliteDriver();
			const database = openDatabase(resolvedPath);
			this.db = database;
			this.resolvedPath = resolvedPath;

			const applicationId = this.getNumericPragma("application_id");
			const userVersion = this.getNumericPragma("user_version");

			if (previouslyExisted && applicationId !== SKILL_REGISTRY_APPLICATION_ID) {
				throw this.notOwnedDatabaseError(resolvedPath);
			}

			if (process.platform !== "win32") {
				fs.chmodSync(path.dirname(resolvedPath), DEFAULT_POSIX_DIR_MODE);
			}

			this.executePragma("PRAGMA foreign_keys = ON");
			this.executePragma("PRAGMA journal_mode = DELETE");
			this.executePragma("PRAGMA synchronous = NORMAL");
			this.executePragma("PRAGMA busy_timeout = 5000");
			this.executePragma("PRAGMA temp_store = MEMORY");

			if (!previouslyExisted || userVersion !== SKILL_REGISTRY_USER_VERSION) {
				this.recreateOwnedSchema();
			}

			this.setDatabasePragmas();
			if (process.platform !== "win32") {
				fs.chmodSync(resolvedPath, DEFAULT_POSIX_FILE_MODE);
			}
		} catch (error) {
			this.close();

			if (createdByThisCall && fs.existsSync(resolvedPath)) {
				try {
					fs.unlinkSync(resolvedPath);
				} catch {
					// best effort cleanup
				}
			}

			if (error instanceof Error && /no such module:\s*fts5/i.test(error.message)) {
				throw new Error("SQLite FTS5 is unavailable in this runtime", { cause: error });
			}
			if (error instanceof Error && /databasePath is not a skill-registry cache database:/.test(error.message)) {
				throw error;
			}

			if (error instanceof Error) {
				throw new Error(`failed to initialize sqlite database at ${resolvedPath}`, {
					cause: error,
				});
			}

			throw error;
		}
	}

	public readSnapshot(requestKey: string, now: number): SkillSearchSnapshot | null {
		if (!this.db) {
			return null;
		}

		let decodeFailure = false;
		let snapshot: SkillSearchSnapshot | null = null;

		this.runReadTransaction(() => {
			const metadata = this.getMetadataRow();
			if (!metadata) {
				return;
			}

			const parsed = this.parseMetadataRow(metadata);
			if (!parsed) {
				decodeFailure = true;
				return;
			}

			if (parsed.requestKey !== requestKey) {
				return;
			}

			if (now - parsed.generatedAt >= parsed.ttlMs) {
				return;
			}

			const skillRows = this.getAll<SkillRow>(
				`SELECT ordinal, skill_id, canonical_name, path, source_root, raw_frontmatter_json, frontmatter_json, body_text, title, category, keywords_json, tags_json, aliases_json, requires_json, recommends_json, text, mtime_ms
				 FROM skills
				 ORDER BY ordinal ASC;`,
			);

			const skills = [] as RawSkill[];
			for (const row of skillRows) {
				const skill = this.parseSkillRow(row);
				if (!skill) {
					decodeFailure = true;
					return;
				}
				skills.push(skill);
			}

			const { dfByTerm, avgLength } = this.readDfAndLength();
			if (!dfByTerm || !Number.isFinite(avgLength) || avgLength < 0) {
				decodeFailure = true;
				return;
			}

			snapshot = {
				snapshotToken: parsed.snapshotToken,
				generatedAt: parsed.generatedAt,
				ttlMs: parsed.ttlMs,
				requestKey: parsed.requestKey,
				settings: parsed.settings,
				requestedNames: parsed.requestedNames,
				skills,
				stats: parsed.stats,
				dfByTerm,
				avgLength,
				indexBuildMs: parsed.indexBuildMs,
			};
		});

		if (decodeFailure) {
			this.clearSnapshotTables();
		}

		return snapshot;
	}

	public isSnapshotCurrent(snapshotToken: string): boolean {
		if (!this.db) {
			return false;
		}

		const metadata = this.getMetadataRow();
		return metadata?.snapshot_token === snapshotToken;
	}

	public replaceSnapshot(input: SkillSearchSnapshotInput, documents: SkillSearchDocument[]): SkillSearchSnapshot {
		if (!this.db) {
			throw new Error("skill search database is not initialized");
		}

		const snapshotToken = randomUUID();
		const documentBySkillId = new Map(documents.map((document) => [document.skillId, document] as const));
		if (documentBySkillId.size !== documents.length || input.skills.length !== documents.length) {
			throw new Error("skill search snapshot requires exactly one document per skill");
		}
		const orderedSkills = input.skills.map((skill) => {
			const document = documentBySkillId.get(skill.id);
			if (!document) {
				throw new Error(`missing skill search document for ${skill.id}`);
			}
			return { document, skill };
		});
		let dfByTerm = new Map<string, number>();
		let avgLength = 0;
		let indexBuildMs = 0;

		this.runWriteTransaction(() => {
			this.executeNonQuery(`DELETE FROM cache_metadata;`);
			this.executeNonQuery(`DELETE FROM skills;`);
			this.executeNonQuery(`DELETE FROM skill_fts;`);

			this.executeNonQuery(
				`INSERT INTO cache_metadata
				 (id, snapshot_token, request_key, generated_at, ttl_ms, settings_json, requested_names_json, stats_json, index_build_ms)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
				snapshotToken,
				input.requestKey,
				input.generatedAt,
				input.ttlMs,
				JSON.stringify(input.settings),
				JSON.stringify(input.requestedNames),
				JSON.stringify(input.stats),
				0,
			);

			const insertSkill = this.prepareNonQuery(`
				INSERT INTO skills
				(ordinal, skill_id, canonical_name, path, source_root, raw_frontmatter_json, frontmatter_json, body_text, title, category, keywords_json, tags_json, aliases_json, requires_json, recommends_json, text, mtime_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);

			const insertFts = this.prepareNonQuery(`
				INSERT INTO skill_fts
				(skill_id, canonical_name, aliases, title, description, category, keywords, tags, body_text)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);

			orderedSkills.forEach((entry, index) => {
				const { skill, document } = entry;
				insertSkill.run(
					index,
					skill.id,
					skill.canonicalName,
					skill.path,
					skill.sourceRoot,
					JSON.stringify(skill.rawFrontmatter),
					JSON.stringify(skill.frontmatter),
					skill.bodyText,
					skill.title,
					skill.category,
					JSON.stringify(skill.keywords),
					JSON.stringify(skill.tags),
					JSON.stringify(skill.aliases),
					JSON.stringify(skill.requires),
					JSON.stringify(skill.recommends),
					skill.text,
					skill.mtimeMs,
				);

				insertFts.run(
					skill.id,
					document.canonicalName,
					document.aliases,
					document.title,
					document.description,
					document.category,
					document.keywords,
					document.tags,
					document.bodyText,
				);
			});

			const metrics = this.readDfAndLength();
			dfByTerm = metrics.dfByTerm;
			avgLength = metrics.avgLength;
			indexBuildMs = Math.max(0, Date.now() - input.buildStartedAt);
			this.executeNonQuery("UPDATE cache_metadata SET index_build_ms = ? WHERE id = 1;", indexBuildMs);
		});

		return {
			snapshotToken,
			generatedAt: input.generatedAt,
			ttlMs: input.ttlMs,
			requestKey: input.requestKey,
			settings: input.settings,
			requestedNames: input.requestedNames,
			skills: orderedSkills.map(({ skill }) => skill),
			stats: input.stats,
			dfByTerm,
			avgLength,
			indexBuildMs,
		};
	}

	public searchTerms(snapshotToken: string, terms: readonly string[]): ReadonlyMap<string, SkillSearchDatabaseMatch[]> {
		if (terms.length === 0) {
			return new Map();
		}
		if (!this.db) {
			throw new Error("skill search database is not initialized");
		}

		const deduplicated = Array.from(new Set(terms));
		const matchesByTerm = new Map<string, SkillSearchDatabaseMatch[]>();

		this.runReadTransaction(() => {
			const currentToken = this.getMetadataRow()?.snapshot_token;
			if (currentToken !== snapshotToken) {
				throw new Error("SQLite skill index snapshot changed; call loadIndex() before searching");
			}

			for (const term of deduplicated) {
				const escaped = this.escapeMatchTerm(term);
				const rows = this.getAll<{ skill_id: string; bm25_rank: number }>(SEARCH_SQL, escaped);
				const matches = rows.map((row) => ({
					skillId: `${row.skill_id}`,
					bm25Rank: Number(row.bm25_rank),
				}));
				matchesByTerm.set(term, matches);
			}
		});

		return matchesByTerm;
	}

	public close(): void {
		if (!this.db) {
			return;
		}

		const db = this.db;
		this.db = null;
		this.resolvedPath = null;
		try {
			db.close();
		} catch {
			// best-effort close
		}
	}

	private async loadSqliteDriver(): Promise<(path: string) => SqliteSyncConnection> {
		// Runtime-selected because bun:sqlite does not exist under Node and node:sqlite does not exist under Bun.
		if (typeof Bun !== "undefined") {
			const bunSqlite = await import("bun:sqlite");
			const Database = (bunSqlite as unknown as { Database: new (path: string) => SqliteSyncConnection }).Database;
			return (filename) => new Database(filename);
		}

		// Jest cannot resolve the node:sqlite specifier through dynamic import, so Node loads its own builtin via createRequire.
		const nodeSqlite = createRequire(import.meta.url)("node:sqlite");
		const DatabaseSync = (nodeSqlite as unknown as { DatabaseSync: new (path: string) => SqliteSyncConnection }).DatabaseSync;
		return (filename) => new DatabaseSync(filename);
	}

	private recreateOwnedSchema(): void {
		this.runWriteTransaction(() => {
			this.executeNonQuery("DROP TABLE IF EXISTS skill_fts_vocab;");
			this.executeNonQuery("DROP TABLE IF EXISTS skill_fts;");
			this.executeNonQuery("DROP TABLE IF EXISTS cache_metadata;");
			this.executeNonQuery("DROP TABLE IF EXISTS skills;");
			this.executeScript(SCHEMA_SQL);
			this.executePragma(`PRAGMA application_id = ${SKILL_REGISTRY_APPLICATION_ID}`);
			this.executePragma(`PRAGMA user_version = ${SKILL_REGISTRY_USER_VERSION}`);
		});
	}

	private clearSnapshotTables(): void {
		this.runWriteTransaction(() => {
			this.executeNonQuery("DELETE FROM skill_fts;");
			this.executeNonQuery("DELETE FROM skills;");
			this.executeNonQuery("DELETE FROM cache_metadata;");
		});
	}

	private setDatabasePragmas(): void {
		this.executePragma(`PRAGMA application_id = ${SKILL_REGISTRY_APPLICATION_ID}`);
		this.executePragma(`PRAGMA user_version = ${SKILL_REGISTRY_USER_VERSION}`);
	}

	private getNumericPragma(name: string): number {
		const row = this.getOne<Record<string, unknown>>(`PRAGMA ${name};`);
		if (!row) {
			return Number.NaN;
		}
		const value = row[name] ?? (row as Record<"value", unknown>).value;
		return this.toFiniteNumber(value);
	}

	private getMetadataRow(): CacheMetadataRow | null {
		return this.getOne<CacheMetadataRow>(
			"SELECT id, snapshot_token, request_key, generated_at, ttl_ms, settings_json, requested_names_json, stats_json, index_build_ms FROM cache_metadata WHERE id = 1;",
		);
	}

	private parseMetadataRow(row: CacheMetadataRow): {
		snapshotToken: string;
		generatedAt: number;
		ttlMs: number;
		requestKey: string;
		settings: Required<SkillRegistrySettings>;
		requestedNames: string[];
		stats: IndexedStats;
		indexBuildMs: number;
	} | null {
		const generatedAt = this.toFiniteNumber(row.generated_at);
		const ttlMs = this.toFiniteNumber(row.ttl_ms);
		const settings = this.parseJson<Required<SkillRegistrySettings>>(row.settings_json);
		const requestedNames = this.parseJson<string[]>(row.requested_names_json);
		const stats = this.parseJson<IndexedStats>(row.stats_json);
		const indexBuildMs = this.toFiniteNumber(row.index_build_ms);
		if (!row.snapshot_token || !row.request_key) {
			return null;
		}
		if (!settings || !Array.isArray(requestedNames) || !stats || !Number.isFinite(generatedAt) || !Number.isFinite(ttlMs)) {
			return null;
		}
		if (!Number.isFinite(indexBuildMs)) {
			return null;
		}

		return {
			snapshotToken: row.snapshot_token,
			generatedAt,
			ttlMs,
			requestKey: row.request_key,
			settings,
			requestedNames,
			stats,
			indexBuildMs,
		};
	}

	private parseSkillRow(row: SkillRow): RawSkill | null {
		if (!row.skill_id || !row.canonical_name || !row.path || !row.source_root) {
			return null;
		}

		const rawFrontmatter = this.parseJson<SkillFrontmatterRecord>(row.raw_frontmatter_json);
		const frontmatter = this.parseJson<SkillFrontmatter>(row.frontmatter_json);
		const keywords = this.parseJson<string[]>(row.keywords_json);
		const tags = this.parseJson<string[]>(row.tags_json);
		const aliases = this.parseJson<string[]>(row.aliases_json);
		const requires = this.parseJson<string[]>(row.requires_json);
		const recommends = this.parseJson<string[]>(row.recommends_json);
		const mtimeMs = this.toFiniteNumber(row.mtime_ms);

		if (!rawFrontmatter || !frontmatter || !keywords || !tags || !aliases || !requires || !recommends || !Number.isFinite(mtimeMs)) {
			return null;
		}

		return {
			id: row.skill_id,
			canonicalName: row.canonical_name,
			path: row.path,
			sourceRoot: row.source_root,
			rawFrontmatter,
			frontmatter: {
				...frontmatter,
				name: row.canonical_name,
				description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
				category: typeof frontmatter.category === "string" ? frontmatter.category : undefined,
				keywords: keywords,
				tags: tags,
				aliases: aliases,
				requires: requires,
				recommends: recommends,
				version: typeof frontmatter.version === "string" ? frontmatter.version : undefined,
			},
			bodyText: row.body_text,
			title: row.title,
			category: row.category,
			keywords,
			tags,
			aliases,
			requires,
			recommends,
			text: row.text,
			mtimeMs,
		};
	}

	private readDfAndLength(): { dfByTerm: Map<string, number>; avgLength: number } {
		const dfRows = this.getAll<DfRow>(
			"SELECT term, COUNT(DISTINCT doc) AS document_count FROM skill_fts_vocab GROUP BY term ORDER BY term ASC;",
		);
		const dfByTerm = new Map<string, number>();
		for (const row of dfRows) {
			const term = `${row.term ?? ""}`;
			const count = this.toFiniteNumber(row.document_count);
			if (term.length > 0 && Number.isFinite(count)) {
				dfByTerm.set(term, count);
			}
		}

		const totalInstances = this.getOne<CountRow>("SELECT COUNT(*) AS value FROM skill_fts_vocab;");
		const totalSkills = this.getOne<CountRow>("SELECT COUNT(*) AS value FROM skills;");
		const totalInstanceCount = this.toFiniteNumber(totalInstances?.value);
		const totalSkillCount = this.toFiniteNumber(totalSkills?.value);
		const avgLength = totalSkillCount > 0 ? totalInstanceCount / totalSkillCount : 0;

		return { dfByTerm, avgLength };
	}

	private escapeMatchTerm(term: string): string {
		return `"${term.replaceAll('"', '""')}"`;
	}

	private executePragma(sql: string): void {
		this.executeNonQuery(sql);
	}

	private executeScript(sql: string): void {
		if (!this.db) {
			throw new Error("sqlite database is not initialized");
		}
		this.db.exec(sql);
	}

	private runReadTransaction<T>(operation: () => T): T {
		this.executeNonQuery("BEGIN;");
		try {
			const result = operation();
			this.executeNonQuery("COMMIT;");
			return result;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}

	private runWriteTransaction<T>(operation: () => T): T {
		this.executeNonQuery("BEGIN IMMEDIATE;");
		try {
			const result = operation();
			this.executeNonQuery("COMMIT;");
			return result;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}

	private rollback(): void {
		try {
			this.executeNonQuery("ROLLBACK;");
		} catch {
			// ignore failed rollback states
		}
	}

	private executeNonQuery(sql: string, ...params: unknown[]): void {
		if (!this.db) {
			throw new Error("sqlite database is not initialized");
		}
		this.db.prepare(sql).run(...params);
	}

	private getAll<T>(sql: string, ...params: unknown[]): T[] {
		if (!this.db) {
			return [];
		}
		return this.db.prepare(sql).all<T>(...params);
	}

	private getOne<T>(sql: string, ...params: unknown[]): T | null {
		if (!this.db) {
			return null;
		}
		return this.db.prepare(sql).get<T>(...params);
	}

	private prepareNonQuery(sql: string): SqliteStatement {
		if (!this.db) {
			throw new Error("sqlite database is not initialized");
		}
		return this.db.prepare(sql);
	}

	private parseJson<T>(value: string): T | null {
		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}

	private toFiniteNumber(value: unknown): number {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		const cast = Number(value);
		if (Number.isFinite(cast)) {
			return cast;
		}
		return Number.NaN;
	}

	private notOwnedDatabaseError(resolvedPath: string): Error {
		return new Error(`databasePath is not a skill-registry cache database: ${resolvedPath}`);
	}
}
