# PI/OMP extension skill-registry

`skill-registry`는 OMP runtime에서 분산된 `SKILL.md` corpus를 검색 가능하고 실행 가능한 skill context로 바꾸는 project-local extension입니다.

## Purpose

에이전트가 모든 skill 본문을 prompt에 미리 넣지 않고도 현재 작업에 필요한 skill을 결정적으로 찾고, 의존 관계를 확장하며, 읽기와 실행에 바로 쓸 packet을 만들 수 있게 합니다.

이 extension은 다음을 일관된 흐름으로 제공합니다.

- 여러 skill root의 `SKILL.md`를 하나의 corpus로 인덱싱
- query 또는 skill name에 맞는 skill 검색과 exact resolve
- `requires`, `recommends`, `related` 관계를 통한 맥락 확장
- 선택 이유, read sequence, handoff, verification 정보를 담은 실행 packet 생성
- runtime skill catalog를 compact guidance로 줄이는 prompt hook 제공

에이전트용 action routing, 입력·출력 판단 기준, deterministic contract는 [AGENTS.md](./AGENTS.md)를 따릅니다.

## Support Features

- **Corpus indexing**: 설정된 root에서 `SKILL.md`를 읽고, agent-scoped SQLite에 전체 parsed snapshot과 validation metadata를 저장합니다.
- **Deterministic search**: SQLite FTS5 `bm25()` ranking에 `score desc → coverage desc → canonical name asc` tie-break를 적용합니다.
- **Name resolution**: canonical name과 `aliases`를 exact resolve와 검색 seed에 함께 반영합니다.
- **Korean and English tokenization**: 원문 token을 보존하면서 한국어 morphology-derived token을 보강하고, 영어에는 exact·prefix 이후 보수적인 Damerau-Levenshtein fuzzy fallback을 적용합니다.
- **Zero-result fallback**: `discover`와 `search`가 0건이면 일반 작업어를 제거한 query rewrite를 한 번만 시도하고 diagnostics를 반환합니다.
- **Relation expansion**: `requires`는 항상 확장하고, `recommends`와 `related`는 `relationMode: "full"`일 때 확장합니다.
- **Task-size-aware routing**: `small`, `medium`, `large` task size에 따라 추천 수와 자동 확장 범위를 제한합니다. `decide`, `plan`, `route`, `current-turn-packet`, `session-packet`, `turn-packet`의 query-only 확장은 `large`에서만 허용합니다.
- **Action families**: find, relation expansion, packet generation, corpus maintenance를 하나의 `skill_registry` tool action으로 제공합니다.
- **Prompt slimming**: `before_agent_start` hook이 runtime `<skills> ... </skills>` block의 첫 번째 항목만 compact registry guidance로 치환합니다.

## How This Work

`src/main.ts`가 runtime entrypoint로서 `skill_registry` tool schema와 query-only large-action gating을 소유하고, concern별 service가 indexing, tokenization, settings, prompt, 결과 직렬화를 담당합니다.

### Dependency structure

```text
                    +-----------------+
                    | OMP runtime     |
                    +--------+--------+
                             |
                             v
                    +-----------------+
                    | src/main.ts     |
                    | tool + hook     |
                    +--+----------+---+
                       |          |
          schema ------+          +------ prompt guidance
                       |
                       v
              +-------------------+
              | indexing services |
              | policy + FTS5 DB  |
              +---+----------+----+
                  |          |
                  v          v
        +--------------+  +----------------+
        | tokenization |  | settings loader|
        +--------------+  +----------------+
                  |
                  v
        +------------------+
        | results helpers  |
        +------------------+
```

`src/schema.ts`는 `skill_registry` tool input schema의 single source of truth입니다.
- `src/service-registry.ts`가 모든 indexing, tokenization, prompt, settings service를 생성해 `SERVICE` 상수로 노출하는 composition root로서 concrete `new` 호출과 의존성 wiring을 단일 지점에서 소유하며, indexing service는 `./indexing` barrel 단일 import로 주입됩니다.
- `src/indexing/`의 capability는 concrete service가 각각 소유합니다: `skill-input-normalizer`가 실행 컨텍스트 정규화, `skill-file-scanner`가 filesystem 수집, `skill-document-parser`가 markdown 파싱, `active-index-store`가 활성 index identity, `skill-index-loader`가 index 생성과 snapshot lifecycle, `skill-search-engine`이 검색·exact resolve·zero-result fallback, `skill-relation-engine`이 relation expansion, `skill-decision-engine`이 decide/plan/route 결정, `skill-index-diagnostics`가 validation·audit, `skill-read-packet-builder`와 `skill-execution-packet-builder`가 packet projection을 담당하고, `skill-search-database.service.ts`가 SQLite schema, snapshot persistence, vocabulary, FTS5 BM25 query를 소유합니다.
- `src/tokenization/`은 query와 document 모두에 같은 tokenization 규칙을 적용합니다.
- `src/settings/`, `src/results/`, `src/prompt/`은 각각 configuration, response serialization, prompt-slimming hook을 담당합니다.

### Data flow

```text
[settings + skill roots]
            |
            v
[SKILL.md frontmatter + body] --> [indexing + tokenization] --> [skill index]
                                                                  |
[user query or names] --> [skill_registry action] ---------------+
                                                                  v
                                            [rank / exact resolve / relations]
                                                                  |
                                                                  v
                                      [results or execution packet + diagnostics]
```

1. settings loader가 skill root, 파일명, cache, response limit을 정규화합니다.
2. skill index가 `SKILL.md` body와 지원 frontmatter를 읽어 tokenized corpus와 relation 정보를 만듭니다.
3. `skill_registry` action이 query 또는 `names`를 받아 search, exact resolve, relation expansion, packet projection 중 하나를 실행합니다.
4. results helper가 검색 결과, 선택 근거, telemetry, validation 또는 agent-ready packet을 직렬화합니다.

### Skill corpus indexing and default discovery

설정을 지정하지 않으면 `skill-registry`는 다음 `roots`를 이 순서대로 사용합니다. 상대 경로는 OMP process의 현재 working directory(`cwd`) 기준으로 해석하고, `~`로 시작하는 경로는 사용자의 home directory로 확장합니다.

| 순서 | 기본 root | 용도 |
| --- | --- | --- |
| 1 | `.pi/skills` | 현재 project의 project-local skills |
| 2 | `.omp/skills` | OMP 작업공간 기본 skills |
| 3 | `.agents/skills` | 다중 agent runtime fallback skills |
| 4 | `~/.pi/agent/skills` | Pi user-level skills |
| 5 | `~/.omp/agent/skills` | OMP user-level skills |
| 6 | `~/.omp/agent/managed-skills` | OMP managed skills |
| 7 | `~/.agents/skills` | 다중 agent fallback skills |

각 root 아래에서 기본 파일명인 `SKILL.md`, `skill.md`, `Skill.md`를 재귀적으로 탐색합니다. 따라서 기본 project-local 위치는 `<omp-cwd>/.pi/skills/**/SKILL.md`이며, 일반적인 skill directory 구조는 `<root>/<skill-name>/SKILL.md`입니다. `SKILL.md`가 root 바로 아래에 있거나 더 깊은 하위 directory에 있어도 파일명이 일치하면 인덱싱 대상입니다.

탐색할 때 다음 directory 이름은 corpus에서 제외합니다.

- `.git`
- `.svn`
- `node_modules`
- `.venv`
- `dist`
- `build`
- `out`

`names`가 없는 일반 query action은 각 root를 full recursive scan합니다. `names`가 지정된 action은 먼저 `<root>/<name>/<fileName>` 및 `<root>/<name>.<extension>` 형태의 직접 경로를 확인하고, 요청된 이름을 모두 직접 찾지 못한 root에 대해서는 full recursive scan으로 fallback합니다. 모든 후보 파일은 regular file이어야 하며, `fileNames`와 basename이 정확히 일치해야 합니다.

여러 root에서 같은 canonical skill name이 발견되면 최신 `mtime`의 항목을 유지하고 나머지는 중복으로 기록합니다. 파일을 읽을 때는 지원되는 frontmatter와 body를 함께 파싱해 이름, alias, 관계, tokenized content를 index entry로 만듭니다. 문서/query는 같은 tokenizer를 통과하고, exact → prefix → 보수적 English fuzzy 순으로 만든 후보를 FTS5 MATCH와 column-weighted `bm25()`로 평가합니다. 외부 score는 SQLite의 음수 rank를 양수 `-bm25()` 방향으로 바꾼 뒤 query variant multiplier를 적용하므로 높을수록 좋은 결과입니다.

기본 index cache TTL은 `60_000ms`입니다. process cache가 없더라도 TTL 안의 SQLite snapshot은 filesystem rescan 없이 복원되며, 최신 파일을 즉시 반영하려면 action 입력에 `refresh: true`를 지정합니다. DB는 agent 전체에서 한 번에 하나의 request snapshot만 보관하고 request key가 달라지면 원자적으로 교체합니다.

#### Settings lookup and overrides

settings loader는 다음 순서로 설정 파일을 찾고, 유효한 JSON을 처음 발견한 파일을 사용합니다.

1. project-local:
   - `.pi/settings/skill-registry/skill-registry.json`
   - `.pi/settings/skill-registry.json`
   - `.pi/settings.json`
2. Pi agent global:
   - `$PI_CODING_AGENT_DIR/settings/skill-registry/skill-registry.json`
   - `$PI_CODING_AGENT_DIR/settings/skillRegistry.json`
   - `PI_CODING_AGENT_DIR`가 없으면 `~/.pi/agent`를 사용합니다.
3. OMP agent global:
   - `$OMP_AGENT_DIR/settings/skill-registry/skill-registry.json`
   - `$OMP_AGENT_DIR/settings/skillRegistry.json`
   - `OMP_AGENT_DIR`와 `OMP_AGENT_HOME`이 모두 없으면 `~/.omp/agent`를 사용합니다.

`OMP_AGENT_DIR`가 설정되면 `OMP_AGENT_HOME`보다 우선합니다. JSON은 다음처럼 top-level `skillRegistry` block으로 감싸거나 settings payload 자체를 바로 사용할 수 있습니다.

```json
{
  "skillRegistry": {
    "roots": ["./skills", "~/.omp/agent/skills"],
    "fileNames": ["SKILL.md"],
    "databasePath": "~/.omp/agent/cache/skill-registry/index.sqlite",
    "cacheTtlMs": 60000
  }
}
```

설정의 `roots`와 `fileNames`는 기본값을 대체합니다. 즉, 명시적 `roots`를 설정하면 기본 root 목록은 그대로 대체되어 `.arcana-local`도 기본값의 포함/제외 여부와 무관하게 요청한 값으로 동작합니다. 또한 tool 입력에 비어 있지 않은 `roots` 또는 `fileNames`를 직접 전달하면 해당 요청에서 settings 값을 override합니다. `databasePath`는 `~`를 home으로 확장하고 상대 경로는 현재 project root를 기준으로 해석합니다. 값이 없으면 `OMP_AGENT_DIR`, `OMP_AGENT_HOME`, `PI_CODING_AGENT_DIR`, `~/.omp/agent` 순서로 agent root를 선택하고 `cache/skill-registry/index.sqlite`를 붙입니다.

SQLite snapshot에는 normalized FTS token뿐 아니라 parsed frontmatter, relation, `SKILL.md` body가 평문으로 저장됩니다. POSIX에서는 cache directory/file mode를 각각 `0700`/`0600`으로 유지합니다. Bun runtime은 built-in `bun:sqlite`를 사용하며, Jest/Node fallback은 `node:sqlite`가 있는 Node `>=22.5.0`을 요구합니다.

## Limits

- `resolve`는 canonical name 또는 alias의 **exact match**만 허용합니다. fuzzy resolve로 동작하지 않습니다.
- 지원 frontmatter는 `aliases`, `requires`, `recommends`, `related`로 한정됩니다.
- relation 규칙은 index service가 소유합니다. packet builder는 ranking 또는 relation 규칙을 우회하지 않습니다.
- Korean/English derived token은 원문 token을 대체하지 않고 보완만 합니다. 영어 fuzzy match는 exact·prefix보다 낮게 평가되며 보수적으로 적용됩니다.
- `minScore`는 양수로 변환한 FTS5 BM25 score에 적용됩니다. 이전 custom K1/B scorer의 절대 score 값과는 호환되지 않습니다.
- SQLite 파일은 disposable cache입니다. 다른 `application_id`의 DB를 덮어쓰거나 손상된 파일을 자동 삭제하지 않으며, `SKILL.md`가 계속 source of truth입니다.
- `small`과 `medium` task에서는 `decide`, `plan`, `route`, `current-turn-packet`, `session-packet`, `turn-packet`의 query-only expansion을 자동으로 실행하지 않습니다. 먼저 `discover`, `search`, `brief`를 사용하거나 `names`를 명시해야 합니다.
- prompt hook은 runtime의 첫 번째 `<skills> ... </skills>` block만 치환합니다.
- 설정은 top-level `skillRegistry` block 또는 파일 전체 payload를 받을 수 있으며, 실제 탐색 경로와 기본값은 `src/settings/settings-loader.service.ts` 및 `src/shared/skill-registry.constant.ts`를 기준으로 합니다.

## License

MIT License.
