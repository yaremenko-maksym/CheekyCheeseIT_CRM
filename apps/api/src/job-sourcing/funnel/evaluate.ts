import type { JobExclusionDto } from '@crm/shared'
import { findMatchingExclusion } from '../filtering'
import { classifyLayer1, RULE_VERSION, type Dimension, type Layer1Result } from './layer1'
import { rankScore, scopedMatchCount } from './rank'
import {
  forViewer,
  matchTech,
  type SeniorMatch,
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
  type Evaluated,
  type Excluded,
  type ExcludedEntry,
  type InvalidInputCode,
  type Reason,
  type ScopeProjection,
  type TraceEntry,
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
 */

const AVAILABILITIES: ReadonlySet<string> = new Set(['OPEN', 'CLOSED', 'EXPIRED', 'UNKNOWN'])
const CLOSED: ReadonlySet<string> = new Set(['CLOSED', 'EXPIRED'])

const reason = (
  code: string,
  evidence: [string, ...string[]],
  ruleVersion: string = EVALUATE_RULE_VERSION,
): Reason => ({ code, evidence, ruleVersion })

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (items: readonly string[]) => [...items].sort(byText)

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime())

const exclusionKey = (e: JobExclusionDto) =>
  [e.scope, e.kind, e.seniorId ?? '', e.id ?? '', e.normalizedValue, e.value].join('\u0000')

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

/** The evidence strings of one layer-1 dimension; an absence still names what was read. */
function dimensionEvidence(name: string, dimension: Dimension<unknown>): [string, ...string[]] {
  const lines = dimension.evidence
    .filter((e) => e.used)
    .map((e) => `${e.source}:${e.field}:${e.code}:${e.excerpt}`)
  return [`${name}=${JSON.stringify(dimension.value)}`, ...lines]
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

function emptyAudit(): EvaluationAudit {
  return { excluded: [], noTeamAccess: [], ignoredExclusionIds: [] }
}

function excludedBy(
  base: Pick<Excluded, 'recordKey' | 'opportunityId' | 'revisionId' | 'evaluatedAt'>,
  trace: TraceEntry[],
  entry: ExcludedEntry,
  audit: EvaluationAudit = emptyAudit(),
): Excluded {
  return {
    kind: 'EXCLUDED',
    ...base,
    reasons: entry.reasons,
    trace,
    audit: { ...audit, excluded: [entry, ...audit.excluded] },
  }
}

/** Stable order for every roster-shaped input, so shuffling arrays cannot change the output. */
function normalizeProfiles(profiles: readonly SeniorTechProfile[]): SeniorTechProfile[] {
  return profiles
    .map((p) => ({
      seniorId: p.seniorId,
      teamIds: sorted(p.teamIds),
      techStack: sorted(p.techStack),
    }))
    .sort((a, b) => byText(a.seniorId, b.seniorId))
}

const teamKey = (teamId: string) => `TEAM:${teamId}`
const seniorKey = (seniorId: string) => `SENIOR:${seniorId}`

function matchedSeniors(view: TechMatchView): SeniorMatch[] {
  return view.seniors.filter((s) => s.matches.length > 0)
}

interface ScopeSpec {
  scope: string
  view: TechMatchView
  /** May an unknown-stack posting reach this scope as TRIAGE? */
  triage: 'NEVER' | 'ALWAYS' | 'GRANTED'
  matchCount: number
}

function projectScope(spec: ScopeSpec): ScopeProjection | null {
  const matched = matchedSeniors(spec.view)
  const base = { scope: spec.scope, tech: spec.view, matchCount: matched.length }
  if (matched.length > 0) {
    const seen = new Map(matched.flatMap((s) => s.matches).map((m) => [m.keyword, m.strength]))
    const evidence = sorted([...seen].map(([keyword, strength]) => `${keyword}:${strength}`))
    return {
      ...base,
      status: 'LEAD',
      score: null,
      rankWarnings: [],
      reasons: [reason('TECH_MATCH', evidence as [string, ...string[]])],
    }
  }
  if (!spec.view.lowInformation || spec.triage === 'NEVER') return null
  const reasons = [reason('UNKNOWN_STACK', ['no tags, requirements or keyword hit'])]
  if (spec.triage === 'GRANTED') {
    reasons.push(reason('TEAM_TRIAGE_GRANT', [spec.scope]))
  }
  return { ...base, status: 'TRIAGE', score: null, rankWarnings: [], reasons }
}

function buildSpecs(
  tech: TechMatchReady,
  profiles: readonly SeniorTechProfile[],
  grants: ReadonlySet<string>,
): ScopeSpec[] {
  const view = (ids: readonly string[]) => forViewer(tech, { visibleSeniorIds: ids })
  const matchable = new Set(tech.matchableSeniorIds)
  const members = new Map<string, string[]>()
  for (const p of profiles.filter((q) => matchable.has(q.seniorId))) {
    for (const teamId of p.teamIds)
      members.set(teamId, [...(members.get(teamId) ?? []), p.seniorId])
  }
  const count = (v: TechMatchView) => matchedSeniors(v).length
  const specs: ScopeSpec[] = tech.matchableSeniorIds.map((id) => {
    const v = view([id])
    return { scope: seniorKey(id), view: v, triage: 'NEVER', matchCount: count(v) }
  })
  for (const [teamId, ids] of members) {
    const v = view(ids)
    specs.push({
      scope: teamKey(teamId),
      view: v,
      triage: grants.has(teamId) ? 'GRANTED' : 'NEVER',
      matchCount: count(v),
    })
  }
  const studio = view(tech.matchableSeniorIds)
  specs.push({ scope: 'STUDIO', view: studio, triage: 'ALWAYS', matchCount: count(studio) })
  return specs
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
  const closed = CLOSED.has(revision.availability)
  const hard = [
    ...(closed ? [reason('AVAILABILITY_CLOSED', [`availability=${revision.availability}`])] : []),
    ...layer1Rejections(layer1),
  ]
  if (hard.length > 0) {
    const inputs = { availability: revision.availability, rejectedBy: layer1.rejectedBy }
    return excludedBy(base, trace, {
      subject: 'OPPORTUNITY',
      stage: 'CLASSIFICATION',
      reasons: hard,
      inputs,
    })
  }

  // Inputs the caller could not load: retried, never filtered.
  const unavailable = sorted(input.unavailable ?? []) as NonNullable<
    typeof input.unavailable
  >[number][]
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

  const exclusions = [...input.exclusions].sort((a, b) => byText(exclusionKey(a), exclusionKey(b)))
  const posting = {
    companyName: revision.companyName,
    title: revision.fields.title,
    ...(revision.sourceType === undefined ? {} : { sourceType: revision.sourceType }),
    ...(revision.url === undefined ? {} : { url: revision.url }),
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
  const profiles = normalizeProfiles(input.profiles)
  const tech = matchTech({
    posting: {
      ...posting,
      // `invalidRevision` required an array.
      tags: revision.fields.tags as string[],
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
  const excludedSeniors: ExcludedEntry[] = tech.audit.excluded
    .map((e) => ({
      subject: seniorKey(e.seniorId),
      stage: 'SCOPED_RESTRICTIONS' as const,
      reasons: [
        reason('SENIOR_EXCLUSION', [`${e.exclusionScope}:${e.exclusionKind}:${e.exclusionId}`]),
      ],
      inputs: { ...e },
    }))
    .sort((a, b) => byText(a.subject, b.subject))
  const audit: EvaluationAudit = {
    excluded: excludedSeniors,
    noTeamAccess: sorted(tech.audit.noTeamAccess),
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

  // 6. Projections per scope.
  enter('PROJECTIONS')
  const specs = buildSpecs(tech, profiles, new Set(input.teamTriageGrants))
  const projections = specs
    .map((spec) => projectScope(spec))
    .filter((p): p is ScopeProjection => p !== null)
    .sort((a, b) => byText(a.scope, b.scope))

  // 7. Score, LEAD only.
  if (projections.some((p) => p.status === 'LEAD')) enter('SCORE')
  const scored = projections.map((p) => {
    if (p.status !== 'LEAD') return p
    const matchCount =
      p.scope === 'STUDIO'
        ? scopedMatchCount('ADMIN', { authorizedTeam: 0, studio: p.matchCount })
        : scopedMatchCount('HR', { authorizedTeam: p.matchCount, studio: 0 })
    const rank = rankScore({
      evaluationTime: input.evaluationTime,
      trustedPublishedAt: revision.trustedPublishedAt,
      firstSeenAt: revision.firstSeenAt,
      firstSeenKind: revision.firstSeenKind,
      matchCount,
      unknownSeniority: layer1.seniority.value === 'UNKNOWN',
      unknownStack: p.tech.lowInformation,
      unknownRemote: layer1.workplace.value === 'UNKNOWN',
    })
    return { ...p, score: rank.score, rankWarnings: rank.warnings }
  })

  const studio = scored.find((p) => p.scope === 'STUDIO')
  const result: Evaluated = {
    kind: 'EVALUATED',
    ...base,
    status: studio?.status ?? 'NO_MATCH',
    layer1,
    projections: scored,
    trace,
    audit,
  }
  return result
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
