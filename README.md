# skill-registry

`skill-registry`는 Pi/OMP runtime에서 여러 `SKILL.md` 문서를 하나의 검색 가능한 corpus로 제공하는 extension입니다. 검색 결과를 그대로 반환하는 데서 그치지 않고, skill 간 관계를 확장하거나 작업에 필요한 읽기·실행 packet으로 정리할 수 있습니다.

## 주요 기능

- 여러 skill root의 문서를 수집해 SQLite FTS5 index로 구성
- canonical name과 alias를 이용한 exact resolve
- BM25 기반 검색과 deterministic tie-break
- `requires`와 `recommends` 관계 탐색
- 검색, 선택 이유, coverage, graph, 작업 순서, 읽기 packet, 실행 packet 제공
- corpus validation, audit, metrics 조회
- runtime의 skill catalog를 compact guidance로 대체하는 prompt hook
  - `tool_result` hook은 exact unknown `skill://` read error만 bounded compact recovery로 바꾸고, valid/non-skill/unrelated errors는 pass-through합니다.
  - recovery는 `discover/search -> resolve -> read` 순서이며, catalog/suggestion text를 그대로 복사하지 않고 <=4096-byte compact recovery만 반환합니다.
  - host wrapper 적용 시 replacement는 `isError:false` transport success로 돌아가지만, text는 semantic unknown을 유지하는 trade-off가 있습니다.
  - plugin package reload 후에만 새 동작이 적용된다는 setup mental model과 일치합니다.

extension은 `skill_registry`라는 하나의 tool을 등록합니다. 별도의 slash command나 custom command는 등록하지 않습니다.

## 요구 사항

- Bun runtime
- Pi/OMP extension API를 제공하는 runtime
- Node 환경에서 테스트하거나 fallback을 사용할 경우 Node `>=22.5.0`

## 시작하기

의존성을 설치하고 extension bundle을 빌드합니다.

```bash
bun install
bun run build
```

빌드 결과는 `dist/main.js`입니다. `package.json`의 `pi.extensions`와 `omp.extensions`가 이 파일을 extension entrypoint로 가리킵니다.

runtime에 등록되면 다음과 같이 tool을 호출할 수 있습니다.

```json
{
  "action": "discover",
  "query": "security review",
  "limit": 5
}
```

검색 결과에서 skill을 확인한 뒤, 이름을 고정해 본문이나 관계를 가져오는 흐름은 다음과 같습니다.

```text
필요한 skill 찾기
  -> discover 또는 search
  -> resolve, brief, 또는 pack
  -> 필요하면 compose, plan, 또는 verification-packet
```

## Skill 문서

기본적으로 root 아래의 `SKILL.md`, `skill.md`, `Skill.md`를 재귀적으로 찾습니다. 일반적인 디렉터리 구조는 다음과 같습니다.

```text
<skill-root>/<skill-name>/SKILL.md
```

frontmatter가 있으면 다음 필드를 인덱싱합니다.

- `name`: canonical name. 없으면 skill 파일의 부모 디렉터리 이름을 사용합니다.
- `description`, `category`, `version`: skill의 기본 메타데이터
- `keywords`, `tags`: 검색용 보조 토큰
- `aliases`: canonical name 대신 사용할 수 있는 이름
- `requires`: 항상 함께 고려할 의존 skill
- `recommends`: 전체 관계 확장 시 고려할 인접 skill

예시:

```markdown
---
name: typescript-developer
description: TypeScript 애플리케이션을 설계하고 구현하는 skill
category: engineering
aliases:
  - ts
keywords:
  - typescript
  - type safety
requires:
  - code-review
recommends:
  - testing
---

# TypeScript Developer

Skill 본문을 작성합니다.
```

이 parser는 위와 같은 단순한 YAML-like frontmatter와 목록을 지원합니다. `summary`, `group`, `type`, `alias`, `require`, `depends_on`, `recommend`, `related`, `tag`, `skill_version`도 해당 canonical field의 입력 alias로 인식합니다. `related`는 `recommends`로 정규화됩니다.

`.git`, `.svn`, `node_modules`, `.venv`, `dist`, `build`, `out` 디렉터리는 검색 대상에서 제외합니다. 같은 canonical name이 여러 root에 있으면 `mtime`이 더 최신인 항목을 유지하고 중복 정보를 diagnostics에 기록합니다.

## 기본 corpus 경로

설정에서 `roots`를 지정하지 않으면 다음 경로를 이 순서로 사용합니다. 상대 경로는 runtime의 현재 working directory를 기준으로 해석하고, `~`는 home directory로 확장합니다.

| 순서 | 경로 | 용도 |
| ---: | --- | --- |
| 1 | `.pi/skills` | project-local skill |
| 2 | `.omp/skills` | OMP workspace skill |
| 3 | `.agents/skills` | agent workspace skill |
| 4 | `~/.pi/agent/skills` | Pi user skill |
| 5 | `~/.omp/agent/skills` | OMP user skill |
| 6 | `~/.omp/managed-skills` | OMP managed skill |
| 7 | `~/.agents/skills` | agent fallback skill |

`names`를 지정한 요청은 각 root에서 직접 경로를 우선 확인하고, 모든 이름을 직접 찾지 못한 root에서는 재귀 탐색으로 보완합니다. `names`가 없으면 전체 재귀 탐색을 사용합니다.

범위(scope) 기반 탐색과 우선순위는 `scopeRoots`/`scopePriority`로 별도 관리됩니다.
현재 기본 값은 다음과 같습니다.

```json
{
  "user-authored:local": ["$cwd"],
  "user-authored:global": ["$home"],
  "managed-skills": ["~/.omp/managed-skills"]
}
```

기본 우선순위는 `user-authored:local > user-authored:global > managed-skills`이며, 입력/설정에서 명시한 순서를 그대로 사용합니다.  
경로 값은 prefix 기반으로 매칭되므로 `$cwd`/`$home`/`~/.omp/managed-skills`는 각각 `/**` 하위 전체를 담당합니다.

`scopePriority`가 빈 배열이거나 항목이 비면 해당 항목만 제외되고, 미기재 scope는 관측된 스코프 뒤에 사전순으로 보존됩니다.
미지정 스코프(`scopes` 입력 누락)는 모든 effective scope를 대상으로 합니다. explicit 목록에서 empty 항목을 제거한 뒤 알려진 scope가 하나도 남지 않으면 safe-zero로 빈 결과를 반환하며, valid scope와 empty 항목이 섞인 경우 valid scope만 조회합니다.

## 설정

설정 파일은 다음 순서로 확인하며, 유효한 JSON을 처음 찾은 파일을 사용합니다.

1. project-local
   - `.pi/settings/skill-registry/skill-registry.json`
   - `.pi/settings/skill-registry.json`
   - `.pi/settings.json`
2. Pi global
   - `$PI_CODING_AGENT_DIR/settings/skill-registry/skill-registry.json`
   - `$PI_CODING_AGENT_DIR/settings/skillRegistry.json`
   - 환경 변수가 없으면 `~/.pi/agent`를 사용
3. OMP global
   - `$OMP_AGENT_DIR/settings/skill-registry/skill-registry.json`
   - `$OMP_AGENT_DIR/settings/skillRegistry.json`
   - `OMP_AGENT_DIR`와 `OMP_AGENT_HOME`이 모두 없으면 `~/.omp/agent`를 사용

`OMP_AGENT_DIR`는 `OMP_AGENT_HOME`보다 우선합니다. 설정 파일은 `skillRegistry`로 감싼 형태와 payload 자체를 모두 지원합니다.

```json
{
  "skillRegistry": {
    "roots": ["./skills", "~/.omp/agent/skills"],
    "scopeRoots": {
      "user-authored:local": ["$cwd"],
      "user-authored:global": ["$home"],
      "managed-skills": ["~/.omp/managed-skills"],
      "team-scope": ["./.team/skills"]
    },
    "scopePriority": ["user-authored:local", "user-authored:global", "managed-skills", "team-scope"],
    "fileNames": ["SKILL.md"],
    "presetSkills": [],
    "databasePath": "~/.omp/agent/cache/skill-registry/index.sqlite",
    "cacheTtlMs": 60000,
    "maxTopK": 50,
    "includePreviewBodyChars": 250
  }
}
```

| 설정 | 기본값 | 설명 |
| --- | ---: | --- |
| `roots` | 위 기본 목록 | skill root 목록. 지정하면 기본 목록을 대체 |
| `scopeRoots` | 위 기본 scope-root 맵 | 경로-기반 scope 분류에 사용 (`scopePriority`에 없더라도 실제 root가 있으면 유효 scope로 반영) |
| `scopePriority` | `user-authored:local`, `user-authored:global`, `managed-skills` | scope 비교/랭킹 우선순위 |
| `fileNames` | `SKILL.md`, `skill.md`, `Skill.md` | 탐색할 파일명 |
| `presetSkills` | `[]` | 설정에 저장하는 preset skill 이름 목록 |
| `databasePath` | agent root 아래 `cache/skill-registry/index.sqlite` | SQLite index 경로 |
| `cacheTtlMs` | `60000` | process index cache의 유효 시간 |
| `maxTopK` | `50` | 결과 수의 상한 |
| `includePreviewBodyChars` | `250` | 검색 결과 preview 본문 길이 |

입력의 `roots`와 `fileNames`는 해당 요청에 한해 설정을 대체합니다. `roots`가 입력/설정에 있을 때는 scopeRoots가 제안한 추가 경로를 병합하지 않고 전체 목록을 대체합니다.
`databasePath`는 tool input으로 덮어쓸 수 없고 settings에서만 지정합니다. SQLite 파일은 cache이며, 원본은 항상 skill 문서입니다.

## `skill_registry` tool

### 입력

`action`은 필수이며 나머지 필드는 선택입니다.

| 필드 | 타입 및 범위 | 설명 |
| --- | --- | --- |
| `action` | enum | 실행할 동작 |
| `query` | string, 최대 1024자 | 검색어 또는 작업 설명 |
| `names` | string[] | canonical name 또는 alias |
| `scopes` | string[] | scope 필터. 생략 시 모든 effective scope를 검색 |
| `suggestionLimit` | integer, 0..5 | `resolve` missing recovery 후보 수. 기본 3 |
| `roots` | string[] | 이번 요청에서 사용할 skill root |
| `fileNames` | string[] | 이번 요청에서 탐색할 파일명 |
| `limit` | number, 1..200 | 결과 수. task size와 `maxTopK`에 따라 다시 제한 |
| `taskSize` | `small`, `medium`, `large` | 결과 폭과 query-only 확장 정책 |
| `refresh` | boolean | `true`이면 filesystem을 다시 읽어 index를 갱신 |
| `minScore` | number, 0..1000 | BM25 score 하한 |
| `includeBody` | boolean | 결과에 skill body를 포함할지 여부 |
| `includePreviewBodyChars` | integer, 20..5000 | preview 길이 override |
| `relationMode` | `required`, `full` | `requires`만 또는 `recommends`까지 확장 |
| `graphMode` | `outbound`, `inbound`, `cycles`, `orphans` | graph 조회 방식 |
| `budgetChars` | integer, 200..200000 | packet 문자 예산 |
| `budgetTokens` | integer, 50..50000 | packet token 예산 |
| `coverageThreshold` | number, 0..1 | `gap`의 coverage 기준 |

기본 입력값은 다음과 같습니다.

- `taskSize`: `medium`
- `refresh`: `false`
- `minScore`: `0`
- `budgetChars`: `4000`
- `budgetTokens`: `1000`
- `coverageThreshold`: `0.7`
- `suggestionLimit`: `3` (최대 5)
- `graphMode`: `outbound`
- `includeBody`: `resolve`에서는 `false`, 그 외 action에서는 `true`
- `relationMode`: `large`에서는 `full`, 그 외에는 `required`
- `limit`: `small`은 2, `medium`은 5, `large`는 설정의 `maxTopK`까지 허용

### Action 목록

#### Index와 검색

| action | 용도 | 입력 |
| --- | --- | --- |
| `index` | 현재 corpus를 인덱싱하고 index 통계를 반환 | 없음 |
| `discover` | diagnostics를 포함한 compact 검색 | `query` |
| `search` | ranked 검색 결과 반환 | `query` |
| `select` | 검색 결과를 본문 중심으로 반환 | `query` |

#### Resolve와 관계

| action | 용도 | 입력 |
| --- | --- | --- |
| `resolve` | canonical name 또는 alias를 exact resolve | `names` |
| `compose` | seed와 관계 확장 결과를 구성 | `query` 또는 `names` |
| `graph` | 관계 graph와 cycle/orphan 정보 조회 | `outbound`·`inbound`는 `query` 또는 `names` 필요 |

#### 판단과 추천

| action | 용도 |
| --- | --- |
| `gap` | query coverage와 후보 skill, scaffold 제안 |
| `explain` | 선택된 seed, ranking, 관계 경로 설명 |
| `decide` | 사용할 skill과 선택 근거 결정 |
| `plan` | 관계와 작업 단계를 반영한 읽기 순서 계획 |
| `route` | skill을 작업 단계별로 배치 |
| `compare` | 선택된 후보 skill 비교 |
| `recommend` | seed와 관계를 기준으로 인접 skill 추천 |

#### Read packet

| action | 용도 |
| --- | --- |
| `brief` | 제한된 분량의 skill brief 생성 |
| `bundle` | skill 본문과 관계 context를 묶은 agent-ready 결과 생성 |
| `pack` | query 또는 names 기반 bounded skill packet 생성 |
| `handoff` | 다음 작업자가 읽을 source path와 command 생성 |
| `session-packet` | session phase, source path, next command, recovery 정보 생성 |
| `turn-packet` | session을 작업 turn 목록으로 확장 |
| `recovery-packet` | 누락 budget 또는 blocked phase 복구 정보 생성 |
| `resume-packet` | recovery 이후 재개할 turn과 command 생성 |
| `current-turn-packet` | 현재 turn의 objective, checklist, source path 생성 |

#### Execution packet

| action | 용도 |
| --- | --- |
| `instruction-packet` | current turn을 instruction, command, checklist로 직렬화 |
| `summary-packet` | turn 또는 session 요약 생성 |
| `markdown-packet` | instruction, commands, checklist를 Markdown으로 생성 |
| `checklist-packet` | checklist와 exit criteria만 추출 |
| `commands-packet` | current turn의 `nextCommands` 추출 |
| `file-ready-packet` | Markdown, checklist, commands를 파일 payload로 준비 |
| `apply-packet` | 파일 payload와 적용 순서 생성 |
| `write-script-packet` | payload를 쓰는 Bun script와 실행 command 생성 |
| `execution-packet` | 실행 command와 예상 파일 결과 생성 |
| `verification-packet` | 실행 후 verification command와 항목 생성 |

#### Corpus 관리

| action | 용도 |
| --- | --- |
| `audit` | 지정 범위의 corpus와 relation 상태 점검 |
| `validate` | 전체 index의 validation issue와 integrity report |
| `metrics` | skill, token, relation, duplicate 통계 |

모든 action은 사람이 읽는 `content`와 구조화된 `details`를 함께 반환합니다. 입력이 부족하거나 실행 중 오류가 발생하면 같은 tool result 형식으로 오류를 반환합니다.

## 검색과 확장 동작

검색에는 document와 query에 공통 tokenizer를 적용합니다. canonical name, alias, title, description, category, keywords, tags, body를 검색 대상으로 삼고 SQLite FTS5 BM25 rank를 사용합니다. 한국어 형태 분석 token은 원문 token을 보완하며, 영어는 exact와 prefix 후보를 우선하고 제한적인 Damerau-Levenshtein fuzzy 후보를 마지막에 사용합니다.

결과 정렬은 다음 순서를 따릅니다.

1. score 내림차순
2. query coverage 내림차순
3. scope rank 오름차순 (`scopePriority` 기반, 입력/설정 priority가 먼저)
4. canonical name 오름차순

`scope`는 파일 위치 분류 라벨이고, `category`는 frontmatter 메타데이터입니다. 둘은 서로 독립이며:
- 검색 정렬에서 `category`는 직접 비교 키로 쓰이지 않고,
- 추천/경로 계산에서는 category 일치가 `recommend` 점수에 보너스 요인으로 반영됩니다.

첫 검색에서 결과가 없으면 운영성 stop word를 제거한 query rewrite를 한 번 시도합니다. 그래도 결과가 없으면 임의로 skill을 선택하지 않고 `safe-zero` diagnostics를 반환합니다.

`scopes` 입력은 다음처럼 동작합니다.
- 생략: scope 미지정 모드로 동작해 effective scope를 전부 탐색합니다(오버헤드 높은 all-scope).
- 명시된 scope가 하나 이상이고 모두 유효: 해당 scope 소속 root만 스캔/표기합니다.
- 명시된 scope가 비어 있거나 unknown: safe-zero로 빈 스냅샷을 즉시 반환합니다.

`index`/`metrics`/`discover` 결과에는 기본적으로 scope 출력이 포함될 수 있습니다(`scope`/`sourceRoot` 기반 분포, scope별 집계). `category`는 각각의 항목 라인과 `metrics`의 카테고리 집계에서 확인할 수 있습니다.

## SQLite 캐시 재생성

`index` 결과는 아래 조건에서 요청 키가 같아도 snapshot이 무효화되거나 손상 가능성이 있으면 캐시를 새로 생성합니다.

- 요청 키/TTL 불일치: 현재 key가 맞지 않으면 `readSnapshot`이 null을 반환해 재빌드 트리거.
- DB 메타/스키마 불일치: `application_id`가 유효하지 않거나 `user_version`이 다른 경우 소유 스키마를 재생성.
- scope/skill 메타 역직렬화 실패: scope 메타데이터, 통계, skill row 파싱이 실패하면 스키마를 재생성 후 다음 실행에서 다시 빌드.

재생성 시 `scopeRoots`와 `scopePriority`는 `settings`와 함께 cache에 round-trip 됩니다.

`resolve`는 canonical name 또는 alias의 exact match만 사용합니다. `compose`와 packet action의 관계 확장은 `requires`를 기본으로 하며, `relationMode: "full"`일 때 `recommends`까지 포함합니다.

알 수 없는 `skill://<name>`을 직접 읽어 resolver 오류를 복구하지 않습니다. `discover` 또는 `search`로 후보를 좁힌 뒤 `resolve`에서 exact canonical name을 확인하고 반환된 `skill://<canonical>`만 읽습니다. `resolve`의 missing recovery 후보는 최대 5개로 제한되며, 확신이 낮으면 전체 catalog 대신 compact discover/search 안내만 반환합니다.

`small`과 `medium`에서 `names` 없이 `decide`, `plan`, `route`, `current-turn-packet`, `session-packet`, `turn-packet`을 query로 실행할 수 없습니다. 이 동작은 `large`에서 허용되며, 작은 작업에서는 먼저 검색하거나 `names`를 지정해야 합니다.

## Prompt hook

extension은 `before_agent_start`와 `before_provider_request` lifecycle hook을 연결합니다. runtime이 제공하는 `<skills>...</skills>` catalog가 있으면 첫 번째 block을 compact skill-registry guidance로 대체해 prompt에 전체 catalog를 반복해서 넣지 않도록 합니다.

`tool_result` hook은 `skill://` read 오류 중 exact unknown case만 위 compact recovery로 치환합니다. `discover/search -> resolve -> read`를 통해 복구하되, catalog 또는 suggestion 문구를 복사하지 않고 <=4096-byte 응답만 생성합니다. valid skill read, non-skill read, 그 밖의 unrelated error는 모두 pass-through합니다. host wrapper에서는 transport success(`isError:false`)로 보여도 text는 semantic unknown을 유지하므로, operator는 이 replacement를 "성공으로 전달되지만 의미는 unknown"인 타협으로 이해해야 합니다. 이 동작은 plugin package reload 이후에 반영됩니다.

## 개발

주요 명령은 다음과 같습니다.

```bash
bun run typecheck
bun run lint
bun run format
bun run check
bun run build
bun run test:unit
bun run test:sqlite
bun run test:e2e
bun run test
```

`bun run check:fix`는 typecheck, lint, format을 순서대로 실행합니다. `bun run test`는 unit, SQLite, E2E 테스트를 모두 실행합니다.

주요 소스 위치:

- `src/main.ts`: tool과 lifecycle hook 등록
- `src/schema.ts`: `skill_registry` 입력 schema
- `src/indexing/`: 문서 수집, 파싱, index, 검색, 관계, packet
- `src/tokenization/`: 공용 query/document tokenization
- `src/settings/`: 설정 파일 탐색과 정규화
- `src/results/`: tool result 직렬화
- `src/prompt/`: prompt guidance hook

## License

MIT License
