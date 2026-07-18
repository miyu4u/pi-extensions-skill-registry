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

| 순서 | 기본 root                     | 용도                                |
| ---- | ----------------------------- | ----------------------------------- |
| 1    | `.pi/skills`                  | 현재 project의 project-local skills |
| 2    | `.omp/skills`                 | OMP 작업공간 기본 skills            |
| 3    | `.agents/skills`              | 다중 agent runtime fallback skills  |
| 4    | `~/.pi/agent/skills`          | Pi user-level skills                |
| 5    | `~/.omp/agent/skills`         | OMP user-level skills               |
| 6    | `~/.omp/agent/managed-skills` | OMP managed skills                  |
| 7    | `~/.agents/skills`            | 다중 agent fallback skills          |

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
#### 탐색 방식

`skill-registry`의 “결정적으로 찾기”는 LLM이 매번 임의로 skill을 선택한다는 뜻이 아니라, 동일한 settings와 index snapshot에서 같은 query를 동일한 규칙으로 평가해 재현 가능한 결과를 반환한다는 뜻입니다.

검색은 다음 순서로 수행됩니다.

1. **입력 정규화**: `query`의 공백을 정리하고, `names`를 정규화·중복 제거합니다. `roots`, `fileNames`, `limit`, `taskSize`, `minScore`는 settings와 task-size 제한에 맞게 정규화합니다.
2. **index snapshot 구성**: 각 root에서 `SKILL.md` 후보를 수집하고 frontmatter, alias, relation, title, description, keywords, tags, body를 파싱해 index에 저장합니다. 여러 root에서 같은 canonical name이 발견되면 최신 `mtime`의 항목을 유지합니다.
3. **동일 tokenizer 적용**: 문서와 query에 같은 tokenizer를 적용합니다. query token마다 exact 후보를 먼저 찾고, 없으면 prefix 후보를 찾으며, 영어 token에 한해 제한적인 Damerau-Levenshtein fuzzy 후보를 마지막으로 추가합니다. 한국어 morphology-derived token은 원문 token을 보완합니다.
4. **BM25 scoring**: SQLite FTS5에서 canonical name, alias, title, description, keywords/tags, body를 column weight와 함께 검색합니다. 각 query token의 최선 variant score를 합산하고, 매칭된 query token 수를 `coverage`로 계산합니다.
5. **고정된 tie-break**: 결과는 `score desc → coverage desc → canonicalName asc` 순으로 정렬한 뒤 `limit`만큼 반환합니다. 따라서 score와 coverage가 같은 후보도 canonical name 사전순으로 동일하게 정렬됩니다.
6. **zero-result fallback**: 첫 검색이 0건이면 운영성 stop word를 제거한 query rewrite를 한 번만 시도합니다. 그래도 결과가 없으면 `safe-zero` diagnostics를 반환하고 임의의 skill을 선택하지 않습니다.

따라서 같은 `roots`, `fileNames`, query, settings, index snapshot을 사용하면 같은 결과 순서를 얻습니다. 이는 검색 결과의 **재현성**을 보장하는 규칙이며, query와 skill body의 의미적 적합성까지 보장한다는 뜻은 아닙니다. 파일 변경, `refresh: true`, settings 변경, alias/body 변경이 있으면 새 snapshot에 따라 결과가 달라질 수 있습니다.


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

## Tools

이 extension이 OMP runtime에 등록하는 custom tool은 `skill_registry` 하나입니다. tool label은 `Skill Registry`이고, corpus를 인덱싱·검색하고, skill 관계를 확장하며, agent-ready packet과 corpus diagnostics를 만드는 단일 entrypoint입니다.

### `skill_registry`

호출 형태는 다음과 같습니다.

```json
{
  "action": "discover",
  "query": "security review",
  "taskSize": "medium",
  "limit": 5
}
```

#### Input schema

| 필드                      | 타입 및 제약                 | 설명                                                              |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| `action`                  | required enum                | 아래 action catalog 중 하나                                       |
| `query`                   | `string`, 최대 1024자        | 검색어 또는 작업 설명                                             |
| `names`                   | `string[]`, 각 항목 최소 1자 | canonical name 또는 alias. 입력 순서를 보존하는 action도 있습니다 |
| `roots`                   | `string[]`, 각 항목 최소 1자 | skill root. 지정하면 settings/default root를 해당 요청에서 대체   |
| `fileNames`               | `string[]`, 각 항목 최소 1자 | 탐색할 skill 문서 basename                                        |
| `limit`                   | `number`, 1..200             | 결과와 packet 폭. task size와 settings의 `maxTopK`로 다시 제한    |
| `taskSize`                | `"small"`                    | `"medium"`                                                        | `"large"`                                               | 추천 폭과 query-only expansion 정책 |
| `refresh`                 | `boolean`                    | `true`이면 filesystem을 다시 스캔하여 index snapshot 갱신         |
| `minScore`                | `number`, 0..1000            | 양수로 변환한 BM25 score 하한                                     |
| `includeBody`             | `boolean`                    | 결과에 skill body를 포함할지 여부                                 |
| `includePreviewBodyChars` | integer, 20..5000            | 검색 결과 preview body 길이 override                              |
| `relationMode`            | `"required"`                 | `"full"`                                                          | `requires`만 확장하거나 `recommends`·`related`까지 확장 |
| `graphMode`               | `"outbound"`                 | `"inbound"`                                                       | `"cycles"`                                              | `"orphans"`                         | relation graph 조회 방향 또는 diagnostics 모드 |
| `budgetChars`             | integer, 200..200000         | read/execution packet의 문자 예산                                 |
| `budgetTokens`            | integer, 50..50000           | read/execution packet의 token 예산                                |
| `coverageThreshold`       | `number`, 0..1               | `gap` action의 query coverage 판정 기준                           |

`query`, `names`, `roots`, `fileNames`는 설정과 action에 맞게 정규화됩니다.

기본값은 `taskSize: "medium"`, `limit: 5`, `refresh: false`, `minScore: 0`, `budgetChars: 4000`, `budgetTokens: 1000`, `coverageThreshold: 0.7`, `graphMode: "outbound"`입니다.

`includeBody`는 `resolve`에서 `false`, 그 외 action에서 `true`가 기본값입니다. `relationMode`는 `large` task에서 `full`, 그 외 task에서 `required`가 기본값입니다.

`small`과 `medium` task에서 `names` 없이 `decide`, `plan`, `route`, `current-turn-packet`, `session-packet`, `turn-packet`을 query로 호출하면 차단됩니다. 이 query-only expansion은 `taskSize: "large"`에서만 허용되며, 작은 작업에서는 먼저 `discover`, `search`, `brief`를 호출하거나 `names`를 명시해야 합니다.

#### Action catalog

| 범주                | action                | 동작                                                                                                                |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Index and search    | `index`               | 현재 roots에서 index를 만들고 skill 수, 중복, snapshot 요약을 반환                                                  |
|                     | `discover`            | query로 skill 후보를 찾고 zero-result diagnostics를 포함해 compact discovery 결과 반환. `query` required            |
|                     | `search`              | BM25 기반 ranked search 결과 반환. `query` required                                                                 |
|                     | `select`              | query와 일치하는 skill의 body 중심 결과 반환. `query` required                                                      |
| Exact and relations | `resolve`             | `names`의 canonical name/alias exact resolve. `names` required                                                      |
|                     | `compose`             | query 또는 `names`에서 seed를 만들고 relation expansion plan 반환. 둘 중 하나 required                              |
|                     | `graph`               | relation graph를 outbound, inbound, cycles, orphans 모드로 조회. `outbound`·`inbound`는 query 또는 `names` required |
| Decision            | `gap`                 | query가 현재 corpus에서 얼마나 covered되는지 평가하고 후보 skill 또는 scaffold action 제안. `query` required        |
|                     | `explain`             | 선택된 seed, ranking, relation 경로와 누락 정보를 설명. query 또는 `names` required                                 |
|                     | `decide`              | 작업에 사용할 skill의 우선순위와 선택 근거 결정. query 또는 `names` required                                        |
|                     | `plan`                | relation과 task phase를 반영한 read/작업 순서 계획 생성. query 또는 `names` required                                |
|                     | `route`               | skill을 작업 phase별로 routing한 계획 생성. query 또는 `names` required                                             |
|                     | `compare`             | query 또는 `names`로 선택된 skill 후보를 비교. query 또는 `names` required                                          |
|                     | `recommend`           | seed skill과 relation을 기준으로 인접 skill 추천. query 또는 `names` required                                       |
| Read packets        | `brief`               | 선택 skill의 bounded brief packet 생성. query 또는 `names` required                                                 |
|                     | `bundle`              | 선택 skill body와 relation context를 묶은 bounded agent-ready bundle 생성. query 또는 `names` required              |
|                     | `pack`                | query 또는 `names` 기반의 bounded skill packet 생성. query 또는 `names` required                                    |
|                     | `handoff`             | 다음 agent가 읽을 source path와 `read(...)` command를 포함한 handoff 생성. query 또는 `names` required              |
|                     | `session-packet`      | 전체 session의 phase, source path, next command, recovery guidance 생성. query 또는 `names` required                |
|                     | `turn-packet`         | session을 작업 turn 목록으로 확장. query 또는 `names` required                                                      |
|                     | `recovery-packet`     | budget 누락이나 blocked phase를 복구할 source path와 recovery command 생성. query 또는 `names` required             |
|                     | `resume-packet`       | recovery 이후 재개할 turn과 next command 생성. query 또는 `names` required                                          |
|                     | `current-turn-packet` | 현재 실행할 turn의 objective, checklist, source path, next command 생성. query 또는 `names` required                |
| Execution packets   | `instruction-packet`  | current turn을 instruction text, command block, checklist로 직렬화. query 또는 `names` required                     |
|                     | `summary-packet`      | 현재 turn/session의 요약 text 생성. query 또는 `names` required                                                     |
|                     | `markdown-packet`     | instruction, `## Commands`, `## Checklist`를 Markdown 문서로 생성. query 또는 `names` required                      |
|                     | `checklist-packet`    | current turn checklist와 exit criteria만 추출. query 또는 `names` required                                          |
|                     | `commands-packet`     | current turn에서 실행할 `nextCommands`만 추출. query 또는 `names` required                                          |
|                     | `file-ready-packet`   | Markdown, checklist, commands를 파일 단위 payload로 준비. query 또는 `names` required                               |
|                     | `apply-packet`        | 준비된 파일 payload와 적용 순서를 생성. query 또는 `names` required                                                 |
|                     | `write-script-packet` | 파일 payload를 쓰는 Bun script와 실행 command 생성. query 또는 `names` required                                     |
|                     | `execution-packet`    | write script 실행 command와 예상 파일 결과를 생성. query 또는 `names` required                                      |
|                     | `verification-packet` | 실행 후 verification command와 verification item을 생성. query 또는 `names` required                                |
| Maintenance         | `audit`               | query 또는 `names` 범위의 corpus health와 relation/index audit 반환                                                 |
|                     | `validate`            | 전체 index의 validation issue와 integrity report 반환                                                               |
|                     | `metrics`             | 현재 index의 skill, token, relation, duplicate 등 metrics 반환                                                      |

모든 action은 사람이 읽는 `content`와 구조화된 `details`를 함께 반환하며, `details.kind`가 결과 종류를 식별합니다. 필수 입력이 없거나 실행 중 오류가 발생하면 동일한 tool result 형식의 error content를 반환합니다.

```json
{
  "action": "resolve",
  "names": ["typescript-developer"],
  "includeBody": false
}
```

body와 packet action은 `budgetChars`·`budgetTokens` 안에서 결과를 만들며, 예산을 초과하거나 포함하지 못한 source는 결과의 omitted/recovery 정보로 표시됩니다.

## Commands

현재 등록된 OMP slash command 또는 custom command는 없습니다. runtime entrypoint의 `wireCommands`가 no-op이며, `register(pi)`는 `skill_registry` tool과 lifecycle hooks만 연결합니다.

`commands-packet`은 slash command가 아니라 `skill_registry` tool의 action입니다. 이 action은 선택된 current turn에서 실행할 `nextCommands`와 `commandBlock`을 반환합니다. 실제 command 등록 없이도 다음처럼 tool action으로 사용할 수 있습니다.

```json
{
  "action": "commands-packet",
  "names": ["typescript-developer"],
  "budgetChars": 4000
}
```

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
