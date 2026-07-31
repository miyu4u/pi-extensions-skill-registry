import type {
  IndexArtifacts,
  RawSkill,
  SearchHit,
  SkillCompareEntry,
  SkillComparePair,
  SkillCompareRelation,
  SkillCompareResult,
  SkillDecideEntry,
  SkillDecideResult,
  SkillExplainEntry,
  SkillExplainResult,
  SkillPlanResult,
  SkillPlanStep,
  SkillRecommendEntry,
  SkillRecommendRelationSignal,
  SkillRecommendResult,
  SkillRelationMode,
  SkillRoutePhase,
  SkillRouteResult,
} from '../shared'
import type { SkillRelationEngine, SkillRelationProjectionEntry } from './skill-relation-engine'
import type { SkillSearchEngine } from './skill-search-engine'

function sdeBuildExplainEntry(
  entry: SkillRelationProjectionEntry,
  hitByName: Map<string, SearchHit>,
  previewChars: number,
): SkillExplainEntry {
  const hit = hitByName.get(entry.skill.canonicalName)
  return {
    name: entry.skill.canonicalName,
    readPath: `skill://${entry.skill.canonicalName}`,
    path: entry.skill.path,
    title: entry.skill.title,
    scope: entry.skill.scope,
    category: entry.skill.category,
    aliases: entry.skill.aliases,
    reason: entry.reason,
    via: entry.via,
    depth: entry.depth,
    readLayer: entry.readLayer,
    applyLayer: entry.applyLayer,
    score: hit?.score,
    coverage: hit?.coverage,
    matchedTerms: hit?.matchedTerms ?? [],
    matchPreview: entry.skill.bodyText.slice(0, previewChars).replace(/\n+/g, ' '),
  } satisfies SkillExplainEntry
}

/** compare/decide/plan/route/recommend/explain의 concrete owner입니다. */
export interface PlanSkillsRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  limit?: number
  minScore?: number
}

export interface SkillExplainRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  limit?: number
  minScore?: number
}

export interface SkillRecommendRequest {
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  limit?: number
  minScore?: number
}

export class SkillDecisionEngine {
  constructor(
    private readonly searchEngine: SkillSearchEngine,
    private readonly relationEngine: SkillRelationEngine,
  ) {}

  /**
   * search와 pack 근거를 합친 explain 결과를 계산합니다.
   */
  explainSkills({
    index,
    query,
    names,
    relationMode = 'full',
    limit = index.settings.maxTopK,
    minScore = 0,
  }: SkillExplainRequest): SkillExplainResult {
    const hits = query ? this.searchEngine.searchByBm25(index, query, limit, minScore) : []
    const hitByName = new Map(hits.map((hit) => [hit.skill.canonicalName, hit] as const))
    const pack = this.relationEngine.projectSkills({
      index,
      query,
      names,
      relationMode,
      limit,
      minScore,
    })

    return {
      query,
      relationMode: pack.relationMode,
      seeds: pack.seeds,
      entries: pack.entries.map((entry) => sdeBuildExplainEntry(entry, hitByName, index.settings.includePreviewBodyChars)),
      missing: pack.missing,
      cycles: pack.cycles,
      diagnostics: pack.diagnostics,
    }
  }

  /**
   * query 또는 names 후보를 side-by-side 비교합니다.
   */
  compareSkills(
    index: IndexArtifacts,
    query: string | undefined,
    names: string[],
    limit = index.settings.maxTopK,
    minScore = 0,
  ): SkillCompareResult {
    const summaryLimit = Math.max(2, Math.min(limit, 8))
    const pool = this.collectRankedCandidates(index, query, names, summaryLimit, minScore)
    const { basis, hitByName } = pool
    const candidates = pool.candidates.slice(0, summaryLimit)
    const candidateEntries = sdeBuildCompareEntries(candidates, hitByName, index)
    const pairs = sdeBuildComparePairs(candidates, candidateEntries)
    return {
      query,
      basis,
      entries: candidateEntries,
      pairs,
    }
  }

  /**
   * query 또는 names 후보 중 첫 read winner를 결정합니다.
   */
  decideSkills(
    index: IndexArtifacts,
    query: string | undefined,
    names: string[],
    limit = index.settings.maxTopK,
    minScore = 0,
  ): SkillDecideResult {
    const summaryLimit = Math.max(1, limit)
    const candidateSearchLimit = limit
    const pool = this.collectRankedCandidates(index, query, names, candidateSearchLimit, minScore)
    const orderedAll = sdeProcessDecideEntries(index, pool.candidates, pool.namedSkills, pool.hitByName)
    return {
      query,
      basis: pool.basis,
      winner: orderedAll[0]?.name ?? null,
      ordered: orderedAll.slice(0, summaryLimit),
    }
  }

  /**
   * winner를 시작점으로 후속 read sequence를 계획합니다.
   */
  planSkills(req: PlanSkillsRequest): SkillPlanResult {
    const { index, query, names, relationMode = 'full', limit = index.settings.maxTopK, minScore = 0 } = req
    const summaryLimit = Math.max(1, limit)
    const isLarge = limit >= index.settings.maxTopK
    const decideLimit = isLarge ? index.skills.length : Math.min(Math.max(summaryLimit * 5, 25), index.skills.length)
    const decision = this.decideSkills(index, query, names, decideLimit, minScore)
    return this.buildPlanSteps(decision, relationMode, summaryLimit)
  }

  private buildPlanSteps(decision: SkillDecideResult, relationMode: SkillRelationMode, summaryLimit: number): SkillPlanResult {
    if (!decision.winner) {
      return {
        query: decision.query,
        basis: decision.basis,
        relationMode,
        winner: null,
        steps: [],
        deferred: [],
      }
    }
    const { query, basis, winner, ordered } = decision
    const orderedByName = this.buildPlanStepsBuildByName(ordered)
    const steps = this.buildPlanStepsCollectSteps(orderedByName, ordered, winner, relationMode, summaryLimit)
    const finalized = this.buildPlanStepsFinalizeSteps(ordered, steps, summaryLimit)
    return {
      query,
      basis,
      relationMode,
      winner,
      steps: finalized.steps,
      deferred: finalized.deferred,
    }
  }

  private buildPlanStepsBuildByName(ordered: readonly SkillDecideEntry[]): Map<string, SkillDecideEntry> {
    return new Map(ordered.map((entry) => [entry.name, entry]))
  }

  private buildPlanStepsCollectSteps(
    orderedByName: Map<string, SkillDecideEntry>,
    ordered: readonly SkillDecideEntry[],
    winner: string,
    relationMode: SkillRelationMode,
    summaryLimit: number,
  ): SkillPlanStep[] {
    const orderIndexByName = new Map(ordered.map((entry, indexPosition) => [entry.name, indexPosition]))
    const steps: SkillPlanStep[] = []
    const usedNames = new Set<string>()
    const winnerEntry = orderedByName.get(winner)
    this.buildPlanStepsAddStep(steps, usedNames, winnerEntry, {
      reason: 'winner',
      phase: 'first',
    })
    for (const candidateName of this.buildPlanStepsSortByDecisionOrder(winnerEntry?.peerRequiredBy ?? [], orderIndexByName)) {
      this.buildPlanStepsAddStep(steps, usedNames, orderedByName.get(candidateName), {
        reason: 'unblocks-required-peer',
        phase: 'next',
        via: winner,
      })
    }
    if (relationMode === 'full') {
      for (const candidateName of this.buildPlanStepsSortByDecisionOrder(winnerEntry?.peerRecommendedBy ?? [], orderIndexByName)) {
        this.buildPlanStepsAddStep(steps, usedNames, orderedByName.get(candidateName), {
          reason: 'unblocks-recommended-peer',
          phase: 'later',
          via: winner,
        })
      }
    }
    for (const entry of ordered) {
      if (steps.length >= summaryLimit) {
        break
      }
      this.buildPlanStepsAddStep(steps, usedNames, entry, {
        reason: 'alternative',
        phase: 'later',
      })
    }
    return steps
  }

  private buildPlanStepsSortByDecisionOrder(namesToSort: readonly string[], orderIndexByName: Map<string, number>): string[] {
    return [...namesToSort].sort((left, right) => {
      const leftIndex = orderIndexByName.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightIndex = orderIndexByName.get(right) ?? Number.MAX_SAFE_INTEGER
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex
      }
      return left.localeCompare(right)
    })
  }

  private buildPlanStepsAddStep(
    steps: SkillPlanStep[],
    usedNames: Set<string>,
    entry: SkillDecideEntry | undefined,
    config: {
      reason: SkillPlanStep['reason']
      phase: SkillPlanStep['phase']
      via?: string
    },
  ): void {
    if (!entry || usedNames.has(entry.name)) {
      return
    }
    usedNames.add(entry.name)
    steps.push({
      order: steps.length + 1,
      phase: config.phase,
      name: entry.name,
      readPath: entry.readPath,
      path: entry.path,
      title: entry.title,
      category: entry.category,
      scope: entry.scope,
      reason: config.reason,
      via: config.via,
      score: entry.score,
      queryScore: entry.queryScore,
      preview: entry.preview,
    })
  }

  private buildPlanStepsFinalizeSteps(
    ordered: readonly SkillDecideEntry[],
    steps: SkillPlanStep[],
    summaryLimit: number,
  ): {
    steps: SkillPlanStep[]
    deferred: string[]
  } {
    const visibleSteps = steps.slice(0, summaryLimit).map((entry, indexPosition) => ({
      ...entry,
      order: indexPosition + 1,
    }))
    const visibleNames = new Set(visibleSteps.map((entry) => entry.name))
    return {
      steps: visibleSteps,
      deferred: ordered.map((entry) => entry.name).filter((name) => !visibleNames.has(name)),
    }
  }

  /**
   * plan 결과를 layer-aware itinerary로 투영합니다.
   */
  routeSkills(req: PlanSkillsRequest): SkillRouteResult {
    const { index, query, names, relationMode = 'full', limit = index.settings.maxTopK, minScore = 0 } = req
    const summaryLimit = Math.max(1, limit)
    const plan = this.planSkills({ index, query, names, relationMode, limit: summaryLimit, minScore })
    if (!plan.winner) {
      return this.빈경로생성(query, plan.basis, relationMode)
    }
    const pack = this.relationEngine.projectSkills({
      index,
      query,
      names,
      relationMode,
      limit: Math.max(summaryLimit, plan.steps.length),
      minScore,
    })
    const entryByName = new Map(pack.entries.map((entry) => [entry.skill.canonicalName, entry] as const))
    const phases: SkillRoutePhase[] = []
    for (const step of plan.steps.slice(0, summaryLimit)) {
      const { kind, layer, rationale } = this.단계속성결정(step.reason, entryByName.get(step.name))
      this.경로단계추가(phases, step, kind, layer, rationale)
    }
    return {
      query,
      basis: plan.basis,
      relationMode,
      winner: plan.winner,
      phases,
      deferred: this.미결정목록정리(plan.steps, plan.deferred, summaryLimit),
    }
  }

  private 빈경로생성(query: string | undefined, basis: SkillRouteResult['basis'], relationMode: SkillRelationMode): SkillRouteResult {
    return {
      query,
      basis,
      relationMode,
      winner: null,
      phases: [],
      deferred: [],
    }
  }

  private 단계속성결정(
    reason: string,
    packEntry: { readLayer?: number | null; applyLayer?: number | null } | undefined,
  ): { kind: SkillRoutePhase['kind']; layer: number | null; rationale: string[] } {
    const kind = this.단계종류결정(reason)
    const layer = this.레이어결정(kind, packEntry)
    const rationale = this.근거결정(kind, layer)
    return { kind, layer, rationale }
  }

  private 단계종류결정(reason: string): SkillRoutePhase['kind'] {
    if (reason === 'winner') return 'start'
    if (reason === 'unblocks-required-peer') return 'read-layer'
    if (reason === 'unblocks-recommended-peer') return 'apply-layer'
    return 'fallback'
  }

  private 레이어결정(
    kind: SkillRoutePhase['kind'],
    packEntry: { readLayer?: number | null; applyLayer?: number | null } | undefined,
  ): number | null {
    if (kind === 'read-layer') return packEntry?.readLayer ?? null
    if (kind === 'apply-layer') return packEntry?.applyLayer ?? packEntry?.readLayer ?? null
    return null
  }

  private 근거결정(kind: SkillRoutePhase['kind'], layer: number | null): string[] {
    if (kind === 'start') return ['decide winner']
    if (kind === 'read-layer') return [`pack read layer ${layer ?? '-'}`]
    if (kind === 'apply-layer') return [`pack apply layer ${layer ?? '-'}`]
    return ['remaining planned steps']
  }

  private 경로단계추가(
    phases: SkillRoutePhase[],
    step: SkillPlanStep,
    kind: SkillRoutePhase['kind'],
    layer: number | null,
    rationale: string[],
  ): void {
    const lastPhase = phases.at(-1)
    if (lastPhase && lastPhase.kind === kind && lastPhase.layer === layer) {
      lastPhase.names.push(step.name)
      lastPhase.readPaths.push(step.readPath)
      lastPhase.rationale = Array.from(new Set([...lastPhase.rationale, ...rationale]))
      return
    }
    phases.push({
      order: phases.length + 1,
      kind,
      layer,
      names: [step.name],
      readPaths: [step.readPath],
      rationale,
    })
  }

  private 미결정목록정리(steps: SkillPlanStep[], deferred: string[], summaryLimit: number): string[] {
    const combined = [...steps.slice(summaryLimit).map((step) => step.name), ...deferred]
    return Array.from(new Set(combined))
  }

  /**
   * query와 seed 인접 relation 기준 후속 추천 skill을 계산합니다.
   */
  recommendSkills(index: IndexArtifacts, req: SkillRecommendRequest): SkillRecommendResult {
    const summaryLimit = Math.max(1, req.limit ?? index.settings.maxTopK)
    const prep = sdePrepareRecommendContextUnique(index, req, summaryLimit, this.searchEngine, this.relationEngine)
    sdeProcessQueryHitsUnique(prep.ctx.recommendationByName, prep.queryHits, prep.ctx.seedNames)
    sdeProcessOutboundUnique(prep.ctx, prep.seeds, prep.outboundByCanonical)
    sdeProcessInboundUnique(prep.ctx, prep.seeds, prep.inboundByCanonical)
    sdeProcessCategoriesUnique(prep.ctx, index.skills, prep.seedCategories)
    const recommendations = Array.from(prep.ctx.recommendationByName.values())
      .map((entry) => sdeMapEntryUnique(entry, index.settings.includePreviewBodyChars))
      .sort(sdeSortEntriesUnique)
      .slice(0, summaryLimit)
    return {
      query: req.query,
      relationMode: req.relationMode ?? 'full',
      seeds: prep.seeds.map((s) => s.canonicalName),
      recommendations,
    }
  }

  /**
   * compare/decide 공통 candidate pool을 stable order로 수집합니다.
   */
  private collectRankedCandidates(
    index: IndexArtifacts,
    query: string | undefined,
    names: string[],
    limit: number,
    minScore: number,
  ): {
    basis: SkillRouteResult['basis']
    namedSkills: RawSkill[]
    queryHits: SearchHit[]
    hitByName: Map<string, SearchHit>
    candidates: RawSkill[]
  } {
    const basis: SkillRouteResult['basis'] = query && names.length > 0 ? 'query+names' : names.length > 0 ? 'names' : 'query'
    const namedSkills = this.searchEngine.findSkillsByNames(index, names)
    const queryHits = query ? this.searchEngine.searchByBm25(index, query, limit, minScore) : []
    const hitByName = new Map(queryHits.map((hit) => [hit.skill.canonicalName, hit] as const))
    const candidates = [...namedSkills, ...queryHits.map((hit) => hit.skill)].filter(
      (skill, indexPosition, collection) => collection.findIndex((entry) => entry.canonicalName === skill.canonicalName) === indexPosition,
    )
    return {
      basis,
      namedSkills,
      queryHits,
      hitByName,
      candidates,
    }
  }
}

function sdeBuildComparePairUnique(
  leftSkill: RawSkill,
  leftEntry: SkillCompareEntry,
  rightSkill: RawSkill,
  rightEntry: SkillCompareEntry,
): SkillComparePair {
  const intersect = (left: string[], right: string[]): string[] => {
    const rightSet = new Set(right)
    return [...new Set(left.filter((item) => rightSet.has(item)))].sort()
  }
  const subtract = (left: string[], right: string[]): string[] => {
    const rightSet = new Set(right)
    return [...new Set(left.filter((item) => !rightSet.has(item)))].sort()
  }

  const resolvePairRelation = (from: RawSkill, to: RawSkill): SkillCompareRelation | undefined => {
    const targetNames = new Set([to.canonicalName, ...to.aliases])
    if (from.requires.some((name) => targetNames.has(name))) {
      return 'requires'
    }
    if (from.recommends.some((name) => targetNames.has(name))) {
      return 'recommends'
    }
    return undefined
  }

  const scoreDelta =
    leftEntry.score !== undefined || rightEntry.score !== undefined
      ? Number(((leftEntry.score ?? 0) - (rightEntry.score ?? 0)).toFixed(3))
      : undefined

  return {
    left: leftSkill.canonicalName,
    right: rightSkill.canonicalName,
    sameCategory: leftSkill.category === rightSkill.category,
    sharedAliases: intersect(leftSkill.aliases, rightSkill.aliases),
    sharedMatchedTerms: intersect(leftEntry.matchedTerms, rightEntry.matchedTerms),
    leftOnlyMatchedTerms: subtract(leftEntry.matchedTerms, rightEntry.matchedTerms),
    rightOnlyMatchedTerms: subtract(rightEntry.matchedTerms, leftEntry.matchedTerms),
    sharedRequires: intersect(leftSkill.requires, rightSkill.requires),
    sharedRecommends: intersect(leftSkill.recommends, rightSkill.recommends),
    leftToRight: resolvePairRelation(leftSkill, rightSkill),
    rightToLeft: resolvePairRelation(rightSkill, leftSkill),
    scoreDelta,
  }
}

function sdeBuildCompareEntries(candidates: RawSkill[], hitByName: Map<string, SearchHit>, index: IndexArtifacts): SkillCompareEntry[] {
  return candidates.map((skill) => {
    const hit = hitByName.get(skill.canonicalName)
    return {
      name: skill.canonicalName,
      readPath: `skill://${skill.canonicalName}`,
      path: skill.path,
      title: skill.title,
      scope: skill.scope,
      category: skill.category,
      aliases: skill.aliases,
      score: hit?.score,
      coverage: hit?.coverage,
      matchedTerms: hit?.matchedTerms ?? [],
      requires: skill.requires,
      recommends: skill.recommends,
      preview: skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, ' '),
    } satisfies SkillCompareEntry
  })
}

function sdeBuildComparePairs(candidates: RawSkill[], candidateEntries: SkillCompareEntry[]): SkillComparePair[] {
  const pairs: SkillComparePair[] = []
  for (let indexPosition = 0; indexPosition < candidates.length; indexPosition += 1) {
    const leftSkill = candidates[indexPosition]
    if (!leftSkill) {
      continue
    }
    const leftEntry = candidateEntries[indexPosition]
    if (!leftEntry) {
      continue
    }
    for (let rightIndexPosition = indexPosition + 1; rightIndexPosition < candidates.length; rightIndexPosition += 1) {
      const rightSkill = candidates[rightIndexPosition]
      const rightEntry = candidateEntries[rightIndexPosition]
      if (!rightSkill || !rightEntry) {
        continue
      }
      pairs.push(sdeBuildComparePairUnique(leftSkill, leftEntry, rightSkill, rightEntry))
    }
  }
  return pairs
}

interface DecideEntryRequest {
  skill: RawSkill
  candidates: RawSkill[]
  index: IndexArtifacts
  hitByName: Map<string, SearchHit>
  explicitNameSet: Set<string>
  resolveCandidateNames: (targets: string[]) => string[]
  resolveUnresolvedRequires: (targets: string[]) => string[]
}

interface EntryExtra {
  peerRequiredBy: string[]
  peerRecommendedBy: string[]
  requiredPeers: string[]
  unresolvedRequires: string[]
  reasons: string[]
  explicitName: boolean
}

function sdeGetPeers(
  skill: RawSkill,
  candidates: RawSkill[],
  index: IndexArtifacts,
): { peerRequiredBy: string[]; peerRecommendedBy: string[] } {
  const peerRequiredBy = candidates
    .filter(
      (other) =>
        other.canonicalName !== skill.canonicalName &&
        other.requires.some((name) => (index.aliasToCanonical.get(name) ?? name) === skill.canonicalName),
    )
    .map((other) => other.canonicalName)
    .sort()
  const peerRecommendedBy = candidates
    .filter(
      (other) =>
        other.canonicalName !== skill.canonicalName &&
        other.recommends.some((name) => (index.aliasToCanonical.get(name) ?? name) === skill.canonicalName),
    )
    .map((other) => other.canonicalName)
    .sort()
  return { peerRequiredBy, peerRecommendedBy }
}

function sdeCalculateScoreAndReasons(params: {
  queryScore?: number
  queryCoverage?: number
  explicitName: boolean
  peerRequiredBy: string[]
  peerRecommendedBy: string[]
  requiredPeers: string[]
  unresolvedRequires: string[]
}): { score: number; reasons: string[] } {
  const { queryScore, queryCoverage, explicitName, peerRequiredBy, peerRecommendedBy, requiredPeers, unresolvedRequires } = params
  const score =
    (queryScore ?? 0) +
    (queryCoverage ?? 0) * 0.25 +
    (explicitName ? 0.5 : 0) +
    peerRequiredBy.length * 4 +
    peerRecommendedBy.length * 2 -
    requiredPeers.length * 2 -
    unresolvedRequires.length * 4
  const reasons = [
    queryScore === undefined ? '' : `query score ${queryScore.toFixed(3)} coverage ${queryCoverage ?? 0}`,
    explicitName ? 'explicit names input' : '',
    peerRequiredBy.length ? `required by peers: ${peerRequiredBy.join(', ')}` : '',
    peerRecommendedBy.length ? `recommended by peers: ${peerRecommendedBy.join(', ')}` : '',
    requiredPeers.length ? `requires peers first: ${requiredPeers.join(', ')}` : '',
    unresolvedRequires.length ? `unresolved requires: ${unresolvedRequires.join(', ')}` : '',
  ].filter(Boolean)
  return { score, reasons }
}

function sdeCreateDecideEntry(
  skill: RawSkill,
  index: IndexArtifacts,
  score: number,
  hit: SearchHit | undefined,
  extra: EntryExtra,
): SkillDecideEntry {
  return {
    name: skill.canonicalName,
    readPath: `skill://${skill.canonicalName}`,
    path: skill.path,
    title: skill.title,
    scope: skill.scope,
    category: skill.category,
    aliases: skill.aliases,
    score: Number(score.toFixed(3)),
    queryScore: hit?.score === undefined ? undefined : Number(hit.score.toFixed(3)),
    queryCoverage: hit?.coverage,
    ...extra,
    preview: skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, ' '),
  }
}

function sdeBuildDecideEntryUnique(req: DecideEntryRequest): SkillDecideEntry {
  const { skill, candidates, index, hitByName, explicitNameSet } = req
  const hit = hitByName.get(skill.canonicalName)
  const explicitName = explicitNameSet.has(skill.canonicalName)
  const { peerRequiredBy, peerRecommendedBy } = sdeGetPeers(skill, candidates, index)
  const requiredPeers = req.resolveCandidateNames(skill.requires).filter((name) => name !== skill.canonicalName)
  const unresolvedRequires = req.resolveUnresolvedRequires(skill.requires)
  const { score, reasons } = sdeCalculateScoreAndReasons({
    queryScore: hit?.score,
    queryCoverage: hit?.coverage,
    explicitName,
    peerRequiredBy,
    peerRecommendedBy,
    requiredPeers,
    unresolvedRequires,
  })
  return sdeCreateDecideEntry(skill, index, score, hit, {
    peerRequiredBy,
    peerRecommendedBy,
    requiredPeers,
    unresolvedRequires,
    reasons,
    explicitName,
  })
}

function sdeProcessDecideEntries(
  index: IndexArtifacts,
  candidates: RawSkill[],
  namedSkills: RawSkill[],
  hitByName: Map<string, SearchHit>,
): SkillDecideEntry[] {
  const context = sdeProcessDecideEntriesBuildContext(index, candidates, namedSkills)
  return candidates
    .map((skill) =>
      sdeBuildDecideEntryUnique({
        skill,
        candidates,
        index,
        hitByName,
        ...context,
      }),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      if ((right.queryScore ?? 0) !== (left.queryScore ?? 0)) {
        return (right.queryScore ?? 0) - (left.queryScore ?? 0)
      }
      if (right.peerRequiredBy.length !== left.peerRequiredBy.length) {
        return right.peerRequiredBy.length - left.peerRequiredBy.length
      }
      return left.name.localeCompare(right.name)
    })
}

function sdeProcessDecideEntriesBuildContext(
  index: IndexArtifacts,
  candidates: RawSkill[],
  namedSkills: RawSkill[],
): {
  explicitNameSet: Set<string>
  resolveCandidateNames: (targets: string[]) => string[]
  resolveUnresolvedRequires: (targets: string[]) => string[]
} {
  const explicitNameSet = new Set(namedSkills.map((skill) => skill.canonicalName))
  const candidateNameSet = new Set(candidates.map((skill) => skill.canonicalName))
  const allSkillNameSet = new Set(index.skills.map((skill) => skill.canonicalName))
  return {
    explicitNameSet,
    resolveCandidateNames: (targets) =>
      [...new Set(targets.map((name) => index.aliasToCanonical.get(name) ?? name).filter((name) => candidateNameSet.has(name)))].sort(),
    resolveUnresolvedRequires: (targets) =>
      [
        ...new Set(
          targets.filter((name) => {
            const canonical = index.aliasToCanonical.get(name) ?? name
            return !allSkillNameSet.has(canonical)
          }),
        ),
      ].sort(),
  }
}

interface MutableRecommendEntry {
  skill: RawSkill
  score: number
  queryScore?: number
  queryCoverage?: number
  matchedTermSet: Set<string>
  outboundSignals: SkillRecommendRelationSignal[]
  outboundKeys: Set<string>
  inboundSignals: SkillRecommendRelationSignal[]
  inboundKeys: Set<string>
  sharedCategorySeedSet: Set<string>
}

interface RecommendContext {
  recommendationByName: Map<string, MutableRecommendEntry>
  seedNames: Set<string>
  skillByName: Map<string, RawSkill>
  canUseRecommended: boolean
}

function sdePrepareRecommendContextUnique(
  index: IndexArtifacts,
  req: SkillRecommendRequest,
  summaryLimit: number,
  searchEngine: SkillSearchEngine,
  relationEngine: SkillRelationEngine,
) {
  const seeds = searchEngine.resolveSeedSkills(index, req.query, req.names, summaryLimit, req.minScore ?? 0)
  const seedNames = new Set(seeds.map((s) => s.canonicalName))
  const queryHits = req.query
    ? searchEngine.searchByBm25(index, req.query, Math.max(summaryLimit * 4, summaryLimit), req.minScore ?? 0)
    : []
  const { skillByName, outboundByCanonical, inboundByCanonical } = sdeFetchRelationsUnique(index, relationEngine)
  return {
    seeds,
    queryHits,
    seedCategories: sdeBuildSeedCategoriesUnique(seeds),
    outboundByCanonical,
    inboundByCanonical,
    ctx: {
      recommendationByName: new Map<string, MutableRecommendEntry>(),
      seedNames,
      skillByName,
      canUseRecommended: (req.relationMode ?? 'full') === 'full',
    },
  }
}

function sdeBuildSeedCategoriesUnique(seeds: RawSkill[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const seed of seeds) {
    const existing = map.get(seed.category) ?? []
    existing.push(seed.canonicalName)
    map.set(seed.category, existing)
  }
  return map
}

function sdeFetchRelationsUnique(index: IndexArtifacts, relationEngine: SkillRelationEngine) {
  const edges = relationEngine.buildRelationGraphEdges(index)
  return {
    skillByName: new Map(index.skills.map((s) => [s.canonicalName, s] as const)),
    outboundByCanonical: relationEngine.groupEdgesByCanonical(edges, 'from'),
    inboundByCanonical: relationEngine.groupEdgesByCanonical(edges, 'to'),
  }
}

function sdeEnsureEntryUnique(
  recommendationByName: Map<string, MutableRecommendEntry>,
  skill: RawSkill,
  seedNames: Set<string>,
): MutableRecommendEntry | null {
  if (seedNames.has(skill.canonicalName)) {
    return null
  }
  let existing = recommendationByName.get(skill.canonicalName)
  if (!existing) {
    existing = {
      skill,
      score: 0,
      matchedTermSet: new Set<string>(),
      outboundSignals: [],
      outboundKeys: new Set<string>(),
      inboundSignals: [],
      inboundKeys: new Set<string>(),
      sharedCategorySeedSet: new Set<string>(),
    }
    recommendationByName.set(skill.canonicalName, existing)
  }
  return existing
}

function sdeProcessQueryHitsUnique(
  recommendationByName: Map<string, MutableRecommendEntry>,
  queryHits: SearchHit[],
  seedNames: Set<string>,
): void {
  for (const hit of queryHits) {
    const rec = sdeEnsureEntryUnique(recommendationByName, hit.skill, seedNames)
    if (rec) {
      rec.score += hit.score + hit.coverage * 0.25
      rec.queryScore = Math.max(rec.queryScore ?? 0, hit.score)
      rec.queryCoverage = Math.max(rec.queryCoverage ?? 0, hit.coverage)
      for (const term of hit.matchedTerms) {
        rec.matchedTermSet.add(term)
      }
    }
  }
}

function sdeHandleOutboundEdgeUnique(ctx: RecommendContext, seed: RawSkill, edge: { to?: string; relation: string }): void {
  if (edge.relation === 'recommends' && !ctx.canUseRecommended) return
  if (!edge.to || ctx.seedNames.has(edge.to)) return
  const relatedSkill = ctx.skillByName.get(edge.to)
  if (!relatedSkill) return
  const rec = sdeEnsureEntryUnique(ctx.recommendationByName, relatedSkill, ctx.seedNames)
  if (!rec) return
  const relation = edge.relation === 'requires' ? 'required' : 'recommended'
  const key = `${seed.canonicalName}:${relation}`
  if (rec.outboundKeys.has(key)) return
  rec.outboundKeys.add(key)
  rec.outboundSignals.push({ via: seed.canonicalName, relation })
  rec.score += relation === 'required' ? 4 : 2
}

function sdeProcessOutboundUnique(
  ctx: RecommendContext,
  seeds: RawSkill[],
  outboundByCanonical: Map<string, Array<{ to?: string; relation: string }>>,
): void {
  for (const seed of seeds) {
    const edges = outboundByCanonical.get(seed.canonicalName) ?? []
    for (const edge of edges) {
      sdeHandleOutboundEdgeUnique(ctx, seed, edge)
    }
  }
}

function sdeHandleInboundEdgeUnique(ctx: RecommendContext, seed: RawSkill, edge: { from?: string; relation: string }): void {
  if (edge.relation === 'recommends' && !ctx.canUseRecommended) return
  if (!edge.from || ctx.seedNames.has(edge.from)) return
  const relatedSkill = ctx.skillByName.get(edge.from)
  if (!relatedSkill) return
  const rec = sdeEnsureEntryUnique(ctx.recommendationByName, relatedSkill, ctx.seedNames)
  if (!rec) return
  const relation = edge.relation === 'requires' ? 'required' : 'recommended'
  const key = `${seed.canonicalName}:${relation}`
  if (rec.inboundKeys.has(key)) return
  rec.inboundKeys.add(key)
  rec.inboundSignals.push({ via: seed.canonicalName, relation })
  rec.score += relation === 'required' ? 1.5 : 0.75
}

function sdeProcessInboundUnique(
  ctx: RecommendContext,
  seeds: RawSkill[],
  inboundByCanonical: Map<string, Array<{ from?: string; relation: string }>>,
): void {
  for (const seed of seeds) {
    const edges = inboundByCanonical.get(seed.canonicalName) ?? []
    for (const edge of edges) {
      sdeHandleInboundEdgeUnique(ctx, seed, edge)
    }
  }
}

function sdeProcessCategoriesUnique(ctx: RecommendContext, skills: RawSkill[], seedCategories: Map<string, string[]>): void {
  for (const skill of skills) {
    if (ctx.seedNames.has(skill.canonicalName)) continue
    const sameCategorySeeds = seedCategories.get(skill.category) ?? []
    if (sameCategorySeeds.length === 0) continue
    const rec = sdeEnsureEntryUnique(ctx.recommendationByName, skill, ctx.seedNames)
    if (!rec) continue
    let addedCount = 0
    for (const seedName of sameCategorySeeds) {
      if (!rec.sharedCategorySeedSet.has(seedName)) {
        rec.sharedCategorySeedSet.add(seedName)
        addedCount += 1
      }
    }
    rec.score += addedCount * 0.5
  }
}

function sdeSortSignalsUnique(left: SkillRecommendRelationSignal, right: SkillRecommendRelationSignal): number {
  if (left.relation !== right.relation) {
    return left.relation.localeCompare(right.relation)
  }
  return left.via.localeCompare(right.via)
}

function sdeMapEntryUnique(entry: MutableRecommendEntry, includePreviewBodyChars: number): SkillRecommendEntry {
  return {
    name: entry.skill.canonicalName,
    readPath: `skill://${entry.skill.canonicalName}`,
    path: entry.skill.path,
    title: entry.skill.title,
    category: entry.skill.category,
    scope: entry.skill.scope,
    aliases: entry.skill.aliases,
    score: Number(entry.score.toFixed(3)),
    queryScore: entry.queryScore === undefined ? undefined : Number(entry.queryScore.toFixed(3)),
    queryCoverage: entry.queryCoverage,
    matchedTerms: [...entry.matchedTermSet].sort(),
    outboundSignals: [...entry.outboundSignals].sort(sdeSortSignalsUnique),
    inboundSignals: [...entry.inboundSignals].sort(sdeSortSignalsUnique),
    sharedCategorySeeds: [...entry.sharedCategorySeedSet].sort(),
    preview: entry.skill.bodyText.slice(0, includePreviewBodyChars).replace(/\n+/g, ' '),
  }
}

function sdeSortEntriesUnique(left: SkillRecommendEntry, right: SkillRecommendEntry): number {
  if (right.score !== left.score) {
    return right.score - left.score
  }
  if (right.outboundSignals.length !== left.outboundSignals.length) {
    return right.outboundSignals.length - left.outboundSignals.length
  }
  if ((right.queryScore ?? 0) !== (left.queryScore ?? 0)) {
    return (right.queryScore ?? 0) - (left.queryScore ?? 0)
  }
  return left.name.localeCompare(right.name)
}
