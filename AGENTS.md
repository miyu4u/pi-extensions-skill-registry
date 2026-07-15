# SKILL REGISTRY AGENTS.md

## STRUCTURE

- `src`
  - `main.ts` : tool registration, schema wiring, query-only large-action gating, hook registration을 소유하는 runtime entrypoint
  - `extension.interface.ts` : runtime entrypoint를 위한 package-local `PiExtensionContract` 정의
  - `extension/` : 예약된 directory이며 runtime registration ownership은 더 이상 이곳에 두지 않음
  - `service-registry.ts` : 모든 indexing/tokenization/prompt/settings service를 생성하고 `SERVICE`로 노출하는 composition root이며 concrete `new` 호출과 의존성 wiring의 single location
  - `indexing/` : corpus indexing, zero-result fallback, ranking aggregation, relation expansion, packet planning, SQLite FTS5 persistence를 각 concrete service가 소유하며 `./indexing` barrel로 노출
    - `skill-input-normalizer.ts` : tool 입력을 settings 기반 실행 컨텍스트로 정규화
    - `skill-file-scanner.ts` : skill 문서 후보를 filesystem에서 수집
    - `skill-document-parser.ts` : skill markdown과 frontmatter를 `RawSkill` 문서로 변환
    - `active-index-store.ts` : process 활성 index identity와 snapshot token의 단일 mutable owner
    - `skill-index-loader.ts` : skill index 생성, cache, snapshot lifecycle의 concrete owner
    - `skill-search-database.interface.ts` : SQLite snapshot/search lifecycle contract
    - `skill-search-database.service.ts` : 소유하는 SQLite schema, disk snapshot persistence, FTS5 vocabulary/BM25 query, connection lifecycle
    - `skill-search-engine.ts` : search, exact resolve, zero-result fallback의 concrete owner
    - `skill-relation-engine.ts` : `requires`/`recommends`/`related` relation traversal과 projection
    - `skill-decision-engine.ts` : `decide`/`compare`/`recommend`/`plan`/`route` 결정 로직
    - `skill-index-diagnostics.ts` : index validation과 audit report의 concrete owner
    - `skill-read-packet-builder.ts` : read-side packet projection(brief, bundle, session, turn, handoff, recovery, resume)
    - `skill-execution-packet-builder.ts` : serialization/execution packet projection의 concrete owner
  - `tokenization/` : English/Korean token derivation과 공용 query tokenization
  - `prompt/` : `before_agent_start` prompt-slimming hook
  - `settings/` : settings lookup과 normalization
  - `results/` : result serialization helper
  - `shared/` : cross-cutting constant와 type
- `docs`:
  - `research` : 보고서
  - `plans` : 계획 문서

## RULE

- tool registration, schema wiring, query-only large-action gating, hook registration을 직접 소유하는 root runtime entrypoint로 `src/main.ts`를 유지하고, concern module은 directory의 `index.ts` barrel을 통해 노출해야 한다. (MUST)
- barrel을 module boundary에서만 사용하고, circular re-export 위험을 줄이기 위해 same-folder import는 direct import로 유지해야 한다. (MUST)
- feature별 interface를 해당 concern directory 안에 유지하고, `src/shared/`는 cross-cutting constant와 type에만 사용해야 한다. (MUST)
- `skill_registry` tool input schema의 single source of truth를 `src/schema.ts`에 유지해야한다.
- tool schema에는 Google Code Assist API가 지원하지 않는 `trim: true`를 포함해서는 안 됩니다. (MUST)

## CODE STYLE

- 작업 중 이 section에 기록된 규칙에 벗어난 pattern을 발견하면, 동일한 pattern이 적용된 범위를 sweep하여 같은 task에서 함께 refactoring해야 한다. (MUST)
- Comment는 multi-line jsdoc 스타일로 해당 함수, 또는 메소드의 이름이 기계적으로 반복되지 않는 의미 있는 주석이어야합니다.

## COMMAND & VERIFICATION

- `bun run check:fix` : typecheck, lint, formatting
- `bun run test` : unit test, e2e test, sqlite testing
- `bun run build` : build

## HOUSEKEEPING

- Source/runtime ownership이 변경되면 agent는 같은 task에서 이 file을 갱신해야 한다. (MUST)
- Human-facing setup, example 또는 operator mental model이 변경되면 agent는 같은 task에서 `README.md`를 갱신해야 한다. (SHOULD)
