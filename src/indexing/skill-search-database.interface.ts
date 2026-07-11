import type { IndexedStats, RawSkill, SkillRegistrySettings } from "../shared";

/** SQLite FTS5에 삽입할 정규화된 검색 문서입니다. */
export type SkillSearchDocument = {
	skillId: string;
	canonicalName: string;
	aliases: string;
	title: string;
	description: string;
	category: string;
	keywords: string;
	tags: string;
	bodyText: string;
};

/** SQLite snapshot 교체 입력입니다. */
export type SkillSearchSnapshotInput = {
	generatedAt: number;
	ttlMs: number;
	requestKey: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	skills: RawSkill[];
	stats: IndexedStats;
	buildStartedAt: number;
};

/** SQLite에서 복원한 skill index snapshot입니다. */
export type SkillSearchSnapshot = {
	snapshotToken: string;
	generatedAt: number;
	ttlMs: number;
	requestKey: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	skills: RawSkill[];
	stats: IndexedStats;
	dfByTerm: Map<string, number>;
	avgLength: number;
	indexBuildMs: number;
};

/** 단일 FTS5 term에 대한 BM25 match입니다. */
export type SkillSearchDatabaseMatch = {
	skillId: string;
	bm25Rank: number;
};

/** SQLite FTS5 persistence/search 계약입니다. */
export interface SkillSearchDatabaseInterface {
	/** database 파일을 열고 owned schema를 준비합니다. */
	initialize(databasePath: string): Promise<void>;

	/** request key와 TTL이 유효한 snapshot을 복원합니다. */
	readSnapshot(requestKey: string, now: number): SkillSearchSnapshot | null;

	/** 현재 persisted snapshot token이 일치하는지 확인합니다. */
	isSnapshotCurrent(snapshotToken: string): boolean;

	/** 단일 persisted snapshot을 원자적으로 교체합니다. */
	replaceSnapshot(input: SkillSearchSnapshotInput, documents: SkillSearchDocument[]): SkillSearchSnapshot;

	/** 하나의 read transaction에서 literal term들을 검색합니다. */
	searchTerms(snapshotToken: string, terms: readonly string[]): ReadonlyMap<string, SkillSearchDatabaseMatch[]>;

	/** 열린 database connection을 닫습니다. */
	close(): void;
}
