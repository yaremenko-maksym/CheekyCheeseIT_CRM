import { type SQL, sql } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { jobSources } from '../../database/schema'
import { type BanScope, type HostPolicy, isValidHostKey } from '../providers/manifest.hosts'

/**
 * Host-level state (r5 Task 2.5 T8; ADR docs/architecture/2026-10-24-job-source-run-ownership.md,
 * "Stop-on-ban" and T8). The ONLY writer of `job_source_hosts`.
 *
 *  - `recordHostBan` pauses a host when the transport observes a ban (T7 calls it on 403 / 429, T6
 *    adds 451). Monotone, never idempotent: it only ever moves `paused_until` later, and a repeat
 *    from the source that set the pause, while that pause runs, changes nothing.
 *  - `claimHostSlot` runs INSIDE the claim transaction (T3), after the source row is locked: it
 *    makes the host row exist, locks it, and refuses a paused host, a host with a running run, and
 *    a claim inside the host's rate.
 *  - `hostOpenPredicate` is the host term of the due predicate.
 *
 * THE CLOCK IS THE DATABASE'S. Every time comparison is SQL over `clock_timestamp()`; no function
 * here reads an application clock, and a `Retry-After` date is passed as an absolute timestamp
 * parameter (SR-L-20). Nothing here imports the manifest: the caller passes the host's policy in.
 *
 * MERGING THIS MAKES NO SOURCE RUNNABLE: nothing in production calls these functions until the
 * run ledger (T3) and the production context (T7) land.
 */

/** The shortest ban pause: a day, whatever the provider says. */
export const HOST_BAN_PAUSE_MIN_HOURS = 24
/** `HOST_BAN_PAUSE_MAX`: the longest a ban can pause a host, a `Retry-After` included (30 days). */
export const HOST_BAN_PAUSE_MAX_HOURS = 720
const HOST_BAN_PAUSE_MAX_SECONDS = HOST_BAN_PAUSE_MAX_HOURS * 3600

/** Anything that runs a drizzle `SQL` and returns rows: the db or a transaction. */
export interface SqlExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

/** A parsed `Retry-After`: a delay from the database's now, or an absolute instant. */
export type RetryAfter =
  { readonly kind: 'DELAY'; readonly seconds: number } | { readonly kind: 'AT'; readonly at: Date }

const DELAY_SECONDS = /^\d{1,12}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** RFC 9110 IMF-fixdate, the one HTTP-date form a sender must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/

/**
 * `Retry-After` in its two forms (RFC 9110 §10.2.3): delay-seconds, or an IMF-fixdate. A delay is
 * capped at `HOST_BAN_PAUSE_MAX`; a date is returned as it is and capped in SQL against the
 * database clock. Anything else -- a negative or fractional number, a date that does not exist
 * (31 Feb, a weekday that does not match), an obsolete date format, a non-string -- is ignored
 * (`null`): the ban then pauses for its floor, which is never shorter than a day.
 */
export function parseRetryAfter(raw: unknown): RetryAfter | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (DELAY_SECONDS.test(value)) {
    return { kind: 'DELAY', seconds: Math.min(Number(value), HOST_BAN_PAUSE_MAX_SECONDS) }
  }
  const m = IMF_FIXDATE.exec(value)
  if (m === null) return null
  const [, dayName, day, month, year, hh, mm, ss] = m as unknown as string[]
  const at = new Date(
    Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hh), Number(mm), Number(ss)),
  )
  // Date.UTC rolls an impossible date or time over (31 Feb -> 3 Mar, 24:00 -> next day): refuse it.
  const exact =
    at.getUTCDate() === Number(day) &&
    at.getUTCHours() === Number(hh) &&
    at.getUTCMinutes() === Number(mm) &&
    at.getUTCSeconds() === Number(ss) &&
    DAYS[at.getUTCDay()] === dayName
  return exact ? { kind: 'AT', at } : null
}

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------

/** What a refused request bans (SR-M-24). */
export type BanTarget = 'HOST' | 'SOURCE' | 'NONE'

/**
 * 429 and 451 always ban the host key. A 403 bans the host key unless the type declares the
 * `SOURCE` scope, in which case it is that source's own failure (T3 counts it). Any other status
 * is not a ban. Anything but a literal `'SOURCE'` scope bans the host: an unknown scope fails
 * toward stopping.
 */
export function banTargetOf(banScope: BanScope, status: number): BanTarget {
  if (status === 429 || status === 451) return 'HOST'
  if (status !== 403) return 'NONE'
  return banScope === 'SOURCE' ? 'SOURCE' : 'HOST'
}

export interface HostBan {
  readonly hostKey: string
  /** A typed code, e.g. `HTTP_429` (the column's CHECK is UPPER_SNAKE). */
  readonly reason: string
  /** The source whose request was refused. */
  readonly sourceId: string
  /** The raw `Retry-After` header, if the response carried one. */
  readonly retryAfter?: string | null
  /** `HostPolicy.floorHours` of the host: the longest `minIntervalHoursFloor` on it. */
  readonly floorHours: number
}

const REASON = /^[A-Z][A-Z0-9_]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function assertBan(ban: HostBan): void {
  if (!isValidHostKey(ban.hostKey)) throw new RangeError('recordHostBan: invalid host key')
  if (!REASON.test(ban.reason)) throw new RangeError('recordHostBan: invalid reason code')
  if (!UUID.test(ban.sourceId)) throw new RangeError('recordHostBan: invalid source id')
  if (
    !Number.isInteger(ban.floorHours) ||
    ban.floorHours < 0 ||
    ban.floorHours > HOST_BAN_PAUSE_MAX_HOURS
  ) {
    throw new RangeError('recordHostBan: invalid floor hours')
  }
}

/** The SQL for `Retry-After`: a delay from the database clock, a parameter instant, or nothing. */
function retrySql(retry: RetryAfter | null): SQL {
  if (retry === null) return sql`NULL::timestamptz`
  if (retry.kind === 'DELAY')
    return sql`clock_timestamp() + make_interval(secs => ${retry.seconds})`
  return sql`${retry.at.toISOString()}::timestamptz`
}

/**
 * The statement `recordHostBan` runs. Exported so its exact text is pinned by a unit test; its
 * semantics are proven against Postgres by `host-state.integration.spec.ts`.
 *
 * The new pause is `LEAST(max, GREATEST(base, retry))` where base is the larger of a day and the
 * host's floor, and `GREATEST` skips a NULL retry. An existing pause is only ever extended
 * (`GREATEST(old, new)`). The WHERE makes a repeat from the pause's own source, while its pause
 * runs, a no-op: written positively, so a host never paused before (NULL source) is banned.
 */
export function hostBanStatement(ban: HostBan): SQL {
  assertBan(ban)
  const baseHours = Math.max(HOST_BAN_PAUSE_MIN_HOURS, ban.floorHours)
  const retry = parseRetryAfter(ban.retryAfter)
  return sql`INSERT INTO job_source_hosts AS h (host_key, paused_until, pause_reason, pause_source_id)
VALUES (${ban.hostKey}, LEAST(clock_timestamp() + make_interval(hours => ${HOST_BAN_PAUSE_MAX_HOURS}), GREATEST(clock_timestamp() + make_interval(hours => ${baseHours}), ${retrySql(retry)})), ${ban.reason}, ${ban.sourceId}::uuid)
ON CONFLICT (host_key) DO UPDATE SET
  paused_until = GREATEST(h.paused_until, EXCLUDED.paused_until),
  pause_reason = CASE WHEN EXCLUDED.paused_until > COALESCE(h.paused_until, '-infinity') THEN EXCLUDED.pause_reason ELSE h.pause_reason END,
  pause_source_id = CASE WHEN EXCLUDED.paused_until > COALESCE(h.paused_until, '-infinity') THEN EXCLUDED.pause_source_id ELSE h.pause_source_id END
WHERE h.paused_until IS NULL OR h.paused_until <= clock_timestamp() OR h.pause_source_id IS DISTINCT FROM EXCLUDED.pause_source_id
RETURNING 1 AS applied`
}

/**
 * Pause every source on `ban.hostKey` (one READ COMMITTED transaction, one row, no lock on
 * `job_sources`). `applied` is false when the call was a same-source repeat inside its pause.
 * Safe to call again after a failure (SR-M-21: T7 retries it, and `finish` calls it once more for a
 * run flagged `HOST_BAN_UNRECORDED`), because a repeat can only extend, never shorten.
 */
export async function recordHostBan(
  db: DatabaseService['db'],
  ban: HostBan,
): Promise<{ applied: boolean }> {
  const statement = hostBanStatement(ban)
  const { rows } = await db.transaction((tx) => tx.execute(statement), {
    isolationLevel: 'read committed',
  })
  return { applied: rows.length === 1 }
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

export const HOST_REFUSALS = [
  'HOST_KEY_MISSING',
  'HOST_PAUSED',
  'HOST_BUSY',
  'HOST_RATE_GAP',
  'HOST_DAILY_CAP',
] as const
export type HostRefusal = (typeof HOST_REFUSALS)[number]

/**
 * A claim's host verdict. `opensAt` is the database's own answer to "when could it be claimed":
 * the pause's end, the gap's end, or when the oldest counted claim leaves the 24 h window. It is
 * NULL for a busy host (that ends when its run ends) and for a missing key. It is only ever written
 * back (T3's `next_attempt_at`), never compared in TypeScript.
 */
export type HostSlot =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: HostRefusal; readonly opensAt: Date | null }

function refuse(reason: HostRefusal, opensAt: unknown = null): HostSlot {
  return { granted: false, reason, opensAt: opensAt instanceof Date ? opensAt : null }
}

function assertPolicy(policy: HostPolicy): void {
  const rate = policy.rate
  if (rate === null) return
  const ok = (n: number) => Number.isInteger(n) && n >= 1
  if (!ok(rate.perMinute) || !ok(rate.perDay)) throw new RangeError('claimHostSlot: invalid rate')
}

/** The statements of `claimHostSlot`, in order. Exported so their text is pinned by a unit test. */
export const hostSlotStatements = {
  ensureRow: (hostKey: string): SQL =>
    sql`INSERT INTO job_source_hosts (host_key) VALUES (${hostKey}) ON CONFLICT (host_key) DO NOTHING`,
  lock: (hostKey: string): SQL =>
    sql`SELECT 1 FROM job_source_hosts WHERE host_key = ${hostKey} FOR UPDATE`,
  // A separate statement AFTER the lock: under READ COMMITTED it takes a fresh snapshot, so it
  // sees what the previous lock holder committed (a pause, a claim time).
  read: (hostKey: string, gapMs: number): SQL =>
    sql`SELECT COALESCE(h.paused_until > clock_timestamp(), false) AS paused, h.paused_until,
  EXISTS (SELECT 1 FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
          WHERE s.host_key = h.host_key AND r.outcome = 'STARTED') AS busy,
  COALESCE(h.last_claimed_at + make_interval(secs => ${gapMs} / 1000.0) > clock_timestamp(), false) AS in_gap,
  h.last_claimed_at + make_interval(secs => ${gapMs} / 1000.0) AS gap_ends_at
FROM job_source_hosts h WHERE h.host_key = ${hostKey}`,
  // `started_at` is written once per claim and never updated, so each claim counts once.
  daily: (hostKey: string, perDay: number): SQL =>
    sql`WITH w AS (SELECT r.started_at FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
           WHERE s.host_key = ${hostKey} AND r.started_at > clock_timestamp() - interval '24 hours')
SELECT (SELECT count(*) FROM w)::int AS claims,
  (SELECT started_at + interval '24 hours' FROM w ORDER BY started_at
    OFFSET GREATEST((SELECT count(*) FROM w) - ${perDay}, 0) LIMIT 1) AS opens_at`,
  stamp: (hostKey: string): SQL =>
    sql`UPDATE job_source_hosts SET last_claimed_at = clock_timestamp() WHERE host_key = ${hostKey}`,
}

/**
 * The host half of a claim (T3 step 3). Call it inside the claim transaction, after the source row
 * is locked and before the run row is inserted; the transaction must be READ COMMITTED.
 *
 * 1. A NULL, empty or malformed key is refused (`HOST_KEY_MISSING`) before any SQL, without an
 *    exception.
 * 2. The host row is inserted if missing (`ON CONFLICT DO NOTHING`), then locked. Two claimers of a
 *    missing row serialize at the INSERT: the second waits on the first's uncommitted index entry,
 *    then finds the committed row (ADR T8 (b)).
 * 3. Refused while paused (`HOST_PAUSED`), while any `STARTED` run exists on a source of this host
 *    (`HOST_BUSY`), and, for a host with a rate, inside the per-minute gap (`HOST_RATE_GAP`) or at
 *    `perDay` claims in the trailing 24 h (`HOST_DAILY_CAP`).
 * 4. Granted: `last_claimed_at` is stamped under the lock.
 */
export async function claimHostSlot(
  tx: SqlExecutor,
  hostKey: string | null | undefined,
  policy: HostPolicy,
): Promise<HostSlot> {
  if (!isValidHostKey(hostKey)) return refuse('HOST_KEY_MISSING')
  assertPolicy(policy)
  const gapMs = policy.rate === null ? 0 : Math.ceil(60_000 / policy.rate.perMinute)
  await tx.execute(hostSlotStatements.ensureRow(hostKey))
  await tx.execute(hostSlotStatements.lock(hostKey))
  const state = (await tx.execute(hostSlotStatements.read(hostKey, gapMs))).rows[0]
  if (state === undefined) throw new Error('claimHostSlot: the host row vanished under its lock')
  if (state['paused'] === true) return refuse('HOST_PAUSED', state['paused_until'])
  if (state['busy'] === true) return refuse('HOST_BUSY')
  if (policy.rate !== null) {
    if (state['in_gap'] === true) return refuse('HOST_RATE_GAP', state['gap_ends_at'])
    const day = (await tx.execute(hostSlotStatements.daily(hostKey, policy.rate.perDay))).rows[0]
    if (Number(day?.['claims']) >= policy.rate.perDay) {
      return refuse('HOST_DAILY_CAP', day?.['opens_at'])
    }
  }
  await tx.execute(hostSlotStatements.stamp(hostKey))
  return { granted: true }
}

// ---------------------------------------------------------------------------
// The due term, and the pause as an input to `isDue`
// ---------------------------------------------------------------------------

/**
 * The host term of the due predicate: the source HAS a host key, and that host is not paused.
 * The NULL test comes FIRST and is a positive term: a bare `NOT EXISTS` is TRUE for a NULL key and
 * would fail open. A host with no row, or with a NULL or past `paused_until`, is open.
 */
export function hostOpenPredicate(): SQL {
  return sql`(${jobSources.hostKey} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM job_source_hosts h WHERE h.host_key = ${jobSources.hostKey} AND h.paused_until > clock_timestamp()))`
}

/**
 * `isDue`'s `hostPaused` input for each id, read on the database clock: true for a NULL key (no
 * host, so never due) and for a paused host. An id the result does not contain (an unknown source)
 * must be treated as paused by the caller: `isDue` refuses anything but a literal `false`.
 */
export async function readHostPaused(
  db: SqlExecutor,
  sourceIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (sourceIds.length === 0) return new Map()
  const { rows } = await db.execute(
    sql`SELECT ${jobSources.id} AS id, NOT ${hostOpenPredicate()} AS paused FROM ${jobSources} WHERE ${jobSources.id} IN ${[...sourceIds]}`,
  )
  return new Map(rows.map((r) => [String(r['id']), r['paused'] !== false]))
}

// ---------------------------------------------------------------------------
// The interval floor
// ---------------------------------------------------------------------------

/** The longest interval anyone may set: a year. */
const MAX_INTERVAL_HOURS = 8760

const validHours = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL_HOURS

/**
 * The cadence a source actually runs at (T8, #1139 SR-L-3): its stored `min_interval_hours`,
 * raised to the provider's `minIntervalHoursFloor`. A NULL or unusable stored value falls back to
 * the manifest entry's own interval. `clamped` reports that the stored value was raised or
 * replaced, so the caller can record it.
 */
export function cadenceHoursAtFloor(
  stored: number | null,
  floorHours: number,
  defaultHours: number,
): { hours: number; clamped: boolean } {
  if (!validHours(defaultHours)) throw new RangeError('cadenceHoursAtFloor: invalid default')
  if (!Number.isInteger(floorHours) || floorHours < 0 || floorHours > MAX_INTERVAL_HOURS) {
    throw new RangeError('cadenceHoursAtFloor: invalid floor')
  }
  const usable = validHours(stored)
  const base = usable ? stored : defaultHours
  const hours = Math.max(base, floorHours)
  return { hours, clamped: hours !== stored && stored !== null }
}
