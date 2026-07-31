import path from 'node:path'
import type {
  IndexArtifacts,
  RawSkill,
  SearchHit,
  SkillApplyPacketResult,
  SkillAuditReport,
  SkillBriefResult,
  SkillBundleResult,
  SkillChecklistPacketResult,
  SkillCommandsPacketResult,
  SkillCompareResult,
  SkillComposePlan,
  SkillCurrentTurnPacketResult,
  SkillDecideEntry,
  SkillDecideResult,
  SkillExecutionPacketResult,
  SkillExplainResult,
  SkillFileReadyPacketResult,
  SkillGapResult,
  SkillHandoffResult,
  SkillInstructionPacketResult,
  SkillMarkdownPacketResult,
  SkillPack,
  SkillPlanResult,
  SkillRecommendResult,
  SkillRecoveryPacketResult,
  SkillRegistryComplaintTelemetry,
  SkillRegistryToolResult,
  SkillRelationGraph,
  SkillResolveResult,
  SkillResumePacketResult,
  SkillRouteResult,
  SkillSearchDiagnostics,
  SkillSessionPacketResult,
  SkillSummaryPacketResult,
  SkillTurnPacketResult,
  SkillValidationReport,
  SkillVerificationPacketResult,
  SkillWriteScriptPacketResult,
  ToolContext,
} from '../shared'
import { SKILL_RESOLVE_RECOVERY_MAX_BYTES, SKILL_RESOLVE_RECOVERY_MAX_TOKENS } from '../shared'

/** select 결과 미리보기 payload입니다. */
type SelectedSkillPreview = {
  name: string
  score: number
  coverage: number
  path: string
  title: string
  category: string
  scope?: string
  aliases: string[]
  requires: string[]
  recommends: string[]
  preview: string
  body?: string
}

/**
 * unknown resolve 결과가 입력 name 길이에 따라 커지지 않도록 recovery text를 자릅니다.
 */
function boundResolveRecoveryText(text: string): string {
  const encoder = new TextEncoder()
  const characters = Array.from(text)
  let lower = 0
  let upper = characters.length
  let best = 0
  while (lower <= upper) {
    const end = Math.floor((lower + upper) / 2)
    const candidate = characters.slice(0, end).join('')
    const bytes = encoder.encode(candidate).byteLength
    const tokens = candidate.match(/\S+/gu)?.length ?? 0
    if (bytes <= SKILL_RESOLVE_RECOVERY_MAX_BYTES && tokens <= SKILL_RESOLVE_RECOVERY_MAX_TOKENS) {
      best = end
      lower = end + 1
      continue
    }
    upper = end - 1
  }
  return characters.slice(0, best).join('')
}

/**
 * 스코프 분포를 deterministic 정렬로 직렬화 가능한 맵으로 정규화합니다.
 * 개별 결과 직렬화에는 scope를 주입하지 않고, 통계 집계용으로만 보완합니다.
 */
function buildDeterministicScopeDistribution(
  skills: readonly RawSkill[],
  scopeDistribution?: Record<string, number>,
): Record<string, number> {
  const base =
    scopeDistribution && Object.keys(scopeDistribution).length > 0
      ? { ...scopeDistribution }
      : (Object.create(null) as Record<string, number>)

  if (Object.keys(base).length === 0) {
    for (const skill of skills) {
      if (!skill.scope) {
        continue
      }
      base[skill.scope] = (base[skill.scope] ?? 0) + 1
    }
  }

  const orderedEntries = Object.entries(base).sort(([scopeA, countA], [scopeB, countB]) =>
    countA === countB ? scopeA.localeCompare(scopeB) : countB - countA,
  )
  const normalized: Record<string, number> = {}
  for (const [scope, count] of orderedEntries) {
    normalized[scope] = count
  }
  return normalized
}

/** retrospective telemetry snapshot을 구성합니다. */
function buildComplaintTelemetrySnapshot(
  input: ToolContext,
  returnedSkills: string[],
  missingRequested: string[],
): SkillRegistryComplaintTelemetry {
  const complaintClass =
    missingRequested.length > 0
      ? 'drift'
      : returnedSkills.length === 0
        ? 'miss'
        : returnedSkills.length >= input.limit
          ? 'overload'
          : 'low-value'
  return {
    query: input.query,
    returnedSkills,
    actuallyUsedSkills: [],
    complaintClass,
  }
}

function buildIndexSummary(index: IndexArtifacts): string[] {
  return [
    `indexed: ${index.docCount}`,
    `queried roots: ${index.settings.roots.length}`,
    `requested names: ${index.requestedNames.length || '전체'}`,
    `nameFilterMode: ${index.stats.nameFilterMode}`,
    `parsed: ${index.stats.totalParsed}`,
    `missing requested: ${index.stats.missingFromRequested.length}`,
    `build ms: ${index.indexBuildMs}`,
  ]
}

function buildIndexRows(skills: RawSkill[], limit: number): string {
  const top = skills.slice(0, limit)
  const rows = top.map((entry) => `${entry.canonicalName}\t${entry.category}\t${entry.scope ?? '-'}\t${entry.sourceRoot}`)
  return rows.length ? rows.join('\n') : '(검색 후보 없음)'
}

function buildIndexContentText(index: IndexArtifacts, limit: number): string {
  return [
    'skill_registry index 완료',
    buildIndexSummary(index).join(' | '),
    '',
    'name\tcategory\tscope\tsource',
    buildIndexRows(index.skills, limit),
  ].join('\n')
}

/** index action 결과를 구성합니다. */
export function buildIndexResult(index: IndexArtifacts, limit: number): SkillRegistryToolResult {
  const statsCast = index.stats as { scopeDistribution?: Record<string, number> }
  const scopeDistribution = buildDeterministicScopeDistribution(index.skills, statsCast.scopeDistribution)
  return {
    content: [
      {
        type: 'text',
        text: buildIndexContentText(index, limit),
      },
    ],
    details: {
      kind: 'index',
      docCount: index.docCount,
      requestedNames: index.requestedNames,
      missingFromRequested: index.stats.missingFromRequested,
      byScope: scopeDistribution,
      stats: index.stats,
      queriedRoots: index.settings.roots,
      indexBuildMs: index.indexBuildMs,
      time: new Date(index.generatedAt).toISOString(),
    },
  }
}

interface DiscoveredSkill {
  name: string
  readPath: string
  score: number
  coverage: number
  category: string
  scope?: string
  aliases: string[]
  requires: string[]
  recommends: string[]
  path: string
  matchedTerms: string[]
}

function mapDiscoverEntry(hit: SearchHit): DiscoveredSkill {
  return {
    name: hit.skill.canonicalName,
    readPath: `skill://${hit.skill.canonicalName}`,
    score: hit.score,
    coverage: hit.coverage,
    category: hit.skill.category,
    scope: hit.skill.scope,
    aliases: hit.skill.aliases,
    requires: hit.skill.requires,
    recommends: hit.skill.recommends,
    path: hit.skill.path,
    matchedTerms: hit.matchedTerms,
  }
}

function formatDiscoverEntry(entry: DiscoveredSkill, rank: number): string {
  return [
    `${rank + 1}. ${entry.name} -> ${entry.readPath}`,
    `   why: score ${entry.score.toFixed(3)}, coverage ${entry.coverage}, matched ${entry.matchedTerms.join(', ') || '없음'}`,
    `   category: ${entry.category}`,
    `   scope: ${entry.scope ?? '-'}`,
    entry.aliases.length ? `   aliases: ${entry.aliases.join(', ')}` : '',
    entry.requires.length || entry.recommends.length
      ? `   related: requires=${entry.requires.join(', ') || '-'} | recommends=${entry.recommends.join(', ') || '-'}`
      : '',
    `   path: ${entry.path}`,
  ].join('\n')
}
function formatDiscoverDiagnostics(diagnostics?: SkillSearchDiagnostics): string {
  return diagnostics
    ? [
        `diagnostics: normalizedQuery="${diagnostics.normalizedQuery}", fallbackMode=${diagnostics.fallbackMode}`,
        diagnostics.matchedAliases.length ? `matchedAliases=${diagnostics.matchedAliases.join(', ')}` : 'matchedAliases=없음',
        diagnostics.whyThisTop1 ? `whyThisTop1=${diagnostics.whyThisTop1}` : '',
        diagnostics.whyZero ? `whyZero=${diagnostics.whyZero}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
    : ''
}

/** discover action 결과를 구성합니다. */
export function buildDiscoverResult(
  index: IndexArtifacts,
  hits: SearchHit[],
  input: ToolContext,
  diagnostics?: SkillSearchDiagnostics,
): SkillRegistryToolResult {
  const discovered = hits.map(mapDiscoverEntry)
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry discover 결과 (${discovered.length}건)`,
          formatDiscoverDiagnostics(diagnostics),
          discovered.length
            ? discovered.map(formatDiscoverEntry).join('\n\n')
            : diagnostics?.whyZero || '추천할 skill이 없습니다. query를 더 구체화하거나 roots 설정을 확인하세요.',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'discover',
      requestedNames: index.requestedNames,
      missingRequested: index.stats.missingFromRequested,
      nameFilterMode: index.stats.nameFilterMode,
      discovered,
      query: input.query,
      diagnostics,
      telemetry: buildComplaintTelemetrySnapshot(
        input,
        discovered.map((e) => e.name),
        index.stats.missingFromRequested,
      ),
    },
  }
}

/** helper to build search result lines */
function buildSearchResultLines(hits: SearchHit[], input: ToolContext): string[] {
  return hits.map((hit, rank) => {
    const preview = hit.skill.bodyText ? `${hit.skill.bodyText.slice(0, input.settings.includePreviewBodyChars).replace(/\n+/g, ' ')}` : ''
    return [
      `${rank + 1}. ${hit.skill.canonicalName} (score ${hit.score.toFixed(3)}, coverage ${hit.coverage})`,
      `   matched: ${hit.matchedTerms.join(', ') || '없음'}`,
      `   category: ${hit.skill.category}`,
      `   scope: ${hit.skill.scope ?? '-'}`,
      hit.skill.aliases.length ? `   aliases: ${hit.skill.aliases.join(', ')}` : '',
      hit.skill.requires.length || hit.skill.recommends.length
        ? `   related: requires=${hit.skill.requires.join(', ') || '-'} | recommends=${hit.skill.recommends.join(', ') || '-'}`
        : '',
      `   path: ${hit.skill.path}`,
      `   preview: ${preview}`,
    ]
      .filter(Boolean)
      .join('\n')
  })
}

/** helper to map search hits for details */
function buildSearchResultHits(hits: SearchHit[]) {
  return hits.map((hit) => ({
    name: hit.skill.canonicalName,
    score: hit.score,
    coverage: hit.coverage,
    path: hit.skill.path,
    scope: hit.skill.scope,
    category: hit.skill.category,
  }))
}

/** search action 결과를 구성합니다. */
export function buildSearchResult(
  index: IndexArtifacts,
  hits: SearchHit[],
  input: ToolContext,
  diagnostics?: SkillSearchDiagnostics,
): SkillRegistryToolResult {
  const telemetry = buildComplaintTelemetrySnapshot(
    input,
    hits.map((h) => h.skill.canonicalName),
    index.stats.missingFromRequested,
  )
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry search 결과 (${hits.length}건)`,
          hits.length ? buildSearchResultLines(hits, input).join('\n\n') : diagnostics?.whyZero || '검색 결과 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'search',
      requestedNames: index.requestedNames,
      missingRequested: index.stats.missingFromRequested,
      nameFilterMode: index.stats.nameFilterMode,
      hits: buildSearchResultHits(hits),
      diagnostics,
      telemetry,
    },
  }
}

function buildSelectedPreviews(hits: SearchHit[], input: ToolContext): SelectedSkillPreview[] {
  return hits.map((hit) => ({
    name: hit.skill.canonicalName,
    score: hit.score,
    coverage: hit.coverage,
    path: hit.skill.path,
    title: hit.skill.title,
    category: hit.skill.category,
    scope: hit.skill.scope,
    aliases: hit.skill.aliases,
    requires: hit.skill.requires,
    recommends: hit.skill.recommends,
    preview: hit.skill.bodyText.slice(0, input.includeBody ? input.settings.includePreviewBodyChars * 2 : 180).replace(/\n+/g, ' '),
    body: input.includeBody ? hit.skill.bodyText : undefined,
  }))
}

function formatSelectTextLines(selected: SelectedSkillPreview[]): string[] {
  return selected.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name}`,
      `   score=${entry.score.toFixed(3)} coverage=${entry.coverage}`,
      `   path=${entry.path}`,
      `   title=${entry.title}`,
      `   scope=${entry.scope ?? '-'}`,
      entry.aliases.length ? `   aliases=${entry.aliases.join(', ')}` : '',
      entry.requires.length || entry.recommends.length
        ? `   related=requires:${entry.requires.join(', ') || '-'} | recommends:${entry.recommends.join(', ') || '-'}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/** select action 결과를 구성합니다. */
export function buildSelectResult(index: IndexArtifacts, hits: SearchHit[], input: ToolContext): SkillRegistryToolResult {
  const selected = buildSelectedPreviews(hits, input)
  const selectedForReturn = selected.map(({ body, ...rest }) => rest)
  const telemetry = buildComplaintTelemetrySnapshot(
    input,
    selected.map((e) => e.name),
    index.stats.missingFromRequested,
  )
  return {
    content: [
      {
        type: 'text',
        text: [
          `selected skills (${selected.length}개)`,
          selected.length ? selected.map((entry) => `${entry.name} (${entry.score.toFixed(3)})`).join(', ') : '선택 결과 없음',
          '',
          ...formatSelectTextLines(selected),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    details: {
      kind: 'select',
      requestedNames: index.requestedNames,
      missingRequested: index.stats.missingFromRequested,
      nameFilterMode: index.stats.nameFilterMode,
      selected: selectedForReturn,
      includeBody: input.includeBody,
      selectedWithBody: input.includeBody ? selected : undefined,
      telemetry,
    },
  }
}

function buildComposeEntries(plan: SkillComposePlan, includeBody: boolean, includePreviewBodyChars: number) {
  return plan.entries.map((entry) => ({
    name: entry.skill.canonicalName,
    readPath: `skill://${entry.skill.canonicalName}`,
    reason: entry.reason,
    via: entry.via,
    depth: entry.depth,
    title: entry.skill.title,
    category: entry.skill.category,
    scope: entry.skill.scope,
    path: entry.skill.path,
    aliases: entry.skill.aliases,
    requires: entry.skill.requires,
    recommends: entry.skill.recommends,
    preview: entry.skill.bodyText.slice(0, includeBody ? includePreviewBodyChars * 2 : 180).replace(/\n+/g, ' '),
    body: includeBody ? entry.skill.bodyText : undefined,
  }))
}

function buildComposeMissingLines(missing: SkillComposePlan['missing']) {
  return missing.map((entry) => `- ${entry.name} (${entry.relation}, via ${entry.via}, depth ${entry.depth})`)
}

function buildComposeTextLines(entries: ReturnType<typeof buildComposeEntries>) {
  return entries.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
      `   reason: ${entry.reason}${entry.via ? ` via ${entry.via}` : ''} | depth ${entry.depth}`,
      `   category: ${entry.category}`,
      `   scope: ${entry.scope ?? '-'}`,
      entry.aliases.length ? `   aliases: ${entry.aliases.join(', ')}` : '',
      entry.requires.length || entry.recommends.length
        ? `   related: requires=${entry.requires.join(', ') || '-'} | recommends=${entry.recommends.join(', ') || '-'}`
        : '',
      `   path: ${entry.path}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function buildComposeEntriesForReturn(entries: ReturnType<typeof buildComposeEntries>) {
  return entries.map(({ body, ...rest }) => rest)
}

function buildComposeResultText(
  relationMode: SkillComposePlan['relationMode'],
  entries: ReturnType<typeof buildComposeEntries>,
  textLines: string[],
  missingLines: string[],
): string {
  return [
    `skill_registry compose 결과 (${entries.length}건)`,
    `relationMode: ${relationMode}`,
    entries.length ? textLines.join('\n\n') : 'compose 결과 없음',
    '',
    missingLines.length ? ['missing relations:', ...missingLines].join('\n') : 'missing relations: 없음',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildComposeResultDetails(
  index: IndexArtifacts,
  plan: SkillComposePlan,
  input: ToolContext,
  entries: ReturnType<typeof buildComposeEntries>,
) {
  const entriesForReturn = buildComposeEntriesForReturn(entries)

  return {
    kind: 'compose',
    query: input.query,
    relationMode: plan.relationMode,
    requestedNames: index.requestedNames,
    missingRequested: index.stats.missingFromRequested,
    nameFilterMode: index.stats.nameFilterMode,
    seeds: plan.seeds.map((skill) => skill.canonicalName),
    entries: entriesForReturn,
    entriesWithBody: input.includeBody ? entries : undefined,
    missing: plan.missing,
  }
}

/** compose action 결과를 구성합니다. */
export function buildComposeResult(index: IndexArtifacts, plan: SkillComposePlan, input: ToolContext): SkillRegistryToolResult {
  const entries = buildComposeEntries(plan, input.includeBody, input.settings.includePreviewBodyChars)
  const textLines = buildComposeTextLines(entries)
  const missingLines = buildComposeMissingLines(plan.missing)
  return {
    content: [{ type: 'text', text: buildComposeResultText(plan.relationMode, entries, textLines, missingLines) }],
    details: buildComposeResultDetails(index, plan, input, entries),
  }
}

/** pack action 결과를 구성합니다. */
function buildPackResultEntryLines(packEntries: SkillPack['entries']): string[] {
  return packEntries.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
      `   reason: ${entry.reason}${entry.via ? ` via ${entry.via}` : ''} | depth ${entry.depth}`,
      `   layers: read=${entry.readLayer ?? '-'} apply=${entry.applyLayer ?? '-'}`,
      `   category: ${entry.category}`,
      entry.aliases.length ? `   aliases: ${entry.aliases.join(', ')}` : '',
      entry.omittedByBudget ? '   body: omitted by budget' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function buildPackResultTextLines(pack: SkillPack, entryLines: string[]): string[] {
  return [
    `skill_registry pack 결과 (${pack.entries.length}건)`,
    `ok: ${pack.ok} | relationMode: ${pack.relationMode}`,
    `seeds: ${pack.seeds.join(', ') || '-'}`,
    `budget: requestedChars=${pack.budget.requestedChars} requestedTokens=${pack.budget.requestedTokens} effectiveChars=${pack.budget.effectiveChars} usedChars=${pack.budget.usedChars}`,
    pack.cycles.length ? `cycles: ${pack.cycles.map((cycle) => `[${cycle.join(' -> ')}]`).join(', ')}` : 'cycles: -',
    pack.missing.length
      ? `missing: ${pack.missing.map((entry) => `${entry.via} -> ${entry.name} (${entry.relation})`).join(', ')}`
      : 'missing: -',
    pack.omittedReadPaths.length ? `omitted read paths: ${pack.omittedReadPaths.join(', ')}` : 'omitted read paths: -',
    '',
    entryLines.length ? entryLines.join('\n\n') : 'pack entries 없음',
  ]
}

function buildPackResultDetails(index: IndexArtifacts, pack: SkillPack) {
  return {
    kind: 'pack',
    ok: pack.ok,
    seeds: pack.seeds,
    entries: pack.entries.map(({ body, ...rest }) => rest),
    entriesWithBody: pack.entries,
    readLayers: pack.readLayers,
    applyLayers: pack.applyLayers,
    missing: pack.missing,
    cycles: pack.cycles,
    orphans: pack.orphans,
    omittedReadPaths: pack.omittedReadPaths,
    budget: pack.budget,
    summary: {
      entryCount: pack.entries.length,
      missingCount: pack.missing.length,
      cycleCount: pack.cycles.length,
      orphanCount: pack.orphans.length,
      validateIssueCount: pack.validate.issues.length,
      validateOk: pack.validate.ok,
    },
    diagnostics: pack.diagnostics,
    requestedNames: index.requestedNames,
    missingRequested: index.stats.missingFromRequested,
    nameFilterMode: index.stats.nameFilterMode,
  }
}

/** pack action 결과를 구성합니다. */
export function buildPackResult(index: IndexArtifacts, pack: SkillPack): SkillRegistryToolResult {
  const entryLines = buildPackResultEntryLines(pack.entries)
  const details = buildPackResultDetails(index, pack)

  return {
    content: [
      {
        type: 'text',
        text: buildPackResultTextLines(pack, entryLines).join('\n'),
      },
    ],
    details,
  }
}

function buildResolveResolvedLines(resolved: SkillResolveResult['resolved']): string[] {
  return resolved.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
      `   category: ${entry.category}`,
      entry.aliases.length ? `   aliases: ${entry.aliases.join(', ')}` : '',
      entry.omittedByBudget ? '   body: omitted by budget' : '',
      `   path: ${entry.path}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function buildResolveSuggestionLines(suggestions: SkillResolveResult['suggestions']): string[] {
  return suggestions.map(
    (suggestion, idx) => `${idx + 1}. ${suggestion.name} -> ${suggestion.readPath} (confidence=${suggestion.confidence.toFixed(3)})`,
  )
}

function buildResolveText(result: SkillResolveResult, resolvedLines: string[], suggestionLines: string[]): string {
  return [
    `skill_registry resolve 결과 (${result.resolved.length}건)`,
    `missing: ${result.missing.length} | omitted: ${result.omittedReadPaths.length}`,
    `budget: requestedChars=${result.budget.requestedChars} requestedTokens=${result.budget.requestedTokens} effectiveChars=${result.budget.effectiveChars} usedChars=${result.budget.usedChars}`,
    result.suggestions.length
      ? `bounded suggestions:\n${suggestionLines.join('\n')}`
      : result.missing.length
        ? 'recovery: use skill_registry discover/search, then resolve the exact canonical name before reading.'
        : 'recovery: -',
    result.missing.length ? `missing names: ${result.missing.join(', ')}` : 'missing names: -',
    result.omittedReadPaths.length ? `omitted read paths: ${result.omittedReadPaths.join(', ')}` : 'omitted read paths: -',
    '',
    resolvedLines.length ? resolvedLines.join('\n\n') : 'resolved skill 없음',
  ].join('\n')
}

/** resolve action 결과를 구성합니다. */
export function buildResolveResult(_index: IndexArtifacts, result: SkillResolveResult): SkillRegistryToolResult {
  const resolvedLines = buildResolveResolvedLines(result.resolved)
  const suggestionLines = buildResolveSuggestionLines(result.suggestions)
  const text = buildResolveText(result, resolvedLines, suggestionLines)
  const boundedText = result.missing.length > 0 && result.resolved.length === 0 ? boundResolveRecoveryText(text) : text

  return {
    content: [
      {
        type: 'text',
        text: boundedText,
      },
    ],
    details: {
      kind: 'resolve',
      resolved: result.resolved.map(({ body, ...rest }) => rest),
      resolvedWithBody: result.resolved,
      missing: result.missing,
      suggestions: result.suggestions,
      omittedReadPaths: result.omittedReadPaths,
      budget: result.budget,
    },
  }
}

/** gap action 결과를 구성합니다. */
function buildGapCandidateLines(candidates: SkillGapResult['candidates']): string[] {
  return candidates.map((candidate, idx) =>
    [
      `${idx + 1}. ${candidate.name} -> ${candidate.readPath}`,
      `   score=${candidate.score.toFixed(3)} coverage=${candidate.coverage}`,
      `   matched=${candidate.matchedTerms.join(', ') || '-'}`,
      `   category=${candidate.category}`,
      `   path=${candidate.path}`,
    ].join('\n'),
  )
}

function buildGapScaffoldHint(scaffold: SkillGapResult['scaffold']): string {
  if (!scaffold) return ''
  return [
    '',
    'scaffold hint:',
    `name: ${scaffold.name}`,
    `category: ${scaffold.category}`,
    `keywords: ${scaffold.keywords.join(', ') || '-'}`,
    `description: ${scaffold.description}`,
  ].join('\n')
}

export function buildGapResult(result: SkillGapResult): SkillRegistryToolResult {
  const candidateLines = buildGapCandidateLines(result.candidates)
  const scaffoldHint = buildGapScaffoldHint(result.scaffold)

  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry gap 결과 (${result.recommendedAction})`,
          `covered: ${result.coveredTerms.join(', ') || '-'} | uncovered: ${result.uncoveredTerms.join(', ') || '-'}`,
          result.candidates.length ? candidateLines.join('\n\n') : 'candidate skill 없음',
          scaffoldHint,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    details: {
      kind: 'gap',
      ok: result.ok,
      query: result.query,
      coverageThreshold: result.coverageThreshold,
      coveredTerms: result.coveredTerms,
      uncoveredTerms: result.uncoveredTerms,
      candidates: result.candidates,
      recommendedAction: result.recommendedAction,
      scaffold: result.scaffold,
    },
  }
}

/** explain entry를 문자열로 구성합니다. */
function formatExplainEntry(entry: SkillExplainResult['entries'][number], idx: number): string {
  return [
    `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
    `   reason: ${entry.reason}${entry.via ? ` via ${entry.via}` : ''} | depth ${entry.depth}`,
    `   layers: read=${entry.readLayer ?? '-'} apply=${entry.applyLayer ?? '-'}`,
    entry.score === undefined ? '' : `   score=${entry.score.toFixed(3)} coverage=${entry.coverage ?? 0}`,
    entry.matchedTerms.length ? `   matched: ${entry.matchedTerms.join(', ')}` : '',
    `   preview: ${entry.matchPreview}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** explain action 결과 본문을 구성합니다. */
function buildExplainText(result: SkillExplainResult): string {
  const lines = result.entries.map((entry, idx) => formatExplainEntry(entry, idx))
  return [
    `skill_registry explain 결과 (${result.entries.length}건)`,
    `seeds: ${result.seeds.join(', ') || '-'} | relationMode: ${result.relationMode}`,
    result.missing.length
      ? `missing: ${result.missing.map((entry) => `${entry.via} -> ${entry.name} (${entry.relation})`).join(', ')}`
      : 'missing: -',
    result.cycles.length ? `cycles: ${result.cycles.map((cycle) => `[${cycle.join(' -> ')}]`).join(', ')}` : 'cycles: -',
    '',
    lines.length ? lines.join('\n\n') : 'explain entries 없음',
  ].join('\n')
}

/** explain action 결과를 구성합니다. */
export function buildExplainResult(result: SkillExplainResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: buildExplainText(result),
      },
    ],
    details: {
      kind: 'explain',
      query: result.query,
      relationMode: result.relationMode,
      seeds: result.seeds,
      entries: result.entries,
      missing: result.missing,
      cycles: result.cycles,
      diagnostics: result.diagnostics,
    },
  }
}

/** decide entry format을 문자열로 구성합니다. */
function formatDecideEntry(entry: SkillDecideEntry, idx: number, winner: string | null): string {
  return [
    `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
    `   score=${entry.score.toFixed(3)} category=${entry.category}${winner === entry.name ? ' winner' : ''}`,
    entry.queryScore === undefined ? '' : `   query score=${entry.queryScore.toFixed(3)} coverage=${entry.queryCoverage ?? 0}`,
    entry.explicitName ? '   explicit names input' : '',
    entry.peerRequiredBy.length ? `   required by peers: ${entry.peerRequiredBy.join(', ')}` : '',
    entry.peerRecommendedBy.length ? `   recommended by peers: ${entry.peerRecommendedBy.join(', ')}` : '',
    entry.requiredPeers.length ? `   requires peers first: ${entry.requiredPeers.join(', ')}` : '',
    entry.unresolvedRequires.length ? `   unresolved requires: ${entry.unresolvedRequires.join(', ')}` : '',
    entry.reasons.length ? `   why: ${entry.reasons.join(' | ')}` : '',
    `   preview: ${entry.preview}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** decide action 결과를 구성합니다. */
export function buildDecideResult(result: SkillDecideResult): SkillRegistryToolResult {
  const lines = result.ordered.map((entry, idx) => formatDecideEntry(entry, idx, result.winner))
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry decide 결과 (${result.ordered.length}건)`,
          `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''}`,
          `winner: ${result.winner ?? '-'}`,
          lines.length ? lines.join('\n\n') : '결정 후보 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'decide',
      query: result.query,
      basis: result.basis,
      winner: result.winner,
      ordered: result.ordered,
    },
  }
}

/** plan action 결과를 구성합니다. */
export function buildPlanResult(result: SkillPlanResult): SkillRegistryToolResult {
  const lines = result.steps.map((step) =>
    [
      `${step.order}. ${step.name} -> ${step.readPath}`,
      `   phase=${step.phase} reason=${step.reason}${step.via ? ` via ${step.via}` : ''}`,
      step.score === undefined ? '' : `   score=${step.score.toFixed(3)}`,
      step.queryScore === undefined ? '' : `   query score=${step.queryScore.toFixed(3)}`,
      `   preview: ${step.preview}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry plan 결과 (${result.steps.length} steps)`,
          `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
          `winner: ${result.winner ?? '-'}`,
          result.deferred.length ? `deferred: ${result.deferred.join(', ')}` : 'deferred: -',
          lines.length ? lines.join('\n\n') : '계획 step 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'plan',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      steps: result.steps,
      deferred: result.deferred,
    },
  }
}

/** route action 결과를 구성합니다. */
export function buildRouteResult(result: SkillRouteResult): SkillRegistryToolResult {
  const phaseLines = result.phases.map((phase) =>
    [
      `${phase.order}. ${phase.kind}${phase.layer === null ? '' : `:${phase.layer}`}`,
      `   names: ${phase.names.join(', ')}`,
      `   readPaths: ${phase.readPaths.join(', ')}`,
      phase.rationale.length ? `   rationale: ${phase.rationale.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry route 결과 (${result.phases.length} phases)`,
          `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
          `winner: ${result.winner ?? '-'}`,
          result.deferred.length ? `deferred: ${result.deferred.join(', ')}` : 'deferred: -',
          phaseLines.length ? phaseLines.join('\n\n') : 'route phase 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'route',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      phases: result.phases,
      deferred: result.deferred,
    },
  }
}

/** brief action 결과를 구성합니다. */
function buildBriefEntryLine(entry: SkillBriefResult['entries'][number], idx: number): string {
  return [
    `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
    `   phase=${entry.phaseKind}${entry.layer === null ? '' : `:${entry.layer}`}`,
    `   category=${entry.category}`,
    entry.body ? `   body: ${entry.body.replace(/\n+/g, ' ').slice(0, 160)}` : '',
    !entry.body && entry.omittedByBudget ? '   body omitted by budget' : '',
    `   preview: ${entry.preview}`,
  ]
    .filter(Boolean)
    .join('\n')
}

function buildBriefEntryLines(entries: SkillBriefResult['entries']): string[] {
  return entries.map((entry, idx) => buildBriefEntryLine(entry, idx))
}

function buildBriefEntries(entries: SkillBriefResult['entries']) {
  return entries.map(({ body, ...entry }) => entry)
}

function buildBriefEntriesWithBody(entries: SkillBriefResult['entries']) {
  return entries.some((entry) => entry.body) ? entries : undefined
}

function buildBriefText(result: SkillBriefResult, entryLines: string[]): string {
  return [
    `skill_registry brief 결과 (${result.entries.length} entries)`,
    `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
    `winner: ${result.winner ?? '-'}`,
    `budget: used=${result.budget.usedChars}/${result.budget.effectiveChars}`,
    result.omittedReadPaths.length ? `omitted: ${result.omittedReadPaths.join(', ')}` : 'omitted: -',
    entryLines.length ? entryLines.join('\n\n') : 'brief entry 없음',
  ].join('\n')
}

/** brief action 결과를 구성합니다. */
export function buildBriefResult(result: SkillBriefResult): SkillRegistryToolResult {
  const entryLines = buildBriefEntryLines(result.entries)
  const entries = buildBriefEntries(result.entries)
  const entriesWithBody = buildBriefEntriesWithBody(result.entries)
  return {
    content: [{ type: 'text', text: buildBriefText(result, entryLines) }],
    details: {
      kind: 'brief',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      phases: result.phases,
      entries,
      entriesWithBody,
      deferred: result.deferred,
      omittedReadPaths: result.omittedReadPaths,
      budget: result.budget,
    },
  }
}

/** bundle action 결과를 구성합니다. */
export function buildBundleResult(result: SkillBundleResult): SkillRegistryToolResult {
  const entryLines = buildBundleResultEntryLines(result.entries)
  return {
    content: buildBundleResultContent(result, entryLines),
    details: buildBundleResultDetails(result),
  }
}

function buildBundleResultEntryLines(entries: SkillBundleResult['entries']) {
  return entries.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
      `   phase=${entry.phaseKind}${entry.layer === null ? '' : `:${entry.layer}`}`,
      `   category=${entry.category}`,
      entry.omittedByBudget ? '   body omitted by budget' : '   body included',
      `   preview: ${entry.preview}`,
    ].join('\n'),
  )
}

function buildBundleResultContent(result: SkillBundleResult, entryLines: string[]): SkillRegistryToolResult['content'] {
  return [
    {
      type: 'text',
      text: [
        `skill_registry bundle 결과 (${result.entries.length} entries)`,
        `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
        `winner: ${result.winner ?? '-'} | ready: ${result.ready}`,
        `budget: used=${result.budget.usedChars}/${result.budget.effectiveChars}`,
        result.omittedReadPaths.length ? `omitted: ${result.omittedReadPaths.join(', ')}` : 'omitted: -',
        entryLines.length ? entryLines.join('\n\n') : 'bundle entry 없음',
      ].join('\n'),
    },
  ]
}

function buildBundleResultDetails(result: SkillBundleResult) {
  return {
    kind: 'bundle',
    query: result.query,
    basis: result.basis,
    relationMode: result.relationMode,
    winner: result.winner,
    ready: result.ready,
    phases: result.phases,
    entries: result.entries,
    entriesWithBody: result.entriesWithBody,
    deferred: result.deferred,
    omittedReadPaths: result.omittedReadPaths,
    budget: result.budget,
  }
}

/** handoff action 결과를 구성합니다. */
function buildHandoffEntryLines(entries: SkillHandoffResult['entries']): string[] {
  return entries.map((entry, idx) =>
    [
      `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
      `   sourcePath: ${entry.path}`,
      `   phase=${entry.phaseKind}${entry.layer === null ? '' : `:${entry.layer}`}`,
      entry.omittedByBudget ? '   body omitted by budget' : '   body included',
      `   preview: ${entry.preview}`,
    ].join('\n'),
  )
}

function buildHandoffContent(result: SkillHandoffResult): SkillRegistryToolResult['content'] {
  const entryLines = buildHandoffEntryLines(result.entries)
  return [
    {
      type: 'text',
      text: [
        `skill_registry handoff 결과 (${result.entries.length} entries)`,
        `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
        `winner: ${result.winner ?? '-'} | ready: ${result.ready}`,
        `sourcePath: ${result.sourcePath ?? '-'}`,
        `nextCommand: ${result.nextCommand ?? '-'}`,
        result.applyHint ? `applyHint: ${result.applyHint}` : 'applyHint: -',
        entryLines.length ? entryLines.join('\n\n') : 'handoff entry 없음',
      ].join('\n'),
    },
  ]
}

function buildHandoffDetails(result: SkillHandoffResult): SkillRegistryToolResult['details'] {
  return {
    kind: 'handoff',
    query: result.query,
    basis: result.basis,
    relationMode: result.relationMode,
    winner: result.winner,
    ready: result.ready,
    sourcePath: result.sourcePath,
    nextCommand: result.nextCommand,
    applyHint: result.applyHint,
    phases: result.phases,
    entries: result.entries,
    entriesWithBody: result.entriesWithBody,
    deferred: result.deferred,
    omittedReadPaths: result.omittedReadPaths,
    budget: result.budget,
  }
}

export function buildHandoffResult(result: SkillHandoffResult): SkillRegistryToolResult {
  return {
    content: buildHandoffContent(result),
    details: buildHandoffDetails(result),
  }
}

function buildSessionPacketStepLines(steps: SkillSessionPacketResult['steps']) {
  return steps.map((step) =>
    [
      `${step.order}. ${step.name}`,
      `   sourcePath: ${step.sourcePath}`,
      `   nextCommand: ${step.nextCommand}`,
      `   phase=${step.phaseKind}${step.layer === null ? '' : `:${step.layer}`}`,
      step.omittedByBudget ? '   body omitted by budget' : '   body included',
    ].join('\n'),
  )
}

function buildSessionPacketContent(result: SkillSessionPacketResult, stepLines: string[]): SkillRegistryToolResult['content'] {
  return [
    {
      type: 'text',
      text: [
        `skill_registry session-packet 결과 (${result.steps.length} steps)`,
        `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
        `winner: ${result.winner ?? '-'} | ready: ${result.ready}`,
        result.recoveryGuidance.length ? `recovery: ${result.recoveryGuidance.join(' | ')}` : 'recovery: -',
        stepLines.length ? stepLines.join('\n\n') : 'session packet step 없음',
      ].join('\n'),
    },
  ]
}

/** session-packet action 결과를 구성합니다. */
export function buildSessionPacketResult(result: SkillSessionPacketResult): SkillRegistryToolResult {
  return {
    content: buildSessionPacketContent(result, buildSessionPacketStepLines(result.steps)),
    details: {
      kind: 'session-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      steps: result.steps,
    },
  }
}

/** turn-packet action 결과를 구성합니다. */
function buildTurnPacketLines(turns: SkillTurnPacketResult['turns']) {
  return turns.map((turn) =>
    [
      `${turn.order}. ${turn.phaseKind}${turn.layer === null ? '' : `:${turn.layer}`}`,
      `   objective: ${turn.objective}`,
      `   names: ${turn.names.join(', ')}`,
      `   sourcePaths: ${turn.sourcePaths.join(', ') || '-'}`,
      `   nextCommands: ${turn.nextCommands.join(' -> ') || '-'}`,
      turn.checklist.length ? `   checklist: ${turn.checklist.join(' | ')}` : '   checklist: -',
      turn.exitCriteria.length ? `   exit: ${turn.exitCriteria.join(' | ')}` : '   exit: -',
      turn.blockedByBudget ? '   budget: blocked' : '   budget: ready',
    ].join('\n'),
  )
}

function buildTurnPacketText(result: SkillTurnPacketResult, turnLines: string[]): SkillRegistryToolResult['content'] {
  return [
    {
      type: 'text',
      text: [
        `skill_registry turn-packet 결과 (${result.turns.length} turns)`,
        `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
        `winner: ${result.winner ?? '-'} | ready: ${result.ready}`,
        result.recoveryGuidance.length ? `recovery: ${result.recoveryGuidance.join(' | ')}` : 'recovery: -',
        result.deferred.length ? `deferred: ${result.deferred.join(', ')}` : 'deferred: -',
        turnLines.length ? turnLines.join('\n\n') : 'turn packet 없음',
      ].join('\n'),
    },
  ]
}

function buildTurnPacketDetails(result: SkillTurnPacketResult) {
  return {
    kind: 'turn-packet',
    query: result.query,
    basis: result.basis,
    relationMode: result.relationMode,
    winner: result.winner,
    ready: result.ready,
    sourcePaths: result.sourcePaths,
    nextCommands: result.nextCommands,
    applyHint: result.applyHint,
    recoveryGuidance: result.recoveryGuidance,
    deferred: result.deferred,
    omittedReadPaths: result.omittedReadPaths,
    budget: result.budget,
    turns: result.turns,
  }
}

export function buildTurnPacketResult(result: SkillTurnPacketResult): SkillRegistryToolResult {
  return {
    content: buildTurnPacketText(result, buildTurnPacketLines(result.turns)),
    details: buildTurnPacketDetails(result),
  }
}

/** recovery-packet action 결과를 구성합니다. */
const buildRecoveryPacketResultBlockedTurnLines = (blockedTurns: SkillRecoveryPacketResult['blockedTurns']) =>
  blockedTurns.map((turn) =>
    [
      `${turn.order}. ${turn.phaseKind}${turn.layer === null ? '' : `:${turn.layer}`}`,
      `   objective: ${turn.objective}`,
      `   names: ${turn.names.join(', ')}`,
      `   omittedReadPaths: ${turn.omittedReadPaths.join(', ') || '-'}`,
      `   sourcePaths: ${turn.sourcePaths.join(', ') || '-'}`,
      `   recoveryCommands: ${turn.recoveryCommands.join(' -> ') || '-'}`,
      turn.unblockCriteria.length ? `   unblock: ${turn.unblockCriteria.join(' | ')}` : '   unblock: -',
    ].join('\n'),
  )

const buildRecoveryPacketResultText = (result: SkillRecoveryPacketResult, blockedTurnLines: string[]) =>
  [
    `skill_registry recovery-packet 결과 (${result.blockedTurns.length} blocked turns)`,
    `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
    `winner: ${result.winner ?? '-'} | ready: ${result.ready} | resumeTurnOrder: ${result.resumeTurnOrder ?? '-'}`,
    result.recoveryGuidance.length ? `recovery: ${result.recoveryGuidance.join(' | ')}` : 'recovery: -',
    result.deferred.length ? `deferred: ${result.deferred.join(', ')}` : 'deferred: -',
    blockedTurnLines.length ? blockedTurnLines.join('\n\n') : 'recovery 대상 turn 없음',
  ].join('\n')

const buildRecoveryPacketResultDetails = (result: SkillRecoveryPacketResult) => ({
  kind: 'recovery-packet',
  query: result.query,
  basis: result.basis,
  relationMode: result.relationMode,
  winner: result.winner,
  ready: result.ready,
  applyHint: result.applyHint,
  recoveryGuidance: result.recoveryGuidance,
  omittedReadPaths: result.omittedReadPaths,
  sourcePaths: result.sourcePaths,
  recoveryCommands: result.recoveryCommands,
  deferred: result.deferred,
  resumeTurnOrder: result.resumeTurnOrder,
  budget: result.budget,
  blockedTurns: result.blockedTurns,
})

export function buildRecoveryPacketResult(result: SkillRecoveryPacketResult): SkillRegistryToolResult {
  const blockedTurnLines = buildRecoveryPacketResultBlockedTurnLines(result.blockedTurns)

  return {
    content: [{ type: 'text', text: buildRecoveryPacketResultText(result, blockedTurnLines) }],
    details: buildRecoveryPacketResultDetails(result),
  }
}

/** resume-packet action 결과를 구성합니다. */
function buildResumePacketResultTurnLine(turn: SkillResumePacketResult['turns'][number]): string {
  return [
    `${turn.order}. ${turn.phaseKind}${turn.layer === null ? '' : `:${turn.layer}`}`,
    `   names: ${turn.names.join(', ')}`,
    `   sourcePaths: ${turn.sourcePaths.join(', ') || '-'}`,
    `   nextCommands: ${turn.nextCommands.join(' -> ') || '-'}`,
    `   objective: ${turn.objective}`,
    turn.checklist.length ? `   checklist: ${turn.checklist.join(' | ')}` : '   checklist: -',
    turn.blockedByBudget ? '   budget: blocked' : '   budget: ready',
  ].join('\n')
}

function buildResumePacketResultText(result: SkillResumePacketResult, turnLines: string[]): string {
  return [
    `skill_registry resume-packet 결과 (${result.turns.length} turns)`,
    `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
    `winner: ${result.winner ?? '-'} | ready: ${result.ready} | resumeTurnOrder: ${result.resumeTurnOrder ?? '-'}`,
    result.recoveryGuidance.length ? `recovery: ${result.recoveryGuidance.join(' | ')}` : 'recovery: -',
    result.recoveryCommands.length ? `recoveryCommands: ${result.recoveryCommands.join(' -> ')}` : 'recoveryCommands: -',
    turnLines.length ? turnLines.join('\n\n') : 'resume 대상 turn 없음',
  ].join('\n')
}

const buildResumePacketResultDetails = (result: SkillResumePacketResult) => ({
  kind: 'resume-packet',
  query: result.query,
  basis: result.basis,
  relationMode: result.relationMode,
  winner: result.winner,
  ready: result.ready,
  applyHint: result.applyHint,
  recoveryGuidance: result.recoveryGuidance,
  omittedReadPaths: result.omittedReadPaths,
  recoveryCommands: result.recoveryCommands,
  sourcePaths: result.sourcePaths,
  nextCommands: result.nextCommands,
  deferred: result.deferred,
  resumeTurnOrder: result.resumeTurnOrder,
  budget: result.budget,
  turns: result.turns,
  blockedTurns: result.blockedTurns,
})

export function buildResumePacketResult(result: SkillResumePacketResult): SkillRegistryToolResult {
  const turnLines = result.turns.map(buildResumePacketResultTurnLine)

  return {
    content: [{ type: 'text', text: buildResumePacketResultText(result, turnLines) }],
    details: buildResumePacketResultDetails(result),
  }
}

/** current-turn-packet action 결과를 구성합니다. */
function buildCurrentTurnPacketResultTurnText(turn: SkillCurrentTurnPacketResult['turn']): string {
  return turn
    ? [
        `${turn.order}. ${turn.phaseKind}${turn.layer === null ? '' : `:${turn.layer}`}`,
        `   names: ${turn.names.join(', ')}`,
        `   sourcePaths: ${turn.sourcePaths.join(', ') || '-'}`,
        `   nextCommands: ${turn.nextCommands.join(' -> ') || '-'}`,
        `   checklist: ${turn.checklist.join(' | ') || '-'}`,
        turn.blockedByBudget ? '   budget: blocked' : '   budget: ready',
      ].join('\n')
    : 'current turn 없음'
}

function buildCurrentTurnPacketResultText(result: SkillCurrentTurnPacketResult): string {
  return [
    `skill_registry current-turn-packet 결과`,
    `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''} | relationMode: ${result.relationMode}`,
    `winner: ${result.winner ?? '-'} | ready: ${result.ready} | activeTurnOrder: ${result.activeTurnOrder ?? '-'}`,
    result.recoveryGuidance.length ? `recovery: ${result.recoveryGuidance.join(' | ')}` : 'recovery: -',
    buildCurrentTurnPacketResultTurnText(result.turn),
  ].join('\n')
}

function buildCurrentTurnPacketResultDetails(result: SkillCurrentTurnPacketResult) {
  return {
    kind: 'current-turn-packet',
    query: result.query,
    basis: result.basis,
    relationMode: result.relationMode,
    winner: result.winner,
    ready: result.ready,
    applyHint: result.applyHint,
    recoveryGuidance: result.recoveryGuidance,
    omittedReadPaths: result.omittedReadPaths,
    recoveryCommands: result.recoveryCommands,
    sourcePaths: result.sourcePaths,
    nextCommands: result.nextCommands,
    deferred: result.deferred,
    activeTurnOrder: result.activeTurnOrder,
    budget: result.budget,
    turn: result.turn,
    blockedTurns: result.blockedTurns,
  }
}

export function buildCurrentTurnPacketResult(result: SkillCurrentTurnPacketResult): SkillRegistryToolResult {
  return {
    content: [{ type: 'text', text: buildCurrentTurnPacketResultText(result) }],
    details: buildCurrentTurnPacketResultDetails(result),
  }
}

/** instruction-packet action 결과를 구성합니다. */
export function buildInstructionPacketResult(result: SkillInstructionPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.instructionText,
      },
    ],
    details: {
      kind: 'instruction-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      instructionText: result.instructionText,
      checklistText: result.checklistText,
      commandBlock: result.commandBlock,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** summary-packet action 결과를 구성합니다. */
export function buildSummaryPacketResult(result: SkillSummaryPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.summaryText,
      },
    ],
    details: {
      kind: 'summary-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      summaryText: result.summaryText,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** markdown-packet action 결과를 구성합니다. */
export function buildMarkdownPacketResult(result: SkillMarkdownPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.markdown,
      },
    ],
    details: {
      kind: 'markdown-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      markdown: result.markdown,
      commandBlock: result.commandBlock,
      checklistItems: result.checklistItems,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** checklist-packet action 결과를 구성합니다. */
export function buildChecklistPacketResult(result: SkillChecklistPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.checklistText || 'checklist 없음',
      },
    ],
    details: {
      kind: 'checklist-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      checklistItems: result.checklistItems,
      checklistText: result.checklistText,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** commands-packet action 결과를 구성합니다. */
export function buildCommandsPacketResult(result: SkillCommandsPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.commandBlock || 'command 없음',
      },
    ],
    details: {
      kind: 'commands-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      commandBlock: result.commandBlock,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** file-ready-packet action 결과를 구성합니다. */
export function buildFileReadyPacketResult(result: SkillFileReadyPacketResult): SkillRegistryToolResult {
  const lines = result.files.map((file) => `- ${file.kind}: ${file.suggestedPath} (${file.mediaType})`)
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry file-ready-packet 결과 (${result.files.length} files)`,
          `baseName: ${result.baseName}`,
          lines.join('\n'),
        ].join('\n'),
      },
    ],
    details: {
      kind: 'file-ready-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      baseName: result.baseName,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      files: result.files,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** apply-packet action 결과를 구성합니다. */
export function buildApplyPacketResult(result: SkillApplyPacketResult): SkillRegistryToolResult {
  const lines = result.writes.map((write) => `- write: ${write.path} (${write.sourceKind}, ${write.mediaType})`)
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry apply-packet 결과 (${result.writes.length} writes)`,
          `baseName: ${result.baseName}`,
          result.applyText,
          lines.join('\n'),
        ].join('\n'),
      },
    ],
    details: {
      kind: 'apply-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      baseName: result.baseName,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      writes: result.writes,
      applyText: result.applyText,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** write-script-packet action 결과를 구성합니다. */
export function buildWriteScriptPacketResult(result: SkillWriteScriptPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry write-script-packet 결과 (${result.writes.length} writes)`,
          `scriptPath: ${result.scriptPath}`,
          `command: ${result.commandBlock}`,
        ].join('\n'),
      },
    ],
    details: {
      kind: 'write-script-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      baseName: result.baseName,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      writes: result.writes,
      scriptPath: result.scriptPath,
      scriptContent: result.scriptContent,
      commandBlock: result.commandBlock,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** execution-packet action 결과를 구성합니다. */
export function buildExecutionPacketResult(result: SkillExecutionPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry execution-packet 결과 (${result.files.length} files / ${result.runCommands.length} commands)`,
          `script: ${result.files[0]?.path ?? '-'}`,
          result.executionText,
        ].join('\n'),
      },
    ],
    details: {
      kind: 'execution-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      baseName: result.baseName,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      files: result.files,
      runCommands: result.runCommands,
      executionText: result.executionText,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

/** verification-packet action 결과를 구성합니다. */
export function buildVerificationPacketResult(result: SkillVerificationPacketResult): SkillRegistryToolResult {
  return {
    content: [
      {
        type: 'text',
        text: [`skill_registry verification-packet 결과 (${result.verificationItems.length} checks)`, result.verificationText].join('\n'),
      },
    ],
    details: {
      kind: 'verification-packet',
      query: result.query,
      basis: result.basis,
      relationMode: result.relationMode,
      winner: result.winner,
      ready: result.ready,
      applyHint: result.applyHint,
      recoveryGuidance: result.recoveryGuidance,
      activeTurnOrder: result.activeTurnOrder,
      baseName: result.baseName,
      sourcePaths: result.sourcePaths,
      nextCommands: result.nextCommands,
      files: result.files,
      runCommands: result.runCommands,
      verificationCommands: result.verificationCommands,
      verificationItems: result.verificationItems,
      verificationText: result.verificationText,
      budget: result.budget,
      turn: result.turn,
    },
  }
}

function formatComparePair(pair: SkillCompareResult['pairs'][number], idx: number): string {
  return [
    `${idx + 1}. ${pair.left} <-> ${pair.right}`,
    `   same category: ${pair.sameCategory}`,
    pair.scoreDelta === undefined ? '' : `   score delta: ${pair.scoreDelta}`,
    pair.sharedMatchedTerms.length ? `   shared matched: ${pair.sharedMatchedTerms.join(', ')}` : '',
    pair.leftOnlyMatchedTerms.length ? `   left-only matched: ${pair.leftOnlyMatchedTerms.join(', ')}` : '',
    pair.rightOnlyMatchedTerms.length ? `   right-only matched: ${pair.rightOnlyMatchedTerms.join(', ')}` : '',
    pair.sharedRequires.length ? `   shared requires: ${pair.sharedRequires.join(', ')}` : '',
    pair.sharedRecommends.length ? `   shared recommends: ${pair.sharedRecommends.join(', ')}` : '',
    pair.leftToRight ? `   left->right: ${pair.leftToRight}` : '',
    pair.rightToLeft ? `   right->left: ${pair.rightToLeft}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatCompareEntry(entry: SkillCompareResult['entries'][number], idx: number): string {
  return [
    `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
    `   category=${entry.category}${entry.score === undefined ? '' : ` score=${entry.score.toFixed(3)}`}`,
    entry.matchedTerms.length ? `   matched: ${entry.matchedTerms.join(', ')}` : '',
    `   preview: ${entry.preview}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** compare action 결과를 구성합니다. */
export function buildCompareResult(result: SkillCompareResult): SkillRegistryToolResult {
  const entryLines = result.entries.map((entry, idx) => formatCompareEntry(entry, idx))
  const pairLines = result.pairs.map((pair, idx) => formatComparePair(pair, idx))
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry compare 결과 (${result.entries.length} skills / ${result.pairs.length} pairs)`,
          `basis: ${result.basis}${result.query ? ` | query: ${result.query}` : ''}`,
          '',
          'entries:',
          entryLines.length ? entryLines.join('\n\n') : '비교 후보 없음',
          '',
          'pairs:',
          pairLines.length ? pairLines.join('\n\n') : 'pair 비교 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'compare',
      query: result.query,
      basis: result.basis,
      entries: result.entries,
      pairs: result.pairs,
    },
  }
}

function buildRecommendResultEntry(entry: SkillRecommendResult['recommendations'][number], idx: number): string {
  return [
    `${idx + 1}. ${entry.name} -> ${entry.readPath}`,
    `   score=${entry.score.toFixed(3)} category=${entry.category}`,
    entry.queryScore === undefined ? '' : `   query score=${entry.queryScore.toFixed(3)} coverage=${entry.queryCoverage ?? 0}`,
    entry.matchedTerms.length ? `   matched: ${entry.matchedTerms.join(', ')}` : '',
    entry.outboundSignals.length
      ? `   outbound: ${entry.outboundSignals.map((signal) => `${signal.via} -> (${signal.relation})`).join(', ')}`
      : '',
    entry.inboundSignals.length
      ? `   inbound: ${entry.inboundSignals.map((signal) => `${entry.name} -> ${signal.via} (${signal.relation})`).join(', ')}`
      : '',
    entry.sharedCategorySeeds.length ? `   shared category seeds: ${entry.sharedCategorySeeds.join(', ')}` : '',
    `   preview: ${entry.preview}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** recommend action 결과를 구성합니다. */
export function buildRecommendResult(result: SkillRecommendResult): SkillRegistryToolResult {
  const lines = result.recommendations.map((entry, idx) => buildRecommendResultEntry(entry, idx))
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry recommend 결과 (${result.recommendations.length}건)`,
          `seeds: ${result.seeds.join(', ') || '-'} | relationMode: ${result.relationMode}`,
          lines.length ? lines.join('\n\n') : '추천 결과 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'recommend',
      query: result.query,
      relationMode: result.relationMode,
      seeds: result.seeds,
      recommendations: result.recommendations,
    },
  }
}

function buildGraphResultNodeLines(graph: SkillRelationGraph): string[] {
  return graph.nodes.map((node, idx) =>
    [
      `${idx + 1}. ${node.name}`,
      `   category: ${node.category}`,
      node.aliases.length ? `   aliases: ${node.aliases.join(', ')}` : '',
      `   path: ${node.path}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function buildGraphResultEdgeLines(graph: SkillRelationGraph): string[] {
  return graph.edges.map((edge) => `${edge.from} -[${edge.relation}]-> ${edge.to ?? edge.target}${edge.resolved ? '' : ' (unresolved)'}`)
}

function buildGraphResultDetails(index: IndexArtifacts, graph: SkillRelationGraph): SkillRegistryToolResult['details'] {
  return {
    kind: 'graph',
    mode: graph.mode,
    seeds: graph.seeds,
    nodes: graph.nodes,
    edges: graph.edges,
    readLayers: graph.readLayers,
    applyLayers: graph.applyLayers,
    cycles: graph.cycles,
    orphans: graph.orphans,
    missing: graph.missing,
    diagnostics: graph.diagnostics,
    requestedNames: index.requestedNames,
    missingRequested: index.stats.missingFromRequested,
    nameFilterMode: index.stats.nameFilterMode,
  }
}

/** graph action 결과를 구성합니다. */
function buildGraphResultText(graph: SkillRelationGraph, nodeLines: string[], edgeLines: string[]): string {
  return [
    `skill_registry graph 결과 (${graph.mode})`,
    `seeds: ${graph.seeds.join(', ') || '-'}`,
    `nodes: ${graph.nodes.length} | edges: ${graph.edges.length} | cycles: ${graph.cycles.length} | orphans: ${graph.orphans.length}`,
    graph.readLayers.length ? `read layers: ${graph.readLayers.map((layer) => `[${layer.join(', ')}]`).join(' -> ')}` : 'read layers: -',
    graph.applyLayers.length
      ? `apply layers: ${graph.applyLayers.map((layer) => `[${layer.join(', ')}]`).join(' -> ')}`
      : 'apply layers: -',
    graph.cycles.length ? `cycles: ${graph.cycles.map((cycle) => `[${cycle.join(' -> ')}]`).join(', ')}` : 'cycles: -',
    graph.orphans.length ? `orphans: ${graph.orphans.join(', ')}` : 'orphans: -',
    graph.missing.length
      ? `missing: ${graph.missing.map((entry) => `${entry.via} -> ${entry.name} (${entry.relation})`).join(', ')}`
      : 'missing: -',
    '',
    'nodes:',
    nodeLines.length ? nodeLines.join('\n\n') : '(graph nodes 없음)',
    '',
    'edges:',
    edgeLines.length ? edgeLines.join('\n') : '(graph edges 없음)',
  ].join('\n')
}

/** graph action 결과를 구성합니다. */
export function buildGraphResult(index: IndexArtifacts, graph: SkillRelationGraph): SkillRegistryToolResult {
  const nodeLines = buildGraphResultNodeLines(graph)
  const edgeLines = buildGraphResultEdgeLines(graph)
  const details = buildGraphResultDetails(index, graph)

  return {
    content: [{ type: 'text', text: buildGraphResultText(graph, nodeLines, edgeLines) }],
    details,
  }
}

function buildAuditResultIssueLines(issues: SkillAuditReport['issues']): string[] {
  return issues.map((issue, idx) =>
    [
      `${idx + 1}. [${issue.severity}] ${issue.kind}`,
      `   message: ${issue.message}`,
      issue.skillName ? `   skill: ${issue.skillName}` : '',
      issue.path ? `   path: ${issue.path}` : '',
      issue.sourceKind ? `   sourceKind: ${issue.sourceKind}` : '',
      issue.relatedSkills?.length ? `   related: ${issue.relatedSkills.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function buildAuditResultTopInboundText(report: SkillAuditReport): string {
  return report.topInbound.length > 0
    ? report.topInbound.map((entry) => `${entry.name}(in=${entry.inbound}, out=${entry.outbound})`).join(', ')
    : '-'
}

function buildAuditResultTopOutboundText(report: SkillAuditReport): string {
  return report.topOutbound.length > 0
    ? report.topOutbound.map((entry) => `${entry.name}(out=${entry.outbound}, in=${entry.inbound})`).join(', ')
    : '-'
}

function buildAuditResultDetails(index: IndexArtifacts, report: SkillAuditReport): SkillRegistryToolResult['details'] {
  return {
    kind: 'audit',
    ok: report.ok,
    counts: report.counts,
    issues: report.issues,
    topInbound: report.topInbound,
    topOutbound: report.topOutbound,
    cycles: report.cycles,
    orphans: report.orphans,
    validate: report.validate,
    requestedNames: index.requestedNames,
    missingRequested: index.stats.missingFromRequested,
    nameFilterMode: index.stats.nameFilterMode,
  }
}

/** audit action 결과를 구성합니다. */
export function buildAuditResult(index: IndexArtifacts, report: SkillAuditReport): SkillRegistryToolResult {
  const issueLines = buildAuditResultIssueLines(report.issues)
  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry audit 결과 (${report.counts.totalSkills} skills)`,
          `ok: ${report.ok} | errors: ${report.counts.errors} | warnings: ${report.counts.warnings} | info: ${report.counts.info}`,
          `cycles: ${report.counts.cycles} | orphans: ${report.counts.orphans} | unresolved relations: ${report.counts.unresolvedRelations}`,
          `top outbound: ${buildAuditResultTopOutboundText(report)}`,
          `top inbound: ${buildAuditResultTopInboundText(report)}`,
          issueLines.length ? issueLines.join('\n\n') : 'audit finding 없음',
        ].join('\n'),
      },
    ],
    details: buildAuditResultDetails(index, report),
  }
}

/** validate action 결과를 구성합니다. */
export function buildValidateResult(index: IndexArtifacts, report: SkillValidationReport): SkillRegistryToolResult {
  const lines = report.issues.map((issue, idx) =>
    [
      `${idx + 1}. [${issue.severity}] ${issue.kind}`,
      `   message: ${issue.message}`,
      issue.skillName ? `   skill: ${issue.skillName}` : '',
      issue.path ? `   path: ${issue.path}` : '',
      issue.via ? `   via: ${issue.via}` : '',
      issue.target ? `   target: ${issue.target}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )

  return {
    content: [
      {
        type: 'text',
        text: [
          `skill_registry validate 결과 (${report.issues.length}건)`,
          `errors: ${report.counts.errors} | warnings: ${report.counts.warnings} | ok: ${report.ok}`,
          report.issues.length ? lines.join('\n\n') : 'validation issue 없음',
        ].join('\n'),
      },
    ],
    details: {
      kind: 'validate',
      ok: report.ok,
      counts: report.counts,
      issues: report.issues,
      requestedNames: index.requestedNames,
      missingRequested: index.stats.missingFromRequested,
      nameFilterMode: index.stats.nameFilterMode,
    },
  }
}

/** metrics action 결과를 구성합니다. */
export function buildMetricsResult(index: IndexArtifacts): SkillRegistryToolResult {
  const aggregation = buildMetricsResultAggregates(index)
  const sortedCategories = buildMetricsResultSortedCategories(aggregation.byCategory)
  const sortedScopes = buildMetricsResultSortedScopes(aggregation.byScope)
  const topTerms = buildMetricsResultTopTerms(index.dfByTerm)

  return {
    content: [{ type: 'text', text: buildMetricsResultText(index, aggregation, sortedCategories, sortedScopes, topTerms) }],
    details: buildMetricsResultDetails(index, aggregation, topTerms),
  }
}

function buildMetricsResultAggregates(index: IndexArtifacts) {
  const byCategory: Record<string, number> = {}
  let aliasBearingSkills = 0
  const relationCounts = { requires: 0, recommends: 0 }
  const byRoot: Record<string, number> = {}
  for (const skill of index.skills) {
    byCategory[skill.category || 'uncategorized'] = (byCategory[skill.category || 'uncategorized'] ?? 0) + 1
    if (skill.aliases.length > 0) {
      aliasBearingSkills += 1
    }
    relationCounts.requires += skill.requires.length
    relationCounts.recommends += skill.recommends.length
    byRoot[skill.sourceRoot] = (byRoot[skill.sourceRoot] ?? 0) + 1
  }
  const avgBodyLength =
    index.skills.length === 0 ? 0 : Math.round(index.skills.reduce((sum, skill) => sum + skill.bodyText.length, 0) / index.skills.length)
  const byScope = buildDeterministicScopeDistribution(
    index.skills,
    (index.stats as { scopeDistribution?: Record<string, number> }).scopeDistribution,
  )
  return { byCategory, aliasBearingSkills, relationCounts, byRoot, avgBodyLength, byScope }
}

function buildMetricsResultSortedCategories(byCategory: Record<string, number>): string {
  return Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([category, count]) => `${category}: ${count}`)
    .join(', ')
}

function buildMetricsResultSortedScopes(byScope: Record<string, number>): string[] {
  return Object.entries(byScope)
    .slice(0, 20)
    .map(([scope, count]) => `${scope}: ${count}`)
}

function buildMetricsResultTopTerms(dfByTerm: ReadonlyMap<string, number>): string {
  return Array.from(dfByTerm.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term, df]) => `${term}(${df})`)
    .join(', ')
}

function buildMetricsResultText(
  index: IndexArtifacts,
  aggregation: ReturnType<typeof buildMetricsResultAggregates>,
  sortedCategories: string,
  sortedScopes: string[],
  topTerms: string,
): string {
  return [
    'skill_registry metrics summary',
    `count: ${index.docCount}`,
    `nameFilterMode: ${index.stats.nameFilterMode}`,
    `missing requested: ${index.stats.missingFromRequested.length}`,
    `avg body length: ${aggregation.avgBodyLength}`,
    `avg token length: ${index.avgLength.toFixed(2)}`,
    `alias-bearing skills: ${aggregation.aliasBearingSkills}`,
    `relation edges: requires=${aggregation.relationCounts.requires}, recommends=${aggregation.relationCounts.recommends}`,
    `root distribution: ${Object.entries(aggregation.byRoot)
      .map(([root, count]) => `${path.basename(root)}=${count}`)
      .join(', ')}`,
    sortedCategories ? `top categories: ${sortedCategories}` : 'top categories: -',
    sortedScopes.length ? `top scopes: ${sortedScopes.join(', ')}` : 'top scopes: -',
    topTerms ? `top terms: ${topTerms}` : 'top terms: -',
    `index built at: ${new Date(index.generatedAt).toISOString()}`,
    `index build ms: ${index.indexBuildMs}`,
  ].join('\n')
}

function buildMetricsResultDetails(index: IndexArtifacts, aggregation: ReturnType<typeof buildMetricsResultAggregates>, topTerms: string) {
  return {
    kind: 'metrics',
    requestedNames: index.requestedNames,
    missingRequested: index.stats.missingFromRequested,
    nameFilterMode: index.stats.nameFilterMode,
    counts: {
      total: index.docCount,
      fileVisited: index.stats.totalFilesVisited,
      parsed: index.stats.totalParsed,
      skippedMissingRoot: index.stats.skippedMissingRoot,
      parseErrors: index.stats.parseErrors,
      deduplicated: index.stats.deduplicated,
      malformedFiles: index.stats.malformedFiles.length,
      aliasBearing: aggregation.aliasBearingSkills,
    },
    byCategory: aggregation.byCategory,
    byRoot: aggregation.byRoot,
    byScope: aggregation.byScope,
    relationCounts: aggregation.relationCounts,
    topTerms: topTerms ? topTerms.split(', ') : [],
    malformedFiles: index.stats.malformedFiles,
    indexBuildMs: index.indexBuildMs,
  }
}

/** 오류 tool result를 구성합니다. */
export function errorResult(message: string): SkillRegistryToolResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
  }
}
