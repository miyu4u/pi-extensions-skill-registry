import type {
  ComposedSkillEntry,
  IndexArtifacts,
  MissingSkillRelation,
  RawSkill,
  SkillComposePlan,
  SkillGraphMode,
  SkillRelationEdgeKind,
  SkillRelationGraph,
  SkillRelationGraphEdge,
  SkillRelationGraphNode,
  SkillRelationMode,
} from '../shared'
import { composeReasonPriority } from './compose-reason-priority'
import { dedupeDuplicateAliasEntries } from './dedupe-duplicate-alias-entries'
import type { SkillSearchEngine } from './skill-search-engine'

export interface SkillRelationProjection {
  relationMode: SkillRelationMode
  seeds: string[]
  entries: SkillRelationProjectionEntry[]
  readLayers: string[][]
  applyLayers: string[][]
  missing: MissingSkillRelation[]
  cycles: string[][]
  orphans: string[]
  compose: SkillComposePlan
  graph: SkillRelationGraph
  diagnostics: SkillRelationGraph['diagnostics']
}

export interface SkillRelationProjectionEntry extends ComposedSkillEntry {
  readLayer: number | null
  applyLayer: number | null
  scope?: string
}
export interface SkillRelationProjectionRequest {
  index: IndexArtifacts
  query?: string
  names: string[]
  relationMode?: SkillRelationMode
  limit?: number
  minScore?: number
}

export interface SkillComposeRequest {
  index: IndexArtifacts
  query?: string
  names: string[]
  limit?: number
  relationMode?: SkillRelationMode
  minScore?: number
}

interface ComposeState {
  index: IndexArtifacts
  relationMode: SkillRelationMode
  skillByName: Map<string, RawSkill>
  bestEntryByName: Map<string, ComposedSkillEntry>
  queue: ComposedSkillEntry[]
  expandedSignatureByName: Map<string, string>
  missingRelations: MissingSkillRelation[]
}

interface BuildRelationGraphSliceRequest {
  index: IndexArtifacts
  mode: SkillGraphMode
  seeds: string[]
  nodeNames: Set<string>
  edges: SkillRelationGraphEdge[]
  resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>
  orphanNames: string[]
  cycles?: string[][]
}

interface GraphSkillsBuildSliceState {
  index: IndexArtifacts
  seeds: string[]
  edges: SkillRelationGraphEdge[]
  resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>
  orphanNames: string[]
  outboundByCanonical: Map<string, SkillRelationGraphEdge[]>
  inboundByCanonical: Map<string, SkillRelationGraphEdge[]>
}

interface StronglyConnectedComponentsState {
  stack: string[]
  onStack: Set<string>
  indexByNode: Map<string, number>
  lowLinkByNode: Map<string, number>
  components: string[][]
  nextIndex: number
}

export interface GraphSkillsRequest {
  index: IndexArtifacts
  query?: string
  names?: string[]
  graphMode?: SkillGraphMode
  limit?: number
  minScore?: number
}

/** compose와 relation graph 계산의 concrete owner입니다. */
export class SkillRelationEngine {
  constructor(private readonly searchEngine: SkillSearchEngine) {}

  projectSkills(request: SkillRelationProjectionRequest): SkillRelationProjection {
    const { index, query, names, relationMode, limit = request.index.settings.maxTopK, minScore = 0 } = request
    const compose = this.composeSkills({ index, query, names, limit, relationMode, minScore })
    const graph = this.graphSkills({ index, query, names, graphMode: 'outbound', limit, minScore })
    const { projectedGraph, entries } = this.projectRelationGraphAndEntries(index, compose, graph)
    return {
      relationMode: compose.relationMode,
      seeds: compose.seeds.map((skill) => skill.canonicalName),
      entries,
      readLayers: projectedGraph.readLayers,
      applyLayers: projectedGraph.applyLayers,
      missing: compose.missing,
      cycles: projectedGraph.cycles,
      orphans: projectedGraph.orphans,
      compose,
      graph: projectedGraph,
      diagnostics: projectedGraph.diagnostics,
    }
  }

  private projectRelationGraphAndEntries(
    index: IndexArtifacts,
    compose: SkillComposePlan,
    graph: SkillRelationGraph,
  ): { projectedGraph: SkillRelationGraph; entries: SkillRelationProjectionEntry[] } {
    const projectedGraph = this.projectRelationGraphAndEntriesProjectGraph(index, compose, graph)
    const entries = this.projectRelationGraphAndEntriesProjectEntries(projectedGraph, compose, index)
    return { projectedGraph, entries }
  }

  private projectRelationGraphAndEntriesProjectGraph(
    index: IndexArtifacts,
    compose: SkillComposePlan,
    graph: SkillRelationGraph,
  ): SkillRelationGraph {
    const allowedNodeNames = new Set(compose.entries.map((entry) => entry.skill.canonicalName))
    const edges = graph.edges.filter((edge) => allowedNodeNames.has(edge.from) && (!edge.to || allowedNodeNames.has(edge.to)))
    const resolvedEdges = edges.filter((edge): edge is SkillRelationGraphEdge & { to: string } => Boolean(edge.to))
    const layers = this.buildRelationGraphLayers(allowedNodeNames, resolvedEdges)
    const orphans = Array.from(allowedNodeNames)
      .filter((nodeName) => {
        const outbound = edges.some((edge) => edge.from === nodeName)
        const inbound = resolvedEdges.some((edge) => edge.to === nodeName)
        return !outbound && !inbound
      })
      .sort()

    return {
      ...graph,
      nodes: graph.nodes.filter((node) => allowedNodeNames.has(node.name)),
      edges,
      readLayers: layers.readLayers,
      applyLayers: layers.applyLayers,
      cycles: this.collectRelationCycles(index, resolvedEdges, allowedNodeNames),
      orphans,
      missing: compose.missing,
    }
  }

  private projectRelationGraphAndEntriesProjectEntries(
    projectedGraph: SkillRelationGraph,
    compose: SkillComposePlan,
    index: IndexArtifacts,
  ): SkillRelationProjectionEntry[] {
    const composeEntryByName = new Map(compose.entries.map((entry) => [entry.skill.canonicalName, entry] as const))
    const readLayerByName = this.projectRelationGraphAndEntriesBuildLayerIndexMap(projectedGraph.readLayers)
    const applyLayerByName = this.projectRelationGraphAndEntriesBuildLayerIndexMap(projectedGraph.applyLayers)
    const entries: SkillRelationProjectionEntry[] = []

    for (const node of projectedGraph.nodes) {
      const composeEntry = composeEntryByName.get(node.name)
      const skill = composeEntry?.skill ?? index.skills.find((entry) => entry.canonicalName === node.name)
      if (!skill) {
        continue
      }
      entries.push({
        skill,
        scope: skill.scope,
        reason: composeEntry?.reason ?? 'seed',
        via: composeEntry?.via ?? undefined,
        depth: composeEntry?.depth ?? 0,
        readLayer: readLayerByName.get(skill.canonicalName) ?? null,
        applyLayer: applyLayerByName.get(skill.canonicalName) ?? null,
      })
    }
    return entries
  }

  private projectRelationGraphAndEntriesBuildLayerIndexMap(layers: readonly string[][]): Map<string, number> {
    const layerByName = new Map<string, number>()
    layers.forEach((layer, layerIndex) => {
      for (const nodeName of layer) {
        layerByName.set(nodeName, layerIndex)
      }
    })
    return layerByName
  }

  private composeInitState(index: IndexArtifacts, relationMode: SkillRelationMode, seedSkills: RawSkill[]): ComposeState {
    const { queue, bestEntryByName } = this.resolveSeedQueue(seedSkills)
    return {
      index,
      relationMode,
      bestEntryByName,
      queue,
      skillByName: new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const)),
      expandedSignatureByName: new Map<string, string>(),
      missingRelations: [],
    }
  }

  private composeDrainQueue(state: ComposeState): void {
    while (state.queue.length > 0) {
      this.processNextQueueEntry(state)
    }
  }

  private composeSortEntries(bestEntryByName: Map<string, ComposedSkillEntry>): ComposedSkillEntry[] {
    return Array.from(bestEntryByName.values()).sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth
      const delta = composeReasonPriority(right.reason) - composeReasonPriority(left.reason)
      return delta === 0 ? left.skill.canonicalName.localeCompare(right.skill.canonicalName) : delta
    })
  }

  /**
   * seed skill과 relation을 확장해 compose 결과를 계산합니다.
   */
  composeSkills(request: SkillComposeRequest): SkillComposePlan {
    const { index, query, names, limit = index.settings.maxTopK, relationMode = 'full', minScore = 0 } = request
    const seedSkills = this.searchEngine.resolveSeedSkills(index, query, names, limit, minScore)
    if (seedSkills.length === 0) {
      return { seeds: [], entries: [], missing: [], relationMode }
    }
    const state = this.composeInitState(index, relationMode, seedSkills)
    this.composeDrainQueue(state)
    return {
      seeds: seedSkills,
      entries: this.composeSortEntries(state.bestEntryByName),
      missing: this.dedupeMissingRelations(state.missingRelations),
      relationMode,
    }
  }

  private resolveSeedQueue(seedSkills: RawSkill[]): { queue: ComposedSkillEntry[]; bestEntryByName: Map<string, ComposedSkillEntry> } {
    const bestEntryByName = new Map<string, ComposedSkillEntry>()
    const queue: ComposedSkillEntry[] = seedSkills.map((skill) => ({
      skill,
      reason: 'seed',
      depth: 0,
    }))
    for (const entry of queue) {
      bestEntryByName.set(entry.skill.canonicalName, entry)
    }
    return { queue, bestEntryByName }
  }

  private getComposeTargets(skill: RawSkill, relationMode: SkillRelationMode): Array<{ name: string; reason: 'required' | 'recommended' }> {
    const targets: Array<{ name: string; reason: 'required' | 'recommended' }> = skill.requires.map((name) => ({
      name,
      reason: 'required',
    }))
    if (relationMode === 'full') {
      targets.push(
        ...skill.recommends.map((name) => ({
          name,
          reason: 'recommended' as const,
        })),
      )
    }
    return targets
  }

  private processNextQueueEntry(state: ComposeState): void {
    const current = state.queue.shift()
    if (!current) return

    const currentBest = state.bestEntryByName.get(current.skill.canonicalName)
    if (!currentBest || currentBest.reason !== current.reason || currentBest.depth !== current.depth || currentBest.via !== current.via) {
      return
    }

    const signature = [currentBest.reason, String(currentBest.depth), currentBest.via ?? ''].join('|')
    if (state.expandedSignatureByName.get(current.skill.canonicalName) === signature) {
      return
    }
    state.expandedSignatureByName.set(current.skill.canonicalName, signature)

    const targets = this.getComposeTargets(current.skill, state.relationMode)
    this.processComposeTargets(current, targets, state)
  }

  private processComposeTargets(
    current: ComposedSkillEntry,
    targets: Array<{ name: string; reason: 'required' | 'recommended' }>,
    state: ComposeState,
  ): void {
    const { index, skillByName, bestEntryByName, queue, missingRelations } = state
    for (const target of targets) {
      const resolvedName = index.aliasToCanonical.get(target.name) ?? target.name
      const relatedSkill = skillByName.get(resolvedName)
      if (!relatedSkill) {
        missingRelations.push({
          name: target.name,
          relation: target.reason,
          via: current.skill.canonicalName,
          depth: current.depth + 1,
        })
        continue
      }

      const candidate: ComposedSkillEntry = {
        skill: relatedSkill,
        reason: target.reason,
        via: current.skill.canonicalName,
        depth: current.depth + 1,
      }
      const existing = bestEntryByName.get(relatedSkill.canonicalName)
      if (existing && !this.isBetterComposeEntry(candidate, existing)) {
        continue
      }

      bestEntryByName.set(relatedSkill.canonicalName, candidate)
      queue.push(candidate)
    }
  }

  /**
   * canonical index 기준 relation graph slice를 계산합니다.
   */
  graphSkills(request: GraphSkillsRequest): SkillRelationGraph {
    const { index, query, names = [], graphMode = 'outbound', limit = index.settings.maxTopK, minScore = 0 } = request
    const edges = this.buildRelationGraphEdges(index)
    const outboundByCanonical = this.groupEdgesByCanonical(edges, 'from')
    const inboundByCanonical = this.groupEdgesByCanonical(edges, 'to')
    const orphanNames = this.graphSkillsGetOrphanNames(index, outboundByCanonical, inboundByCanonical)
    const seeds = this.searchEngine.resolveSeedSkills(index, query, names, limit, minScore).map((skill) => skill.canonicalName)
    const resolvedEdges = edges.filter((edge): edge is SkillRelationGraphEdge & { to: string } => Boolean(edge.to))

    return this.graphSkillsBuildSlice({
      index,
      graphMode,
      seeds,
      edges,
      resolvedEdges,
      orphanNames,
      outboundByCanonical,
      inboundByCanonical,
    })
  }

  private graphSkillsGetOrphanNames(
    index: IndexArtifacts,
    outboundByCanonical: Map<string, SkillRelationGraphEdge[]>,
    inboundByCanonical: Map<string, SkillRelationGraphEdge[]>,
  ): string[] {
    return index.skills
      .filter((skill) => {
        const outbound = outboundByCanonical.get(skill.canonicalName) ?? []
        const inbound = inboundByCanonical.get(skill.canonicalName) ?? []
        return outbound.length === 0 && inbound.length === 0
      })
      .map((skill) => skill.canonicalName)
      .sort()
  }

  private graphSkillsBuildSlice(params: GraphSkillsBuildSliceState & { graphMode: SkillGraphMode }): SkillRelationGraph {
    const { graphMode } = params
    switch (graphMode) {
      case 'inbound':
        return this.graphSkillsBuildSliceInbound(params)
      case 'cycles':
        return this.graphSkillsBuildSliceCycles(params)
      case 'orphans':
        return this.graphSkillsBuildSliceOrphans(params)
      default:
        return this.graphSkillsBuildSliceOutbound(params)
    }
  }

  private graphSkillsBuildSliceInbound(params: GraphSkillsBuildSliceState): SkillRelationGraph {
    const { index, seeds, edges, resolvedEdges, orphanNames, inboundByCanonical } = params
    const nodeNames = this.collectReachableNodeNames(seeds, inboundByCanonical, (edge) => edge.from)
    return this.buildRelationGraphSlice({
      index,
      mode: 'inbound',
      seeds,
      nodeNames,
      edges,
      resolvedEdges,
      orphanNames,
    })
  }

  private graphSkillsBuildSliceCycles(params: GraphSkillsBuildSliceState): SkillRelationGraph {
    const { index, seeds, edges, resolvedEdges, orphanNames } = params
    const cycles = this.collectRelationCycles(index, resolvedEdges)
    const filteredCycles = seeds.length > 0 ? cycles.filter((cycle) => cycle.some((name) => seeds.includes(name))) : cycles
    const cycleNodeNames = new Set(filteredCycles.flat())
    return this.buildRelationGraphSlice({
      index,
      mode: 'cycles',
      seeds,
      nodeNames: cycleNodeNames,
      edges,
      resolvedEdges,
      orphanNames,
      cycles: filteredCycles,
    })
  }

  private graphSkillsBuildSliceOrphans(params: GraphSkillsBuildSliceState): SkillRelationGraph {
    const { index, seeds, edges, resolvedEdges, orphanNames } = params
    const orphanSet = seeds.length > 0 ? new Set(orphanNames.filter((name) => seeds.includes(name))) : new Set(orphanNames)
    return this.buildRelationGraphSlice({
      index,
      mode: 'orphans',
      seeds,
      nodeNames: orphanSet,
      edges,
      resolvedEdges,
      orphanNames,
    })
  }

  private graphSkillsBuildSliceOutbound(params: GraphSkillsBuildSliceState): SkillRelationGraph {
    const { index, seeds, edges, resolvedEdges, orphanNames, outboundByCanonical } = params
    const nodeNames = this.collectReachableNodeNames(seeds, outboundByCanonical, (edge) => edge.to)
    return this.buildRelationGraphSlice({
      index,
      mode: 'outbound',
      seeds,
      nodeNames,
      edges,
      resolvedEdges,
      orphanNames,
    })
  }

  /**
   * full canonical index에서 relation edge를 계산합니다.
   */
  buildRelationGraphEdges(index: IndexArtifacts): SkillRelationGraphEdge[] {
    const edges: SkillRelationGraphEdge[] = []
    for (const skill of index.skills) {
      this.pushRelationEdges(edges, skill, skill.requires, 'requires', index)
      this.pushRelationEdges(edges, skill, skill.recommends, 'recommends', index)
    }
    return edges
  }

  /**
   * single skill의 relation을 canonical edge로 추가합니다.
   */
  private pushRelationEdges(
    edges: SkillRelationGraphEdge[],
    skill: RawSkill,
    targets: string[],
    relation: SkillRelationEdgeKind,
    index: IndexArtifacts,
  ): void {
    for (const target of targets) {
      const resolvedName = index.aliasToCanonical.get(target)
      edges.push({
        from: skill.canonicalName,
        to: resolvedName,
        target,
        relation,
        resolved: Boolean(resolvedName),
      })
    }
  }

  /**
   * relation edge를 source/target canonical 기준 map으로 그룹화합니다.
   */
  groupEdgesByCanonical(edges: SkillRelationGraphEdge[], direction: 'from' | 'to'): Map<string, SkillRelationGraphEdge[]> {
    const grouped = new Map<string, SkillRelationGraphEdge[]>()
    for (const edge of edges) {
      const key = direction === 'from' ? edge.from : edge.to
      if (!key) {
        continue
      }
      const bucket = grouped.get(key) ?? []
      bucket.push(edge)
      grouped.set(key, bucket)
    }
    return grouped
  }

  /**
   * seed에서 adjacency를 따라 도달 가능한 canonical node 집합을 계산합니다.
   */
  private collectReachableNodeNames(
    seeds: string[],
    adjacency: Map<string, SkillRelationGraphEdge[]>,
    pickNext: (edge: SkillRelationGraphEdge) => string | undefined,
  ): Set<string> {
    const visited = new Set<string>(seeds)
    const queue = [...seeds]
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) {
        continue
      }
      for (const edge of adjacency.get(current) ?? []) {
        const next = pickNext(edge)
        if (!next || visited.has(next)) {
          continue
        }
        visited.add(next)
        queue.push(next)
      }
    }
    return visited
  }

  /**
   * canonical node 집합을 graph payload로 투영합니다.
   */
  private buildRelationGraphSlice(req: BuildRelationGraphSliceRequest): SkillRelationGraph {
    const { index, mode, seeds, nodeNames, edges, resolvedEdges, orphanNames, cycles } = req
    const nodes = this.buildRelationGraphNodes(index, nodeNames)
    const edgeSlice = this.buildRelationGraphEdgesSlice(edges, nodeNames)
    const cycleList = cycles ?? this.collectRelationCycles(index, resolvedEdges, nodeNames)
    const { readLayers, applyLayers } =
      mode === 'cycles' ? { readLayers: [], applyLayers: [] } : this.buildRelationGraphLayers(nodeNames, resolvedEdges)

    return {
      mode,
      seeds,
      nodes,
      edges: edgeSlice,
      readLayers,
      applyLayers,
      missing: this.buildRelationGraphMissing(edgeSlice),
      cycles: cycleList,
      orphans: orphanNames.filter((name) => nodeNames.has(name)),
      diagnostics: this.buildRelationGraphDiagnostics(index),
    }
  }

  private buildRelationGraphNodes(index: IndexArtifacts, nodeNames: Set<string>): SkillRelationGraphNode[] {
    const skillByName = new Map(index.skills.map((skill) => [skill.canonicalName, skill] as const))
    return Array.from(nodeNames)
      .map((name) => skillByName.get(name))
      .filter((skill): skill is RawSkill => Boolean(skill))
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName))
      .map(
        (skill) =>
          ({
            name: skill.canonicalName,
            path: skill.path,
            category: skill.category,
            title: skill.title,
            scope: skill.scope,
            aliases: skill.aliases,
          }) satisfies SkillRelationGraphNode,
      )
  }

  private buildRelationGraphEdgesSlice(edges: SkillRelationGraphEdge[], nodeNames: Set<string>): SkillRelationGraphEdge[] {
    return edges
      .filter((edge) => nodeNames.has(edge.from) && (!edge.to || nodeNames.has(edge.to)))
      .sort((left, right) => {
        if (left.from !== right.from) {
          return left.from.localeCompare(right.from)
        }
        if ((left.to ?? left.target) !== (right.to ?? right.target)) {
          return (left.to ?? left.target).localeCompare(right.to ?? right.target)
        }
        return left.relation.localeCompare(right.relation)
      })
  }

  private buildRelationGraphMissing(edgeSlice: SkillRelationGraphEdge[]): MissingSkillRelation[] {
    return edgeSlice
      .filter((edge) => !edge.resolved)
      .map((edge) => ({
        name: edge.target,
        relation: edge.relation === 'requires' ? 'required' : 'recommended',
        via: edge.from,
        depth: 1,
      }))
  }

  private buildRelationGraphDiagnostics(index: IndexArtifacts): SkillRelationGraph['diagnostics'] {
    return {
      duplicateCanonicalEntries: index.stats.duplicateCanonicalEntries,
      duplicateAliasEntries: dedupeDuplicateAliasEntries(index.stats.duplicateAliasEntries),
    }
  }

  /**
   * resolved relation graph의 strongly connected component를 계산합니다.
   */
  private collectStronglyConnectedComponents(
    nodeNames: Set<string>,
    resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
  ): string[][] {
    const adjacency = this.buildStronglyConnectedComponentsAdjacency(nodeNames, resolvedEdges)
    const state = this.createStronglyConnectedComponentsState()

    for (const nodeName of Array.from(nodeNames).sort()) {
      if (!state.indexByNode.has(nodeName)) {
        this.visitStronglyConnectedComponent(nodeName, adjacency, state)
      }
    }

    return state.components.sort((left, right) => this.compareGraphComponents(left, right))
  }

  private buildStronglyConnectedComponentsAdjacency(
    nodeNames: Set<string>,
    resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
  ): Map<string, string[]> {
    const adjacency = new Map<string, string[]>()
    for (const nodeName of nodeNames) {
      adjacency.set(nodeName, [])
    }
    for (const edge of resolvedEdges) {
      if (nodeNames.has(edge.from) && nodeNames.has(edge.to)) {
        adjacency.get(edge.from)?.push(edge.to)
      }
    }
    return adjacency
  }

  private createStronglyConnectedComponentsState(): StronglyConnectedComponentsState {
    return {
      stack: [],
      onStack: new Set<string>(),
      indexByNode: new Map<string, number>(),
      lowLinkByNode: new Map<string, number>(),
      components: [],
      nextIndex: 0,
    }
  }

  private visitStronglyConnectedComponent(
    nodeName: string,
    adjacency: Map<string, string[]>,
    state: StronglyConnectedComponentsState,
  ): void {
    state.indexByNode.set(nodeName, state.nextIndex)
    state.lowLinkByNode.set(nodeName, state.nextIndex)
    state.nextIndex += 1
    state.stack.push(nodeName)
    state.onStack.add(nodeName)

    for (const next of adjacency.get(nodeName) ?? []) {
      if (!state.indexByNode.has(next)) {
        this.visitStronglyConnectedComponent(next, adjacency, state)
        const minLow = Math.min(state.lowLinkByNode.get(nodeName) ?? 0, state.lowLinkByNode.get(next) ?? 0)
        state.lowLinkByNode.set(nodeName, minLow)
      } else if (state.onStack.has(next)) {
        const minLow = Math.min(state.lowLinkByNode.get(nodeName) ?? 0, state.indexByNode.get(next) ?? 0)
        state.lowLinkByNode.set(nodeName, minLow)
      }
    }

    if ((state.lowLinkByNode.get(nodeName) ?? -1) === (state.indexByNode.get(nodeName) ?? -2)) {
      state.components.push(this.popComponent(nodeName, state))
    }
  }

  private popComponent(nodeName: string, state: StronglyConnectedComponentsState): string[] {
    const component: string[] = []
    while (state.stack.length > 0) {
      const stacked = state.stack.pop()
      if (!stacked) {
        continue
      }
      state.onStack.delete(stacked)
      component.push(stacked)
      if (stacked === nodeName) {
        break
      }
    }
    component.sort()
    return component
  }

  /**
   * graph slice에서 cycle component를 계산합니다.
   */
  collectRelationCycles(
    index: IndexArtifacts,
    resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
    nodeNames?: Set<string>,
  ): string[][] {
    const scopedNodeNames = nodeNames ?? new Set(index.skills.map((skill) => skill.canonicalName))
    const components = this.collectStronglyConnectedComponents(scopedNodeNames, resolvedEdges)
    return components.filter((component) => {
      if (component.length > 1) {
        return true
      }
      const nodeName = component[0]
      return resolvedEdges.some((edge) => edge.from === nodeName && edge.to === nodeName && scopedNodeNames.has(nodeName))
    })
  }

  /**
   * graph slice의 dependency layer order를 계산합니다.
   */
  buildRelationGraphLayers(
    nodeNames: Set<string>,
    resolvedEdges: Array<SkillRelationGraphEdge & { to: string }>,
  ): { readLayers: string[][]; applyLayers: string[][] } {
    const components = this.collectStronglyConnectedComponents(nodeNames, resolvedEdges)
    const componentIndexByNode = new Map<string, number>()
    components.forEach((component, index) => {
      for (const nodeName of component) {
        componentIndexByNode.set(nodeName, index)
      }
    })

    const dependencyEdges = new Set<string>()
    const applyEdges = new Set<string>()
    for (const edge of resolvedEdges) {
      if (!nodeNames.has(edge.from) || !nodeNames.has(edge.to)) {
        continue
      }
      const fromIndex = componentIndexByNode.get(edge.from)
      const toIndex = componentIndexByNode.get(edge.to)
      if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) {
        continue
      }
      dependencyEdges.add(`${toIndex}:${fromIndex}`)
      applyEdges.add(`${fromIndex}:${toIndex}`)
    }

    return {
      readLayers: this.buildTopologicalLayers(components, dependencyEdges),
      applyLayers: this.buildTopologicalLayers(components, applyEdges),
    }
  }

  /**
   * component DAG를 layer 순서로 정렬합니다.
   */
  private buildTopologicalLayers(components: string[][], serializedEdges: Set<string>): string[][] {
    const { outgoing, indegree } = this.buildTopologicalGraph(components, serializedEdges)
    return this.buildTopologicalSort(components, outgoing, indegree)
  }

  private buildTopologicalGraph(
    components: string[][],
    serializedEdges: Set<string>,
  ): { outgoing: Map<number, Set<number>>; indegree: Map<number, number> } {
    const outgoing = new Map<number, Set<number>>()
    const indegree = new Map<number, number>()
    for (let index = 0; index < components.length; index += 1) {
      outgoing.set(index, new Set<number>())
      indegree.set(index, 0)
    }
    for (const serialized of serializedEdges) {
      const [fromRaw, toRaw] = serialized.split(':')
      const fromIndex = Number(fromRaw)
      const toIndex = Number(toRaw)
      const bucket = outgoing.get(fromIndex)
      if (!bucket || bucket.has(toIndex)) {
        continue
      }
      bucket.add(toIndex)
      indegree.set(toIndex, (indegree.get(toIndex) ?? 0) + 1)
    }
    return { outgoing, indegree }
  }

  private buildTopologicalSort(components: string[][], outgoing: Map<number, Set<number>>, indegree: Map<number, number>): string[][] {
    const remaining = new Set<number>(components.map((_, index) => index))
    const layers: string[][] = []
    while (remaining.size > 0) {
      const currentLayer = this.getZeroIndegreeComponents(remaining, indegree).sort((left, right) =>
        this.compareGraphComponents(components[left] ?? [], components[right] ?? []),
      )
      if (currentLayer.length === 0) {
        layers.push(
          Array.from(remaining)
            .sort((left, right) => this.compareGraphComponents(components[left] ?? [], components[right] ?? []))
            .flatMap((index) => components[index] ?? []),
        )
        break
      }
      layers.push(currentLayer.flatMap((index) => components[index] ?? []))
      for (const index of currentLayer) {
        remaining.delete(index)
        for (const next of outgoing.get(index) ?? []) {
          indegree.set(next, (indegree.get(next) ?? 0) - 1)
        }
      }
    }
    return layers
  }

  /**
   * indegree가 0인 component들을 반환합니다.
   */
  private getZeroIndegreeComponents(remaining: Set<number>, indegree: Map<number, number>): number[] {
    return Array.from(remaining).filter((index) => (indegree.get(index) ?? 0) === 0)
  }

  /**
   * graph component 정렬 비교자입니다.
   */
  private compareGraphComponents(left: string[], right: string[]): number {
    return (left[0] ?? '').localeCompare(right[0] ?? '')
  }

  /**
   * compose 엔트리의 우선순위를 비교합니다.
   */
  private isBetterComposeEntry(candidate: ComposedSkillEntry, existing: ComposedSkillEntry): boolean {
    const priorityDelta = composeReasonPriority(candidate.reason) - composeReasonPriority(existing.reason)
    if (priorityDelta !== 0) {
      return priorityDelta > 0
    }
    if (candidate.depth !== existing.depth) {
      return candidate.depth < existing.depth
    }
    return (candidate.via ?? '').localeCompare(existing.via ?? '') < 0
  }

  /**
   * 중복 missing relation을 제거하고 정렬합니다.
   */
  private dedupeMissingRelations(relations: MissingSkillRelation[]): MissingSkillRelation[] {
    const deduped = new Map<string, MissingSkillRelation>()
    for (const relation of relations) {
      deduped.set(`${relation.relation}:${relation.name}:${relation.via}:${relation.depth}`, relation)
    }
    return Array.from(deduped.values()).sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth
      }
      if (left.relation !== right.relation) {
        return left.relation.localeCompare(right.relation)
      }
      if (left.via !== right.via) {
        return left.via.localeCompare(right.via)
      }
      return left.name.localeCompare(right.name)
    })
  }
}
