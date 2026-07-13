import type {
	IndexArtifacts,
	SkillApplyPacketResult,
	SkillChecklistPacketResult,
	SkillCommandsPacketResult,
	SkillExecutionPacketResult,
	SkillFileReadyPacketResult,
	SkillInstructionPacketResult,
	SkillMarkdownPacketResult,
	SkillRelationMode,
	SkillSummaryPacketResult,
	SkillVerificationPacketResult,
	SkillWriteScriptPacketResult,
} from "../shared";

/**
 * 스킬 질의 파이프라인의 전체 계약을 정의하는 인터페이스입니다.
 * Tool 입력 정규화에서 시작해 검색, 관계 확장, 패킷 직렬화, 실행 검증까지의
 * 변환 단계별 책임을 타입 레벨에서 일관되게 고정합니다.
 */
export interface SkillIndexInterface {

	/**
	 * current turn packet을 모델이 바로 사용할 수 있는 prompt-ready 실행 지시문으로 직렬화합니다.
	 * 세부 기술 선택은 유지하되 문장형 명령어 형태로 바꿔 실행 전환 계층의 포맷 요구를 만족시킵니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 실행 지시문 텍스트가 포함된 SkillInstructionPacketResult
	 */
	instructionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillInstructionPacketResult;

	/**
	 * current turn 내용을 한두 문장으로 요약해 전달용 summary를 생성합니다.
	 * 상세 실행 데이터는 별도 packet에서 유지하고, 상태 보고/로그 출력에서는 핵심만 노출하는 용도입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 요약 문자열이 포함된 SkillSummaryPacketResult
	 */
	summaryPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillSummaryPacketResult;

	/**
	 * current turn을 markdown 형식의 체크리스트·커맨드 문서로 직렬화합니다.
	 * 사람과 도구가 모두 읽기 쉬운 뷰(섹션 구분, 단계순서)로 변환해 다음 협업/검토 단계에 전달합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns markdown packet 결과
	 */
	markdownPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillMarkdownPacketResult;

	/**
	 * current turn packet에서 체크리스트 전용 뷰만 추출합니다.
	 * 실행 문맥은 줄이고 완료/상태 관리에 필요한 항목만 남겨 사람이 바로 체크 가능하게 합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 체크리스트 전용 SkillChecklistPacketResult
	 */
	checklistPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillChecklistPacketResult;

	/**
	 * current turn packet에서 command 전용 뷰만 추출합니다.
	 * 체크리스트 텍스트를 제외해 실행할 명령어 목록만 분리함으로써 자동 실행 모듈 연동을 단순화합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 커맨드 전용 SkillCommandsPacketResult
	 */
	commandsPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillCommandsPacketResult;

	/**
	 * current turn packet을 파일 쓰기 준비(payload)로 축약합니다.
	 * 경로, 변경 대상, 본문 크기 제약 정보를 모아 파일 반영 단계에서
	 * 바로 write/apply로 이어질 수 있도록 정규화합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 파일 저장용 payload를 담은 SkillFileReadyPacketResult
	 */
	fileReadyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillFileReadyPacketResult;

	/**
	 * file-ready packet을 write/apply 호출용 payload로 변환합니다.
	 * 실제 파일 생성/수정 API가 요구하는 형식으로 인수와 순서를 맞춰 변환하여
	 * 적용 단계의 파싱 비용을 줄이는 단계입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns apply 호출용 SkillApplyPacketResult
	 */
	applyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillApplyPacketResult;

	/**
	 * apply packet을 실행 가능한 write script payload로 번역합니다.
	 * apply 단계의 추상 payload를 실제 스크립트 실행 인터페이스가 받아들일 수 있는
	 * 구문 형태로 바꾸며, 실행 실패 시에도 역추적 가능한 구조를 유지합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns write script payload를 담은 SkillWriteScriptPacketResult
	 */
	writeScriptPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillWriteScriptPacketResult;

	/**
	 * write script packet을 script file + run command 번들로 결합합니다.
	 * 실제 실행자가 바로 호출할 수 있도록 스크립트 위치, 실행 경로, command 시퀀스를
	 * 한 묶음으로 정렬하고 실행 환경 의존성을 함께 전달합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 실행 번들형 SkillExecutionPacketResult
	 */
	executionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillExecutionPacketResult;

	/**
	 * execution 결과에 대해 검증 checklist를 생성해 실행 품질을 점검합니다.
	 * 성공/실패 판정 기준과 필요한 후속 확인 항목을 함께 산출해 apply 이후의 신뢰도 계층을 완성합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 검증용 checklist bundle를 담은 SkillVerificationPacketResult
	 */
	verificationPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillVerificationPacketResult;


}
