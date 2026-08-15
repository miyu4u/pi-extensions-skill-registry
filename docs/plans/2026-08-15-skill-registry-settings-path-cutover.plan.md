---
id: "skill-registry-settings-path-cutover"
revision: 1
title: "설정파일 경로 정규화 및 cutover"
description: "skill-registry 설정 파일을 네 개의 명시된 후보 경로와 고정 우선순위로 전환하고 기존 경로 호환을 제거한다."
plan_status: "sealed"
execution_status: "acceptance"
supersedes: null
updated_at: "2026-08-15 07:07:21"
mode: "fast"
metadata:
  time_standard: "UTC"
  requirements:
    - "레포지토리 로컬 설정이 machine global 설정보다 우선한다."
    - "로컬과 global 모두 .pi가 .omp보다 우선한다."
    - "설정 후보는 .pi/skill-registry.json, .omp/agent/skill-registry.json, ~/.pi/skill-registry.json, ~/.omp/agent/skill-registry.json만 사용한다."
    - "기존 설정 경로는 compatibility candidate로 읽지 않는다."
    - "loadSettings와 loadPromptSettings가 동일한 precedence를 사용한다."
  goal: "네 후보 경로의 순서가 코드, 테스트, fixture, 문서에서 일치하고 legacy 경로가 더 이상 설정 source로 사용되지 않는 상태"
  tasks:
    - "T-01"
    - "T-02"
    - "T-03"
    - "T-04"
    - "T-05"
---

# 목표 및 문제, 사용자의 질문

사용자는 `skill-registry` 설정 파일 경로를 정규화하고 다음 precedence로 clean cutover 하도록 요청했다.

1. `.pi/skill-registry.json`
2. `.omp/agent/skill-registry.json`
3. `~/.pi/skill-registry.json`
4. `~/.omp/agent/skill-registry.json`

현재 loader는 `.pi/settings/...`, `.pi/settings.json`, 환경 변수로 계산한 Pi/OMP `settings/...` 경로를 함께 후보로 취급한다. 이 때문에 요청된 네 경로와 실제 탐색 순서가 다르고, 오래된 경로가 새 경로보다 먼저 또는 대신 사용될 수 있다. 이 계획은 설정 파일 후보와 그 검증·문서·격리 fixture를 하나의 bounded workstream으로 전환한다.

## 목표에 대한 이해

- `SettingsLoaderService`의 `loadSettings()`와 `loadPromptSettings()`가 동일한 네 후보를 위 순서로 조회한다.
- 첫 번째로 존재하는 유효 JSON을 사용하고, 후보가 모두 없거나 유효하지 않으면 현재 기본 settings fallback을 유지한다.
- `.pi/settings/skill-registry/skill-registry.json`, `.pi/settings/skill-registry.json`, `.pi/settings.json`, 환경 변수 기반 `settings/...`, `skillRegistry.json` 등 기존 후보는 더 이상 읽지 않는다.
- 변경 대상은 설정 파일 path lookup이며, 기존 `skillRegistry` payload wrapper와 settings value normalization, databasePath 계산 규칙은 보존한다.
- 관측 가능한 acceptance는 네 후보의 우선순위, legacy 후보 무시, 두 loader entrypoint의 precedence 일치, built artifact fixture의 동일 동작이다.

## Preflight 조사

### C1 — 명확화 결과

- Interview 상태: skipped
- 판단 이유: 사용자가 후보 경로 네 개와 우선순위, legacy compatibility 제거 및 cutover 의도를 직접 지정했으며, 실행 범위와 acceptance를 바꾸는 추가 질문이 필요하지 않다.
- 사용자 결정:
  - repository local이 machine global보다 우선한다.
  - 동일한 local/global 계층에서 `.pi`가 `.omp`보다 우선한다.
  - 후보는 정확히 네 개이며 기존 path candidate는 호환하지 않는다.
- 미해결 질문:
  - none

### C2 — 배경 정보와 모드 선택

- 관측 사실:
  - `src/settings/settings-loader.service.ts`의 `collectSettingFileCandidates()`는 `SKILL_REGISTRY_SETTINGS_FILE_PATHS`를 이용해 `.pi/settings/...`와 `.pi/settings.json`을 만들고, `PI_CODING_AGENT_DIR`, `OMP_AGENT_DIR`, `OMP_AGENT_HOME`으로 global 후보를 계산한다.
  - `src/shared/skill-registry.constant.ts`에는 현재 후보 base directory와 `skill-registry.json` 파일명이 분리되어 있다.
  - `src/settings/settings-loader.service.spec.ts`는 dedicated project settings, `.pi/settings.json`, env-derived agent directory, legacy managed skill root를 포함한 기존 경로 동작을 검증한다.
  - `README.md`, `__test__/__e2e__/skill-registry-extension.e2e-spec.ts`, `scripts/verify/verify-artifact.ts`, `scripts/verify/fresh-process-child.ts`에도 기존 settings 경로 fixture 또는 설명이 있다.
  - `AGENTS.md`는 settings/runtime ownership이 바뀌면 같은 task에서 문서를 갱신하도록 요구한다.
- 해석:
  - production 변경은 shared candidate contract와 settings loader에 집중되며, prompt hook은 이미 같은 loader를 호출하므로 별도 runtime algorithm 변경은 필요하지 않다.
  - 환경 변수는 database cache 경로 계산에 계속 사용될 수 있지만, 요청된 네 설정 후보를 바꾸는 입력으로는 남겨서는 안 된다.
  - E2E와 built artifact fixture는 새 상대경로 후보를 실제로 발견할 수 있도록 cwd 또는 격리 home fixture를 함께 바꿔야 한다.
- 미검증 경계:
  - 아직 production code, fixture, 문서 또는 dist를 변경하지 않았다.
  - 현재 host runtime에서 `os.homedir()`가 테스트의 격리 home 환경 변수와 어떻게 상호작용하는지는 실행 전이다.
  - installed plugin freshness와 실제 machine global 설정 파일은 이 plan preflight 범위에서 실행하지 않았다.
- 선택 모드: fast
- 선택 이유: 하나의 settings lookup workstream이며 ownership이 `src/shared`, `src/settings`, 관련 fixture·문서로 명확하고, cycle 없는 단순 DAG와 targeted unit/runtime/artifact verification으로 acceptance를 표현할 수 있다. migration rollout이나 외부 시스템 변경은 포함하지 않는다.

# User-Facing

## 작업 요약 및 브리핑 설명

현재 설정 탐색은 여러 historical location과 runtime environment variable을 함께 확인한다. 제안하는 cutover는 설정 파일의 source of truth를 네 경로로 줄이고, 목록 순서 자체를 precedence contract로 만든다. 따라서 project-local `.pi` 설정이 항상 가장 먼저 적용되고, project-local이 없을 때만 `.omp/agent`, 그 다음 machine global `.pi`, 마지막으로 machine global `.omp/agent`가 사용된다.

기존 path candidate는 fallback으로 남기지 않는다. 사용자는 새 네 경로 중 하나로 설정을 이동해야 하며, 이 계획은 설정 payload의 기존 `skillRegistry` wrapper와 값 정규화까지 재설계하지 않는다.

## 관측 시점의 현재 구성

```text
cwd
 ├─ .pi/settings/skill-registry/skill-registry.json
 ├─ .pi/settings/skill-registry.json
 └─ .pi/settings.json
       ↓
PI_CODING_AGENT_DIR / OMP_AGENT_DIR / OMP_AGENT_HOME
       ↓
agent/settings/skill-registry/skill-registry.json
agent/settings/skillRegistry.json
       ↓
SettingsLoaderService
```

- project candidate와 global candidate가 서로 다른 규칙으로 계산된다.
- `.pi`와 `.omp`의 요청된 직접 경로가 candidate contract에 존재하지 않는다.
- `loadSettings()`와 `loadPromptSettings()`는 같은 candidate collector를 사용하지만 collector 자체가 legacy path를 포함한다.
- 기존 unit/E2E/artifact fixture가 historical path를 생성하므로 production cutover만 적용하면 검증 fixture가 stale해진다.

## 개선 후 예상 구성

```text
1 .pi/skill-registry.json
        │ missing/invalid
        ▼
2 .omp/agent/skill-registry.json
        │ missing/invalid
        ▼
3 ~/.pi/skill-registry.json
        │ missing/invalid
        ▼
4 ~/.omp/agent/skill-registry.json
        │ missing/invalid
        ▼
default settings
        │
        ├─ loadSettings
        └─ loadPromptSettings
```

- candidate list는 direct file path 네 개를 fixed order로 선언하거나 이에 준하는 단일 contract로 소유한다.
- local path는 `process.cwd()`를 기준으로, global path는 `os.homedir()`를 기준으로 해석한다.
- `PI_CODING_AGENT_DIR`, `OMP_AGENT_DIR`, `OMP_AGENT_HOME`은 config lookup precedence를 변경하지 않는다. 요청 범위 밖인 database cache path 계산은 보존한다.
- E2E와 fresh-process/artifact fixture는 새 candidate path에 맞춰 cwd/home을 격리하고, README와 `AGENTS.md`는 operator contract를 반영한다.

## 변경 영향

- `P0-1`: 기존 `.pi/settings/...`, `.pi/settings.json`, env-derived `settings/...`, `skillRegistry.json` 경로에서만 설정하던 사용자는 새 네 경로로 이동해야 한다. 이는 사용자가 요청한 breaking cutover이다.
- `P1-1`: 설정 source precedence가 deterministic하게 바뀌며, config lookup에 대한 agent directory environment variable의 영향이 제거된다. database cache path와 skill corpus path 설정값의 의미는 유지한다.
- `P2-1`: README, `AGENTS.md`, unit/E2E/artifact fixture가 새 경로 표기로 정렬된다. historical plan ledger와 generated `dist`를 source 문서처럼 수정하지 않는다.

## 사용자가 결정해야 하는 부분

- `HD` 결정: none. 사용자가 네 후보와 순서를 명시했으므로 execution contract를 바꾸는 추가 결정이 없다.
- `SD` 결정: none. path cutover 외의 preference를 추가하지 않는다.

## 가정들

- `AS-1`: “기존 호환 없음”은 설정 파일 path candidate 호환을 제거한다는 뜻으로 적용한다.
  - 이유: 요청의 직접 대상이 설정파일 경로이며, payload shape 변경은 별도로 지시되지 않았다.
  - 대안: `skillRegistry` wrapper 및 top-level payload parsing까지 제거하는 별도 schema migration.
  - 트레이드오프: 현재 JSON payload를 유지하면 path migration만으로 범위를 제한할 수 있지만, 사용자가 payload compatibility까지 금지한 의도였다면 요구사항 일부가 남는다.
  - 깨질 때의 처리: payload schema 또는 wrapper 제거가 요구되면 현재 revision을 `replan-required`로 전환하고 별도 HD decision과 migration task를 만든다.
- `AS-2`: “유효한 JSON을 처음 찾으면 사용”하는 현재 fallback semantics는 유지한다.
  - 이유: path precedence만 바꾸고 invalid candidate 처리 semantics를 불필요하게 바꾸지 않는다.
  - 대안: 첫 존재 파일이 invalid이면 즉시 오류로 중단한다.
  - 트레이드오프: invalid local file이 있는 경우 다음 candidate가 사용되므로 운영자가 오류를 즉시 발견하지 못할 수 있다.
  - 깨질 때의 처리: 사용자 acceptance가 invalid file fail-fast를 요구하면 `replan-required`로 전환한다.

## 결정 트리

- `DT-1`: 네 direct path를 single ordered candidate contract로 정규화한다.
  - 결정 이유: local/global 및 `.pi`/`.omp` precedence를 코드와 테스트에서 동일하게 보장하고 legacy path 누수를 막기 위해서다.
  - 근거: 사용자 결정의 exact path list와 `AS-1`.
  - 예상 대안:
    - `DT-1-A-1`: 기존 base directory 상수에 path를 덧붙이는 방식. legacy compatibility가 남아 clean cutover를 위반하므로 선택하지 않는다.
    - `DT-1-A-2`: loader method 안에 네 path를 개별 hardcode하는 방식. shared contract 재사용성이 낮아 선택하지 않는다.
- `DT-2`: config lookup의 global root는 fixed `os.homedir()` 기반으로 두고 agent environment variable은 database path 계산에만 남긴다.
  - 결정 이유: 사용자가 machine global 경로를 literal `~/.pi`와 `~/.omp/agent`로 지정했으며, config source와 cache storage의 책임을 섞지 않기 위해서다.
  - 근거: 사용자 path list와 `AS-1`.
  - 예상 대안:
    - `DT-2-A-1`: environment variable을 global settings root alias로 계속 사용한다. 네 path 고정 contract와 충돌한다.
    - `DT-2-A-2`: database path precedence도 함께 변경한다. 요청 scope를 넘어가므로 선택하지 않는다.

# Agent-Facing

## Drift Guardrail

- 반드시 포함:
  - 정확히 `.pi/skill-registry.json`, `.omp/agent/skill-registry.json`, `~/.pi/skill-registry.json`, `~/.omp/agent/skill-registry.json` 순서로 설정 후보를 조회한다.
  - `loadSettings()`와 `loadPromptSettings()` 모두 같은 candidate precedence를 사용한다.
  - 상대경로는 cwd, global 경로는 home 기준으로 정규화하고 기존 settings value normalization을 보존한다.
- 변경 금지:
  - `skillRegistry` payload parsing, settings value validation, scope roots, database cache path 계산, prompt replacement algorithm.
  - completed historical plan의 state ledger와 `.tmp` session evidence.
- 하지 않을 일:
  - legacy path에서 설정을 읽는 compatibility fallback 추가.
  - machine global 파일을 생성·수정하거나 installed plugin을 link/reinstall하는 운영 작업.
  - database schema, skill indexing, prompt semantics, runtime registration contract의 unrelated refactor.
  - generated `dist/main.js`를 source of truth로 직접 편집.
- 재계획 신호:
  - exact four paths 외 후보를 보존해야 한다는 요구가 발생한다.
  - payload wrapper/schema, invalid JSON fail-fast, database path precedence까지 바꿔야 한다.
  - config candidate owner가 shared constant와 settings loader 사이에서 합의되지 않는다.
  - isolated fixture로 local/global precedence를 재현할 수 없어 non-local host verification이 필수가 된다.

## Task Managing Boards

### T-01 — 설정 후보 contract와 loader cutover

```yaml
task:
  id: T-01
  source: initial
  status: done
  dependencies: []
  ownership:
    semantic: "ordered settings candidate contract and SettingsLoaderService lookup"
    write:
      - "src/shared/skill-registry.constant.ts"
      - "src/shared/index.ts"
      - "src/settings/settings-loader.service.ts"
  dod:
    - "candidate order is exactly .pi/skill-registry.json, .omp/agent/skill-registry.json, ~/.pi/skill-registry.json, ~/.omp/agent/skill-registry.json"
    - "legacy settings paths and agent-environment-derived config candidates are absent from the lookup"
    - "loadSettings and loadPromptSettings share the same ordered candidates"
    - "payload parsing, value normalization, and databasePath calculation remain unchanged"
  verification:
    - "bun run typecheck"
```

### T-02 — settings loader precedence regression tests

```yaml
task:
  id: T-02
  source: initial
  status: done
  dependencies:
    - T-01
  ownership:
    semantic: "observable precedence, invalid-candidate fallback, and legacy-path rejection"
    write:
      - "src/settings/settings-loader.service.spec.ts"
  dod:
    - "all four candidates are exercised with distinct payloads and resolve in the requested order"
    - "local .pi wins over local .omp, local wins over both home candidates, and home .pi wins over home .omp"
    - "legacy candidate files do not affect loadSettings or loadPromptSettings"
    - "agent directory environment variables do not redirect config lookup"
    - "missing or invalid candidates preserve the existing default/fallback behavior"
  verification:
    - "bun run test:unit -- src/settings/settings-loader.service.spec.ts"
```

### T-03 — runtime와 artifact fixture cutover

```yaml
task:
  id: T-03
  source: initial
  status: done
  dependencies:
    - T-01
  ownership:
    semantic: "isolated host-runtime, built-artifact, and fresh-process settings fixtures"
    write:
      - "__test__/__e2e__/skill-registry-extension.e2e-spec.ts"
      - "scripts/verify/verify-artifact.ts"
      - "scripts/verify/fresh-process.ts"
      - "scripts/verify/fresh-process-child.ts"
  dod:
    - "E2E writes project settings to .pi/skill-registry.json and restores cwd/home/environment isolation"
    - "artifact and fresh-process fixtures write only the new direct candidate paths"
    - "fresh-process request carries enough isolated workspace/home context for the child loader to observe the intended candidate"
    - "existing tool registration, prompt hook, and planning corpus assertions remain semantically unchanged"
  verification:
    - "bun run test:e2e -- __test__/__e2e__/skill-registry-extension.e2e-spec.ts"
```

### T-04 — operator 문서와 repository contract 정렬

```yaml
task:
  id: T-04
  source: initial
  status: done
  dependencies:
    - T-01
  ownership:
    semantic: "human-facing settings path contract and repository ownership guidance"
    write:
      - "README.md"
      - "AGENTS.md"
  dod:
    - "README lists only the four candidates in the exact precedence order and explains the breaking migration"
    - "README configuration example uses a new path without retaining old path instructions"
    - "AGENTS records the current settings ownership/path contract without editing historical plan evidence"
    - "non-historical source documentation contains no stale legacy candidate claim"
  verification:
    - "rg -n '\\.pi/settings|settings/skill-registry|skillRegistry\\.json|OMP_AGENT_DIR.*settings|PI_CODING_AGENT_DIR.*settings' README.md AGENTS.md src __test__ scripts/verify"
```

### T-05 — 통합 검증과 cutover gate

```yaml
task:
  id: T-05
  source: initial
  status: done
  dependencies:
    - T-02
    - T-03
    - T-04
  ownership:
    semantic: "integrated source, runtime fixture, and built artifact acceptance gate"
    write:
      - "dist/main.js"
  dod:
    - "typecheck and repository check pass after all source and documentation changes"
    - "focused settings precedence tests pass"
    - "updated E2E settings fixture passes"
    - "built dist registration and planning artifact verification pass using the new candidate contract"
    - "no accepted hard blocker or unverified required acceptance remains"
  verification:
    - "bun run check"
    - "bun run test:unit -- src/settings/settings-loader.service.spec.ts"
    - "bun run test:e2e -- __test__/__e2e__/skill-registry-extension.e2e-spec.ts"
    - "bun run build && bun run verify:artifact"
```

## DAG

```text
T-01
├──> T-02 ──┐
├──> T-03 ──┼──> T-05
└──> T-04 ──┘
```

T-01은 shared candidate contract와 loader ownership을 먼저 확정한다. T-02, T-03, T-04는 서로 다른 write surface에서 병렬로 진행할 수 있으며 T-05가 integrated verification을 소유한다. 첫 dependency-ready task는 T-01이다.

## Step Verification

| Task | 단계 | 검증 방법 | 기대 결과 | 실패 시 처리 |
| --- | --- | --- | --- | --- |
| `T-01` | ordered candidate contract와 loader 변경 | `bun run typecheck` | exact four paths와 loader call graph가 type-safe하게 유지된다. | compile failure의 owner를 수정하고 T-01을 `progress`로 유지한다. public contract가 더 넓어지면 `replan-required`를 검토한다. |
| `T-02` | precedence/legacy regression 추가 | `bun run test:unit -- src/settings/settings-loader.service.spec.ts` | distinct fixture payload가 네 단계 precedence와 legacy ignore를 증명한다. | 실패한 invariant를 수정하고 test evidence 전에는 `done`으로 바꾸지 않는다. |
| `T-03` | E2E 및 fresh-process fixture cutover | `bun run test:e2e -- __test__/__e2e__/skill-registry-extension.e2e-spec.ts` | isolated runtime이 새 direct path를 읽고 기존 registration/prompt assertions를 유지한다. | cwd/home/env 격리를 보정한다. host dependency가 필요하면 exact blocker와 resume state를 기록한다. |
| `T-04` | 문서 및 AGENTS contract 갱신 | 지정된 `rg` stale-path scan | 비역사적 source 문서와 fixture 설명에 legacy candidate가 남지 않는다. | canonical documentation owner를 수정하고 historical evidence는 보존한다. |
| `T-05` | integrated cutover gate | `bun run check` 및 `bun run build && bun run verify:artifact` | source, test, built artifact가 같은 four-path contract를 통과한다. | 실패 원인별 repair task를 추가하고 `execution_status: progress` 또는 `replan-required`를 기록한다. |

### Task Verification

| Task | DoD 항목 | 독립 검증 | 기록할 근거 |
| --- | --- | --- | --- |
| `T-01` | exact candidate order와 legacy candidate 제거 | loader unit test가 노출하는 네 path fixture와 source typecheck | 실행 후 실제 candidate resolution 결과와 typecheck 출력 |
| `T-02` | 네 계층 precedence 및 legacy ignore | focused Jest settings-loader suite | 각 candidate payload의 resolved settings와 legacy-only fallback assertion |
| `T-03` | runtime/artifact fixture가 새 path를 사용 | targeted E2E 및 `verify:artifact` | fresh isolated workspace에서의 pass 결과와 artifact diagnostics |
| `T-04` | 문서 contract 정렬 | stale-path scan과 reviewer inspection | scan 결과 및 수정된 README/AGENTS 경로 목록 |
| `T-05` | integrated acceptance gate | `bun run check`, focused tests, `bun run build && bun run verify:artifact` | 각 명령의 실제 pass output, built `dist/main.js` identity, unverified boundary 기록 |

## 실행 기록

- 현재 task: none
- 완료 task: T-01, T-02, T-03, T-04, T-05
- 실패 또는 미실행 검증: none for the planned acceptance gates.
- Blocker: none. sealed plan의 implementation, 통합 gate, 독립 review를 완료했다.

### Execution Ledger 1 — 2026-08-15

- T-01: `src/shared/skill-registry.constant.ts`, `src/shared/index.ts`, `src/settings/settings-loader.service.ts`를 exact four-path contract로 전환하고 `bun run typecheck`를 통과했다.
- T-02: canonical four-way precedence, `loadPromptSettings()` parity, legacy path rejection, `PI_CODING_AGENT_DIR`/`OMP_AGENT_DIR`/`OMP_AGENT_HOME` non-redirection을 추가하고 focused suite `26 passed`를 확인했다.
- T-03: E2E, artifact verifier, fresh-process parent/child fixture를 canonical `.pi/skill-registry.json`과 workspace propagation으로 전환하고 targeted E2E `4 passed`를 확인했다.
- T-04: `README.md`와 `AGENTS.md`에 exact four-path breaking migration contract를 기록했다. legacy path 언급은 제거 안내와 rejection fixture에만 남겼다.
- T-05 step verification: `bun run check` pass, `bun run build && bun run verify:artifact` pass. Artifact diagnostics는 `indexed=3`, `parsed=3`, `resolvedNames=3`, `missingNames=[]`, `freshProcess=true`였다.
- Independent review: integrated snapshot `integrated-cutover-after-gates-2026-08-15`에 대해 correctness/boundary review wave 진행 중이다.

### Execution Ledger 2 — 2026-08-15 07:07:21 UTC

- Final focused settings suite는 보강된 invalid-candidate fixture를 포함해 `27 passed`였다.
- Final independent review snapshot `integrated-cutover-final-2026-08-15`의 correctness와 cross-module/docs 두 lens가 모두 `clean`으로 종료되었고 open finding은 없다.
- 첫 boundary review에서 관측된 README의 기존 slash command 문구 불일치는 final snapshot 전에 현재 runtime command contract를 설명하도록 보정했다.

# State Ledger

- 현재 plan status: `sealed`
- 현재 execution status: `acceptance`
- plan status와 execution status는 독립적이다. `ready`는 task가 모델링되었다는 뜻이며, `sealed` 전에는 implementation을 승인하지 않는다.
- 이번 revision에서 기록된 findings: none
- repair task: none
- Loop Ledger: none
- acceptance: recorded — exact four-path settings cutover is implemented, focused/runtime/artifact gates pass, and the latest independent review is clean.
- 관측된 evidence: bounded preflight에서 확인한 source, test, fixture, documentation locations; T-01 typecheck; T-02 focused unit `27 passed`; T-03 targeted E2E `4 passed`; T-04 stale-path inspection; T-05 check/build/artifact pass와 planning corpus diagnostics
- 미검증 경계: targeted E2E/artifact harness 밖의 host runtime routing, installed plugin freshness, 실제 machine global settings migration
- residual-risk disposition: installed plugin refresh와 실제 machine global settings migration은 breaking path cutover의 operator 후속 작업으로 남기며, source/runtime acceptance를 차단하지 않는다.
