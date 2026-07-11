# skill-registry 한국어 형태소 분석 + 영어 fuzz 검색 구현 계획

## Goal

`skill-registry`의 검색 품질을 올리기 위해 다음 두 가지를 추가한다.

1. 한국어 query/document에 대해 단순 Unicode token 일치보다 강한 형태소 기반 매칭을 지원한다.
2. 영어 query에 대해 현재 single-typo fallback보다 넓은 fuzz 매칭을 지원한다.

## Non-goals

- 이번 범위에서 검색 엔진을 BM25 외 다른 랭커로 교체하지 않는다.
- `skill_registry` tool action surface를 새로 추가하지 않는다.
- usage/frequent skills 같은 별도 analytics surface는 이번 계획 범위에 포함하지 않는다.
- 다국어 전반의 언어별 analyzer를 한 번에 추가하지 않는다. 우선 한국어 + 영어만 다룬다.

## Planning Status

- [x] 현재 `skill-registry` 검색 구조 확인
- [x] 현재 테스트 seam 확인
- [x] 구현 계획 문서 작성
- [x] 검색 토큰화 책임 분리 구현
- [x] 한국어 형태소 분석 매칭 구현
- [x] 영어 fuzz 매칭 확장 구현
- [x] README / 테스트 / 패키지 검증 갱신

## Current State

### 입력

- 검색 진입점은 `skill-registry/src/skill-index.service.ts`의 `searchByBm25()`이다.
- query token 생성은 같은 파일의 `normalizeTokens()`가 담당한다.
- token 분리 규칙은 `skill-registry/src/skill-registry.constant.ts`의 `NON_WORD_BOUNDARY_RE = /[\p{L}\p{N}_]+/gu` 이다.

### 처리

- 현재 검색은 BM25 기반이다.
- query term variant는 `resolveQueryTokenVariants()`에서 계산한다.
- 현재 variant 전략은 대체로 다음 순서다.
  1. exact token
  2. prefix fallback
  3. single-typo Levenshtein fallback
- document index도 `normalizeTokens()` 결과를 그대로 가중 합산한다.

### 출력

- `search`, `discover`, `select`, `gap`, `explain`, `recommend`, `plan`, `route` 등 query 기반 action이 모두 `searchByBm25()` 결과에 직간접적으로 의존한다.
- 따라서 검색 품질 변경은 tool output 전반에 영향을 준다.

## Existing Evidence

- `skill-registry/index.test.ts`
  - prefix fallback 검증이 있다.
  - single-typo fallback 검증이 있다.
  - `"코드 리뷰"` 같은 한글 non-ASCII tokenization 검증이 있다.
- 의미:
  - 현재도 한글 exact token 검색은 된다.
  - 하지만 형태소 분석은 아직 없다.
  - 영어 fuzz도 현재는 single-typo 중심이라 폭이 좁다.

## Target Behavior

### 한국어

다음 종류를 현재보다 잘 맞춘다.

- 조사/어미 차이
  - query: `코드 리뷰`
  - document: `코드를 리뷰하고`
- 활용형 차이
  - query: `자동화`
  - document: `자동화합니다`
- 복합 명사/명사열
  - query: `형태소 분석`
  - document: `형태소분석`
  - 또는 반대 방향

### 영어

다음 종류를 현재보다 잘 맞춘다.

- deletion / insertion / substitution / transposition typo
  - `authentcation` -> `authentication`
  - `observabiltiy` -> `observability`
- 긴 토큰의 2-edit 이내 오타
- 기존 exact / alias / prefix match의 우선순위 유지

## Recommended Design

## 1. 검색 책임 분리

현재 `SkillIndexService`가 인덱싱, 정규화, query variant, BM25 scoring을 모두 가진다. 이번 변경은 책임을 더 늘리므로 검색 정규화 책임을 별도 service로 분리한다.

### 추가 파일

- `skill-registry/src/search-tokenizer.interface.ts`
- `skill-registry/src/search-tokenizer.service.ts`
- `skill-registry/src/english-fuzzy-matcher.interface.ts`
- `skill-registry/src/english-fuzzy-matcher.service.ts`
- `skill-registry/src/korean-morphology-analyzer.interface.ts`
- `skill-registry/src/korean-morphology-analyzer.service.ts`

### 기존 파일 변경

- `skill-registry/src/skill-index.service.ts`
- `skill-registry/src/skill-registry.constant.ts`
- `skill-registry/src/skill-registry.type.ts`
- `skill-registry/index.test.ts`
- `skill-registry/README.md`
- 필요 시 `skill-registry/package.json`

## 2. 공통 토큰 모델 정의

`skill-registry.type.ts`에 아래 성격의 내부 타입을 추가한다.

- `SearchToken`
  - `token`: 실제 검색 token
  - `source`: `base | ko-morph | en-fuzzy`
  - `scoreMultiplier`: 파생 token 점수 보정값
- `SearchTokenizationResult`
  - `baseTokens`
  - `derivedTokens`
- `LanguageAwareQueryVariant`
  - query 원문 token과 확장 variant 목록

핵심 원칙:

- BM25 본체는 유지한다.
- token 생성/확장만 언어별로 강화한다.
- exact token > 구조적 확장 token > fuzzy token 순으로 점수 multiplier를 낮춘다.

## 3. 한국어 형태소 분석 전략

### 권장 방향

- **문서 인덱싱 시** 한국어 문장을 형태소/어근 기반 token으로 추가한다.
- **query 처리 시** 동일 analyzer를 적용해 query 쪽도 같은 규칙으로 확장한다.
- 원본 token은 유지하고, 파생 형태소 token만 추가한다.

### 구현 원칙

- native binary 의존성보다 **pure JS/ESM 우선**으로 고른다.
- postinstall binary, OS별 사전 설치, Mecab 계열 native dependency는 1차 구현에서 피한다.
- analyzer 선택 기준:
  1. Bun/Node 20 호환
  2. ESM 사용 가능
  3. 명사/어근 추출 가능
  4. 설치가 단순함
  5. 테스트 환경에서 재현 가능

### 실패 대비 fallback

적절한 pure JS analyzer가 없으면 1차 contingency로 아래를 둔다.

- 현재 Unicode tokenization 유지
- Hangul token에 대해 내부 분해 기반 sub-token 보조 확장만 추가
- 단, 이 fallback은 형태소 분석과 동일 정확도를 목표로 하지 않는다

### 점수 규칙

- 문서 원본 token: 기존 weight 유지
- 한국어 형태소 파생 token: 원본 대비 낮은 multiplier 사용
- query도 base token과 morphology token을 함께 넣되, morphology token 우선순위는 base보다 낮춘다

## 4. 영어 fuzz 매칭 전략

### 현재 한계

- 현재는 prefix fallback 후 Levenshtein distance 1 중심이다.
- transposition과 긴 단어 2-edit 케이스가 약하다.

### 권장 방향

`resolveQueryTokenVariants()`를 아래 정책으로 확장한다.

1. exact
2. alias/existing normalized exact
3. prefix
4. Damerau-Levenshtein distance 1
5. 길이 7 이상 token에 한해 distance 2 허용
6. 후보 수 상한 유지

### 세부 규칙

- 첫 글자 동일 제약은 유지하되 지나치게 공격적이면 길이 기반으로 완화한다.
- 거리 허용은 token 길이에 따라 다르게 둔다.
  - 1~4: fuzzy 없음 또는 매우 보수적
  - 5~6: distance 1
  - 7+: distance 2
- score multiplier는 아래 순서를 유지한다.
  - exact > prefix > distance 1 > distance 2
- unrelated token 오탐을 막기 위해 candidate 상한과 minimum score 방어를 유지한다.

## 5. 인덱싱/검색 데이터 흐름 변경

### 입력

- skill frontmatter / title / description / body text
- user query

### 처리

1. 공통 Unicode tokenization
2. token 언어 분류
   - Hangul 포함 token
   - ASCII latin 중심 token
   - 그 외 token
3. 문서 인덱싱 단계
   - base token 적재
   - 한국어 token이면 형태소 파생 token 추가 적재
4. query 단계
   - base token 생성
   - 한국어 token이면 형태소 파생 query token 생성
   - 영어 token이면 fuzz variant 생성
5. BM25 score 합산
   - 파생 token은 multiplier 반영

### 출력

- 기존 `SearchHit.score`, `coverage`, `matchedTerms` shape는 유지한다.
- `matchedTerms`는 가능하면 사용자 친화적으로 canonical matched term을 유지한다.
- 내부 derived token이 노출되더라도 결과 텍스트가 과하게 noisy 해지지 않도록 formatter는 최소 수정한다.

## 6. 단계별 구현 순서

### Phase 1. 검색 정규화 분리

목표
- `SkillIndexService`에서 tokenization / variant 생성 책임을 분리한다.

변경
- 새 interface/service 추가
- `normalizeTokens()`와 `resolveQueryTokenVariants()` 호출부를 adapter 경유로 변경

성공 기준
- 기존 테스트가 동일하게 통과한다.
- 동작 변화 없이 리팩터링만 완료된다.

### Phase 2. 한국어 형태소 분석 추가

목표
- query/document 양쪽에 morphology-derived token을 넣는다.

변경
- 한국어 analyzer service 추가
- index token count 합산 로직 확장
- query token expansion 확장

성공 기준
- 조사/어미가 다른 한글 query가 기존보다 더 자주 맞는다.
- 기존 한글 exact token 테스트는 그대로 유지된다.

### Phase 3. 영어 fuzz 확장

목표
- transposition 및 length-aware distance 2까지 지원한다.

변경
- Levenshtein helper를 Damerau-Levenshtein 또는 동등 로직으로 교체/확장
- query variant 상한과 multiplier 재조정

성공 기준
- 기존 typo 테스트 유지
- 추가 typo/transposition 테스트 통과
- 오탐 방지 테스트 추가

### Phase 4. 문서/튜닝 정리

목표
- README와 테스트를 실제 behavior에 맞춘다.

변경
- README 검색 설명 갱신
- dependency가 있으면 package manifest 반영
- score multiplier / candidate cap 상수 정리

성공 기준
- README, 테스트, package manifest가 구현과 일치한다.

## Verification Plan

### broad check

- `bun run test`
- `bun run test:typecheck`
- `bun run check`

### targeted tests to add

#### 한국어

- `코드 리뷰` query가 `코드를 리뷰하고 자동화합니다`를 찾는지
- `자동화` query가 `자동화합니다`를 찾는지
- `형태소 분석` query가 복합 명사 표기 차이를 넘어서 매칭되는지
- 형태소 파생 token 때문에 무관한 한글 문서가 과도하게 올라오지 않는지

#### 영어

- transposition typo (`observabiltiy`) 매칭
- 2-edit long token typo 매칭
- 짧은 token에는 fuzz가 과도하게 넓어지지 않는지
- exact/prefix hit가 fuzz hit보다 항상 우선하는지

#### 회귀

- alias 검색 유지
- prefix fallback 유지
- 기존 BM25 ordering deterministic property 유지
- query 기반 상위 action(`discover`, `select`, `gap`, `recommend`)의 snapshot text가 과도하게 깨지지 않는지

## Risks

### 1. 한국어 analyzer dependency risk

- pure JS analyzer 품질이 부족할 수 있다.
- native analyzer는 설치/CI 복잡도를 높일 수 있다.

대응
- dependency 선택을 별도 작은 spike로 닫는다.
- 실패 시 fallback path를 남긴다.

### 2. 인덱스 확장에 따른 score drift

- derived token이 많아지면 기존 BM25 점수 분포가 흔들릴 수 있다.

대응
- derived token multiplier를 base보다 낮게 둔다.
- 기존 deterministic ordering 테스트를 유지한다.

### 3. fuzz 오탐 증가

- distance 2는 unrelated skill을 끌어올릴 수 있다.

대응
- 길이 기준 제한, 후보 수 제한, 낮은 multiplier를 같이 둔다.
- 짧은 token에는 보수적으로 유지한다.

## Recommended First Pass

가장 안전한 첫 구현 순서는 아래다.

1. 검색 정규화 service 분리
2. 한국어 analyzer abstraction 추가
3. 한국어 morphology token을 query/document 양쪽에만 우선 반영
4. 영어 fuzz는 Damerau-Levenshtein + length-aware threshold로 최소 확장
5. 테스트/README 갱신

이 순서는 기존 BM25 구조를 보존하면서 정확도 개선을 가장 작게 주입하는 경로다.
