import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { enqueueDirty } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { MATCH_RULE_VERSION, type SeniorVersions, loadRoster } from './recompute-inputs'

/**
 * Periodic full reconciliation of job matches (r5 Task 4.6 S4b).
 *
 * WHY. Until S5 ships producers for roster and exclusion changes (archive, team change, new
 * exclusion), only a new opportunity revision enqueues a recompute, so a stored match can outlive
 * the roster it was computed from (SR-M-2, PR #1177). This sweep is the repair: it finds
 * opportunities whose stored match versions differ from the live roster's (or that have no match
 * rows) and enqueues them as dirty work for the S4a worker.
 *
 * MAXIMUM STALENESS (SR-M-2): a stale match survives at most one sweep PERIOD, plus the time to
 * sweep and drain: `RECONCILE_PERIOD_HOURS` (the cron in `job-match-reconciliation.cron.ts`).
 * A reader of `job_opportunity_matches` must still check the live roster itself (its own AC).
 *
 * SCOPE. Every opportunity, whatever its age or availability: no date window. That is a superset
 * of "active and claimed" (there is no claim table yet); a closed one recomputes to EXCLUDED.
 *
 * IDEMPOTENCE. The dirty row's reason carries the live roster digest and the opportunity's stored
 * fingerprint, and `uq_job_dirty_work_entity_target` is not partial, so the same (revision, roster,
 * stored state) enqueues once for good. A second sweep while rows are pending enqueues nothing, and
 * an opportunity whose verdict legitimately has no rows is not re-enqueued every period.
 *
 * KNOWN GAP: a senior who JOINS the roster is not detected for an opportunity that already has
 * rows for other seniors (no row to mismatch). Detecting it needs the roster-size comparison S5's
 * team-change producer will give; until then such an opportunity is repaired at its next revision.
 */

/** MP-05: the initial page size, easy to change. */
export const RECONCILE_PAGE_SIZE = 200
/** The sweep period in hours: the SR-M-2 staleness bound (the cron expression derives from it). */
export const RECONCILE_PERIOD_HOURS = 6
/** Pages one call may scan; the rest resumes from the returned cursor (bounded tick). */
export const RECONCILE_MAX_PAGES = 500

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

interface StoredMatch {
  readonly seniorId: string
  readonly profile: string
  readonly exclusion: string
  readonly rule: string
}

export interface ReconcileOptions {
  readonly pageSize?: number
  readonly maxPages?: number
  /** Resume after this opportunity id (the previous report's `cursor`). */
  readonly cursor?: string | null
}

export interface ReconcileReport {
  readonly scanned: number
  readonly stale: number
  readonly enqueued: number
  /** Opportunities whose comparison failed on their own data; the sweep went on. */
  readonly failed: number
  readonly pages: number
  /** `null`: the sweep reached the end. Otherwise pass it back to resume. */
  readonly cursor: string | null
}

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

function parseMatches(raw: unknown): StoredMatch[] {
  if (!Array.isArray(raw)) throw new TypeError('matches is not an array')
  return raw.map((m: unknown) => {
    if (!Array.isArray(m) || m.length !== 4) throw new TypeError('malformed match tuple')
    const [seniorId, profile, exclusion, rule] = m.map(String)
    return {
      seniorId: seniorId as string,
      profile: profile as string,
      exclusion: exclusion as string,
      rule: rule as string,
    }
  })
}

/** Stale: no rows, or any row of a senior the roster no longer has, or with other versions. */
export function isStale(
  matches: readonly StoredMatch[],
  live: ReadonlyMap<string, SeniorVersions>,
): boolean {
  if (matches.length === 0) return true
  return matches.some((m) => {
    const v = live.get(m.seniorId)
    return (
      v === undefined ||
      v.profile !== m.profile ||
      v.exclusion !== m.exclusion ||
      m.rule !== MATCH_RULE_VERSION
    )
  })
}

/** The dirty reason: live roster digest + the stored fingerprint (see IDEMPOTENCE above). */
export function reconcileReason(
  live: ReadonlyMap<string, SeniorVersions>,
  matches: readonly StoredMatch[],
): string {
  const roster = digest([...live].sort(([a], [b]) => (a < b ? -1 : 1)))
  const stored = digest([...matches].sort((a, b) => (a.seniorId < b.seniorId ? -1 : 1)))
  return `RECONCILE:${roster}:${stored}`
}

/**
 * Scan pages by id from `cursor`, enqueue each stale opportunity at its current revision.
 * A comparison failure on one opportunity is counted and skipped; any database error propagates
 * and aborts the sweep (the next tick retries; enqueueing is idempotent).
 */
export async function reconcileOnce(
  db: SqlExecutor,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const pageSize = options.pageSize ?? RECONCILE_PAGE_SIZE
  const maxPages = options.maxPages ?? RECONCILE_MAX_PAGES
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be >= 1')
  const live = (await loadRoster(db)).versions
  let cursor = options.cursor ?? NIL_UUID
  let scanned = 0
  let stale = 0
  let enqueued = 0
  let failed = 0
  let pages = 0
  while (pages < maxPages) {
    const { rows } = await db.execute(
      sql`SELECT o.id, o.revision,
                 COALESCE((SELECT jsonb_agg(jsonb_build_array(m.senior_id, m.senior_profile_version,
                                                              m.exclusion_version, m.rule_version))
                             FROM job_opportunity_matches m WHERE m.opportunity_id = o.id), '[]'::jsonb) AS matches
            FROM job_opportunities o WHERE o.id > ${cursor}::uuid ORDER BY o.id LIMIT ${pageSize}`,
    )
    pages += 1
    for (const row of rows) {
      scanned += 1
      let reason: string | null = null
      try {
        const matches = parseMatches(row['matches'])
        if (isStale(matches, live)) reason = reconcileReason(live, matches)
      } catch {
        failed += 1
        continue
      }
      if (reason === null) continue
      stale += 1
      try {
        const { inserted } = await enqueueDirty(
          db,
          'OPPORTUNITY',
          String(row['id']),
          Number(row['revision']),
          reason,
        )
        if (inserted) enqueued += 1
      } catch (err) {
        // Input validation of this opportunity's own values; a database error is not a RangeError.
        if (!(err instanceof RangeError)) throw err
        failed += 1
      }
    }
    if (rows.length < pageSize) return { scanned, stale, enqueued, failed, pages, cursor: null }
    cursor = String(rows[rows.length - 1]?.['id'])
  }
  return { scanned, stale, enqueued, failed, pages, cursor }
}
