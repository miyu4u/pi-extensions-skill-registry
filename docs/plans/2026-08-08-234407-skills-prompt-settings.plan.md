---
plan_name: "skills-prompt-settings"
status: "completed"
mode: "deep"
authoring_phase: "upgrade"
created_at: "2026-08-08T23:44:07+09:00"
updated_at: "2026-08-08T15:26:06Z"
goal: "skills block replacement controls and configurable persistent skill prompt guidance"
budgets:
  max_document_lines: 560
  max_action_tasks: 12
  max_parallel_lanes: 4
  appended_policy: "compact-then-split"
---

<MUST> 해당 plan 파일을 진행상황 관리 board로 사용해야합니다 </MUST>

# Skills Prompt Settings

## Human Review Block

### 목표

- `<skills>` 첫 block replacement를 settings 기반으로 제어하고, custom prompt와 자주 쓰는 skill names를 안전하게 반영한다.

### 간략한 브리핑 설명

- 현재 두 prompt hook은 static `SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK`으로 항상 치환한다.
- `skillsPromptEnabled`는 기본 `true`로 기존 동작을 보존하고, `skillsPrompt`가 없으면 extension default body를 사용한다.
- `promptSkillNames`는 기존 indexing 전용 `presetSkills`와 분리해 prompt에만 deterministic하게 남긴다.

### 기능별 작업 계약

#### 1. `<skills>` block replacement on/off toggle

- 설정 입력: `skillRegistry.skillsPromptEnabled`를 추가하고 기본값은 `true`로 둔다. boolean `false`만 replacement를 끄며, `null`·문자열 등 invalid value는 기존 동작을 보존하도록 `true`로 fallback한다.
- production 작업: `PromptGuidanceService`에 settings 조회와 early return을 추가해 `handleBeforeAgentStart`와 `handleBeforeProviderRequest` 양쪽을 모두 pass-through로 만든다. `main.ts`의 hook registration ownership은 유지한다.
- 검증 작업: string system prompt, provider `instructions`, system/developer `messages`, text-part payload 각각에서 off는 원문/identity를 보존하고 on은 기존 first-block replacement를 유지하는지 테스트한다.

#### 2. 외부 settings prompt와 built-in fallback

- 설정 입력: `skillRegistry.skillsPrompt`를 body text로 추가한다. non-empty 값은 custom prompt로 사용하고 missing/blank/invalid 값은 extension의 built-in guidance body로 fallback한다.
- production 작업: prompt builder가 body에 `<skills>` outer markers를 붙이고 첫 `<skills>...</skills>` block만 교체하도록 한다. custom prompt가 전체 marker를 중복 생성하지 않도록 body contract를 문서화하고 compatibility normalization을 구현한다.
- 검증 작업: custom text가 그대로 들어가는지, blank 설정이 built-in으로 돌아가는지, 두 번째 block과 marker 없는 payload가 보존되는지 확인한다.

#### 3. settings 지정 skill names의 prompt 상주

- 설정 입력: `skillRegistry.promptSkillNames`에 `["planning", "typescript-code-style"]`처럼 순서를 가진 names를 받는다. trim, empty 제거, 중복 제거 후 입력 순서를 보존한다.
- production 작업: prompt builder가 names를 built-in/custom block의 deterministic 안내 line에 삽입한다. 기존 `presetSkills`는 indexing filter로만 남기고 prompt에서 참조하지 않는다.
- 검증 작업: names가 prompt에 남고 order/dedupe가 지켜지는지, 빈 배열과 whitespace-only 값이 추가 line을 만들지 않는지, `presetSkills` indexing 동작이 변하지 않는지 확인한다.

#### 구현 순서와 파일 산출물

- `src/settings/`에 prompt settings contract와 loader normalization을 추가한다.
- `src/prompt/prompt-guidance.service.ts`에 toggle gate와 custom/default/names renderer를 순서대로 구현하고 `src/service-registry.ts`에서 `SettingsLoader`를 주입한다.
- `src/settings/*.spec.ts`, `src/prompt/*.spec.ts`, `src/main.spec.ts`, `__test__/__e2e__/`에 위 세 기능의 독립 acceptance를 추가한다.
- `README.md`, `AGENTS.md`, `package.json`에 settings example, structure ownership, `bun run test:runtime` entrypoint를 반영한다.

```json
{
  "skillRegistry": {
    "skillsPromptEnabled": true,
    "skillsPrompt": "Use the registry when specialized knowledge is needed.",
    "promptSkillNames": ["planning", "typescript-code-style"]
  }
}
```

#### 기능별 완료 판정

- Toggle: boolean `false`에서는 두 hook 모두 원문을 유지하고, default 또는 invalid fallback `true`에서는 기존 built-in replacement가 회귀 없이 동작한다.
- Prompt override: non-empty custom body가 built-in을 대체하고, 설정 누락/blank/invalid는 built-in으로 돌아간다.
- Persistent names: configured names가 custom/default prompt 안에 한 번씩 남고 `presetSkills` indexing semantics에는 side effect가 없다.


### NEED DECISIONS

- 없음: 열린 결정 없음

### AS IS

- Settings는 indexing pipeline으로만 흐르고, `PromptGuidanceService`는 settings를 읽지 않는다.
- ASCII Graph:

```text
settings.json -> SettingsLoader -> SkillInputNormalizer -> IndexLoader
main hooks -> PromptGuidanceService -> static SKILL_REGISTRY_PROMPT_GUIDANCE_BLOCK
```

### TO BE

- `SettingsLoader.loadPromptSettings()`가 동일한 settings precedence로 prompt controls를 정규화하고, prompt service가 두 hook에서 매번 조회한다.
- `enabled=false`는 pass-through, enabled 상태에서 `skillsPrompt`가 없으면 built-in default, `promptSkillNames`는 두 source 모두에 deterministic line으로 추가한다.
- ASCII Graph:

```text
settings.json -> loadPromptSettings -> PromptGuidanceService
                                      -> disabled: pass-through
                                      -> enabled: custom || default + promptSkillNames
main hooks --------------------------> first <skills> block only
```

### DoD

- `skillsPromptEnabled`, `skillsPrompt`, `promptSkillNames`의 default, precedence, invalid-value fallback이 settings tests로 증명된다.
- 두 hook이 off에서는 원문을 유지하고, on에서는 custom/default prompt와 configured names를 첫 block에만 반영한다.
- `presetSkills`는 indexing semantics를 유지하며 prompt names 설정과 섞이지 않는다.
- `bun run test:runtime`와 targeted unit test, `bun run check`가 통과하고 README/AGENTS가 실제 설정 계약과 일치한다.

### Evidence Pack

- `src/prompt/prompt-guidance.service.ts`: 현재 첫 `<skills>` block replacement와 provider payload traversal.
- `src/settings/settings-loader.service.ts`: settings file precedence와 normalization boundary.
- `src/shared/skill-registry.constant.ts`: built-in prompt markers와 default guidance.
- `src/prompt/prompt-guidance.service.spec.ts`, `__test__/__e2e__/skill-registry-extension.e2e-spec.ts`: current prompt hook evidence.
- `README.md`, `package.json`: operator settings와 verification entrypoint ownership.

### 리뷰 포인트

- Fragile: 첫 block만 바꾸는 규칙, string/array/provider message shape, malformed marker의 no-op을 점검한다.
- Drift: raw settings key, normalized `PromptGuidanceSettings`, default prompt body, README 예시가 서로 어긋나지 않는지 점검한다.
- Regression: default-on 호환성, `presetSkills` indexing filter, non-system/user message 보호를 점검한다.
- Border value: blank/invalid prompt, empty/duplicate/whitespace names, toggle false, missing end marker를 점검한다.
- 예상되는 포인트만으로 리뷰 범위를 한정해서는 안 된다. 구현 중 드러나는 추가 위험도 함께 점검한다.

### Decision Tree

- DT-1 prompt settings ownership
  - considered_options:
    - 권고: settings concern에 `loadPromptSettings()`를 추가해 indexing cache와 prompt controls를 분리
    - 대안: `SkillRegistrySettings`에 prompt fields를 넣고 SQLite metadata까지 확장
  - chosen_path: 별도 `PromptGuidanceSettings` contract와 loader method
  - rationale: prompt 변경이 index cache identity를 불필요하게 무효화하지 않고 기존 `presetSkills` 의미를 보존한다.
  - drift_guard: settings candidate precedence와 fallback normalization은 기존 `loadSettings()`와 동일하게 유지한다.
  - blocker_fallback:
    - blocker: 공통 raw settings parser를 재사용할 수 없어 precedence drift가 생긴다.
    - fallback: loader 내부 raw payload reader를 먼저 공통화한 뒤 두 normalization path가 같은 candidate list를 사용한다.
  - feedback_received: no

- DT-2 replacement prompt shape
  - considered_options:
    - 권고: settings `skillsPrompt`는 body text로 받고 service가 `<skills>` markers를 소유
    - 대안: settings가 완성된 `<skills>...</skills>` block 전체를 소유
  - chosen_path: body text를 trim한 뒤 markers와 names line을 deterministic하게 조립
  - rationale: custom prompt가 malformed marker를 만들지 않고 existing first-block contract를 유지한다.
  - drift_guard: 빈 body는 built-in default로 fallback하며 outer marker는 항상 extension이 생성한다.
  - blocker_fallback:
    - blocker: 기존 operator 설정이 full block text를 이미 사용한다.
    - fallback: 한 겹의 outer markers만 인식해 body로 normalize하고 동일한 output contract를 유지한다.
  - feedback_received: no

- DT-3 persistent skill names
  - considered_options:
    - 권고: prompt 전용 `promptSkillNames`를 trim/dedupe해 built-in/custom prompt에 추가
    - 대안: 기존 indexing 전용 `presetSkills`를 prompt에도 재사용
  - chosen_path: `promptSkillNames`를 새 prompt-only setting으로 도입
  - rationale: indexing 대상 제한과 prompt visibility는 독립 요구이며 한 설정의 side effect를 피한다.
  - drift_guard: names는 index resolve 결과가 아니라 settings 입력을 deterministic order로 표현한다.
  - blocker_fallback:
    - blocker: prompt-only setting을 추가할 수 없는 host settings boundary가 확인된다.
    - fallback: toggle/custom prompt를 먼저 독립 출시하고 names embedding은 별도 replan으로 분리한다.
  - feedback_received: no

## Agent Working Block

### Scope / Non-goals

- In scope: settings normalization contract, prompt service DI/rewrite, unit/runtime tests, README/AGENTS/package verification wiring.
- Non-goals: tool schema/action 변경, indexing ranking/relations 변경, host runtime source 변경, `presetSkills` aliasing.

### Assumption Register

- A1: 실행 주체는 long-context에 약하고 약 40 turns / 5분 내외 soft cutoff lifetime을 가진 agents swarm이다.
- A2: settings body-only contract와 prompt-only names contract는 implementation 전에 고정된다.

### Guardrail

#### 경고

- main.ts는 hook registration owner로 유지하고 prompt business logic을 이관하지 않는다.
- `skillsPromptEnabled=false`에서는 before-agent/provider 양쪽 모두 payload를 복제·변경하지 않고 `undefined`/pass-through를 반환한다.
- `presetSkills`를 `promptSkillNames`의 alias로 만들거나 indexing cache에 prompt controls를 섞지 않는다.

#### 주의

- 설정 파일 후보 precedence, string trim/dedupe, names order, first-block-only와 malformed-marker no-op을 기존 contract와 함께 유지한다.
- 새 settings interface와 service에는 project Korean JSDoc/naming/barrel 규칙을 적용하고, source ownership 변경 시 AGENTS.md STRUCTURE를 갱신한다.
- runtime-composed prompt output이 바뀌므로 unit evidence만으로 완료 처리하지 않고 `bun run test:runtime` gate를 남긴다.

### Nested Decomposition

- `T1` settings contract and toggle behavior
  - `T1.1` `skillsPromptEnabled` normalization and both-hook early-return gate
  - `T1.2` `skillsPrompt` custom body and built-in fallback renderer
  - `T1.3` `promptSkillNames` normalization and deterministic prompt insertion
- `T2` integration, tests, and operator contract
  - `T2.1` service wiring and feature acceptance tests
  - `T2.2` runtime gate, README, and structure documentation

### Board

- [x] `T1.1` toggle settings와 두 hook no-op gate 구현 (`src/settings/`, `src/prompt/`; depends_on: none)
  - DoD:
    - [x] `skillsPromptEnabled`의 default `true`, invalid fallback, settings precedence가 구현되었다.
    - [x] disabled 상태에서 `before_agent_start`와 `before_provider_request`가 payload를 변경하지 않는 gate가 구현되었다.
  - expected_file_ownership:
    - `src/settings/prompt-guidance-settings.interface.ts`
    - `src/settings/settings-loader.interface.ts`
    - `src/settings/settings-loader.service.ts`
    - `src/prompt/prompt-guidance.service.ts`

- [x] `T1.2` external `skillsPrompt`와 built-in fallback renderer 구현 (`src/prompt/`, `src/shared/`; depends_on: T1.1)
  - DoD:
    - [x] non-empty custom body, blank/invalid fallback, outer marker normalization이 구현되었다.
    - [x] 첫 `<skills>` block만 교체하고 두 번째 block, marker 없는 입력, malformed input의 기존 보존 규칙이 유지된다.
  - expected_file_ownership:
    - `src/prompt/prompt-guidance.service.ts`
    - `src/shared/skill-registry.constant.ts`
    - `src/prompt/prompt-guidance.interface.ts`

- [x] `T1.3` `promptSkillNames` normalization과 prompt insertion 구현 (`src/prompt/`, `src/settings/`; depends_on: T1.2)
  - DoD:
    - [x] names가 trim/empty 제거/dedupe 후 입력 순서로 built-in/custom prompt에 삽입된다.
    - [x] `presetSkills`를 읽거나 변경하지 않고 empty names에서는 추가 line이 생성되지 않는다.
  - expected_file_ownership:
    - `src/prompt/prompt-guidance.service.ts`
    - `src/settings/settings-loader.service.ts`
    - `src/shared/skill-registry.constant.ts`

- [x] `T2.1` service wiring과 세 기능 acceptance tests 작성 (`src/service-registry.ts`, `src/**/*.spec.ts`; depends_on: T1.3)
  - DoD:
    - [x] `SettingsLoader`가 prompt service에 주입되고 두 hook에서 동일한 normalized settings가 사용된다.
    - [x] toggle, custom/default fallback, names persistence, `presetSkills` non-regression이 observable assertion으로 검증되었다.
  - expected_file_ownership:
    - `src/service-registry.ts`
    - `src/settings/settings-loader.service.spec.ts`
    - `src/prompt/prompt-guidance.service.spec.ts`
    - `src/main.spec.ts`

- [x] `T2.2` runtime/operator verification contract 갱신 (`package.json`, `README.md`, `AGENTS.md`, `__test__/__e2e__/`; depends_on: T2.1)
  - DoD:
    - [x] `bun run test:runtime`가 registered hooks에서 세 settings 기능의 최종 prompt output을 검증한다.
    - [x] README 설정 예시, AGENTS STRUCTURE, `bun run check` evidence가 실제 key/file ownership과 일치한다.
  - expected_file_ownership:
    - `package.json`
    - `README.md`
    - `AGENTS.md`
    - `__test__/__e2e__/skill-registry-extension.e2e-spec.ts`

### DAG

- [x] `T1.1` (L1; depends_on: none)
  - DoD:
    - [x] toggle settings와 두 hook gate exit condition이 검증되었다.
- [x] `T1.2` (L2; depends_on: T1.1)
  - DoD:
    - [x] custom/default prompt replacement exit condition이 검증되었다.
- [x] `T1.3` (L3; depends_on: T1.2)
  - DoD:
    - [x] prompt skill names insertion exit condition이 검증되었다.
- [x] `T2.1` (L4; depends_on: T1.3)
  - DoD:
    - [x] service wiring과 feature acceptance exit condition이 검증되었다.
- [x] `T2.2` (L5; depends_on: T2.1)
  - DoD:
    - [x] runtime/operator evidence exit condition이 검증되었다.
- critical_path: T1.1 -> T1.2 -> T1.3 -> T2.1 -> T2.2
- review_gates: T2.1, T2.2

### Loop Ledger

- canonical_skill: `loop`
- min_loops: 3
- effective_max_loops: 10
- final_status: `success`
- plan_sufficiency: preflight passed; executable TODO, scope, and validation were present
- guardrail_summary: `main.ts` hook registration remained the owner; `presetSkills` stayed indexing-only; host runtime source and index cache schema were untouched

#### Loop 1: T1 source implementation

- checkpoint before: `preflight` passed with `min_loops=3` and `effective_max_loops=10`
- plan slice / TODO: `T1.1` toggle normalization and gate, `T1.2` custom/default renderer, `T1.3` prompt names normalization
- build summary: added `PromptGuidanceSettings`, `loadPromptSettings()`, settings precedence reuse, prompt DI, custom/built-in block assembly, marker compatibility, and both-hook pass-through
- validation result: targeted unit run exposed a whitespace-only names fixture mismatch; after correcting the fixture, 3 suites and 36 tests passed. `bun run typecheck` passed.
- review bucket: actionable improvement, provider/runtime registration coverage was carried forward to Loop 2
- guardrail status: closed
- checkpoint after: `L1-source-unit-pass`
- observability trace: `preflight -> build -> validation -> review -> checkpoint`
- retry / idempotency: deterministic test failure fixed once; no migration or external side effect was retried
- verification ladder: `required=targeted-unit`; `highest_proven=local-proof`
- carry-forward: registered `before_provider_request` acceptance and operator documentation
- self_improvement_audit: `no-change`; repeated_pattern=none; count_or_evidence=source and targeted unit coverage; action=none; changed_skill_or_script=none; deferred_reason=none

#### Loop 2: T2 integration and runtime contract

- checkpoint before: `L1-source-unit-pass`
- plan slice / TODO: `T2.1` service wiring and acceptance tests, `T2.2` runtime harness, package entrypoint, README, and AGENTS ownership
- build summary: expanded `main.spec.ts` and runtime harnesses for both hooks, added custom/default/names/disabled runtime cases, restored `test:verify`, and documented settings ownership
- validation result: the first `bun run test:runtime` attempt found a deterministic harness gap, `registerCommand` was absent from the e2e fake API. After adding it, the runtime gate passed with 1 suite and 4 tests.
- review bucket: blocker, resolved within this loop
- guardrail status: closed
- checkpoint after: `L2-runtime-gate-pass`
- observability trace: `build -> validation(fail) -> review -> build(fix) -> validation(pass) -> checkpoint`
- retry / idempotency: one deterministic test-harness correction; no production side effect was repeated
- verification ladder: `required=runtime-composition`; `highest_proven=runtime-composition`
- carry-forward: final formatting, preset/indexing coexistence assertion, and plan validator status
- self_improvement_audit: `no-change`; repeated_pattern=none; count_or_evidence=runtime harness pass; action=none; changed_skill_or_script=none; deferred_reason=none

#### Loop 3: final review and plan closure

- checkpoint before: `L2-runtime-gate-pass`
- plan slice / TODO: close review findings, prove `presetSkills` coexistence, run final gates, and close the plan board
- build summary: preserved null settings payload compatibility, added explicit `presetSkills` plus prompt settings coexistence assertion, applied import/format fixes, and recorded this loop ledger
- validation result: final targeted unit passed with 3 suites and 36 tests; `bun run test:runtime` passed with 1 suite and 4 tests; `bun run check` passed; `validate-plan ... --json` passed with `status=ok` and no diagnostics
- review bucket: no-action after resolving formatting, status vocabulary, and indexing-only regression evidence gaps
- guardrail status: closed
- checkpoint after: `L3-terminal-success`
- observability trace: `build -> validation -> review -> guardrail -> final`
- retry / idempotency: formatting/check and plan-status corrections were deterministic and completed before terminal validation
- verification ladder: `required=runtime-composition`; `highest_proven=runtime-composition`
- carry-forward: none
- self_improvement_audit: `applied`; repeated_pattern=sealed prompt-settings loop execution; count_or_evidence=three-loop completion; action=created optimized managed skill; changed_skill_or_script=`skill-registry-prompt-settings-loop`; deferred_reason=none

### Loop Final Summary

- completion_status: `success`
- total_loops: 3
- last_review_bucket: `follow-up`
- last_verification_ladder: `required=runtime-composition`; `highest_proven=runtime-composition`; `open verification gap=artifact-verifier-prompt-hook-coverage`
- checkpoint_resume_state: terminal at `L3-terminal-success`; no resume required
- trace_summary: all required `preflight`, `build`, `validation`, `review`, `guardrail`, `checkpoint`, and `final` events recorded above
- guardrail_summary: closed
- human_review_gate: `approve` for plan DoD; post-review decision is `needs-follow-up` for non-blocking artifact verifier coverage
- resume_replay_safety: safe; only deterministic test/format/plan corrections were retried
- observability_summary: command-level evidence is recorded in each loop validation result
- replan_required: no

### Verification / Rollback

- Verification:
  - `bun run test:unit -- src/settings/settings-loader.service.spec.ts src/prompt/prompt-guidance.service.spec.ts src/main.spec.ts`
  - `bun run test:runtime`
  - `bun run check`
  - `bash /Users/miyu/code/spell-book/skills/10-discovery-planning/planning/scripts/planning.sh validate-plan docs/plans/2026-08-08-234407-skills-prompt-settings.plan.md --json`
- Rollback:
  - settings loader method, prompt DI, and prompt renderer changes are scope-local; restore static default renderer and remove only the new prompt settings fields/tests/docs.
  - do not modify host runtime source or indexing cache schema during rollback.

### Replan / Review Queue


- Replan trigger: deep budget(560 lines/12 action tasks/4 lanes), A1 lifetime, or repeated validator/runtime failures are exceeded.
- Review queue:
  - confirm body-only `skillsPrompt` compatibility before implementation starts.
  - inspect newly discovered provider payload shapes beyond the current test fixtures.

### Post-Review Follow-up

- confirmed_blocker: none
- decision: `needs-follow-up`
- follow_up: extend `scripts/verify/dist-harness.ts` and `scripts/verify/verify-artifact.ts` to exercise built `before_agent_start` and `before_provider_request` prompt settings behavior.
- artifact_policy: `dist` is generated and ignored; `package.json` `verify:pr` runs `bun run build` before artifact verification, and rebuilt bundle prompt parity passed during review.
- rationale: source and rebuilt runtime behavior are proven; artifact-level prompt coverage remains unautomated and is not a release blocker.

## APPENDED

- Compact notes:
  - Current `presetSkills` remains indexing-only; this plan intentionally introduces prompt-only settings.
- User feedback: 세 기능별 설정 key, production 작업, 테스트 대상, 완료 판정을 Human Review Block과 atomic leaf에 명시했다.
- Test evidence follow-up:
  - [x] 설정 파일 부재 시 `skillsPromptEnabled=true` 기본값을 단독 테스트로 검증했다.
  - [x] `null`·숫자·객체·배열 등 strict `false` 이외 invalid toggle의 `true` fallback을 parameterized test로 검증했다.
  - [x] disabled provider payload의 `instructions`, system/developer messages, text-part content에 대한 pass-through 및 직렬화 보존을 세분화해 검증했다.
  - validation: targeted unit 3 suites/43 tests, `bun run test:runtime` 1 suite/4 tests, `bun run check` passed.
  - residual: built artifact verifier의 prompt-hook parity 자동화는 기존 Post-Review Follow-up으로 남겨 둔다.
