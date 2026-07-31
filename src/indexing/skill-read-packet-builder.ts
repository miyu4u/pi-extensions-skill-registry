import type {
  IndexArtifacts,
  SkillBriefEntry,
  SkillBriefResult,
  SkillBundleResult,
  SkillCurrentTurnPacketResult,
  SkillHandoffResult,
  SkillPack,
  SkillPackEntry,
  SkillRecoveryPacketResult,
  SkillRelationMode,
  SkillResumePacketResult,
  SkillRoutePhase,
  SkillRouteResult,
  SkillSessionPacketResult,
  SkillSessionPacketStep,
  SkillTurnPacketResult,
} from '../shared'
import { composeReasonPriority } from './compose-reason-priority'
import type { SkillDecisionEngine } from './skill-decision-engine'
import type { SkillIndexDiagnostics } from './skill-index-diagnostics'
import type { SkillRelationEngine, SkillRelationProjection } from './skill-relation-engine'

export interface SkillBriefRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  includeBody?: boolean
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillBundleRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}
export interface SkillHandoffRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillSessionPacketRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}
export interface SkillRecoveryPacketRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillResumePacketRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillTurnPacketRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillCurrentTurnPacketRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  budgetChars?: number
  budgetTokens?: number
  limit?: number
  minScore?: number
}

export interface SkillPackRequest {
  index: IndexArtifacts
  query: string | undefined
  names: string[]
  relationMode?: SkillRelationMode
  includeBody: boolean
  budgetChars: number
  budgetTokens: number
  limit?: number
  minScore?: number
}

/** read/session/turn 계열 packet projection의 concrete owner입니다. */
export class SkillReadPacketBuilder {
  constructor(
    private readonly relationEngine: SkillRelationEngine,
    private readonly indexDiagnostics: SkillIndexDiagnostics,
    private readonly decisionEngine: SkillDecisionEngine,
  ) {}

  private briefSkillsBuildResult(
    query: string | undefined,
    relationMode: SkillRelationMode,
    route: SkillRouteResult,
    pack: SkillPack,
  ): SkillBriefResult {
    const entries = this.buildBriefEntries(route.phases, pack.entries)
    return {
      query,
      basis: route.basis,
      relationMode,
      winner: route.winner,
      phases: route.phases,
      entries,
      deferred: route.deferred,
      omittedReadPaths: pack.omittedReadPaths,
      budget: pack.budget,
    }
  }

  /**
   * route와 pack을 합쳐 bounded read packet을 구성합니다.
   */
  briefSkills(request: SkillBriefRequest): SkillBriefResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      includeBody = true,
      budgetChars = 4_000,
      budgetTokens = 1_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request

    const summaryLimit = Math.max(1, limit)
    const route = this.decisionEngine.routeSkills({
      index,
      query,
      names,
      relationMode,
      limit: summaryLimit,
      minScore,
    })
    const pack = this.packSkills({
      index,
      query,
      names,
      relationMode,
      includeBody,
      budgetChars,
      budgetTokens,
      limit: Math.max(summaryLimit, route.phases.flatMap((phase) => phase.names).length),
      minScore,
    })

    return this.briefSkillsBuildResult(query, relationMode, route, pack)
  }

  private buildBriefEntries(phases: SkillRoutePhase[], packEntries: SkillPackEntry[]): SkillBriefEntry[] {
    const packEntryByName = new Map(packEntries.map((entry) => [entry.name, entry] as const))
    const seenNames = new Set<string>()
    const entries: SkillBriefEntry[] = []
    for (const phase of phases) {
      for (const name of phase.names) {
        if (seenNames.has(name)) {
          continue
        }
        const packEntry = packEntryByName.get(name)
        if (!packEntry) {
          continue
        }
        seenNames.add(name)
        entries.push({
          phaseOrder: phase.order,
          phaseKind: phase.kind,
          layer: phase.layer,
          name: packEntry.name,
          readPath: packEntry.readPath,
          path: packEntry.path,
          title: packEntry.title,
          category: packEntry.category,
          scope: packEntry.scope,
          preview: packEntry.preview,
          body: packEntry.body,
          omittedByBudget: packEntry.omittedByBudget,
        })
      }
    }
    return entries
  }

  bundleSkills(request: SkillBundleRequest): SkillBundleResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request

    const brief = this.briefSkills({
      index,
      query,
      names,
      relationMode,
      includeBody: true,
      budgetChars,
      budgetTokens,
      limit,
      minScore,
    })

    return this.bundleSkillsAssemble(brief)
  }

  private bundleSkillsAssemble(brief: SkillBriefResult): SkillBundleResult {
    const entries = brief.entries.map(({ body, ...entry }) => entry)
    const entriesWithBody = brief.entries.some((entry) => entry.body) ? brief.entries : undefined

    return {
      query: brief.query,
      basis: brief.basis,
      relationMode: brief.relationMode,
      winner: brief.winner,
      ready: brief.omittedReadPaths.length === 0,
      phases: brief.phases,
      entries,
      entriesWithBody,
      deferred: brief.deferred,
      omittedReadPaths: brief.omittedReadPaths,
      budget: brief.budget,
    }
  }

  /**
   * bundle에 source/next command 힌트를 얹은 handoff packet을 구성합니다.
   */
  handoffSkills(request: SkillHandoffRequest): SkillHandoffResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request
    const bundle = this.bundleSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const winnerEntry = bundle.entries.find((entry) => entry.name === bundle.winner)
    const sourcePath = winnerEntry?.path ?? null
    const nextCommand = sourcePath ? `read("${sourcePath}")` : null
    return {
      query: bundle.query,
      basis: bundle.basis,
      relationMode: bundle.relationMode,
      winner: bundle.winner,
      ready: bundle.ready,
      sourcePath,
      sourceCategory: winnerEntry?.category,
      sourceScope: winnerEntry?.scope,
      nextCommand,
      applyHint: bundle.ready ? undefined : 'Increase budgetChars/budgetTokens or inspect omittedReadPaths before apply.',
      phases: bundle.phases,
      entries: bundle.entries,
      entriesWithBody: bundle.entriesWithBody,
      deferred: bundle.deferred,
      omittedReadPaths: bundle.omittedReadPaths,
      budget: bundle.budget,
    }
  }

  /**
   * handoff를 session-ready ordered packet으로 투영합니다.
   */
  sessionPacketSkills(request: SkillSessionPacketRequest): SkillSessionPacketResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request
    const handoff = this.handoffSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const sourcePaths = handoff.entries.map((entry) => entry.path)
    return {
      query: handoff.query,
      basis: handoff.basis,
      relationMode: handoff.relationMode,
      winner: handoff.winner,
      ready: handoff.ready,
      sourcePaths,
      sourcePathScopes: handoff.entries.map((entry) => entry.scope),
      sourcePathCategories: handoff.entries.map((entry) => entry.category),
      nextCommands: sourcePaths.map((sourcePath) => `read("${sourcePath}")`),
      applyHint: handoff.applyHint,
      recoveryGuidance: this.buildSessionRecoveryGuidance(handoff.ready, handoff.omittedReadPaths, handoff.applyHint),
      steps: this.buildSessionSteps(handoff.entries),
    }
  }

  private buildSessionSteps(entries: SkillBriefEntry[]): SkillSessionPacketStep[] {
    return entries.map((entry, indexPosition) => ({
      order: indexPosition + 1,
      name: entry.name,
      sourcePath: entry.path,
      sourceScope: entry.scope ?? undefined,
      sourceCategory: entry.category ?? undefined,
      nextCommand: `read("${entry.path}")`,
      phaseKind: entry.phaseKind,
      layer: entry.layer,
      omittedByBudget: entry.omittedByBudget,
    }))
  }

  private buildSessionRecoveryGuidance(ready: boolean, omittedReadPaths: string[], applyHint: string | undefined): string[] {
    if (ready) {
      return []
    }
    return [
      ...(omittedReadPaths.length ? [`Read omitted paths first: ${omittedReadPaths.join(', ')}`] : []),
      ...(applyHint ? [applyHint] : []),
    ]
  }

  /**
   * session-packet을 turn 단위 execution packet으로 투영합니다.
   */
  turnPacketSkills(request: SkillTurnPacketRequest): SkillTurnPacketResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request
    const handoff = this.handoffSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const turns = handoff.phases.map((phase) => this.buildTurn(phase, handoff.entries))
    const sourcePaths = turns.flatMap((turn) => turn.sourcePaths)
    const nextCommands = turns.flatMap((turn) => turn.nextCommands)
    return {
      query: handoff.query,
      basis: handoff.basis,
      relationMode: handoff.relationMode,
      winner: handoff.winner,
      ready: handoff.ready,
      sourcePaths,
      sourcePathScopes: turns.flatMap((turn) => turn.sourcePathScopes ?? []),
      sourcePathCategories: turns.flatMap((turn) => turn.sourcePathCategories ?? []),
      nextCommands,
      applyHint: handoff.applyHint,
      recoveryGuidance: handoff.ready ? [] : this.buildRecoveryGuidance(handoff),
      deferred: handoff.deferred,
      omittedReadPaths: handoff.omittedReadPaths,
      budget: handoff.budget,
      turns,
    }
  }

  /**
   * turn-packet에서 recovery 대상 turn만 추려 resume packet으로 투영합니다.
   */
  recoveryPacketSkills(request: SkillRecoveryPacketRequest): SkillRecoveryPacketResult {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = index.settings.maxTopK,
      minScore = 0,
    } = request
    const handoff = this.handoffSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const blockedTurns = this.buildBlockedTurns(handoff.phases, handoff.entries)
    return {
      query: handoff.query,
      basis: handoff.basis,
      relationMode: handoff.relationMode,
      winner: handoff.winner,
      ready: handoff.ready,
      applyHint: handoff.applyHint,
      recoveryGuidance: this.buildRecoveryGuidance(handoff),
      omittedReadPaths: handoff.omittedReadPaths,
      sourcePaths: blockedTurns.flatMap((t) => t.sourcePaths),
      sourcePathScopes: blockedTurns.flatMap((t) => t.sourcePathScopes ?? []),
      sourcePathCategories: blockedTurns.flatMap((t) => t.sourcePathCategories ?? []),
      recoveryCommands: blockedTurns.flatMap((t) => t.recoveryCommands),
      deferred: handoff.deferred,
      resumeTurnOrder: blockedTurns[0]?.order ?? null,
      budget: handoff.budget,
      blockedTurns,
    }
  }

  private normalizeResumePacketRequest(
    request: SkillResumePacketRequest,
  ): {
    index: IndexArtifacts
    query: string | undefined
    names: string[]
    relationMode: SkillRelationMode
    budgetChars: number
    budgetTokens: number
    limit: number
    minScore: number
  } {
    const {
      index,
      query,
      names,
      relationMode = 'full',
      budgetChars = 8_000,
      budgetTokens = 2_000,
      limit = request.index.settings.maxTopK,
      minScore = 0,
    } = request
    return { index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore }
  }



  private buildResumePacketSkillsResult(
    turnPacket: SkillTurnPacketResult,
    recoveryPacket: SkillRecoveryPacketResult,
    resumeTurnOrder: number | null,
    turns: SkillTurnPacketResult['turns'],
  ): SkillResumePacketResult {
    return {
      query: turnPacket.query,
      basis: turnPacket.basis,
      relationMode: turnPacket.relationMode,
      winner: turnPacket.winner,
      ready: recoveryPacket.ready,
      applyHint: recoveryPacket.applyHint,
      recoveryGuidance: recoveryPacket.recoveryGuidance,
      omittedReadPaths: recoveryPacket.omittedReadPaths,
      recoveryCommands: recoveryPacket.recoveryCommands,
      sourcePaths: turns.flatMap((turn) => turn.sourcePaths),
      nextCommands: turns.flatMap((turn) => turn.nextCommands),
      sourcePathScopes: turns.flatMap((turn) => turn.sourcePathScopes ?? []),
      sourcePathCategories: turns.flatMap((turn) => turn.sourcePathCategories ?? []),
      deferred: turnPacket.deferred,
      resumeTurnOrder,
      budget: turnPacket.budget,
      turns,
      blockedTurns: recoveryPacket.blockedTurns,
    }
  }

  resumePacketSkills(request: SkillResumePacketRequest): SkillResumePacketResult {
    const { index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore } = this.normalizeResumePacketRequest(request)
    const turnPacket = this.turnPacketSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const recoveryPacket = this.recoveryPacketSkills({ index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore })
    const resumeTurnOrder = recoveryPacket.resumeTurnOrder ?? turnPacket.turns[0]?.order ?? null
    const turns = resumeTurnOrder === null ? [] : turnPacket.turns.filter((turn) => turn.order >= resumeTurnOrder)
    return this.buildResumePacketSkillsResult(turnPacket, recoveryPacket, resumeTurnOrder, turns)
  }



  currentTurnPacketSkills(request: SkillCurrentTurnPacketRequest): SkillCurrentTurnPacketResult {
    const resumePacket = this.resumePacketSkills(request)
    const turn = resumePacket.turns[0] ?? null
    return {
      query: resumePacket.query,
      basis: resumePacket.basis,
      relationMode: resumePacket.relationMode,
      winner: resumePacket.winner,
      ready: turn ? !turn.blockedByBudget : resumePacket.ready,
      applyHint: resumePacket.applyHint,
      recoveryGuidance: resumePacket.recoveryGuidance,
      omittedReadPaths: resumePacket.omittedReadPaths,
      recoveryCommands: resumePacket.recoveryCommands,
      sourcePaths: turn?.sourcePaths ?? [],
      sourcePathScopes: turn ? (turn.sourcePathScopes ?? []) : [],
      sourcePathCategories: turn ? (turn.sourcePathCategories ?? []) : [],
      nextCommands: turn?.nextCommands ?? [],
      deferred: resumePacket.deferred,
      activeTurnOrder: turn?.order ?? null,
      budget: resumePacket.budget,
      turn,
      blockedTurns: resumePacket.blockedTurns,
    }
  }

  packSkills(request: SkillPackRequest): SkillPack {
    const { index, query, names, relationMode, includeBody, budgetChars, budgetTokens, limit, minScore } =
      this.normalizePackRequest(request)
    const projection = this.relationEngine.projectSkills({
      index,
      query,
      names,
      relationMode,
      limit,
      minScore,
    })
    const validation = this.indexDiagnostics.validateIndex(index)
    const { effectiveChars, omittedReadPaths, finalizedEntries, usedChars } = this.preparePackSelection({
      projection, index, includeBody, budgetChars, budgetTokens,
    })
    return {
      ok: projection.missing.every((entry) => entry.relation !== 'required') && projection.cycles.length === 0 && validation.ok,
      relationMode: projection.relationMode,
      seeds: projection.seeds,
      entries: finalizedEntries,
      readLayers: projection.readLayers,
      applyLayers: projection.applyLayers,
      missing: projection.missing,
      cycles: projection.cycles,
      orphans: projection.orphans,
      omittedReadPaths,
      budget: { requestedChars: budgetChars, requestedTokens: budgetTokens, effectiveChars, usedChars },
      compose: projection.compose,
      graph: projection.graph,
      validate: validation,
      diagnostics: projection.diagnostics,
    }
  }

  /** Pack 요청의 optional 검색 경계를 실행 가능한 기본값으로 정규화합니다. */
  private normalizePackRequest(request: SkillPackRequest): SkillPackRequest & { limit: number; minScore: number } {
    return {
      ...request,
      limit: request.limit ?? request.index.settings.maxTopK,
      minScore: request.minScore ?? 0,
    }
  }

  /** Character와 token budget 중 실제 body selection에 적용할 더 엄격한 상한을 계산합니다. */
  private resolvePackEffectiveChars(budgetChars: number, budgetTokens: number): number {
    return budgetChars > 0 && budgetTokens > 0
      ? Math.min(budgetChars, budgetTokens * 4)
      : Math.max(budgetChars, budgetTokens * 4)
  }

  /** Budget에 선택되지 않은 body를 제거하면서 omission metadata를 보존합니다. */
  private finalizePackEntries(
    entries: SkillPack["entries"],
    selectedBodyPaths: ReadonlySet<string>,
  ): SkillPack["entries"] {
    return entries.map((entry) =>
      selectedBodyPaths.has(entry.readPath) ? entry : { ...entry, body: undefined, omittedByBudget: Boolean(entry.body) },
    )
  }

  /** Pack projection에서 body budget 적용과 omission metadata 계산을 한 번에 수행합니다. */
  private preparePackSelection(request: {
    projection: SkillRelationProjection
    index: IndexArtifacts
    includeBody: boolean
    budgetChars: number
    budgetTokens: number
  }): {
    effectiveChars: number
    omittedReadPaths: string[]
    finalizedEntries: SkillPack["entries"]
    usedChars: number
  } {
    const { projection, index, includeBody, budgetChars, budgetTokens } = request
    const effectiveChars = this.resolvePackEffectiveChars(budgetChars, budgetTokens)
    const omittedReadPaths: string[] = []
    const entries = this.buildPackEntries(projection, index, includeBody)
    const { selectedBodyPaths, usedChars } = this.selectPackBodies(entries, effectiveChars, omittedReadPaths)
    return { effectiveChars, omittedReadPaths, finalizedEntries: this.finalizePackEntries(entries, selectedBodyPaths), usedChars }
  }

  private buildRecoveryGuidance(handoff: { ready: boolean; omittedReadPaths: string[]; applyHint?: string }): string[] {
    if (handoff.ready) return []
    return [
      ...(handoff.omittedReadPaths.length ? [`Read omitted paths first: ${handoff.omittedReadPaths.join(', ')}`] : []),
      ...(handoff.applyHint ? [handoff.applyHint] : []),
    ]
  }

  private buildBlockedTurns(
    phases: SkillHandoffResult['phases'],
    entries: SkillHandoffResult['entries'],
  ): SkillRecoveryPacketResult['blockedTurns'] {
    return phases.flatMap((p) => this.buildBlockedTurnsPhase(p, entries))
  }

  private buildBlockedTurnsPhase(
    p: SkillHandoffResult['phases'][number],
    entries: SkillHandoffResult['entries'],
  ): SkillRecoveryPacketResult['blockedTurns'] {
    const omitted = entries.filter((e) => e.phaseOrder === p.order && e.omittedByBudget)
    if (omitted.length === 0) return []
    const omittedReadPaths = omitted.map((e) => e.readPath)
    const sp = omitted.map((e) => e.path)
    const cmd = sp.map((x) => `read("${x}")`)
    const obj =
      p.kind === 'start'
        ? `Recover winner ${p.names[0] ?? '-'} before continuing`
        : p.kind === 'read-layer'
          ? `Recover required layer ${p.layer ?? '-'} before dependent peers`
          : p.kind === 'apply-layer'
            ? `Recover optional apply layer ${p.layer ?? '-'} before extension work`
            : 'Recover fallback steps before resuming'
    return [
      {
        order: p.order,
        phaseKind: p.kind,
        layer: p.layer,
        names: p.names,
        omittedReadPaths,
        sourcePaths: sp,
        recoveryCommands: cmd,
        objective: obj,
        sourcePathScopes: omitted.map((e) => e.scope),
        sourcePathCategories: omitted.map((e) => e.category),
        unblockCriteria: [
          `Read omitted skill bodies: ${omittedReadPaths.join(', ')}`,
          cmd.length ? `Open source files: ${cmd.join(' -> ')}` : undefined,
        ].filter((item): item is string => Boolean(item)),
      },
    ]
  }

  private buildTurn(
    p: SkillHandoffResult['phases'][number],
    es: SkillHandoffResult['entries'],
  ): SkillTurnPacketResult['turns'][number] {
    const pe = this.findTurnPhaseEntries(es, p.order)
    const sourcePaths = this.getTurnSourcePaths(pe)
    const nextCommands = this.getTurnNextCommands(sourcePaths)
    const blockedByBudget = this.isTurnBlockedByBudget(pe)
    return {
      order: p.order,
      phaseKind: p.kind,
      layer: p.layer,
      names: p.names,
      readPaths: p.readPaths,
      sourcePaths,
      nextCommands,
      objective: this.buildTurnObjective(p),
      blockedByBudget,
      sourcePathScopes: pe.map((e) => e.scope),
      sourcePathCategories: pe.map((e) => e.category),
      checklist: this.buildTurnChecklist(p, nextCommands, blockedByBudget),
      exitCriteria: this.buildTurnExitCriteria(p, blockedByBudget),
    }
  }

  private findTurnPhaseEntries(
    es: SkillHandoffResult['entries'],
    order: number,
  ): SkillHandoffResult['entries'] {
    return es.filter((e) => e.phaseOrder === order)
  }

  private getTurnSourcePaths(
    phaseEntries: SkillHandoffResult['entries'],
  ): string[] {
    return phaseEntries.map((e) => e.path)
  }

  private getTurnNextCommands(sourcePaths: string[]): string[] {
    return sourcePaths.map((x) => `read("${x}")`)
  }

  private isTurnBlockedByBudget(phaseEntries: SkillHandoffResult['entries']): boolean {
    return phaseEntries.some((e) => e.omittedByBudget)
  }

  private buildTurnObjective(
    p: SkillHandoffResult['phases'][number],
  ): string {
    return p.kind === 'start'
      ? `Start with winner ${p.names[0] ?? '-'}`
      : p.kind === 'read-layer'
        ? `Read required layer ${p.layer ?? '-'} before dependent peers`
        : p.kind === 'apply-layer'
          ? `Read apply layer ${p.layer ?? '-'} for optional extension`
          : 'Inspect remaining fallback steps'
  }

  private buildTurnChecklist(
    p: SkillHandoffResult['phases'][number],
    nextCommands: string[],
    blockedByBudget: boolean,
  ): string[] {
    return [
      p.readPaths.length ? `Read packet entries: ${p.readPaths.join(', ')}` : undefined,
      nextCommands.length ? `Open source files: ${nextCommands.join(' -> ')}` : undefined,
      blockedByBudget ? 'Resolve omitted skill bodies before applying this turn.' : 'No omitted skill body in this turn.',
    ].filter((i): i is string => Boolean(i))
  }

  private buildTurnExitCriteria(
    p: SkillHandoffResult['phases'][number],
    blockedByBudget: boolean,
  ): string[] {
    return [
      p.names.length ? `Reviewed skills: ${p.names.join(', ')}` : undefined,
      blockedByBudget ? `Budget omissions cleared for turn ${p.order}` : `Turn ${p.order} is ready without extra budget recovery`,
    ].filter((i): i is string => Boolean(i))
  }

  private buildPackEntries(projection: SkillRelationProjection, index: IndexArtifacts, includeBody: boolean): SkillPackEntry[] {
    return projection.entries.map((entry) => {
      const { skill, ...relationEntry } = entry
      return {
        name: skill.canonicalName,
        path: skill.path,
        title: skill.title,
        category: skill.category,
        scope: skill.scope,
        aliases: skill.aliases,
        requires: skill.requires,
        recommends: skill.recommends,
        ...relationEntry,
        preview: skill.bodyText.slice(0, index.settings.includePreviewBodyChars).replace(/\n+/g, ' '),
        body: includeBody ? skill.bodyText : undefined,
        readPath: `skill://${skill.canonicalName}`,
        omittedByBudget: false,
      } satisfies SkillPackEntry
    })
  }

  private selectPackBodies(
    entries: SkillPackEntry[],
    effectiveChars: number,
    omittedReadPaths: string[],
  ): { selectedBodyPaths: Set<string>; usedChars: number } {
    const selectedBodyPaths = new Set<string>()
    let usedChars = 0
    for (const entry of [...entries].sort((left, right) => this.comparePackEntries(left, right))) {
      const nextBodyChars = entry.body?.length ?? 0
      const canIncludeBody = Boolean(entry.body) && (effectiveChars <= 0 || usedChars + nextBodyChars <= effectiveChars)
      if (canIncludeBody) {
        usedChars += nextBodyChars
        selectedBodyPaths.add(entry.readPath)
      } else if (entry.body) {
        omittedReadPaths.push(entry.readPath)
      }
    }
    return { selectedBodyPaths, usedChars }
  }

  /**
   * pack entry 우선순위 비교자입니다.
   */
  private comparePackEntries(left: SkillPackEntry, right: SkillPackEntry): number {
    const reasonDelta = composeReasonPriority(right.reason) - composeReasonPriority(left.reason)
    if (reasonDelta !== 0) {
      return reasonDelta
    }
    const readLayerLeft = left.readLayer ?? Number.MAX_SAFE_INTEGER
    const readLayerRight = right.readLayer ?? Number.MAX_SAFE_INTEGER
    if (readLayerLeft !== readLayerRight) {
      return readLayerLeft - readLayerRight
    }
    if (left.depth !== right.depth) {
      return left.depth - right.depth
    }
    return left.name.localeCompare(right.name)
  }
}
