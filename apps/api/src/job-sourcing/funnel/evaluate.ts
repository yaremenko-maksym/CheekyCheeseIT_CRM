import { findMatchingExclusion } from '../filtering'
import { classifyLayer1, RULE_VERSION, type Dimension, type Layer1Result } from './layer1'
import { rankScore } from './rank'
import {
  forViewer,
  matchTech,
  type SeniorTechProfile,
  type TechMatchReady,
  type TechMatchView,
} from './tech-match'
import {
  EVALUATE_RULE_VERSION,
  type BatchEntry,
  type CanonicalRevision,
  type EvaluateInput,
  type EvaluationAudit,
  type EvaluationResult,
  type EvaluationStage,
  type Excluded,
  type ExcludedEntry,
  type InvalidInputCode,
  type Reason,
  type ScopeProjection,
  type TraceEntry,
  type UnavailableInput,
  type Viewer,
} from './evaluate.types'

export * from './evaluate.types'

/**
 * `evaluate` (Task 4.4): composes layer 1, exclusions, tech match and rank into one pure,
 * synchronous verdict per canonical revision. No I/O, no clock (the evaluation time is an input),
 * no network or model.
 *
 * Order, recorded in `trace`: REVISION, CLASSIFICATION, GLOBAL_RESTRICTIONS, SCOPED_RESTRICTIONS,
 * SKILL_SIGNALS, PROJECTIONS, SCORE (LEAD only). A hard negative (closed or expired posting, a
 * layer-1 REJECT, a matching exclusion) ends the evaluation EXCLUDED at its own stage; later
 * unknowns cannot reopen it. Entity resolution is upstream, so the roster cannot change a
 * classification.
 *
 * VISIBILITY. HR sees an item only through the projection of their OWN team, which exists only
 * when a senior of that team matches (LEAD) or the team holds an explicit triage grant for an
 * unknown-stack posting. There is no global unknown pool; ADMIN reads `STUDIO`.
 *
 * COUNTS. A projection's `matchCount` is the number of seniors of THAT scope who match, taken
 * from the viewer-shaped `forViewer` result, so it is scoped by construction; `scopedMatchCount`
 * (a role gate over two counts) has nothing left to decide here and is not used.
 */

const AVAILABILITIES: ReadonlySet<string> = new Set(['OPEN', 'CLOSED', 'EXPIRED', 'UNKNOWN'])
const CLOSED: ReadonlySet<string> = new Set(['CLOSED', 'EXPIRED'])

const reason = (
  code: string,
  evidence: [string, ...string[]],
  ruleVersion: string = EVALUATE_RULE_VERSION,
): Reason => ({ code, evidence, ruleVersion })

/** Code-unit order, the same on every machine. */
const sorted = (items: readonly string[]) => [...items].sort()

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime())

/** Order-insensitive normal form of a JSON value: sorting the serialised items needs no comparator. */
const inCanonicalOrder = <T>(items: readonly T[]): T[] =>
  items
    .map((item) => JSON.stringify(item))
    .sort()
    .map((json) => JSON.parse(json) as T)

function invalidRevision(revision: CanonicalRevision | null): InvalidInputCode | null {
  if (revision === null || revision === undefined) return 'MISSING_REVISION'
  const text = (v: unknown) => typeof v === 'string' && v !== ''
  const wellFormed =
    text(revision.opportunityId) &&
    text(revision.revisionId) &&
    typeof revision.companyName === 'string' &&
    typeof revision.fields?.title === 'string' &&
    Array.isArray(revision.fields.tags) &&
    AVAILABILITIES.has(revision.availability) &&
    isValidDate(revision.firstSeenAt)
  return wellFormed ? null : 'INVALID_REVISION'
}

/** The dimension's value and every piece of evidence it rests on. */
function dimensionEvidence(name: string, dimension: Dimension<unknown>): [string, ...string[]] {
  return [
    `${name}=${JSON.stringify(dimension.value)}`,
    ...dimension.evidence.map((e) => `${e.source}:${e.field}:${e.code}:${e.excerpt}`),
  ]
}

function layer1Rejections(layer1: Layer1Result): Reason[] {
  const dimensions = layer1 as unknown as Record<string, Dimension<unknown>>
  return layer1.rejectedBy.map((name) =>
    reason(
      'LAYER1_REJECT',
      dimensionEvidence(name, dimensions[name] as Dimension<unknown>),
      layer1.ruleVersion,
    ),
  )
}

function excludedBy(
  base: Pick<Excluded, 'recordKey' | 'opportunityId' | 'revisionId' | 'evaluatedAt'>,
  trace: TraceEntry[],
  entry: ExcludedEntry,
  audit: Omit<EvaluationAudit, 'excluded'> = { noTeamAccess: [], ignoredExclusionIds: [] },
): Excluded {
  return {
    kind: 'EXCLUDED',
    ...base,
    reasons: entry.reasons,
    trace,
    audit: { ...audit, excluded: [entry] },
  }
}

const teamKey = (teamId: string) => `TEAM:${teamId}`
const seniorKey = (seniorId: string) => `SENIOR:${seniorId}`

interface Scope {
  key: string
  view: TechMatchView
  /** May an unknown-stack posting reach this scope as TRIAGE? */
  triage: boolean
}

/**
 * Scopes in `scope`-key order by construction: `SENIOR:` < `STUDIO` < `TEAM:` (E < T), seniors
 * and teams each ascending. Team membership comes from the MATCHABLE seniors only, so an
 * excluded senior can never create a team scope.
 */
function buildScopes(
  tech: TechMatchReady,
  profiles: readonly SeniorTechProfile[],
  grants: ReadonlySet<string>,
  studioUnknown: boolean,
): { seniors: Scope[]; studio: Scope; teams: Scope[] } {
  const view = (ids: readonly string[]) => forViewer(tech, { visibleSeniorIds: ids })
  const teamsOf = new Map(profiles.map((p) => [p.seniorId, p.teamIds]))
  const members = new Map<string, string[]>()
  for (const seniorId of tech.matchableSeniorIds) {
    for (const teamId of teamsOf.get(seniorId) as readonly string[]) {
      const list = members.get(teamId)
      if (list) list.push(seniorId)
      else members.set(teamId, [seniorId])
    }
  }
  return {
    seniors: tech.matchableSeniorIds.map((id) => ({
      key: seniorKey(id),
      view: view([id]),
      triage: false,
    })),
    studio: { key: 'STUDIO', view: view(tech.matchableSeniorIds), triage: true },
    teams: [...members.keys()].sort().map((teamId) => ({
      key: teamKey(teamId),
      view: view(members.get(teamId) as string[]),
      triage: studioUnknown && grants.has(teamId),
    })),
  }
}

interface ProjectionContext {
  layer1: Layer1Result
  revision: CanonicalRevision
  evaluationTime: Date
  /** U10: the stack is unknown because the detail is pending — triage, never a stack exclusion. */
  detailPending: boolean
}

function projectScope(scope: Scope, ctx: ProjectionContext): ScopeProjection | null {
  const matched = scope.view.seniors.filter((s) => s.matches.length > 0)
  const base = { scope: scope.key, tech: scope.view, matchCount: matched.length }
  if (matched.length > 0) {
    const keywords = new Set(
      matched.flatMap((s) => s.matches).map((m) => `${m.keyword}:${m.strength}`),
    )
    const rank = rankScore({
      evaluationTime: ctx.evaluationTime,
      trustedPublishedAt: ctx.revision.trustedPublishedAt,
      firstSeenAt: ctx.revision.firstSeenAt,
      firstSeenKind: ctx.revision.firstSeenKind,
      matchCount: matched.length,
      unknownSeniority: ctx.layer1.seniority.value === 'UNKNOWN',
      // A LEAD has a keyword hit, so its stack is known.
      unknownStack: false,
      unknownRemote: ctx.layer1.workplace.value === 'UNKNOWN',
    })
    return {
      ...base,
      status: 'LEAD',
      score: rank.score,
      rankWarnings: rank.warnings,
      reasons: [reason('TECH_MATCH', sorted([...keywords]) as [string, ...string[]])],
    }
  }
  // TRIAGE needs the studio-level posting to be unknown-stack, the scope's own view to hold a
  // matchable senior, and for a team the grant. The stack is unknown either because the list
  // carries no signal (`lowInformation`) or because the detail that would carry it is pending
  // (U10) AND the list offered no stack-judging signal of its own: a department tag alone makes
  // `lowInformation` false but does not judge the stack, so a detail-pending record is still
  // unknown-stack. A keyword hit or a requirements statement, by contrast, IS a verdict — then a
  // `coreMismatch` is genuine and must win, so `detailPending` does not lift it to TRIAGE. (A LEAD
  // is already returned above, so `detailPending` can never downgrade one.)
  const detailUnjudged =
    ctx.detailPending &&
    !scope.view.evidenceSurfaces.keywordHit &&
    !scope.view.evidenceSurfaces.requirements
  const stackUnknown = scope.view.lowInformation || detailUnjudged
  if (!stackUnknown || !scope.triage) return null
  const unknownStack = scope.view.lowInformation
    ? reason('UNKNOWN_STACK', ['no tags, requirements or keyword hit'])
    : reason('UNKNOWN_STACK', ['detail pending: description not loaded'])
  return {
    ...base,
    status: 'TRIAGE',
    score: null,
    rankWarnings: [],
    reasons: [
      unknownStack,
      ...(scope.key.startsWith('TEAM:') ? [reason('TEAM_TRIAGE_GRANT', [scope.key])] : []),
    ],
  }
}

export function evaluate(input: EvaluateInput): EvaluationResult {
  const { recordKey } = input
  const code = !isValidDate(input.evaluationTime)
    ? 'INVALID_EVALUATION_TIME'
    : invalidRevision(input.revision)
  if (code !== null) return { kind: 'INVALID_INPUT', recordKey, code, trace: [] }
  // Validated above: `revision` is present and well formed.
  const revision = input.revision as CanonicalRevision

  const trace: TraceEntry[] = []
  const enter = (stage: EvaluationStage, ruleVersion: string = EVALUATE_RULE_VERSION) =>
    trace.push({ stage, ruleVersion })
  const base = {
    recordKey,
    opportunityId: revision.opportunityId,
    revisionId: revision.revisionId,
    evaluatedAt: input.evaluationTime.toISOString(),
  }
  enter('REVISION')

  // 2. Classification and availability.
  const layer1 = classifyLayer1(revision.fields, {
    ruleVersion: RULE_VERSION,
    evaluationTime: input.evaluationTime,
  })
  enter('CLASSIFICATION', layer1.ruleVersion)
  const hard = [
    ...(CLOSED.has(revision.availability)
      ? [reason('AVAILABILITY_CLOSED', [`availability=${revision.availability}`])]
      : []),
    ...layer1Rejections(layer1),
  ]
  if (hard.length > 0) {
    return excludedBy(base, trace, {
      subject: 'OPPORTUNITY',
      stage: 'CLASSIFICATION',
      reasons: hard,
      inputs: { availability: revision.availability, rejectedBy: layer1.rejectedBy },
    })
  }

  // Inputs the caller could not load: retried, never filtered.
  const unavailable = sorted(input.unavailable) as UnavailableInput[]
  if (unavailable.length > 0) {
    return {
      kind: 'RETRYABLE',
      recordKey,
      code: 'INPUT_UNAVAILABLE',
      unavailable,
      readiness: [],
      trace,
    }
  }

  const exclusions = inCanonicalOrder(input.exclusions)
  const posting = {
    companyName: revision.companyName,
    title: revision.fields.title,
    sourceType: revision.sourceType,
    url: revision.url,
  }

  // 3. Studio-wide restrictions. Global COMPANY entries are unused by decision A1g (see tech-match).
  enter('GLOBAL_RESTRICTIONS')
  const globalHit = findMatchingExclusion(
    posting,
    exclusions.filter((e) => e.scope === 'GLOBAL' && e.kind === 'KEYWORD'),
  )
  if (globalHit) {
    return excludedBy(base, trace, {
      subject: 'OPPORTUNITY',
      stage: 'GLOBAL_RESTRICTIONS',
      reasons: [reason('GLOBAL_EXCLUSION', [`${globalHit.kind}:${globalHit.value}`])],
      inputs: { exclusion: globalHit },
    })
  }

  // 4 and 5. Per-senior restrictions, then skill signals: one call, recorded as two stages.
  enter('SCOPED_RESTRICTIONS')
  const profiles = inCanonicalOrder(
    input.profiles.map((p) => ({
      seniorId: p.seniorId,
      teamIds: sorted([...new Set(p.teamIds)]),
      techStack: sorted(p.techStack),
    })),
  )
  const tech = matchTech({
    posting: {
      ...posting,
      tags: revision.fields.tags as string[], // `invalidRevision` required an array
      body: revision.fields.descriptionMd,
    },
    rosterSeniorIds: sorted(input.rosterSeniorIds),
    profiles,
    exclusions,
  })
  if (tech.status === 'READINESS_ISSUE') {
    return {
      kind: 'RETRYABLE',
      recordKey,
      code: 'ROSTER_NOT_READY',
      unavailable: [],
      readiness: tech.issues,
      trace,
    }
  }
  // `tech.audit.excluded` follows the profile order, which is sorted by senior id.
  const excludedSeniors: ExcludedEntry[] = tech.audit.excluded.map((e) => ({
    subject: seniorKey(e.seniorId),
    stage: 'SCOPED_RESTRICTIONS',
    reasons: [
      reason('SENIOR_EXCLUSION', [`${e.exclusionScope}:${e.exclusionKind}:${e.exclusionId}`]),
    ],
    inputs: { ...e },
  }))
  const audit: EvaluationAudit = {
    excluded: excludedSeniors,
    noTeamAccess: tech.audit.noTeamAccess,
    ignoredExclusionIds: sorted(tech.audit.ignoredExclusionIds),
  }
  if (tech.matchableSeniorIds.length === 0 && excludedSeniors.length > 0) {
    return {
      kind: 'EXCLUDED',
      ...base,
      reasons: excludedSeniors.flatMap((e) => e.reasons),
      trace,
      audit,
    }
  }
  enter('SKILL_SIGNALS')

  // 6. Projections per scope (and, for a LEAD, 7. the scope score).
  enter('PROJECTIONS')
  // shortcut: roster, exclusions and profiles are sorted per record; the roster is small (tens of
  // seniors), so hoisting this out of `evaluateBatch` is deferred until a roster of thousands.
  // shortcut: `buildScopes` calls `forViewer` once per senior, per team and for the studio, each
  // re-filtering the senior list: O(S * (S + T)) per record. Fine for tens of seniors; upgrade
  // (one pass bucketed by senior id) when the roster grows past a few hundred.
  const detailPending = input.detailPending === true
  const ctx = { layer1, revision, evaluationTime: input.evaluationTime, detailPending }
  // Team triage follows the studio: a detail-pending posting is unknown-stack for the studio only
  // when the list gave the studio no stack-judging signal either (no union keyword hit, no
  // requirements). A real studio verdict (a hit or a requirements statement) keeps grants closed.
  const studioUnjudged =
    detailPending && !tech.evidenceSurfaces.keywordHit && !tech.evidenceSurfaces.requirements
  const scopes = buildScopes(
    tech,
    profiles,
    new Set(input.teamTriageGrants),
    tech.lowInformation || studioUnjudged,
  )
  const studio = projectScope(scopes.studio, ctx)
  const projections = [
    ...scopes.seniors.map((scope) => projectScope(scope, ctx)),
    studio,
    ...scopes.teams.map((scope) => projectScope(scope, ctx)),
  ].filter((p): p is ScopeProjection => p !== null)
  if (projections.some((p) => p.status === 'LEAD')) enter('SCORE')

  return {
    kind: 'EVALUATED',
    ...base,
    status: studio?.status ?? 'NO_MATCH',
    layer1,
    projections,
    trace,
    audit,
  }
}

/** One entry per input, in input order. A malformed or throwing record fails alone. */
export function evaluateBatch(inputs: readonly EvaluateInput[]): BatchEntry[] {
  return inputs.map((input, index): BatchEntry => {
    const key =
      typeof input?.recordKey === 'string' && input.recordKey !== '' ? input.recordKey : null
    if (key === null) {
      return { kind: 'RECORD_FAILED', recordKey: `#${index}`, code: 'MALFORMED_RECORD' }
    }
    try {
      return evaluate(input)
    } catch {
      return { kind: 'RECORD_FAILED', recordKey: key, code: 'EVALUATION_THREW' }
    }
  })
}

/**
 * What a viewer may read. HR: the projection of their OWN team only (none without a team, none
 * when no senior of that team is relevant). ADMIN: the studio view. Any other role fails closed.
 * The audit, and with it every excluded payload, is never part of the answer.
 */
export function projectionsForViewer(result: BatchEntry, viewer: Viewer): ScopeProjection[] {
  if (result.kind !== 'EVALUATED') return []
  let wanted: string | null = null
  if (viewer.role === 'ADMIN') wanted = 'STUDIO'
  else if (viewer.role === 'HR' && viewer.teamId) wanted = teamKey(viewer.teamId)
  return result.projections.filter((p) => p.scope === wanted)
}
