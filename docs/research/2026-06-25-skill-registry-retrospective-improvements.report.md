---
title: skill-registry retrospective improvements
date: 2026-06-25
type: report
area: skills
source_mode: repository-evidence
status: complete
---

# skill-registry 회고 불만 반복에 대한 개선 보고서

## Goal

session retrospective에서 반복되는 “skill-registry가 적합한 skill을 못 준다”, “읽게 했지만 작업에 실질적으로 도움이 되지 않았다”는 불만을 repository-based 근거로 정리하고, 작은 단계로 실행 가능한 개선안을 제안한다.

## Interview Brief

- 요청: 반복되는 회고 불만의 원인을 고민하고 개선 방안을 보고서로 정리한다.
- 산출물: 연구 문서 아래 보고서 1건
- source mode: repository-evidence
- 제약: 구현이 아니라 개선안 제안에 집중한다.

## Scope

- `skill-registry`의 검색/발견/패킷화 contract와 최근 회고 근거를 본다.
- 실제 complaint를 입력 → 처리 → 출력 단계로 분해한다.
- 바로 실행 가능한 P0/P1/P2 개선안을 제안한다.
- non-goal: 이번 문서에서 곧바로 코드 구현이나 schema 변경까지 수행하지 않는다.

## KQs

1. 반복되는 불만은 어떤 failure pattern으로 묶이는가?
2. 원인은 검색 품질, catalog drift, activation 과부하 중 어디에 있는가?
3. 가장 작은 개선 순서는 무엇인가?

## Progress Checklist

- [x] 회고 근거 수집
- [x] 현재 `skill-registry` contract 확인
- [x] 최근 검색 품질 개선 계획 확인
- [x] 개선 보고서 작성

## Preflight Ledger

### P1
- input: 연구 문서 목록과 인덱스
- observed shape: 연구 문서는 날짜별 분류와 목차 링크 구조를 따른다.
- scope impact: 새 보고서를 연구 문서 영역에 추가하고 목차를 갱신해야 한다.

### P2
- input: 최근 회고와 해당 애플리케이션 문서
- observed shape: 문제는 단일 BM25 품질보다 넓고, 실제 회고에는 skill 과다 로드도 함께 기록돼 있다.
- scope impact: 개선안을 검색 품질 하나로 좁히지 않고 routing/diagnostics/catalog drift까지 포함해야 한다.

## Source Log

- **S1** 검색 품질 개선 계획 문서
  - 최근 검색 품질 개선 계획. query 기반 action 대부분이 `searchByBm25()`에 의존함을 명시한다.
- **S2** 세션 회고 문서
  - 실제 회고. skill/contract 과다 로드와 activation 불충족을 명시한다.
- **S3** 해당 애플리케이션 문서
  - 현재 `skill-registry`의 action family, prompt slimming 역할, 검색 behavior를 설명한다.
- **S4** 분석 세션 관찰
  - 특정 작업 관련 검색 질의를 넣었을 때 0건이 반환됐다.
- **S5** 인덱싱된 프롬프트 자료의 검색 결과
  - 프롬프트 자료에는 특정 내부 절차가 catalog 예시로 남아 있었다.
- **S6** 분석 세션 관찰
  - 내부 스킬 참조 읽기에 실패했고, 현재 접근 가능한 목록에도 해당 이름이 없었다.

## Research Result

### Executive Summary

반복 불만의 핵심은 “검색 품질이 조금 약하다” 수준이 아니다. 실제 failure pattern은 3개가 겹친다: **(1) discover miss**, **(2) 과다한 skill/contract 로드**, **(3) 문서/색인과 실제 skill surface 사이의 drift**. 따라서 형태소 분석·영어 fuzz 같은 검색 개선은 필요하지만, 그것만으로 회고 불만은 줄지 않는다. `0 results` fallback, task-size-aware routing, catalog drift smoke가 함께 들어가야 한다. (참고: S1, S2, S3, S4, S5, S6)

### 1. 입력(Input) 단계에서 보이는 불만 신호

현재 `skill-registry`는 query나 name에서 출발해 discover/search/select/decide/packet 계열로 이어지는 entrypoint 역할을 맡는다. 즉 첫 입력에서 miss가 나면 이후 action family 전체가 약해진다. README도 query 기반 action 대부분과 prompt slimming 유도가 이 검색 surface 위에 서 있다고 설명한다. 분석 중 개선 보고서 작성이라는 비교적 직접적인 query조차 스킬 검색에서 0건을 반환한 것은, 사용자의 표현을 registry vocabulary로 바꾸는 첫 단계가 아직 약하다는 신호다. (참고: S3, S4)

회고 문서에서도 불만은 “skill이 전혀 없었다”보다 “읽긴 읽었는데 적합성이 약했다” 쪽에 가깝다. 2026-06-24 retrospective는 실제 activation 충족 skill이 있었음에도 umbrella → source-map → contract를 지나며 최소 6개 skill/contract를 읽었고, small/medium merge였다면 더 적게 읽을 수 있었다고 기록한다. 즉 입력 failure는 miss만이 아니라 **너무 많은 near-match를 읽게 만드는 현상**도 포함한다. (참고: S2)

### 2. 처리(Processing) 단계의 구조적 원인

첫 번째 원인은 **검색 품질의 언어/표현 변형 취약성**이다. 최근 계획 문서는 query 기반 action 대부분이 `searchByBm25()` 결과에 직간접 의존한다고 적고, 기존 시스템이 exact → prefix → single-typo fallback 중심이라 한국어 형태소 변화와 더 넓은 영어 typo를 충분히 흡수하지 못했다고 정리한다. 검색 품질 개선 계획이 이미 따로 나온 것은 이 원인이 실제로 누적되었음을 보여 준다. (참고: S1)

두 번째 원인은 **routing granularity 부족**이다. README상 `skill-registry`는 찾기, 확장, 패키징, 유지보수까지 매우 넓은 action surface를 제공한다. surface가 넓을수록 discover가 반환한 후보를 “지금 바로 읽어야 할 최소 집합”으로 줄여 주는 책임이 중요해지는데, retrospective 증거는 실제로 그 축소가 충분히 일어나지 않았음을 보여 준다. 특히 medium 이하 작업에서 umbrella skill과 contract skill을 연속으로 읽게 만들면, 사용자는 registry가 “도움을 준다”기보다 “절차를 늘린다”고 느끼기 쉽다. (참고: S2, S3)

세 번째 원인은 **catalog drift**다. 인덱싱된 프롬프트 자료에는 특정 내부 catalog 항목이 예시로 남아 있지만, 현재 runtime catalog에서는 같은 이름을 읽을 수 없다. 이 상태에서는 사용자와 에이전트가 “존재한다고 믿는 skill”과 “실제로 지금 읽을 수 있는 skill”이 어긋난다. 이는 검색 결과 품질과 별개로 trust를 직접 깎는 문제다. (참고: S5, S6)

### 3. 출력(Output) 단계에서 사용자가 체감하는 문제

출력 단계에서 사용자가 받는 불만은 대체로 세 문장으로 요약된다. 첫째, “찾아야 할 skill을 못 찾는다.” 둘째, “관련은 있지만 지금 일에는 과하다.” 셋째, “문서나 과거 prompt에서 본 skill 이름이 실제로는 안 열린다.” 이 셋은 각각 no-result, over-bundling, stale catalog로 대응되며, 지금 회고 불만이 반복되는 이유도 같은 failure class가 서로 다른 작업에서 다시 나타나기 때문이다. (참고: S2, S4, S5, S6)

### 4. 개선 방향

#### P0. `0 results`를 실패가 아니라 진단 가능한 fallback으로 바꾼다

가장 먼저 할 일은 `discover/search`의 0건 반환을 조용한 miss로 두지 않는 것이다. 0건이면 즉시 두 번째 pass를 수행해 query를 재작성해야 한다. 우선순위는 다음이 적당하다: 1) 조사/어미/동사형을 줄인 핵심 명사 추출, 2) “보고서 작성”, “개선”, “회고” 같은 일반 작업어 제거, 3) 남은 명사 기준으로 preset/general skill fallback 제안, 4) 그래도 없으면 기본 조사·진단 fallback을 명시한다. 이렇게 하면 “아무것도 못 찾음” 대신 “왜 못 찾았는지, 무엇으로 대신 시작할지”를 출력할 수 있다. (추론: S1, S3, S4)

#### P0. 결과와 함께 최소 진단 필드를 노출한다

현재 불만은 결과 자체보다 결과를 신뢰할 근거가 약한 데서도 생긴다. `discover` 응답에 최소한 `normalizedQuery`, `matchedAliases`, `fallbackMode`, `whyThisTop1`, `whyZero` 같은 compact diagnostics를 추가하면 회고가 감정 서술이 아니라 구조적 miss class로 축적된다. 특히 retrospective 자동화가 있다면 “0-result query”, “fallback-only success”, “selected but unused skill”을 세어 corpus 개선 backlog로 바로 보낼 수 있다. (추론: S2, S3, S4)

#### P1. task-size-aware routing을 도입해 과다 로드를 줄인다

세션 retrospective가 보여 준 문제는 “없는 skill”보다 “너무 많이 읽게 하는 skill routing”이다. 따라서 discover/select/decide에 task-size 힌트를 받아 small/medium 작업에서는 top 1~2개의 실행형 skill만 우선 추천하고, umbrella skill·source-map·contract 연쇄는 large/high-risk일 때만 자동 확장하도록 바꾸는 편이 좋다. 이미 action surface 안에 `decide`, `plan`, `route`, `current-turn-packet`이 있으므로 새 action을 늘리기보다 기본 discover routing policy를 바꾸는 쪽이 작다. (참고: S2, S3)

#### P1. alias와 preset skill을 “불만 표현” 기준으로 보강한다

분석 query에는 `retrospective`, `report`, `improvement` 같은 메타 작업어가 많았다. 이런 표현은 특정 domain skill보다 연구·세션 분석·스킬 관리·계획 같은 운영 skill과 더 맞닿아 있다. 따라서 corpus 정비 시 기술 domain noun뿐 아니라 사용자가 실제로 불만을 표현하는 운영어휘를 alias에 넣어야 한다. 예: `retrospective`, `postmortem`, `report`, `diagnostics`, `skill usefulness`, `skill mismatch`. 이건 랭커를 바꾸지 않고도 hit rate를 올릴 수 있는 저비용 조치다. (추론: S2, S3, S4)

#### P1. catalog drift smoke를 정례화한다

문서/프롬프트에 보이는 skill name이 실제 스킬 참조 인터페이스와 어긋나면 신뢰가 빠르게 무너진다. 최소 smoke는 두 가지면 충분하다. 1) runtime prompt/indexed docs에 노출된 canonical skill name 목록을 수집한다. 2) 각 이름에 대해 스킬 참조 경로로 resolve 가능 여부를 검사한다. 실패하면 validate/audit 또는 CI에서 red flag를 주고, 오래된 예시는 프롬프트 자료와 문서에서 제거한다. 이 smoke는 검색 품질과 별개로 “존재성 신뢰”를 회복한다. (참고: S5, S6)

#### P2. retrospective feedback loop를 registry backlog와 직접 연결한다

반복 불만이 계속 회고에만 남고 corpus/alias/routing까지 닿지 않으면 같은 miss가 재발한다. session retrospective에서 최소한 `query`, `returnedSkills`, `actuallyUsedSkills`, `complaintClass(miss|overload|drift|low-value)`를 structured하게 남기고, 주기적으로 상위 miss class를 alias 추가·preset 정리·routing penalty 조정 backlog로 연결해야 한다. 이 단계는 구현 비용이 더 들지만, “불만이 반복된다”는 현재 상태를 정량적으로 끊는 데 필요하다. (추론: S2, S3, S4, S6)

### 5. 권장 실행 순서

1. **P0 / 검색 fallback + zero-result diagnostics**
   - 이유: 분석 중 첫 discover miss를 즉시 줄일 수 있다.
2. **P1 / task-size-aware routing**
   - 이유: 회고의 “도움이 안 됐다”를 줄이는 핵심은 over-bundling 완화다.
3. **P1 / alias·preset 보강**
   - 이유: code 변경 범위가 작고 immediate hit-rate 개선이 가능하다.
4. **P1 / catalog drift smoke**
   - 이유: 검색 품질과 독립적으로 trust 손실을 막는다.
5. **P2 / retrospective telemetry loop**
   - 이유: 반복 불만을 backlog 자동화와 연결한다.

### 6. 성공 기준

- `discover` 0-result 비율 감소
- fallback으로 성공한 query 비율 측정 가능
- small/medium 작업에서 최초 추천 skill 수 감소
- retrospective의 complaint class 중 `overload`, `drift` 비율 감소
- prompt/indexed docs에 나온 skill name과 실제 스킬 참조 경로의 resolve 불일치 0건

## Self Evaluation

- **stop**: 반복 불만의 failure pattern, 구조 원인, 우선순위 있는 개선 순서까지 제시했다.

## Final Validation

- KQ1~KQ3 모두 답변했다.
- Source Log 6건으로 repository-based 근거를 남겼다.
- 구현 제안과 현재 한계를 분리했다.

## Open Questions / Limits

- 이번 보고서는 session retrospective 표본을 소수만 읽었으므로 complaint 빈도의 정량 집계까지는 하지 않았다.
- `discover` 응답 schema를 실제 런타임 구현까지 내려가 확인하지는 않았으므로, diagnostics field 추가 제안은 설계 수준이다.
- 인덱싱된 프롬프트 자료와 현재 스킬 접근 인터페이스의 불일치가 단일 사례인지 반복 사례인지는 별도 sweep이 필요하다.
