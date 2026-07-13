import type {
	IndexArtifacts,
	SkillApplyPacketResult,
	SkillAuditReport,
	SkillBriefResult,
	SkillBundleResult,
	SkillChecklistPacketResult,
	SkillCommandsPacketResult,
	SkillCompareResult,
	SkillComposePlan,
	SkillCurrentTurnPacketResult,
	SkillDecideResult,
	SkillExecutionPacketResult,
	SkillExplainResult,
	SkillFileReadyPacketResult,
	SkillGraphMode,
	SkillHandoffResult,
	SkillInstructionPacketResult,
	SkillMarkdownPacketResult,
	SkillPack,
	SkillPlanResult,
	SkillRecommendResult,
	SkillRecoveryPacketResult,
	SkillRelationGraph,
	SkillRelationMode,
	SkillResumePacketResult,
	SkillRouteResult,
	SkillSessionPacketResult,
	SkillSummaryPacketResult,
	SkillTurnPacketResult,
	SkillValidationReport,
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
	 * seed skill과 관계를 탐색해 compose 결과를 계산합니다.
	 * 검색/resolve 단계에서 정돈된 후보를 기반으로 graph 기반 인접 노드를 확장해
	 * 다음 단계에 넣을 실행 가능 플랜으로 조합합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names seed 또는 초기 후보 name 목록
	 * @param relationMode 관계 확장 전략
	 * @returns relation 확장 결과인 SkillComposePlan
	 */
	composeSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		limit?: number,
		relationMode?: SkillRelationMode,
		minScore?: number,
	): SkillComposePlan;

	/**
	 * search, compose, graph의 근거를 하나로 묶어 explain 결과로 변환합니다.
	 * 단일 스코어 계산이 아닌, 어떤 단계에서 어떤 입력이 어떤 규칙으로 반영됐는지
	 * 추적 가능한 설명 체인을 만들어 분석/감사용 관측 가능성을 높입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names seed 또는 조회 대상 skill 목록
	 * @param relationMode 관계 분석 모드
	 * @returns 단계별 근거가 결합된 SkillExplainResult
	 */
	explainSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		limit?: number,
		minScore?: number,
	): SkillExplainResult;

	/**
	 * 쿼리 또는 seed 후보군에서 최초 read winner를 결정합니다.
	 * 복수 후보가 존재할 때 현재 단계의 시작점을 단일 노드로 수렴시켜
	 * plan 단계가 고정된 기준으로 진행되도록 합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param limit 결과 평가 상한
	 * @returns 판정된 winner 정보를 담은 SkillDecideResult
	 */
	decideSkills(index: IndexArtifacts, query: string | undefined, names: string[], limit?: number, minScore?: number): SkillDecideResult;

	/**
	 * winner를 시작점으로 read sequence를 순차 계획합니다.
	 * 결정된 중심 노드에서 의존성·우선순위를 반영해 다음 read 순서를 산출하며,
	 * plan은 실제 실행 순번을 만들기 위한 중간 변환 결과입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 확장 모드
	 * @param limit 후보 확장 상한
	 * @returns 순번이 할당된 SkillPlanResult
	 */
	planSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		limit?: number,
		minScore?: number,
	): SkillPlanResult;

	/**
	 * plan 단계를 layer-aware itinerary로 재배치합니다.
	 * 같은 노드라도 실행 계층(현재/기반/후속)이 다르면 실행 가능성이 달라지므로,
	 * handoff 전에 단계별 호출 순서를 명시적으로 분리합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 레이어링 모드
	 * @param limit 후보 확장 상한
	 * @returns 레이어/계층 정보가 반영된 SkillRouteResult
	 */
	routeSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		limit?: number,
		minScore?: number,
	): SkillRouteResult;

	/**
	 * route 결과를 읽기 제한 조건에 맞춰 bounded brief packet로 축약합니다.
	 * includeBody 및 예산 단위를 적용해 불필요한 상세정보를 제거하고,
	 * 다음 bundle/handoff 단계에서 크기 통제가 가능한 형태로 변환합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 라우팅 관계 모드
	 * @param includeBody 본문 포함 여부
	 * @param budgetChars 출력 문자 수 제약
	 * @param budgetTokens 출력 토큰 수 제약
	 * @returns 경량화된 브리핑 결과
	 */
	briefSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		includeBody?: boolean,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillBriefResult;

	/**
	 * brief를 agent-ready preset로 결합해 읽기 전용 bundle을 구성합니다.
	 * 실행 체계가 동일한 환경에서도 바로 사용할 수 있도록 메타 + 순서 + 바인딩을
	 * 하나의 묶음으로 정규화합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns handoff 전단계에서 바로 소비 가능한 SkillBundleResult
	 */
	bundleSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillBundleResult;

	/**
	 * bundle 결과에 source/next command 힌트를 덧붙여 handoff packet으로 변환합니다.
	 * 단순 데이터 묶음이 아니라 다음 실행 주체가 이어서 작업할 수 있도록
	 * 전환 포인트를 가진 실행 지침 메타데이터를 함께 제공합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 인수인계용 handoff 데이터
	 */
	handoffSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillHandoffResult;

	/**
	 * handoff 결과를 세션 단위로 순서 정렬해 session-ready packet으로 투영합니다.
	 * 다중 턴을 안전하게 연속 처리하기 위해 handoff의 임시 정보를 세션 정렬 규칙으로
	 * 정돈해 저장/재개 흐름에 적합하게 바꿉니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 세션 실행용 SkillSessionPacketResult
	 */
	sessionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillSessionPacketResult;

	/**
	 * session packet을 turn 단위 execution packet으로 나눕니다.
	 * 하나의 세션 패킷을 실행 가능한 작은 단위로 분할해 현재 턴 실행이 가능한 입력으로 전환하는,
	 * 명령 배치용 변환 단계입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns turn 단위로 정렬된 SkillTurnPacketResult
	 */
	turnPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillTurnPacketResult;

	/**
	 * turn packet에서 장애 복구가 필요한 turn만 선별해 recovery packet으로 재구성합니다.
	 * 성공한 turn을 걸러내고 실패/중단 turn만 남겨 재개 비용을 줄이는 전환 단계입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 복구 대상만 담은 SkillRecoveryPacketResult
	 */
	recoveryPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillRecoveryPacketResult;

	/**
	 * recovery 경로에서 남은 turn sequence를 이어서 실행할 수 있도록 재조합합니다.
	 * 실패 구간 이후의 연속성만 살려 반환하므로 중복 작업 없이 재개가 가능해집니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 재개용 SkillResumePacketResult
	 */
	resumePacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillResumePacketResult;

	/**
	 * resume 단계에서 즉시 실행 가능한 첫 번째 turn만 packet으로 추출합니다.
	 * 실행 큐를 더 쪼개, 사용자 인터랙션 지연을 줄이고 현재 작업 단위를 즉시 보여주기 위한 단계입니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param budgetChars 출력 문자 예산
	 * @param budgetTokens 출력 토큰 예산
	 * @returns 현재 턴 패킷 하나를 담은 SkillCurrentTurnPacketResult
	 */
	currentTurnPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		budgetChars?: number,
		budgetTokens?: number,
		limit?: number,
		minScore?: number,
	): SkillCurrentTurnPacketResult;

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

	/**
	 * query 또는 seed 후보를 비교 뷰로 정규화해 side-by-side 판단 근거를 제공합니다.
	 * 추천/선택을 자동화할 때 단일 점수 대신 대안 간 trade-off가 어떻게 다른지
	 * 패키지 단위로 확인할 수 있게 합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param limit 비교 결과 상한
	 * @param minScore 비교 대상 최소 점수
	 * @returns 후보 비교 결과 SkillCompareResult
	 */
	compareSkills(index: IndexArtifacts, query: string | undefined, names: string[], limit?: number, minScore?: number): SkillCompareResult;

	/**
	 * query와 seed의 인접 relation을 분석해 다음 추천 스킬을 계산합니다.
	 * 현재 선택의 연장선에서 중복 후보를 줄이고, 탐색이 필요한 갭 방향을 제안하는 후속 추천을 반환합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 기반 추천 모드
	 * @param limit 최대 추천 개수
	 * @param minScore 최소 점수 임계치
	 * @returns 후속 추천을 담은 SkillRecommendResult
	 */
	recommendSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode?: SkillRelationMode,
		limit?: number,
		minScore?: number,
	): SkillRecommendResult;

	/**
	 * compose, graph, validate 결과를 한 번의 snapshot pack으로 통합합니다.
	 * 서로 다른 단계의 산출물을 별도로 조립하지 않고 한 구조로 묶어,
	 * consume 쪽에서 변환 비용 없이 즉시 해석 가능한 패킷을 제공합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 후보 name 목록
	 * @param relationMode 관계 모드
	 * @param includeBody 본문 포함 여부
	 * @param budgetChars 문자 예산
	 * @param budgetTokens 토큰 예산
	 * @returns compose/graph/validate 통합 결과 SkillPack
	 */
	packSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode | undefined,
		includeBody: boolean,
		budgetChars: number,
		budgetTokens: number,
		limit?: number,
		minScore?: number,
	): SkillPack;

	/**
	 * 인덱스 자체의 정합성을 검사해 index-level validation issue를 계산합니다.
	 * 인덱스 항목, 메타 레코드, 참조 링크의 일관성 문제를 찾아
	 * 검색/패킷 변환 품질 저하를 예방하기 위한 진단 보고서를 반환합니다.
	 */
	validateIndex(index: IndexArtifacts): SkillValidationReport;

	/**
	 * query 또는 names 기반으로 corpus의 건강 상태를 audit합니다.
	 * 빈약한 노출, 고립 노드, 관계 손실 등 운영 관점의 품질 저하를 진단해
	 * 유지보수 우선순위가 되는 지표를 도출합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names 대상 name 목록
	 * @param limit 반환 항목 상한
	 * @param minScore 최소 점수 필터
	 * @returns Health 지표 집약 객체 SkillAuditReport
	 */
	auditSkills(index: IndexArtifacts, query: string | undefined, names: string[], limit?: number, minScore?: number): SkillAuditReport;

	/**
	 * canonical index 기준으로 relation graph의 특정 slice를 추출합니다.
	 * 전체 그래프를 재구성하지 않고 query/names 주변의 필요한 이웃과 연결을
	 * graphMode별로 제한해 관계 탐색 비용을 최소화합니다.
	 *
	 * @param index 로드된 인덱스 아티팩트
	 * @param query 검색 질의(선택)
	 * @param names seed 또는 후보 skill 목록
	 * @param graphMode 그래프 추출 모드
	 * @param limit 반환할 node 수 상한
	 * @param minScore 최소 관계 점수
	 * @returns 관계 구조 슬라이스인 SkillRelationGraph
	 */
	graphSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		graphMode?: SkillGraphMode,
		limit?: number,
		minScore?: number,
	): SkillRelationGraph;
}
