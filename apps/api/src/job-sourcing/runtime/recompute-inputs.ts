import { createHash } from 'node:crypto'
import type { JobExclusionDto, JobSourceType } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { type SeniorProjectRow, deriveProjectExclusions, manualExclusionDto } from '../filtering'
import { DETAIL_FETCH } from '../ownership/dirty-work.store'
import {
  type Availability,
  type CanonicalRevision,
  EVALUATE_RULE_VERSION,
  type Evaluated,
  type Excluded,
} from '../funnel/evaluate'
import { RULE_VERSION } from '../funnel/layer1'
import type { Layer1Input } from '../funnel/layer1'
import type { SeniorTechProfile } from '../funnel/tech-match'
import type { ObservedDate } from '../normalize/date-policy'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * The recompute worker's database side (r5 Task 4.6 S4a): what `evaluate` needs, read from the
 * canonical store and the roster, and how its verdict is installed as `job_opportunity_matches`.
 * The orchestration (claim, failure classes, fencing, yield) is in `recompute-worker.ts`.
 *
 * NO DATE WINDOW. An opportunity is loaded by id whatever its age or claim state: active and
 * claimed opportunities are recomputed regardless of when they were first seen (plan Task 4.6).
 */

/** Matches carry the rule versions of both stages, so a layer-1 rule change also stales a row. */
export const MATCH_RULE_VERSION = `${EVALUATE_RULE_VERSION}+${RULE_VERSION}`

type Row = Record<string, unknown>

/**
 * A per-record failure the data itself causes: retrying cannot help. Defined here (the worker
 * re-exports it) so the install step can raise it without an import cycle.
 */
export class RecomputePoisonError extends Error {
  constructor(readonly code: string) {
    super(`recompute refused the record: ${code}`)
    this.name = 'RecomputePoisonError'
  }
}

/** A senior's input versions, as stored on each of their match rows. */
export interface SeniorVersions {
  readonly profile: string
  readonly exclusion: string
}

/**
 * The roster `evaluate` matches against, read inside the install transaction after the
 * opportunity lock (SR-M-1). `versions` is computed once per load, not per match row (CR-M-3).
 */
export interface RosterInputs {
  readonly rosterSeniorIds: readonly string[]
  readonly profiles: readonly SeniorTechProfile[]
  readonly exclusions: readonly JobExclusionDto[]
  readonly versions: ReadonlyMap<string, SeniorVersions>
}

/** One opportunity at its current revision, shaped for `evaluate`. */
/** SFS U10 (ADR 6a): a backing ON_DEMAND record awaiting its detail — the enqueue target. */
export interface OnDemandMissing {
  readonly recordId: string
  /** The record's current `observation_seq`: the DETAIL_FETCH row's `target_version`. */
  readonly version: number
}

export interface LoadedOpportunity {
  readonly revision: number
  readonly canonical: CanonicalRevision
  /** Teams holding an unrevoked, unexpired triage grant for this opportunity. */
  readonly teamTriageGrants: readonly string[]
  /**
   * SFS U10: the description is absent because a backing ON_DEMAND record's detail is still expected
   * (not yet fetched, not FAILED). `evaluate` reads this so such a posting is never EXCLUDED on stack
   * grounds (AC7). False when no source is ON_DEMAND (`onDemandTypes` empty, the pre-U10 default).
   */
  readonly detailPending: boolean
  /** The backing ON_DEMAND records lacking a description and not FAILED: the DETAIL_FETCH targets. */
  readonly onDemandMissing: readonly OnDemandMissing[]
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * Seniors who can be matched: role SENIOR, not archived, an active member of a team (the legacy
 * `findEligibleSeniorIds` rule), with their stack and teams; and every exclusion that applies to
 * any of them: studio-wide rows, their own rows, and the ones derived from their projects.
 */
export async function loadRoster(db: SqlExecutor): Promise<RosterInputs> {
  const { rows } = await db.execute(
    sql`SELECT u.id, u.tech_stack, array_agg(DISTINCT tm.team_id::text) AS team_ids
          FROM users u JOIN team_members tm ON tm.user_id = u.id AND tm.left_at IS NULL
         WHERE u.role = 'SENIOR' AND u.archived_at IS NULL
         GROUP BY u.id ORDER BY u.id`,
  )
  const profiles: SeniorTechProfile[] = rows.map((r) => ({
    seniorId: String(r['id']),
    teamIds: strings(r['team_ids']).sort(),
    techStack: strings(r['tech_stack']),
  }))
  const ids = profiles.map((p) => p.seniorId)
  if (ids.length === 0)
    return { rosterSeniorIds: [], profiles, exclusions: [], versions: new Map() }
  const roster = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`
  const { rows: manual } = await db.execute(
    sql`SELECT id, senior_id, kind, value, normalized_value, created_at FROM job_exclusion_filters
         WHERE senior_id IS NULL OR senior_id IN ${roster} ORDER BY id`,
  )
  const { rows: owned } = await db.execute(
    sql`SELECT senior_id, name, company_name, archived_at FROM projects
         WHERE senior_id IN ${roster} ORDER BY id`,
  )
  // One pass over the projects, grouped by senior: O(seniors + projects), not their product.
  const projectsOf = new Map<string, SeniorProjectRow[]>()
  for (const p of owned) {
    const seniorId = String(p['senior_id'])
    const row: SeniorProjectRow = {
      name: String(p['name']),
      companyName: String(p['company_name']),
      // Stryker disable next-line all: carried for the row type only; `deriveProjectExclusions` never reads it (archived projects still exclude).
      archivedAt: p['archived_at'] == null ? null : instant(p['archived_at']),
    }
    const list = projectsOf.get(seniorId)
    if (list === undefined) projectsOf.set(seniorId, [row])
    else list.push(row)
  }
  // Only seniors with projects derive anything; the query already limits them to the roster.
  const derived = [...projectsOf].flatMap(([id, rows]) => deriveProjectExclusions(id, rows))
  const stored = manual.map((r) =>
    manualExclusionDto({
      id: String(r['id']),
      seniorId: r['senior_id'] == null ? null : String(r['senior_id']),
      kind: r['kind'] as JobExclusionDto['kind'],
      value: String(r['value']),
      normalizedValue: String(r['normalized_value']),
      createdAt: instant(r['created_at']),
    }),
  )
  const exclusions = [...stored, ...derived]
  return {
    rosterSeniorIds: ids,
    profiles,
    exclusions,
    versions: rosterVersions(profiles, exclusions),
  }
}

/** A timestamp as the driver returns it (a `Date`, or text when its parser is overridden). */
const instant = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))

/** JSON dates back to `ObservedDate`: an OK date gets its instant back as a `Date`. */
function reviveDates(v: unknown): ObservedDate[] {
  if (!Array.isArray(v)) return []
  return v.map((d: Row) =>
    d['status'] === 'OK'
      ? ({ ...d, value: new Date(String(d['value'])) } as ObservedDate)
      : ({ ...d, value: null } as ObservedDate),
  )
}

/**
 * The representative revision: the one the canonical title was taken from, else the latest
 * revision of the lowest-id active member. It supplies what the canonical row does not keep
 * (remote, employment type, seniority hint, dates, evidence, source type).
 */
const REPRESENTATIVE = sql`
  SELECT v.normalized, v.evidence, r.source_type, r.source_url
    FROM (SELECT 0 AS prio, CASE WHEN jsonb_typeof(o.field_revisions->'title') = 'string'
                                 THEN (o.field_revisions->>'title')::uuid END AS revision_id,
                 NULL::uuid AS record_id
          UNION ALL
          SELECT 1, r2.latest_revision_id, r2.id
            FROM job_opportunity_sources s JOIN job_source_records r2 ON r2.id = s.source_record_id
           WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL) c
    JOIN job_source_record_revisions v ON v.id = c.revision_id
    JOIN job_source_records r ON r.id = v.source_record_id
   ORDER BY c.prio, c.record_id
   LIMIT 1`

/**
 * U10 (ADR 6a): the backing ON_DEMAND records whose current revision has no description and whose
 * current-version DETAIL_FETCH row has NOT settled — the enqueue targets, and the reason the
 * opportunity is `detailPending`. A row at the current version is settled once it is DONE, DEFERRED
 * or FAILED (CR-M-3 / SPEC-M-3): a successful fetch that carried a description writes a new revision
 * (so `description_sha256 IS NULL` is already false), but a 404 GONE or an empty-description detail
 * leaves no description, yet must STOP being detail-pending — otherwise the opportunity would be
 * perpetually lifted off stack exclusion and never resolved. A PENDING/CLAIMED row (fetch not yet
 * settled) still counts. Empty expression when no type is ON_DEMAND (the pre-U10 default), so the
 * query costs nothing until a source is flipped.
 */
function onDemandMissingExpr(onDemandTypes: readonly JobSourceType[]): SQL {
  if (onDemandTypes.length === 0) return sql`'[]'::jsonb`
  const types = sql.join(
    onDemandTypes.map((t) => sql`${t}::job_source_type`),
    sql`, `,
  )
  return sql`COALESCE((
    SELECT jsonb_agg(jsonb_build_object('recordId', r.id, 'version', h.observation_seq) ORDER BY r.id)
      FROM job_opportunity_sources s
      JOIN job_source_records r ON r.id = s.source_record_id
      JOIN job_source_record_heads h ON h.source_record_id = r.id
      JOIN job_source_record_revisions v ON v.id = h.latest_revision_id
     WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL
       AND r.source_type IN (${types})
       AND v.description_sha256 IS NULL
       AND NOT EXISTS (SELECT 1 FROM job_dirty_work d
                        WHERE d.entity_kind = 'SOURCE_RECORD' AND d.entity_id = r.id
                          AND d.reason = ${DETAIL_FETCH} AND d.target_version = h.observation_seq
                          AND d.status IN ('DONE', 'DEFERRED', 'FAILED'))), '[]'::jsonb)`
}

function parseOnDemandMissing(value: unknown): OnDemandMissing[] {
  if (!Array.isArray(value)) return []
  return value.map((r) => ({
    recordId: String((r as Row)['recordId']),
    version: Number((r as Row)['version']),
  }))
}

/** The opportunity at its current revision, or null when it does not exist. */
export async function loadOpportunity(
  db: SqlExecutor,
  opportunityId: string,
  onDemandTypes: readonly JobSourceType[] = [],
): Promise<LoadedOpportunity | null> {
  const { rows } = await db.execute(
    sql`SELECT o.id, o.revision, o.title, o.employer_name, o.location, o.stack_keywords,
               o.application_url, o.availability, o.first_seen_at, b.text AS description,
               rep.normalized, rep.evidence, rep.source_type, rep.source_url,
               ${onDemandMissingExpr(onDemandTypes)} AS on_demand_missing,
               ARRAY(SELECT t.team_id::text FROM job_opportunity_team_triage t
                      WHERE t.opportunity_id = o.id AND t.revoked_at IS NULL
                        AND t.expires_at > clock_timestamp() ORDER BY t.team_id) AS grants
          FROM job_opportunities o
          LEFT JOIN job_text_blobs b ON b.sha256 = o.description_sha256
          LEFT JOIN LATERAL (${REPRESENTATIVE}) rep ON true
         WHERE o.id = ${opportunityId}::uuid`,
  )
  const o = rows[0]
  if (o === undefined) return null
  const n = (o['normalized'] ?? {}) as Row
  const dates = reviveDates(n['dates'])
  const published = dates.find((d) => d.semantics === 'PUBLISHED' && d.status === 'OK')
  const evidence = (o['evidence'] as Row | null)?.['fields']
  const fields: Layer1Input = {
    title: String(o['title']),
    location: (o['location'] as string | null) ?? null,
    descriptionMd: (o['description'] as string | null) ?? '',
    remote: (n['remote'] ?? null) as Exclude<Layer1Input['remote'], undefined>,
    employmentType: (n['employmentType'] ?? null) as Exclude<
      Layer1Input['employmentType'],
      undefined
    >,
    seniorityHint: (n['seniorityHint'] ?? null) as Exclude<Layer1Input['seniorityHint'], undefined>,
    tags: strings(o['stack_keywords']),
    dates,
    ...(Array.isArray(evidence)
      ? { evidence: evidence as NonNullable<Layer1Input['evidence']> }
      : {}),
  }
  const revision = Number(o['revision'])
  const onDemandMissing = parseOnDemandMissing(o['on_demand_missing'])
  return {
    revision,
    teamTriageGrants: strings(o['grants']),
    detailPending: onDemandMissing.length > 0,
    onDemandMissing,
    canonical: {
      opportunityId,
      revisionId: String(revision),
      companyName: (o['employer_name'] as string | null) ?? '',
      url: (o['application_url'] as string | null) ?? (o['source_url'] as string | null) ?? '',
      sourceType: (o['source_type'] as string | null) ?? '',
      fields,
      availability: String(o['availability']) as Availability,
      firstSeenAt: instant(o['first_seen_at']),
      // shortcut: every opportunity is NORMAL; INITIAL_SWEEP arrives with the initial-sweep task.
      firstSeenKind: 'NORMAL',
      trustedPublishedAt: published?.status === 'OK' ? published.value : null,
    },
  }
}

export type MatchOutcome = 'LEAD' | 'TRIAGE' | 'EXCLUDED'

export interface MatchRow {
  readonly seniorId: string
  readonly outcome: MatchOutcome
  readonly evidence: Record<string, unknown>
}

const SENIOR = 'SENIOR:'

/**
 * Per-senior rows of a verdict. LEAD: a senior scope that matched. EXCLUDED: a senior removed by
 * an exclusion, or — for an opportunity-level exclusion (closed, layer-1 reject, global
 * exclusion) — every roster senior. A plain mismatch is no row. An EXCLUDED entry is never
 * overwritten by a projection (SR-L-1).
 *
 * NOT PERSISTED IN S4a (SPEC-M-1): the STUDIO and TEAM projections — including a TEAM-scope
 * TRIAGE from a triage grant — are deliberately dropped here; this table is per senior. The
 * queue reader task (and S5's invalidation) must derive them from the verdict on read; until
 * then nothing serves them.
 */
export function matchRows(result: Evaluated | Excluded, roster: RosterInputs): MatchRow[] {
  const rows = new Map<string, MatchRow>()
  for (const e of result.audit.excluded) {
    const evidence = { stage: e.stage, reasons: e.reasons }
    if (e.subject.startsWith(SENIOR)) {
      const seniorId = e.subject.slice(SENIOR.length)
      rows.set(seniorId, { seniorId, outcome: 'EXCLUDED', evidence })
    } else {
      for (const seniorId of roster.rosterSeniorIds)
        rows.set(seniorId, { seniorId, outcome: 'EXCLUDED', evidence })
    }
  }
  if (result.kind === 'EVALUATED') {
    for (const p of result.projections) {
      if (!p.scope.startsWith(SENIOR)) continue
      const seniorId = p.scope.slice(SENIOR.length)
      if (rows.get(seniorId)?.outcome === 'EXCLUDED') continue
      rows.set(seniorId, {
        seniorId,
        outcome: p.status,
        evidence: { score: p.score, reasons: p.reasons, rankWarnings: p.rankWarnings },
      })
    }
  }
  return [...rows.keys()].sort().map((id) => rows.get(id) as MatchRow)
}

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)

/** A senior's profile version: the stack and teams the verdict rests on. */
export function profileVersion(p: SeniorTechProfile): string {
  return digest([[...p.techStack].sort(), [...p.teamIds].sort()])
}

const exclusionKey = (e: JobExclusionDto) =>
  JSON.stringify([e.scope, e.kind, e.normalizedValue, e.id])

/** The digest of a senior's entries: studio-wide keys sorted, then the senior's own sorted. */
const exclusionDigest = (studioSorted: readonly string[], ownSorted: readonly string[]) =>
  digest([...studioSorted, ...ownSorted])

/**
 * An exclusion version: the digest of a senior's applicable entries, order-insensitive.
 * Studio-wide entries (no senior) come first, each part sorted. A key starts with its scope and
 * `"GLOBAL"` sorts before `"SENIOR"`, so for consistent rows this is the digest of the whole set
 * sorted; splitting by senior makes that an identity by construction, not by data.
 */
export function exclusionVersion(applicable: readonly JobExclusionDto[]): string {
  const keys = (studioWide: boolean) =>
    applicable
      .filter((e) => (e.seniorId === null) === studioWide)
      .map(exclusionKey)
      .sort()
  return exclusionDigest(keys(true), keys(false))
}

/**
 * Every roster senior's versions, equal to `exclusionVersion` of the studio-wide entries plus the
 * senior's own (CR-M-3, CR-M-5). Each exclusion is serialised once and grouped once; the
 * studio-wide list is sorted once and reused for every senior.
 *
 * BOUND: O(E log E + S * G) for E exclusions, S seniors and G studio-wide entries. Not
 * O(S + E): every senior's digest covers the studio-wide list, so its G keys are hashed once per
 * senior; folding in a pre-digested studio part instead would change every stored value.
 * Studio-wide entries are a short manual list, so S * G stays small.
 */
export function rosterVersions(
  profiles: readonly SeniorTechProfile[],
  exclusions: readonly JobExclusionDto[],
): Map<string, SeniorVersions> {
  const studio: string[] = []
  const own = new Map<string, string[]>()
  for (const e of exclusions) {
    const key = exclusionKey(e)
    if (e.seniorId === null) {
      studio.push(key)
      continue
    }
    const list = own.get(e.seniorId)
    if (list === undefined) own.set(e.seniorId, [key])
    else list.push(key)
  }
  studio.sort()
  return new Map(
    profiles.map((p) => [
      p.seniorId,
      {
        profile: profileVersion(p),
        exclusion: exclusionDigest(studio, [...(own.get(p.seniorId) ?? [])].sort()),
      },
    ]),
  )
}

/**
 * Replace the opportunity's matches with the verdict for `revision`, inside the caller's
 * transaction (which holds the opportunity and has checked `revision` is current). Neither the
 * upsert nor the delete ever touches a row of a NEWER revision.
 *
 * STALENESS (SR-M-2): since S5 a senior's stack / role / archive / team change, an exclusion and a
 * project client change enqueue a recompute of every opportunity in the write's own transaction
 * (`dirty-producers.ts`, `roster-fanout.ts`), so a row converges once the queue drains. Between the
 * write and the drain a row can still describe the old roster, and a write made outside the hooked
 * services is caught only by the reconciliation sweep, so a reader MUST still compare
 * `senior_profile_version` / `exclusion_version` with the live hashes (`rosterVersions`).
 */
export async function installMatches(
  tx: SqlExecutor,
  opportunityId: string,
  revision: number,
  result: Evaluated | Excluded,
  roster: RosterInputs,
): Promise<number> {
  const rows = matchRows(result, roster).map((r) => {
    const v = roster.versions.get(r.seniorId)
    // A verdict senior the roster does not know cannot be versioned (SR-L-3): refuse the record
    // as poison rather than fail with a TypeError that would be retried as an infra error.
    if (v === undefined) throw new RecomputePoisonError('VERDICT_SENIOR_NOT_IN_ROSTER')
    return {
      senior_id: r.seniorId,
      outcome: r.outcome,
      evidence: r.evidence,
      profile_version: v.profile,
      exclusion_version: v.exclusion,
    }
  })
  const json = JSON.stringify(rows)
  await tx.execute(
    sql`DELETE FROM job_opportunity_matches
         WHERE opportunity_id = ${opportunityId}::uuid AND opportunity_revision <= ${revision}
           AND senior_id NOT IN (SELECT (x->>'senior_id')::uuid FROM jsonb_array_elements(${json}::jsonb) x)`,
  )
  if (rows.length === 0) return 0
  const upsert: SQL = sql`
    INSERT INTO job_opportunity_matches
      (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version,
       rule_version, outcome, evidence, evaluated_at)
    SELECT ${opportunityId}::uuid, x.senior_id, ${revision}, x.profile_version, x.exclusion_version,
           ${MATCH_RULE_VERSION}, x.outcome::job_opportunity_match_outcome, x.evidence,
           ${result.evaluatedAt}::timestamptz
      FROM jsonb_to_recordset(${json}::jsonb)
        AS x(senior_id uuid, outcome text, evidence jsonb, profile_version text, exclusion_version text)
    ON CONFLICT (opportunity_id, senior_id) DO UPDATE
       SET opportunity_revision = EXCLUDED.opportunity_revision,
           senior_profile_version = EXCLUDED.senior_profile_version,
           exclusion_version = EXCLUDED.exclusion_version, rule_version = EXCLUDED.rule_version,
           outcome = EXCLUDED.outcome, evidence = EXCLUDED.evidence, evaluated_at = EXCLUDED.evaluated_at
     WHERE job_opportunity_matches.opportunity_revision <= EXCLUDED.opportunity_revision`
  await tx.execute(upsert)
  return rows.length
}
