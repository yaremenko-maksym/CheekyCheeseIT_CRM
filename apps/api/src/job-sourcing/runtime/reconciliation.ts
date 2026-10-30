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
 * MAXIMUM STALENESS (SR-M-2, CR-M-1, SPEC-L-1). Not "one period": a tick sweeps at most
 * `RECONCILE_MAX_PAGES` x `RECONCILE_PAGE_SIZE` = 100,000 opportunities (the cursor carries the rest
 * to the next tick) and its caller drains at most `RECONCILE_MAX_DRAIN_BATCHES` x 200 = 2,000 dirty
 * rows (the backlog carries over). With P = `RECONCILE_PERIOD_HOURS` (6 h) the bound is
 *   P x (ceil(N / 100,000) + ceil(S / 2,000))   for N opportunities, S of them stale at once,
 * i.e. one period when N <= 100,000 and S <= 2,000, and 50 further periods (300 h) for the worst
 * case S = 100,000. The drain cap is deliberately not raised: each batch is 200 transactions on
 * the database every other cron shares, and a roster change that stales most opportunities is the
 * rare case. A reader of `job_opportunity_matches` must still check the live roster itself.
 *
 * SCOPE. Every opportunity, whatever its age or availability: no date window. That is a superset
 * of "active and claimed" (there is no claim table yet); a closed one recomputes to EXCLUDED.
 *
 * DEDUPLICATION AND RETRY (SR-M-1). `uq_job_dirty_work_entity_target` is not partial, so the reason
 * decides what a sweep may enqueue for an opportunity at its current revision:
 *   - a PENDING or CLAIMED row exists          -> skip (in flight; the drain or lease recovery owns it);
 *   - a DONE row with the same base reason     -> skip (repaired for this exact roster and stored
 *     state; this is also why a verdict that legitimately has zero rows is enqueued once, not every
 *     sweep);
 *   - a FAILED/DEFERRED row with that reason   -> enqueue again under the base reason plus the
 *     period index, a fresh key each period, so a failure retries at most once per period;
 *   - otherwise                                -> enqueue under the base reason.
 * The cron also runs `recoverExpiredDirty` first, so a crashed worker's expired lease becomes
 * PENDING (or FAILED, then retried as above) instead of staying CLAIMED for good.
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

/** Dirty rows the cron's drain may process per tick: batches x `DIRTY_BATCH_DEFAULT` (200). */
export const RECONCILE_MAX_DRAIN_BATCHES = 10

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const PERIOD_MS = RECONCILE_PERIOD_HOURS * 3_600_000

interface DirtyRow {
  readonly status: string
  readonly reason: string
}

/** The period index of `nowMs`: a fresh dirty-row key for each period (base 36, bounded length). */
export const periodBucket = (nowMs: number): string => Math.floor(nowMs / PERIOD_MS).toString(36)

/**
 * The reason to enqueue under, or `null` to skip (see DEDUPLICATION AND RETRY above).
 * `dirty` holds the opportunity's dirty rows at its current revision.
 */
export function enqueueReason(
  dirty: readonly DirtyRow[],
  baseReason: string,
  nowMs: number,
): string | null {
  if (dirty.some((d) => d.status === 'PENDING' || d.status === 'CLAIMED')) return null
  // `base` and `base:<period>` rows are one lineage: a DONE anywhere in it ends the retrying.
  const same = dirty.filter((d) => d.reason === baseReason || d.reason.startsWith(`${baseReason}:`))
  if (same.some((d) => d.status === 'DONE')) return null
  if (same.length === 0) return baseReason
  return `${baseReason}:${periodBucket(nowMs)}`
}

function parseDirty(raw: unknown): DirtyRow[] {
  return (raw as unknown[]).map((d: unknown) => {
    if (!Array.isArray(d) || d.length !== 2) throw new TypeError()
    return { status: String(d[0]), reason: String(d[1]) }
  })
}

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
  /** The clock, for the retry period index; tests pass a fixed one. */
  readonly now?: () => number
}

export interface ReconcileReport {
  readonly scanned: number
  readonly stale: number
  readonly enqueued: number
  /** Opportunities whose comparison failed on their own data; the sweep went on. */
  readonly failed: number
  /** Stale opportunities not enqueued: already in flight or already repaired (see DEDUPLICATION). */
  readonly skipped: number
  readonly pages: number
  /** `null`: the sweep reached the end. Otherwise pass it back to resume. */
  readonly cursor: string | null
}

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

function parseMatches(raw: unknown): StoredMatch[] {
  // `.map` on a non-array throws a TypeError: the caller counts it as this opportunity's failure.
  return (raw as unknown[]).map((m: unknown) => {
    if (!Array.isArray(m) || m.length !== 4) throw new TypeError()
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
  const roster = digest([...live].map(([id, v]) => `${id}|${v.profile}|${v.exclusion}`).sort())
  const stored = digest(
    matches.map((m) => `${m.seniorId}|${m.profile}|${m.exclusion}|${m.rule}`).sort(),
  )
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
  // Stryker disable next-line StringLiteral: the message text only; the throw itself is asserted.
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be >= 1')
  const live = (await loadRoster(db)).versions
  let cursor = options.cursor ?? NIL_UUID
  let scanned = 0
  let stale = 0
  let enqueued = 0
  let failed = 0
  let skipped = 0
  let pages = 0
  const now = options.now ?? Date.now
  while (pages < maxPages) {
    const { rows } = await db.execute(
      sql`SELECT o.id, o.revision,
                 COALESCE((SELECT jsonb_agg(jsonb_build_array(m.senior_id, m.senior_profile_version,
                                                              m.exclusion_version, m.rule_version))
                             FROM job_opportunity_matches m WHERE m.opportunity_id = o.id), '[]'::jsonb) AS matches,
                 COALESCE((SELECT jsonb_agg(jsonb_build_array(w.status::text, w.reason))
                             FROM job_dirty_work w
                            WHERE w.entity_kind = 'OPPORTUNITY' AND w.entity_id = o.id
                              AND w.target_version = o.revision), '[]'::jsonb) AS dirty
            FROM job_opportunities o WHERE o.id > ${cursor}::uuid ORDER BY o.id LIMIT ${pageSize}`,
    )
    pages += 1
    for (const row of rows) {
      scanned += 1
      let reason: string | null = null
      let wasStale = false
      try {
        const matches = parseMatches(row['matches'])
        if (isStale(matches, live)) {
          wasStale = true
          reason = enqueueReason(parseDirty(row['dirty']), reconcileReason(live, matches), now())
        }
      } catch {
        failed += 1
        continue
      }
      if (!wasStale) continue
      stale += 1
      if (reason === null) {
        skipped += 1
        continue
      }
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
    if (rows.length < pageSize)
      return { scanned, stale, enqueued, failed, skipped, pages, cursor: null }
    cursor = String((rows[rows.length - 1] as Record<string, unknown>)['id'])
  }
  return { scanned, stale, enqueued, failed, skipped, pages, cursor }
}
