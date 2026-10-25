import { type SQL, sql } from 'drizzle-orm'
import { JOB_HANDLE_MAX } from '../../database/schema/job-patterns'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Run ownership (r5 Task 2.5 T3; ADR 2026-10-24-job-source-run-ownership.md, "Operations"): the
 * ONE ownership predicate, used verbatim by `heartbeat`, `assertOwned` and `finish`.
 *
 * It lives apart from the ledger so the meter store can import `assertOwned` without importing the
 * ledger, which imports the meter store.
 */

/**
 * The prefix of every attempt id the ledger issues (`run-<uuid>`). The meter store refuses a binding
 * with such an attempt and NO run id (T7): it would skip fencing, and the end-of-run settlement,
 * which settles by run id, would never reach its reservations.
 */
export const RUN_ATTEMPT_PREFIX = 'run-'

/** What an executor holds after a claim: the run, its fresh owner token and its epoch. */
export interface RunHandle {
  readonly runId: string
  readonly ownerToken: string
  readonly fencingEpoch: number
}

/** The executor no longer owns its run: a wrong token, a superseded epoch, or a lease gone. */
export class RunFencedError extends Error {
  readonly code = 'RUN_FENCED' as const

  constructor(message = 'the run is not owned by this executor') {
    super(message)
    this.name = 'RunFencedError'
  }
}

/**
 * True for a refusal on ownership grounds: the ledger's `RunFencedError`, or the production
 * context's own refusal once its locally tracked lease has passed (T7, SR-L-22), which carries the
 * same code. Read by code, not class, because the meter store and the context throw it from two
 * modules.
 */
export function isRunFenced(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'RUN_FENCED'
  )
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A handle that cannot own anything: not a uuid, an empty or over-long token, a non-positive or
 * fractional epoch. Refused as fenced before any SQL, so a malformed handle never reaches a cast
 * that would fail with a different error.
 */
export function isWellFormedHandle(h: RunHandle): boolean {
  return (
    UUID.test(h.runId) &&
    typeof h.ownerToken === 'string' &&
    h.ownerToken.length > 0 &&
    h.ownerToken.length <= JOB_HANDLE_MAX &&
    Number.isSafeInteger(h.fencingEpoch) &&
    h.fencingEpoch > 0
  )
}

/** `id = $run AND owner_token = $owner AND fencing_epoch = $epoch AND STARTED AND lease alive`. */
export function ownershipPredicate(h: RunHandle): SQL {
  return sql`id = ${h.runId}::uuid AND owner_token = ${h.ownerToken} AND fencing_epoch = ${h.fencingEpoch} AND outcome = 'STARTED' AND lease_expires_at > clock_timestamp()`
}

export interface OwnedRun {
  readonly runId: string
  readonly accountKey: string
  readonly sourceId: string
}

/**
 * `SELECT … WHERE <ownership predicate> FOR UPDATE`, inside the caller's transaction. No row means
 * the executor is fenced out: `RunFencedError`, and the caller's transaction rolls back. Called
 * first in `savePage`, and inside the meter's `reserve`, `markSent` and `reconcile` after the meter
 * lock. Locking the run row is what serializes a `markSent` against recovery (ADR "Why this makes
 * F4 false").
 */
export async function assertOwned(tx: SqlExecutor, h: RunHandle): Promise<OwnedRun> {
  if (!isWellFormedHandle(h)) throw new RunFencedError('a malformed run handle owns nothing')
  const { rows } = await tx.execute(
    sql`SELECT id, account_key, source_id FROM job_collection_runs WHERE ${ownershipPredicate(h)} FOR UPDATE`,
  )
  const row = rows[0]
  if (row === undefined) throw new RunFencedError()
  return {
    runId: String(row['id']),
    accountKey: String(row['account_key']),
    sourceId: String(row['source_id']),
  }
}
