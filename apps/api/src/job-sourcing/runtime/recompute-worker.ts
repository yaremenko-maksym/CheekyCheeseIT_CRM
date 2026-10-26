import { sql } from 'drizzle-orm'
import { findPgError } from '../../database/pg-errors'
import { type Evaluated, type Excluded, evaluate } from '../funnel/evaluate'
import type { MeterDb } from '../metering/account-meter.store'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  DIRTY_BATCH_DEFAULT,
  DirtyWorkFencedError,
  type FailOutcome,
  type RetryOptions,
  claimDirtyBatch,
  completeDirty,
  failDirty,
} from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { CanonicalStateError, resolveRecords } from '../store/canonical.store'
import { LockContentionError, setLockTimeout, withLockRetry } from '../store/lock-order'
import { STORE_LOCK_TIMEOUT_MS } from '../store/source-record.store'
import {
  type LoadedOpportunity,
  RecomputePoisonError,
  type RosterInputs,
  installMatches,
  loadOpportunity,
  loadRoster,
} from './recompute-inputs'

/**
 * The dirty-work recompute consumer (r5 Task 4.6 S4a). One `runOnce` claims a batch through the
 * S3 store and finishes every row it holds:
 *
 *   SOURCE_RECORD  resolve the record onto its opportunity (`resolveRecords`). The canonical write
 *                  enqueues the OPPORTUNITY row it affects, so the record is PERSISTED before
 *                  anything is evaluated; a crash in between leaves that row pending.
 *   OPPORTUNITY    load the current revision and the roster, `evaluate`, install the matches.
 *
 * VERSIONS. A row whose target version is no longer current is completed without work (the store
 * marks it DEFERRED / VERSION_STALE; a newer row exists). Output is installed only in a
 * transaction that holds the opportunity and re-reads its revision, and the install itself never
 * overwrites a newer revision's rows.
 *
 * FENCING. Every write of a row commits in ONE transaction with `completeDirty`, whose holder
 * predicate refuses a lost lease: `DirtyWorkFencedError` rolls the write back, and the worker
 * moves on without touching the row again.
 *
 * FAILURES. Bad data (an invalid revision, an evaluation that throws, a canonical state error, a
 * SQLSTATE class 22 data exception) is POISON: the row is failed with no retry, and the batch continues. Anything
 * else — lock contention after the store's retries, a lost connection, an unknown error — is
 * INFRASTRUCTURE: the row returns to PENDING until its attempts are spent, then the store marks it
 * FAILED. Not started from a cron here (S4b adds the periodic reconciliation).
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const
/** Rows processed between two turns of the event loop. */
export const RECOMPUTE_YIELD_EVERY = 50
/** One attempt: a poison row is terminal at once. */
const POISON_ATTEMPTS = 1

/** A per-record failure the data itself causes: retrying cannot help (defined with the inputs). */
export { RecomputePoisonError }

/** An input `evaluate` needs is not ready yet (roster, exclusions): retried, never filtered. */
export class RecomputeNotReadyError extends Error {
  constructor(readonly code: string) {
    super(`recompute input not ready: ${code}`)
    this.name = 'RecomputeNotReadyError'
  }
}

/**
 * What one batch shares: the evaluation time. The roster is NOT shared: it is read per row inside
 * the install transaction, after the opportunity lock (SR-M-1), so a stale batch snapshot can never
 * overwrite a newer install, and a failed roster read costs only its own row (CR-M-1).
 */
export interface RecomputeBatch {
  readonly evaluationTime: Date
}

/** The worker's port to the database; `createRecomputeSteps` is the real one. */
export interface RecomputeSteps {
  claim(owner: string, batchSize: number): Promise<ClaimedDirtyWork[]>
  /** Process one held row and complete it, in one transaction with any write it makes. */
  process(work: ClaimedDirtyWork, batch: RecomputeBatch): Promise<CompleteOutcome>
  fail(work: ClaimedDirtyWork, code: string, opts: RetryOptions): Promise<FailOutcome>
}

export interface Failure {
  readonly code: string
  readonly poison: boolean
}

/** Poison or infrastructure, and the `last_error_code` to record. */
export function classifyFailure(err: unknown): Failure {
  if (err instanceof RecomputePoisonError) return { code: err.code, poison: true }
  if (err instanceof RecomputeNotReadyError) return { code: err.code, poison: false }
  if (err instanceof CanonicalStateError) return { code: err.code, poison: true }
  if (err instanceof LockContentionError) return { code: err.code, poison: false }
  // `findPgError` only returns a node whose `code` is a well-formed SQLSTATE.
  const pg = findPgError(err)
  if (pg !== null) {
    const sqlstate = String(pg['code'])
    // Class 22 (data exception) is the value's fault; every other class is the server's.
    return { code: `PG_${sqlstate}`, poison: sqlstate.startsWith('22') }
  }
  // Poison only by an explicit marker (CR-M-2): a bare RangeError may be the runtime's own (stack
  // overflow, "Invalid array length") and must not burn a row as bad data.
  return { code: 'RECOMPUTE_ERROR', poison: false }
}

export interface RecomputeReport {
  claimed: number
  done: number
  deferred: number
  retried: number
  failed: number
  fenced: number
}

export interface RecomputeOptions {
  readonly owner: string
  readonly batchSize?: number
  readonly yieldEvery?: number
  readonly now?: () => Date
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export class RecomputeWorker {
  constructor(
    private readonly steps: RecomputeSteps,
    private readonly options: RecomputeOptions,
  ) {}

  /** Claim one batch and finish every row of it. Rejects only when a failure cannot be recorded. */
  async runOnce(): Promise<RecomputeReport> {
    const {
      owner,
      batchSize = DIRTY_BATCH_DEFAULT,
      yieldEvery = RECOMPUTE_YIELD_EVERY,
    } = this.options
    const claimed = await this.steps.claim(owner, batchSize)
    const report: RecomputeReport = {
      claimed: claimed.length,
      done: 0,
      deferred: 0,
      retried: 0,
      failed: 0,
      fenced: 0,
    }
    const batch: RecomputeBatch = { evaluationTime: (this.options.now ?? (() => new Date()))() }
    // Records first: their resolution is what the batch's opportunity rows are evaluated against.
    const ordered = [
      ...claimed.filter((w) => w.entityKind === 'SOURCE_RECORD'),
      ...claimed.filter((w) => w.entityKind !== 'SOURCE_RECORD'),
    ]
    let sinceYield = 0
    for (const work of ordered) {
      if (sinceYield === yieldEvery) {
        sinceYield = 0
        await yieldToLoop()
      }
      sinceYield += 1
      await this.finish(work, batch, report)
    }
    return report
  }

  private async finish(
    work: ClaimedDirtyWork,
    batch: RecomputeBatch,
    report: RecomputeReport,
  ): Promise<void> {
    try {
      const outcome = await this.steps.process(work, batch)
      if (outcome === 'DONE') report.done += 1
      else report.deferred += 1
      return
    } catch (err) {
      if (err instanceof DirtyWorkFencedError) {
        report.fenced += 1
        return
      }
      const { code, poison } = classifyFailure(err)
      try {
        const outcome = await this.steps.fail(
          work,
          code,
          poison ? { maxAttempts: POISON_ATTEMPTS } : {},
        )
        if (outcome === 'FAILED') report.failed += 1
        else report.retried += 1
      } catch (failErr) {
        // A failure that cannot be recorded (the database is gone) ends the batch; the lease
        // returns the rest. A fence lost meanwhile is just this row.
        if (!(failErr instanceof DirtyWorkFencedError)) throw failErr
        report.fenced += 1
      }
    }
  }
}

/** One transaction under the store's lock timeout, re-run as a whole on contention. */
function inTx<T>(db: MeterDb, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      await setLockTimeout(tx, STORE_LOCK_TIMEOUT_MS)
      return work(tx)
    }, READ_COMMITTED),
  )
}

/** SOURCE_RECORD: resolve at the current observation, then complete, atomically. */
function resolveSourceRecord(db: MeterDb, work: ClaimedDirtyWork): Promise<CompleteOutcome> {
  return inTx(db, async (tx) => {
    const { rows } = await tx.execute(
      sql`SELECT observation_seq FROM job_source_record_heads WHERE source_record_id = ${work.entityId}::uuid`,
    )
    if (Number(rows[0]?.['observation_seq']) === work.targetVersion)
      await resolveRecords(tx, [work.entityId])
    return completeDirty(tx, work)
  })
}

/** `evaluate`, with its non-verdict outcomes turned into the worker's failure classes. */
function verdictOf(
  work: ClaimedDirtyWork,
  batch: RecomputeBatch,
  loaded: LoadedOpportunity,
  roster: RosterInputs,
): Evaluated | Excluded {
  let result: ReturnType<typeof evaluate>
  try {
    result = evaluate({
      recordKey: work.id,
      evaluationTime: batch.evaluationTime,
      revision: loaded.canonical,
      rosterSeniorIds: roster.rosterSeniorIds,
      profiles: roster.profiles,
      exclusions: roster.exclusions,
      teamTriageGrants: loaded.teamTriageGrants,
      unavailable: [],
    })
  } catch {
    throw new RecomputePoisonError('EVALUATION_THREW')
  }
  if (result.kind === 'INVALID_INPUT') throw new RecomputePoisonError(result.code)
  if (result.kind === 'RETRYABLE') throw new RecomputeNotReadyError(result.code)
  return result
}

/**
 * OPPORTUNITY: lock the opportunity, and only then read it and the roster, evaluate, install and
 * complete — one transaction (SR-M-1). The lock serialises installs of one opportunity, and every
 * input is read after it, so an install never rests on a snapshot older than one already
 * committed: a stale roster cannot overwrite a newer EXCLUDED with LEAD.
 */
function recomputeOpportunity(
  db: MeterDb,
  work: ClaimedDirtyWork,
  batch: RecomputeBatch,
): Promise<CompleteOutcome> {
  return inTx(db, async (tx) => {
    const { rows } = await tx.execute(
      // NO KEY UPDATE (CR-M-4): conflicts with the canonical store's FOR UPDATE and with another
      // worker, but not with the FOR KEY SHARE an FK insert (source link, triage grant) takes.
      sql`SELECT revision FROM job_opportunities WHERE id = ${work.entityId}::uuid FOR NO KEY UPDATE`,
    )
    // Missing or moved on: nothing to compute, the store records ENTITY_MISSING / VERSION_STALE.
    if (Number(rows[0]?.['revision']) !== work.targetVersion) return completeDirty(tx, work)
    // Locked above at the target revision, so it exists.
    const loaded = (await loadOpportunity(tx, work.entityId)) as LoadedOpportunity
    const roster = await loadRoster(tx)
    const verdict = verdictOf(work, batch, loaded, roster)
    await installMatches(tx, work.entityId, work.targetVersion, verdict, roster)
    return completeDirty(tx, work)
  })
}

/** The real port: the S3 store, the canonical store and the recompute inputs. */
export function createRecomputeSteps(db: MeterDb): RecomputeSteps {
  return {
    claim: (owner, batchSize) => claimDirtyBatch(db, { owner, batchSize }),
    process: (work, batch) =>
      work.entityKind === 'SOURCE_RECORD'
        ? resolveSourceRecord(db, work)
        : recomputeOpportunity(db, work, batch),
    fail: (work, code, opts) => failDirty(db, work, code, opts),
  }
}
