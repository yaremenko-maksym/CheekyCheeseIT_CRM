import { createHash } from 'node:crypto'
import type { JobExclusionDto } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { type SeniorProjectRow, deriveProjectExclusions, manualExclusionDto } from '../filtering'
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
export interface LoadedOpportunity {
  readonly revision: number
  readonly canonical: CanonicalRevision
  /** Teams holding an unrevoked, unexpired triage grant for this opportunity. */
  readonly teamTriageGrants: readonly string[]
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

/** The opportunity at its current revision, or null when it does not exist. */
export async function loadOpportunity(
  db: SqlExecutor,
  opportunityId: string,
): Promise<LoadedOpportunity | null> {
  const { rows } = await db.execute(
    sql`SELECT o.id, o.revision, o.title, o.employer_name, o.location, o.stack_keywords,
               o.application_url, o.availability, o.first_seen_at, b.text AS description,
               rep.normalized, rep.evidence, rep.source_type, rep.source_url,
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
  return {
    revision,
    teamTriageGrants: strings(o['grants']),
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

/** An exclusion version: the digest of a senior's applicable entries, order-insensitive. */
export function exclusionVersion(applicable: readonly JobExclusionDto[]): string {
  return digest(
    applicable.map((e) => JSON.stringify([e.scope, e.kind, e.normalizedValue, e.id])).sort(),
  )
}

/**
 * Every roster senior's versions in one pass (CR-M-3): exclusions are grouped by senior once, so
 * the cost is O(seniors + exclusions) per roster load, whatever the number of match rows.
 * A senior's exclusions are the studio-wide entries plus their own.
 */
export function rosterVersions(
  profiles: readonly SeniorTechProfile[],
  exclusions: readonly JobExclusionDto[],
): Map<string, SeniorVersions> {
  const studio: JobExclusionDto[] = []
  const own = new Map<string, JobExclusionDto[]>()
  for (const e of exclusions) {
    if (e.seniorId === null) studio.push(e)
    else own.set(e.seniorId, [...(own.get(e.seniorId) ?? []), e])
  }
  return new Map(
    profiles.map((p) => [
      p.seniorId,
      {
        profile: profileVersion(p),
        exclusion: exclusionVersion([...studio, ...(own.get(p.seniorId) ?? [])]),
      },
    ]),
  )
}

/**
 * Replace the opportunity's matches with the verdict for `revision`, inside the caller's
 * transaction (which holds the opportunity and has checked `revision` is current). Neither the
 * upsert nor the delete ever touches a row of a NEWER revision.
 *
 * STALENESS UNTIL S5 (SR-M-2): only a new opportunity revision enqueues a recompute. A senior's
 * archive, team change or new exclusion does NOT (that is S5, pending decision D2), so a row
 * written here can outlive the roster it was computed from. Until S5 ships, a reader MUST check
 * the live roster and compare `senior_profile_version` / `exclusion_version` with the current
 * hashes (`rosterVersions`) before serving a row.
 */
export async function installMatches(
  tx: SqlExecutor,
  opportunityId: string,
  revision: number,
  result: Evaluated | Excluded,
  roster: RosterInputs,
): Promise<number> {
  const rows = matchRows(result, roster).map((r) => {
    // Every senior of a verdict comes from this roster, so each has its versions.
    const v = roster.versions.get(r.seniorId) as SeniorVersions
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
