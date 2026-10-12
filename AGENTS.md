<INSTRUCTIONS project="skill-registry">

# Skill Registry Project

<directive>
- 해야한다. 해야합니다 : MUST
- 하지 말아야한다. 해서는 안된다 : MUST NOT
- 해야할 필요가 있다 : SHOULD
- 할 수 있다. : COULD, MAY
</directive>

## PURPOSE

Pi/OMP runtime에서 여러 `SKILL.md` 문서를 검색 가능한 corpus로 제공하고, 관계 확장과 bounded read·execution packet을 생성하는 extension입니다.

- skill root를 수집해 SQLite FTS5 index를 만들고 BM25 ranking과 deterministic tie-break를 제공합니다.
- canonical name과 alias를 exact resolve하고 `requires`, `recommends`, `related` 관계를 탐색합니다.
- `skill_registry` tool, `before_agent_start`·`before_provider_request` prompt hook과 namespaced slash command를 등록합니다.

## DOCUMENTATION

- `AGENTS.md`: 작업 원칙, architecture, implementation 규칙과 domain contract를 관리합니다.
- [STRUCTURE.md](./STRUCTURE.md): 프로젝트 구조, concern별 역할과 구조 문서 유지 규칙을 관리합니다.
- [README.md](./README.md): human-facing setup, 사용 예제와 operator 안내를 관리합니다.
- `docs/plans/`: implementation plan을 관리합니다.

## WORKING PRINCIPLES

- 기존 작업 변경을 보존해야 하며, 문제 해결을 위해 `git clean`이나 전체 변경 취소를 수행해서는 안 됩니다.
- 기술 용어와 핵심 identifier는 알파벳 표기를 유지하고, 설명은 한국어로 작성해야 합니다.

## ARCHITECTURE

### OWNERSHIP

- 각 concern은 명확한 책임과 단일 정의 위치를 유지해야 합니다.
- `src/main.ts`는 tool registration, schema wiring, query-only large-action gating과 hook registration을 직접 소유하는 root runtime entrypoint로 유지해야 합니다.
- extension entrypoint는 `main.ts`에서 `export default`로 내보내고, entrypoint 메서드명은 `register`로 지정해야 합니다. `main.ts`에서 다른 export를 re-export해서는 안 됩니다.
- `src/schema.ts`는 `skill_registry` tool input schema의 single source of truth로 유지해야 합니다.
- `src/service-registry.ts`는 concrete service 생성과 dependency wiring의 single location으로 유지해야 합니다.
- command 기능은 공통 interface 정의 → 각 command의 독립 service 구현·확장 → command-service wiring 순서로 구성해야 합니다.
- slash command는 `/skill-registry:$command_name` namespace를 사용해야 하며, unnamespaced command를 등록해서는 안 됩니다.

### MODULE BOUNDARIES

- concern module의 외부 노출은 해당 directory의 `index.ts` barrel을 통해 수행하고, module 내부 same-folder import는 direct import를 유지해야 합니다.
- feature별 interface는 해당 concern directory에 두어야 합니다. class가 직접 implement하는 interface는 같은 파일의 class 바로 위에 선언하며, 별도 `.interface.ts` 분리를 의무화하지 않습니다. `src/shared/`는 cross-cutting constant와 type에만 사용해야 합니다.
- 클래스는 SOLID 원칙, 특히 SRP에 따라 단일 책임을 유지해야 합니다.
- class가 있는 module에서 재사용 목적이 없는 function은 module 범위에 분산시키지 않고 해당 class의 method로 구성해야 합니다.

### HOST RUNTIME BOUNDARY

- host-owned dependency는 extension을 실행하는 host가 runtime 구현을 제공하는 package입니다. extension bundle에는 extension 소유 구현을 포함하고, host 소유 구현은 host의 module resolution으로 연결해야 합니다.
- dependency를 추가하거나 import를 변경할 때 type-only usage, extension-owned runtime dependency, host-owned runtime dependency를 먼저 구분해야 합니다. `dependencies`·`peerDependencies` 선언과 실제 import graph를 함께 확인해야 합니다.
- type-only usage는 `import type`으로 선언해야 합니다. 현재 `src/main.ts`와 `src/extension.interface.ts`의 `ExtensionAPI`는 이 경계에 해당하며, type 선언을 runtime import로 바꾸어서는 안 됩니다.
- host-owned package에서 runtime 값이 필요하면 실제 지원되는 narrower subpath를 우선하고, build에서 해당 package·사용 subpath를 `--external` 대상으로 지정해야 합니다. external 대상은 bundle에 구현을 복사하지 않고 runtime import로 남으며, 실행 host에서 resolve할 수 있어야 합니다.
- schema/helper-only usage는 host의 broad runtime root에 의존해서는 안 됩니다. 현재 `src/schema.ts`의 `Type`처럼 `@sinclair/typebox`를 직접 사용하고, 필요한 작은 helper는 file-local로 정의해야 합니다.
- `@earendil-works/pi-coding-agent`와 `@earendil-works/pi-ai`의 broad root import는 사용하지 않는 optional·telemetry dependency까지 import graph에 포함할 수 있으므로, 필요한 export와 transitive dependency를 점검해야 합니다.
- 현재 `package.json`의 build script는 `bun build ./src/main.ts --outdir ./dist --target bun`이며 explicit `--external`이 없습니다. 현재 확인한 host import는 type-only입니다. runtime host import 추가 시 external 설정과 host resolution 검증을 함께 추가해야 합니다.
- build 성공 여부, bundle 경계, runtime load를 각각 확인해야 합니다. built `dist/main.js`의 실행 가능한 import·dependency 경로를 확인하고, `verify:artifact`의 fresh-process load를 수행한 뒤 설치 경계 변경 시 `verify:installed`로 실제 설치 대상의 identity와 load를 확인해야 합니다. 단순 package 문자열 존재 여부만으로 runtime dependency 포함을 판정해서는 안 됩니다.
- OMP 설치·관리는 `plugins` package 방식으로 수행해야 하며, legacy `extensions` 경로로 직접 등록해서는 안 됩니다.

## IMPLEMENTATION

### CONTRACTS AND TYPES

- interface contract를 먼저 정의하고, 클래스는 해당 interface를 명시적으로 implement해야 합니다.
- class가 직접 implement하는 interface는 같은 파일에서 class 선언 바로 위에 배치해야 합니다. 그 사이에 다른 declaration을 삽입하지 않고, class는 `implements`로 계약을 명시해야 합니다.
- interface는 외부에서 사용하는 method·property의 contract를 표현해야 합니다. private implementation detail을 interface에 노출해서는 안 됩니다. 같은 class의 계약을 여러 위치에 중복 정의하지 않아야 합니다.
- arguments와 return result는 사용 경계가 드러나는 type으로 정의해야 합니다. 특정 schema library나 type 추론 방식의 사용을 의무화하지 않습니다. 외부 입력의 runtime validation은 별도로 유지해야 합니다.
- arguments로 전달받은 object의 property를 내부 method에서 변경해서는 안 됩니다. 변경이 필요하면 새 객체를 생성해 반환하거나 class가 소유하는 state에 반영해야 합니다. 중첩 object를 변경하는 얕은 복사도 입력 mutation으로 취급합니다.
- tool schema에는 Google Code Assist API가 지원하지 않는 `trim: true`를 포함해서는 안 됩니다.

### CONTROL FLOW AND ERRORS

- 구성과 흐름이 한눈에 드러나도록 구조를 단순하게 유지해야 합니다.
- 조건별 multi return은 입력 오류·처리 제외·종료 조건을 guard clause로 먼저 반환하고, 정상 처리 경로를 마지막에 배치해야 합니다. early return을 위해 cleanup이나 transaction 종료를 생략해서는 안 됩니다.
- 하나의 discriminator 값을 여러 case로 분기할 때 `switch`를 우선해야 합니다. 서로 다른 predicate나 범위 조건은 짧은 guard clause로 처리하고, 기계적으로 `switch (true)`로 변환해서는 안 됩니다. enum·union의 누락 case와 default 처리를 명시해야 합니다.
- `if-else`와 `try-catch`의 중첩은 최대 1-depth로 유지해야 합니다. function·method body를 기준으로 첫 조건·예외 block을 1-depth로 세고, 그 안의 추가 조건·예외 block을 2-depth로 봅니다. `else if` chain도 guard clause 또는 discriminator 기반 `switch`로 정리해야 합니다.
- block 분리가 필요하면 해당 class의 private method로 책임을 추출해야 합니다. 함수 분리 후에도 처리 순서, error propagation과 cleanup 동작을 유지해야 합니다.
- 예상 가능한 failure는 원인을 구분하는 명시적인 Exception Class로 표현해야 합니다. catch는 복구, cleanup 또는 경계의 error result 변환이 필요한 위치에 두고, 처리할 수 없는 error는 원인 정보를 유지하며 상위로 전달해야 합니다.
- class는 한 concern의 책임을 가져야 합니다. 상태·정책이 다른 책임을 한 class에 누적하지 않고, dependency는 composition root에서 연결해야 합니다. 공통화는 실제 재사용 대상이 있을 때 적용해야 합니다.

### NAMING

- 파일명은 `kebab-case.<type>.ts` 또는 `kebab-case.ts` 형식을 따라야 합니다.
- `<type>`은 역할을 나타내는 단수 명사이며, NestJS 스타일의 `module`, `service`, `controller`, `provider`, `factory`, `guard`, `interceptor`, `pipe`, `decorator`, `middleware`, `filter`, `exception`, `dto`, `entity`, `repository`, `spec` 등을 사용해야 합니다.
- 파일명은 역할을 직접 드러내야 하며, extension 이름을 기계적으로 반복하는 prefix나 `advisor-...`, `apply-patch-...` 같은 일반적 prefix를 지양해야 합니다.
- class·interface·type·constant 명칭은 NestJS 스타일을 따라 역할에 맞게 정규화해야 합니다.
- `.service.ts`는 `PascalCaseService`, `.provider.ts`는 `PascalCaseProvider`, `.interface.ts`는 `PascalCaseInterface` 또는 명시된 contract 명칭을 export해야 합니다.
- naming 규칙은 신규·수정 declaration에 적용해야 합니다. rename할 때 직접 연결된 import·export·usage를 함께 갱신해야 하며, unrelated 파일의 naming 정리를 작업 범위에 자동으로 추가하지 않습니다.

### COMMENTS

- interface에 public method·property의 한국어 multiline JSDoc을 우선 작성해야 합니다. contract의 역할, 입력·출력과 호출자가 알아야 할 조건을 interface에서 설명해야 합니다.
- interface에 선언된 method를 구현하는 class method에는 별도의 JSDoc을 작성하지 않습니다. interface의 contract 설명을 implementation에 복제해서는 안 됩니다.
- interface에 선언되지 않은 private method, 독립 function과 수정한 const·type·property에는 선언 위치에 한국어 multiline JSDoc을 작성해야 합니다. interface에 이미 설명된 property의 contract를 implementation에 반복하지 않습니다.
- 주석은 이름이나 반환값을 반복하지 않고 역할, 핵심 작동 흐름과 판단 이유를 설명해야 합니다.
- property 주석은 해당 property에 inline multiline JSDoc으로 작성해야 합니다.
- 인자가 있으면 `@param`, 반환값이 있으면 `@returns`로 각각 한국어 설명을 작성해야 합니다.

## DOMAIN CONTRACTS

### SEARCH AND ACTION GATING

- 검색 결과가 없을 때 임의의 skill을 선택하지 않고 safe-zero diagnostics를 반환해야 합니다.
- query-only는 정규화 후 explicit `names`가 없고 query로 후보 선택부터 시작하는 호출입니다. large-action gating 대상은 `decide`, `plan`, `route`, `current-turn-packet`, `session-packet`, `turn-packet`입니다. 모든 query 기반 action에 이 제한을 적용해서는 안 됩니다.
- 판단 순서는 input 정규화 → taskSize·names 기반 gate → `loadIndex()` → action handler의 필수 입력 검사입니다. 차단 시 error result를 반환하고 `loadIndex()`를 호출해서는 안 됩니다.
- gate는 대상 action, `taskSize !== 'large'`, 정규화된 `names.length === 0`이 모두 성립하면 차단해야 합니다. query가 길거나 구체적이어도 `small`·`medium`의 차단을 해제하지 않습니다.
- `taskSize` 생략 시 `medium`으로 정규화합니다. names 생략·빈 배열·정규화 후 빈 값은 names가 없는 호출로 판단합니다. nonempty names가 있으면 이 gate를 통과하며, 실제 canonical resolve 성공 여부는 후속 처리에서 확인합니다.

| 대상 action 입력 | `small`·`medium` | `large` |
| --- | --- | --- |
| nonempty query, names 없음 | index load 전 차단 | gate 통과 후 action 실행 |
| nonempty names, query 유무 무관 | gate 통과 후 action 실행 | gate 통과 후 action 실행 |
| query·names 모두 없음 | index load 전 차단 | gate 통과 후 handler에서 필수 입력 error |

- query는 trim 후 nonempty 값이어야 query 입력으로 인정합니다. 현재 구현에는 query 길이·의미를 평가하는 별도 '충분함' threshold가 없습니다. gate 통과는 검색 결과 존재나 실행 성공을 보장하지 않습니다.
- `small`·`medium`에서 대상 action이 필요하면 `discover`·`search`·`brief`로 후보를 먼저 좁히고, 선택한 names를 명시해야 합니다. `large`는 query-only 확장을 허용하지만 범위·결과 budget은 유지해야 합니다.
- 결과 limit은 `small` 최대 2, `medium` 최대 5이며, `large`는 설정의 `maxTopK`를 적용합니다. 모든 size에서 요청 limit과 `maxTopK` 상한을 적용합니다. `small`·`medium`의 relationMode는 `required`로 제한됩니다.
- 이 contract의 근거는 `src/main.ts`의 `LARGE_ONLY_QUERY_ACTIONS`·`executeTool`, `src/indexing/skill-input-normalizer.ts`와 `src/main.spec.ts`의 차단 시 index load 생략 regression입니다.

### SCOPE AND PROVENANCE

- 기본 scope mapping은 `$cwd/**` → `user-authored:local`, `$home/**` → `user-authored:global`, `~/.omp/managed-skills/**` → `managed-skills`로 구성해야 합니다. path와 scope 목록을 hardcode된 집합으로 제한하지 않고 설정으로 확장·재정의할 수 있어야 합니다.
- OMP runtime managed root인 `~/.omp/agent/managed-skills`를 기본 corpus와 `managed-skills` scope에 포함하고, legacy `~/.omp/managed-skills`도 함께 지원해야 합니다.
- `scopes` 생략 시 모든 effective scope를 검색하고 configurable weighting을 적용해야 합니다. 기본 우선순위는 `user-authored:local > user-authored:global > managed-skills`입니다.
- `scopes`가 명시되면 exact-matched scope만 탐색해야 합니다. 빈 배열, `[""]` 또는 알 수 없는 scope만 포함한 입력은 safe-zero를 반환해야 합니다.
- 결과와 통계의 `scope`는 경로 분류값이며, frontmatter 메타데이터인 `category`와 독립적으로 취급해야 합니다.
- explicit scope 조회에서도 path provenance는 모든 configured scope root의 longest-prefix로 분류해야 합니다. requested scope는 scan/result filtering에만 적용해야 합니다.

### INDEX AND CACHE LIFECYCLE

- filesystem의 skill document를 source of truth로 유지하고, SQLite persistence는 재생성 가능한 cache로 취급해야 합니다.
- index cache metadata에는 `scopeRoots`와 `scopePriority` snapshot을 보존해야 합니다. scope 필드를 포함한 복원·파싱 실패 시 cache를 재생성해야 합니다.
- filesystem source의 삭제·추가·rename·stat 변경과 root 생성·삭제는 다음 `loadIndex()`에서 source manifest mismatch로 감지해야 합니다.
- active index와 SQLite snapshot은 source signature가 일치할 때만 재사용해야 합니다.

### UNKNOWN SKILL RECOVERY

- host `read` resolver와 extension `resolve`의 ownership을 분리해야 합니다.
- host source를 수정하지 않고 plugin `tool_result` hook에서 direct unknown skill read compaction을 처리해야 합니다.
- compaction은 host `read` error 결과에서 `skill://` 대상, `Unknown skill`, `Available signature`가 모두 match될 때만 적용해야 합니다.
- `Available catalog` 원문을 parse/copy해서는 안 되며, recoverable signature만 좁게 전달해야 합니다.
- host replacement를 위한 `isError: false` 전환은 의도된 transport trade-off입니다. semantic unknown 상태를 유지하고, 이 동작을 tests와 문서에 명시해야 합니다.

## VERIFICATION

### 1단계: 코드 위생과 정적 검증

- 대상: type, lint와 formatting 변경을 확인하는 기본 검증입니다. 코드 위생 요청에는 lint 자동 수정을 포함해야 합니다.
- 명령: `bun run lint` → `bun run format` → `bun run check` 순서로 실행해야 합니다. 앞의 두 명령은 현재 Biome 설정의 `--write`로 파일을 수정하고, 마지막 명령은 typecheck와 Biome check로 잔여 오류를 확인합니다.
- `bun run typecheck`는 type 오류를 단독 재현할 때 사용합니다. `bun run check:fix`는 typecheck → lint → format 순서이므로, typecheck 실패 시 자동 수정까지 진행되지 않는다는 점을 고려해야 합니다.
- 통과 조건: 각 명령의 exit status와 잔여 diagnostics를 확인하고, 자동 수정 diff가 요청 범위와 기존 변경을 훼손하지 않는지 검토해야 합니다. warning은 별도로 보고해야 합니다.
- 이 단계는 source 동작, built artifact load 또는 installed runtime의 정상 동작을 확인하지 않습니다.

### 2단계: Source contract와 built artifact 검증

- 대상: source implementation, SQLite lifecycle, tool·hook integration과 실제 bundle load를 확인합니다. 기능·schema·indexing·prompt·dependency·build 변경에 적용해야 합니다.
- source tests: `bun run test:unit`으로 concern contract, `bun run test:sqlite`으로 SQLite schema·snapshot·FTS5·connection lifecycle, `bun run test:e2e`로 host registration과 settings-aware prompt output을 검증해야 합니다. `bun run test`는 세 suite를 순서대로 실행합니다.
- `bun run test:runtime`은 현재 `test:e2e`의 alias이므로 동일한 검증을 중복 실행하는 것을 별도 coverage로 계산해서는 안 됩니다.
- artifact: `bun run build` → `bun run verify:artifact` → `bun run test:verify` 순서로 실행해야 합니다. build는 `dist/main.js`를 생성하며, 나머지 두 명령은 build를 암묵 실행하지 않습니다.
- `verify:artifact`는 fake ExtensionAPI에 built dist를 register하고 planning fixture의 discovery·index·resolve를 fresh process에서 검증합니다. `test:verify`는 child Bun isolation, stale bundle failure와 freshness regression을 검증합니다.
- `bun run verify:pr`는 check → unit → SQLite → build → artifact → verify regression을 묶은 gate입니다. 현재 e2e는 포함하지 않으므로 2단계 전체를 완료하려면 `bun run test:e2e`를 추가해야 합니다.
- 통과 조건: nonzero test 실행, 실패·skip 여부, build·artifact 각 명령의 결과와 실제 확인한 bundle boundary를 기록해야 합니다. 1단계 검증을 함께 충족해야 하며, built artifact 통과를 installed runtime 검증으로 간주해서는 안 됩니다.

### 3단계: Installed plugin과 실제 corpus 검증

- 대상: 설치·배포·host dependency 경계 변경과 stale runtime 진단입니다. 1·2단계 결과와 실제 설치 대상의 일치 여부를 확인합니다.
- 명령: build된 candidate와 설치 상태를 확인한 뒤 `bun run verify:installed`를 실행해야 합니다. repository·lock·installed version, symlink·checksum identity와 실제 managed planning corpus를 확인합니다.
- 실제 planning skill을 기준으로 discovery, explicit-root index와 known canonical resolve를 검증해야 합니다. fixture 성공과 real managed corpus 성공은 각각 보고해야 합니다.
- 설치 artifact가 stale하면 plugin link/reinstall 후 새 OMP process/session에서 재검증해야 합니다. 실행 중인 plugin은 `bun run build`만으로 reload되지 않습니다.
- indexing/discovery 실패 시 source와 실제 loaded artifact의 version·bundle identity를 대조하고, 확인된 stale runtime을 갱신한 뒤 실제 planning skill로 재검증해야 합니다.
- 통과 조건: source·built·installed candidate의 identity, fresh-process 검증 결과와 실제 planning canonical resolve 결과를 확인해야 합니다. 설치 작업이나 host 재시작이 필요하면 해당 작업의 허용 범위를 먼저 확인해야 합니다.
- `verify:pr`는 3단계를 포함하지 않습니다. 실행 환경 부재·설치 불일치로 검증이 막히면 미검증 또는 blocked 상태로 보고해야 합니다.

단계 번호는 검증 범위를 구분합니다. 상위 단계는 하위 단계의 증거를 함께 요구하며, 변경 위험에 따라 필요한 단계를 선택합니다. 문서만 수정한 경우 문서의 링크·형식·원문 보존을 검증하고, 코드 검증을 실행했다고 보고해서는 안 됩니다.

## CHANGE MANAGEMENT

- 특정 plan의 최신화 요청 시 실제 repository contract, 구현, tests와 scripts를 대조하고, 검증 시각과 구현 상태를 해당 plan에 기록해야 합니다.
- commit 정리는 파일 수보다 독립적으로 설명하고 검증할 수 있는 의미 있는 변경 단위로 묶어야 합니다.
<INSTRUCTIONS project="">
