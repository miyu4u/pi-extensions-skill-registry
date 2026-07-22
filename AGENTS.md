<INSTRUCTIONS project="skill-registry">

<directive>
- 해야한다. 해야합니다 : MUST
- 하지 말아야한다. 해서는 안된다 : MUST NOT
- 해야할 필요가 있다 : SHOULD
- 할 수 있다. : COULD, MAY
</directive>

# PROJECT AGENTS.md

## PURPOSE

Pi/OMP runtime에서 여러 `SKILL.md` 문서를 검색 가능한 corpus로 제공하고, 관계 확장과 bounded read·execution packet을 생성하는 extension입니다.

- skill root를 수집해 SQLite FTS5 index를 만들고 BM25 ranking과 deterministic tie-break를 제공합니다.
- canonical name과 alias를 exact resolve하고 `requires`, `recommends`, `related` 관계를 탐색합니다.
- `skill_registry` 하나의 tool과 `before_agent_start`, `before_provider_request` prompt hook을 등록하며 별도 slash command는 등록하지 않습니다.

## STRUCTURE

- `src/`
  - `main.ts`: tool registration, schema wiring, query-only large-action gating, hook registration을 소유하는 root runtime entrypoint입니다.
  - `schema.ts`: `skill_registry` tool input schema의 single source of truth입니다.
  - `extension.interface.ts`: package-local `PiExtensionContract`를 정의합니다.
  - `service-registry.ts`: indexing, tokenization, prompt, settings service를 생성하고 dependency wiring을 담당하는 composition root입니다.
  - `indexing/`: corpus indexing, SQLite FTS5 persistence, search, relation expansion, diagnostics, decision, read packet, execution packet을 담당합니다.
    - `skill-input-normalizer.ts`: tool input을 settings 기반 execution context로 정규화합니다.
    - `skill-file-scanner.ts`: filesystem에서 skill 문서 후보를 수집합니다.
    - `skill-document-parser.ts`: Markdown과 frontmatter를 `RawSkill` document로 변환합니다.
    - `active-index-store.ts`: process 활성 index identity와 snapshot token의 단일 mutable owner입니다.
    - `skill-index-loader.ts`: index 생성, cache, snapshot lifecycle을 담당합니다.
    - `skill-search-database.interface.ts`: SQLite snapshot/search lifecycle contract를 정의합니다.
    - `skill-search-database.service.ts`: SQLite schema, disk snapshot, FTS5 vocabulary/BM25 query, connection lifecycle을 소유합니다.
    - `skill-search-engine.ts`: search, exact resolve, zero-result fallback을 담당합니다.
    - `skill-relation-engine.ts`: `requires`, `recommends`, `related` relation traversal과 projection을 담당합니다.
    - `skill-decision-engine.ts`: `decide`, `compare`, `recommend`, `plan`, `route` decision logic을 담당합니다.
    - `skill-index-diagnostics.ts`: index validation과 audit report를 생성합니다.
    - `skill-read-packet-builder.ts`: brief, bundle, session, turn, handoff, recovery, resume read packet을 projection합니다.
    - `skill-execution-packet-builder.ts`: serialization과 execution packet을 projection합니다.
    - `index.ts`: indexing concern의 module boundary barrel입니다.
  - `tokenization/`: English/Korean token derivation과 공용 query tokenization을 담당하며 `index.ts`로 concern을 노출합니다.
  - `prompt/`: `before_agent_start`와 `before_provider_request` prompt guidance hook을 담당합니다.
  - `settings/`: settings lookup과 normalization을 담당합니다.
  - `results/`: result serialization helper를 제공합니다.
  - `shared/`: cross-cutting constant와 type만 보관하며 `index.ts`로 concern을 노출합니다.
- `__test__/`: e2e test와 e2e Jest configuration을 보관합니다.
- `docs/research/`: research report를 보관합니다.
- `docs/plans/`: implementation plan을 보관합니다.
- `tsconfig.json`: standalone TypeScript config입니다. parent workspace file을 extend해서는 안 됩니다.
- `jest.config.json`: local unit-test config입니다.

### STRUCTURE GUIDE

- 구조는 stale해지기 쉬우므로 변경이 생기거나 관측상 변경이 있는 경우 STRUCTURE 섹션을 갱신해야합니다.

## RULES

- 작업 중 기록된 규칙에 벗어난 pattern을 발견하면, 동일한 pattern이 적용된 범위를 sweep하여 같은 task에서 함께 refactoring해야 한다. (MUST)
- 주의 : 문제가 생겼을 때, git clean revert를 하지 말 것 (변경사항 전체 취소 등)
- tool registration, schema wiring, query-only large-action gating, hook registration을 직접 소유하는 root runtime entrypoint로 `src/main.ts`를 유지
- 기술 용어, 핵심 용어는 알파벳을 유지하면서 서술은 한국어로 합니다.
- 사용자가 지시한 내용은 `AGENTS.md`에 기록한 후 해당 규칙에 따라 작업합니다.
- 작업 중 `AGENTS.md`의 `RULES`에 기술된 규칙에서 `drift` 또는 `stale` 상태인 부분을 발견하면 함께 `sweep`합니다.
- concern module의 외부 노출은 해당 directory의 `index.ts` barrel을 통해 수행하고, module 내부 same-folder import는 direct import를 유지합니다.
- feature별 interface는 해당 concern directory에 두며 `src/shared/`는 cross-cutting constant와 type에만 사용합니다.
- `skill_registry` tool input schema는 `src/schema.ts`만 source of truth로 유지합니다.
- `service-registry.ts`를 concrete service 생성과 dependency wiring의 single location으로 유지합니다.
- query-only large-action은 `small`과 `medium`에서 names 없이 실행하지 않으며, 충분한 query 또는 explicit names를 요구합니다. `large`에서만 해당 query-only action을 허용합니다.

## GUIDE

### HOW TO WRITE COMMENT

- Comment는 multi-line jsdoc 스타일로 해당 함수, 또는 메소드의 이름이 기계적으로 반복되지 않는 의미 있는 주석이어야합니다.
- 작업한 부분 중 const, type, property, function, method에는 multiline jsdoc 형식의 한글 주석을 작성해야합니다.
- comment는 method 또는 const name 의 반복된 서술이여서는 안되며, 구체적인 작동 방식 및 "어떤 역할을 하는지"를 충분히 설명 할 수 있어야합니다.
- property는 각 property에 inline multiline jsdoc으로 작성합니다.

## CODE STYLE

- 에러는 종류에따라 명시적인 Exception Class를 사용합니다.
- 구조는 단순해야하며, 구성 및 흐름이 한눈에 보일 수 있어야합니다.
- by-condition multi return 인 경우, funnel처럼 early return으로 조건이 처리되어야 합니다
- if-else, else if 의 chain 보다는 switch를 우선으로 사용하세요
- 2-depth 이상 if-else block, try-catch block을 사용하지 않습니다.
- arguments로 object를 전달 받은 경우, object내에 property를 inner-method에서 변경하지 않습니다.
- arguments, return result 객체의 타입은 zod schema -> z.infer를 사용한 type 객체를 사용합니다.
  - EX) `const UserSchema = z.object({}); type User = z.infer<typeof UserSchema>`
- Comment는 multi-line jsdoc 스타일로 해당 함수, 또는 메소드의 이름이 기계적으로 반복되지 않는 의미 있는 주석이어야합니다.
- SOLID 원칙을 준수하며, 특히 클래스는 단일 책임 원칙(SRP)에 따라 구현해야 합니다.
- 반드시 interface contract를 먼저 정의하고, 클래스는 해당 interface를 명시적으로 implement 해야 합니다.

### CODE STRUCTURE

- class에 implements로 상속되는 interface는 항상 class code의 바로 위에 위치해야합니다.
  - interface method에는 주석을 작성하고, 해당 interface 구현한 class에는 주석을 작성하지 않습니다.
  - private method는 주석이 있어야 합니다.
- file module 내에 class가 있다면, 재사용 해야하는 함수가 아니라면 function을 file module range로 spreading 하지 않습니다. 파일 내 method 로 흡수합니다.

### NAMING STYLE

- Extension Entrypoint는 `main.ts`에서 `export default`로 반드시 내보내야 합니다.
  - 진입점인 `main.ts`에는 다른 export를 re-export 하지 않습니다.
- Extension Entrypoint 메서드명은 반드시 `register`로 지정합니다.
- 파일명은 반드시 `kebab-case.<type>.ts` 혹은 `kebab-case.ts` 규칙을 따라야 합니다.
  - `<type>`은 파일 역할을 나타내는 단수 명사여야 하며, NestJS 스타일 명명 규칙(e.g., `module`, `service`, `controller`, `provider`, `factory`, `guard`, `interceptor`, `pipe`, `decorator`, `middleware`, `filter`, `exception`, `dto`, `entity`, `repository`, `spec`)을 따라야 합니다.
- 확장 기능 이름을 기계적으로 파일명 prefix로 반복해서는 안 됩니다.
  - 동일 확장 내부에서는 역할을 직접적으로 나타내는 파일명을 사용해, 목적이 명확히 드러나야 합니다(`advisor-...`, `apply-patch-...`와 같은 일반적 prefix 지양).
  - 누구라도 파일명만 보고 확장 내 역할을 유추할 수 있어야 합니다.
- 클래스/interface/type/constant 명칭 역시 NestJS 스타일을 엄격하게 따르며 역할에 맞게 정규화해야 합니다.
  - 예를 들어, `.service.ts`로 끝나는 파일은 반드시 `PascalCaseService`를, `.provider.ts` 파일은 `PascalCaseProvider`를, `.interface.ts` 파일은 `PascalCaseInterface` 또는 명시 규약에 맞는 contract 명칭만을 export 해야 합니다.
- 네이밍 규칙은 반드시 지켜야 하며, 신규 파일/심볼뿐만 아니라 파일을 수정하거나 인접 파일을 건드릴 때에도 꼭 적용해야 합니다. 네이밍 위반을 발견하면 반드시 동시에 수정해야 합니다.
  - 네이밍 위반을 남겨둔 채 기능 추가나 변경을 진행해서는 안 됩니다.

## COMMAND

- `bun run check` : typecheck와 Biome check
- `bun run check:fix` : typecheck, lint, formatting
- `bun run test:unit` : unit test
- `bun run test:sqlite` : SQLite FTS5 database test
- `bun run test:e2e` : e2e test
- `bun run test` : unit, SQLite, e2e test 전체 실행
- `bun run build` : extension bundle build

## VERIFICATION

- `bun run check` 또는 `bun run check:fix`로 typecheck와 Biome 검증을 수행합니다.
- `bun run test:unit`으로 indexing, tokenization, prompt, settings, result serialization contract를 검증합니다.
- `bun run test:sqlite`으로 SQLite schema, snapshot persistence, FTS5 query와 connection lifecycle을 검증합니다.
- `bun run test:e2e`로 host runtime에서 tool과 prompt hook registration을 검증합니다.
- `bun run test`로 위 unit, SQLite, e2e test를 함께 검증합니다.
- `bun run build`로 `src/main.ts` bundle과 host-owned `@earendil-works/*` runtime boundary를 검증합니다.

## CAUTIONS

- tool schema에는 Google Code Assist API가 지원하지 않는 `trim: true`를 포함해서는 안 됩니다.
- host runtime package import는 build/runtime boundary를 먼저 점검해야 합니다.
  - `@earendil-works/pi-coding-agent` 같은 broad runtime package root import는 직접 사용하지 않는 optional/telemetry chain까지 bundle graph로 끌어와 build failure를 만들 수 있습니다.
  - type-only usage는 반드시 `import type`으로 분리하고, narrower subpath import가 가능하면 root import보다 우선합니다.
  - extension이 host runtime 위에서 실행되는 구조라면 해당 package는 bundle에 포함하지 말고 build 단계에서 `--external` 처리해 host-owned boundary를 유지합니다.
- schema/helper-only import는 broad runtime package root entry에 기대면 안 됩니다.
  - `schema.ts`, `tool-schema.constant.ts` 같은 schema 정의 파일에서 `Type`, `StringEnum` 류 helper만 필요할 때는 `@sinclair/typebox` 직접 import와 file-local helper를 우선합니다.
  - `@earendil-works/pi-ai` 같은 broad runtime package root import는 transitive runtime dependency를 bundle에 끌어들여 extension load failure를 만들 수 있으므로 schema-only 용도로 사용하지 않습니다.
- SQLite file은 cache이며 원본은 filesystem의 skill document입니다. index persistence를 source of truth로 취급하지 않습니다.
- 검색 결과가 없을 때 임의의 skill을 선택하지 않고 safe-zero diagnostics를 반환해야 합니다.

## HOUSE KEEPING

- Source/runtime ownership이 변경되면 agent는 같은 task에서 이 file을 갱신해야 한다. (MUST)
- Human-facing setup, example 또는 operator mental model이 변경되면 agent는 같은 task에서 `README.md`를 갱신해야 한다. (SHOULD)
---

## APPENDED RULES


<INSTRUCTIONS project="">
