import type { IndexedStats, RawSkill, SkillRegistrySettings } from "../shared";

/**
 * SQLite FTS5에 삽입할 정규화된 검색 문서를 구성하는 필드입니다.
 * 검색 색인 구성 시 canonical 이름, 별칭, 본문 텍스트를 분리 저장해
 * 키워드 매칭과 정렬에서 동일 가중치 편향을 방지합니다.
 */
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

/**
 * 캐시 재생성 입력으로 사용되는 snapshot 계약입니다.
 * settings와 stats는 scope-aware 상태까지 포함해 저장해야 하며,
 * 재생성 시 원본 캐시 요청 identity를 그대로 반영해야 합니다.
 */
export type SkillSearchIndexedStats = IndexedStats & {
	/**
	 * scope 별 집계 결과입니다.
	 * scope 분포가 없으면 안전하게 생략되며,
	 * 값이 존재하지만 유효하지 않으면 재생성 경로로 invalid metadata를 처리합니다.
	 */
	scopeDistribution?: Record<string, number>;
};

/**
 * SQLite snapshot 교체 입력입니다.
 */
export type SkillSearchSnapshotInput = {
	generatedAt: number;
	ttlMs: number;
	requestKey: string;
	/**
	 * Snapshot 생성 시 관측한 filesystem manifest signature입니다.
	 */
	sourceSignature: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	skills: RawSkill[];
	stats: SkillSearchIndexedStats;
	buildStartedAt: number;
};

/**
 * SQLite에서 복원한 skill index snapshot입니다.
 * settings와 stats는 read/write 모두에서 round-trip 되어야 하며,
 * scopeRoots는 절대 경로 형태로 정규화해 보존합니다.
 * scope 메타데이터가 없는 legacy 행은 안전하게 무효 처리해야 합니다.
 */
export type SkillSearchSnapshot = {
	snapshotToken: string;
	generatedAt: number;
	ttlMs: number;
	requestKey: string;
	/**
	 * Cache hit 전에 현재 filesystem 상태와 비교할 manifest signature입니다.
	 */
	sourceSignature: string;
	settings: Required<SkillRegistrySettings>;
	requestedNames: string[];
	skills: RawSkill[];
	stats: SkillSearchIndexedStats;
	dfByTerm: Map<string, number>;
	avgLength: number;
	indexBuildMs: number;
};

/**
 * 단일 FTS5 term에 대한 BM25 match입니다.
 * skillId는 후보 식별자, bm25Rank는 스코어 오름차순 정렬 기준으로 사용됩니다.
 */
export type SkillSearchDatabaseMatch = {
	skillId: string;
	bm25Rank: number;
};

/**
 * SQLite FTS5 persistence/search 계약입니다.
 * 초기화, 복원, 교체, 검색에 대한 입력과 출력 규약을 소유권 있는 캐시 기준으로 고정합니다.
 */
export interface SkillSearchDatabaseInterface {
	/**
	 * database 파일을 열고 owned schema를 준비합니다.
	 * 소유권이 검증되지 않는 DB는 그대로 유지하고 초기화를 거부해야 합니다.
	 */
	initialize(databasePath: string): Promise<void>;

	/**
	 * request key와 TTL이 유효한 snapshot을 복원합니다.
	 * 요청 식별자가 다르거나 만료된 행은 null로 처리해 새 재구축을 유도합니다.
	 */
	readSnapshot(requestKey: string, now: number): SkillSearchSnapshot | null;

	/**
	 * 현재 persisted snapshot token이 일치하는지 확인합니다.
	 * token 불일치면 stale 상태로 간주해 재검색/재생성을 유도해야 합니다.
	 */
	isSnapshotCurrent(snapshotToken: string): boolean;

	/**
	 * 단일 persisted snapshot을 원자적으로 교체합니다.
	 * 입력 스냅샷을 그대로 반영하고, 복원 가능한 형태로 metadata를 갱신합니다.
	 */
	replaceSnapshot(input: SkillSearchSnapshotInput, documents: SkillSearchDocument[]): SkillSearchSnapshot;

	/**
	 * 하나의 read transaction에서 literal term들을 검색합니다.
	 * 동시 갱신으로 token이 바뀐 경우 즉시 stale 오류로 호출 측에 알립니다.
	 */
	searchTerms(snapshotToken: string, terms: readonly string[]): ReadonlyMap<string, SkillSearchDatabaseMatch[]>;

	/**
	 * 열린 database connection을 닫습니다.
	 * 정합성이 깨진 호출 경합에서도 안전하게 리소스만 정리하고 종료해야 합니다.
	 */
	close(): void;
}
