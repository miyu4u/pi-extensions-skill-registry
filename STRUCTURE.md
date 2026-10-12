# STRUCTURE

- `src/`
  - `main.ts`: tool registration, schema wiring, query-only large-action gating, hook registration을 소유하는 root runtime entrypoint입니다.
  - `schema.ts`: `skill_registry` tool input schema의 single source of truth입니다.
  - `extension.interface.ts`: package-local `PiExtensionContract`를 정의합니다.
  - `service-registry.ts`: concrete service 생성과 dependency wiring을 담당하는 composition root입니다.
  - `commands/`: 공통 command contract와 reindex, discover, diagnostics command service를 소유합니다.
  - `indexing/`: input·scope 정규화, filesystem scan·parse, source freshness, SQLite FTS5 index·snapshot, search·resolve, relation·decision, diagnostics와 packet 생성을 담당합니다.
  - `tokenization/`: English/Korean 문서·query token 정규화와 exact → prefix → English fuzzy 검색 후보 생성을 담당합니다.
  - `prompt/`: settings를 적용해 `before_agent_start`와 `before_provider_request`의 첫 `<skills>` block을 교체합니다.
  - `settings/`: settings lookup·normalization과 prompt 설정 contract를 담당합니다.
  - `results/`: tool result serialization과 unknown `skill://` read 결과의 signature 기반 compaction을 담당합니다.
  - `shared/`: concern 간 공유하는 cross-cutting constant와 type을 보관합니다.
- `__test__/`
  - `__e2e__/`: host runtime의 tool·prompt hook registration과 settings-aware 동작을 검증합니다.
  - `verify/`: built dist, fresh-process isolation과 installed freshness checker의 Bun regression test를 보관합니다.
  - `jest.e2e-config.json`: e2e Jest 실행 설정입니다.
- `scripts/`
  - `verify/`: dist registration harness, planning fixture, freshness checker, fresh-process runner와 artifact·installed 검증 gate를 보관합니다.
- `docs/`
  - `plans/`: implementation plan을 보관합니다.
- `package.json`: plugin entrypoint, dependency와 build·검증 script를 정의합니다.
- `biome.json`: lint와 formatting 설정입니다.
- `tsconfig.json`: standalone TypeScript config입니다. parent workspace file을 extend해서는 안 됩니다.
- `jest.config.json`: local unit-test config입니다.

### STRUCTURE GUIDE

- 구조 목록은 `STRUCTURE.md`에 최대 2-depth로 작성하고, 하위 세부 구현은 concern directory의 역할 설명으로 요약해야 합니다.
- 구조 변경이나 문서와 실제 구조의 차이가 확인되면 `STRUCTURE.md`를 갱신해야 합니다.
