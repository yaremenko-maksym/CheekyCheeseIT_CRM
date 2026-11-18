import type { JobSourceType } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { findPgError } from '../../database/pg-errors'
import { type Evaluated, type Excluded, evaluate } from '../funnel/evaluate'
import { ROLE_CLASSIFIER_VERSION } from '../funnel/role-classifier'
import type { MeterDb } from '../metering/account-meter.store'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  DETAIL_FETCH,
  DIRTY_BATCH_DEFAULT,
  DirtyWorkFencedError,
  type FailOutcome,
  type RetryOptions,
  claimDirtyBatch,
  completeDirty,
  enqueueDirty,
  failDirty,
} from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { CanonicalStateError, resolveRecords } from '../store/canonical.store'
import { LockContentionError, setLockTimeout, withLockRetry } from '../store/lock-order'
import { deriveOpportunityRoles, writeOpportunityRoles } from '../store/opportunity-roles'
import { STORE_LOCK_TIMEOUT_MS } from '../store/source-record.store'
import {
  type LoadedOpportunity,
  RecomputePoisonError,
  type RosterInputs,
  detailFetchTargets,
  installMatches,
  loadOpportunity,
  loadRoster,
} from './recompute-inputs'
import { type FanoutOptions, fanOutDirty } from './roster-fanout'

/**
 * The dirty-work recompute consumer (r5 Task 4.6 S4a). One `runOnce` claims a batch through the
 * S3 store and finishes every row it holds:
 *
 *   SOURCE_RECORD  resolve the record onto its opportunity (`resolveRecords`). The canonical write
 *                  enqueues the OPPORTUNITY row it affects, so the record is PERSISTED before
 *                  anything is evaluated; a crash in between leaves that row pending.
 *   OPPORTUNITY    load the current revision and the roster, `evaluate`, install the matches.
 *   SENIOR, EXCLUSION, PROJECT_CLIENT (S5)
 *                  fan out: enqueue an OPPORTUNITY row for every opportunity, one bounded page
 *                  per pass (`roster-fanout.ts`); the next batch recomputes them.
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
  /** `freshOnly`: only rows never attempted (`ClaimOptions.freshOnly`). */
  claim(owner: string, batchSize: number, freshOnly: boolean): Promise<ClaimedDirtyWork[]>
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
  async runOnce(opts: { readonly freshOnly?: boolean } = {}): Promise<RecomputeReport> {
    const {
      owner,
      batchSize = DIRTY_BATCH_DEFAULT,
      yieldEvery = RECOMPUTE_YIELD_EVERY,
    } = this.options
    const claimed = await this.steps.claim(owner, batchSize, opts.freshOnly === true)
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
      roles: loaded.roles,
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
  onDemandTypes: readonly JobSourceType[],
  roleAiEnabled: boolean,
): Promise<CompleteOutcome> {
  return inTx(db, async (tx) => {
    const { rows } = await tx.execute(
      // NO KEY UPDATE (CR-M-4): conflicts with the canonical store's FOR UPDATE and with another
      // worker, but not with the FOR KEY SHARE an FK insert (source link, triage grant) takes.
      sql`SELECT revision, manual_team_id IS NOT NULL AS manual, title, title_key, stack_keywords,
                   description_sha256, role_classifier_version
            FROM job_opportunities WHERE id = ${work.entityId}::uuid FOR NO KEY UPDATE`,
    )
    const row = rows[0]
    // Missing or moved on: nothing to compute, the store records ENTITY_MISSING / VERSION_STALE.
    if (row === undefined || Number(row['revision']) !== work.targetVersion) {
      return completeDirty(tx, work)
    }
    // Senior roles PR 2, the lazy backfill: a row no classifier version (or an older one) decided
    // gets its roles under this lock. Only the 3 role columns move; `revision` does not.
    if (row['role_classifier_version'] !== ROLE_CLASSIFIER_VERSION) {
      await writeOpportunityRoles(
        tx,
        work.entityId,
        await deriveOpportunityRoles(tx, {
          title: String(row['title']),
          titleKey: String(row['title_key']),
          // Both columns as stored: stack_keywords is NOT NULL, description_sha256 is nullable.
          tags: row['stack_keywords'] as string[],
          descriptionSha256: row['description_sha256'] as string | null,
        }),
      )
    }
    // A manual card (r5 Phase 6) is never match-evaluated: no match row may grant another team
    // visibility of it (SR-M-1). Work that reached it anyway completes without evaluation.
    if (row['manual'] === true) return completeDirty(tx, work)
    // Locked above at the target revision, so it exists.
    const loaded = (await loadOpportunity(tx, work.entityId, onDemandTypes)) as LoadedOpportunity
    const roster = await loadRoster(tx)
    const verdict = verdictOf(work, batch, loaded, roster)
    await installMatches(tx, work.entityId, work.targetVersion, verdict, roster)
    // SFS U10 (ADR 6a, "Want"): an opportunity that came out LEAD or TRIAGE for any senior enqueues
    // one DETAIL_FETCH per backing ON_DEMAND record whose detail is still missing. The dirty row's
    // unique key makes a second enqueue a no-op: the detail is fetched once.
    if (verdict.kind === 'EVALUATED' && verdict.projections.length > 0) {
      // Missing first, then stale (ADR 6a step 4, #6 / AC4-TTL: a cached detail aged past
      // DETAIL_STALE_DAYS is re-fetched under the same "still wanted" gate). A stale record's unique
      // key makes a second enqueue a no-op until the next detail-write advances its version.
      for (const rec of detailFetchTargets(loaded)) {
        await enqueueDirty(tx, 'SOURCE_RECORD', rec.recordId, rec.version, DETAIL_FETCH)
      }
    }
    // Senior roles 4.4 (plan Review Focus 5, Owner decision 2): a role-`PENDING` vacancy comes out
    // EXCLUDED, so the wanted branch above never fires for it, yet the AI pass needs the full
    // description to classify it. Its missing detail is fetched only while the AI pass is on: with
    // the flag off the fetch buys nothing, so no external GET is made for it. The plan's
    // `loaded.detailPending` conjunct is the loop itself — `detailPending` IS
    // `onDemandMissing.length > 0` (`recompute-inputs.ts`), so an empty list enqueues nothing.
    if (roleAiEnabled && loaded.roles.status === 'PENDING') {
      for (const rec of loaded.onDemandMissing) {
        await enqueueDirty(tx, 'SOURCE_RECORD', rec.recordId, rec.version, DETAIL_FETCH)
      }
    }
    return completeDirty(tx, work)
  })
}

/** The real port: the S3 store, the canonical store and the recompute inputs. */
export function createRecomputeSteps(
  db: MeterDb,
  fanout: FanoutOptions = {},
  onDemandTypes: readonly JobSourceType[] = [],
  /** Senior roles 4.4: `JOB_ROLE_AI_ENABLED`. Off by default, like the flag itself. */
  roleAiEnabled = false,
): RecomputeSteps {
  return {
    claim: (owner, batchSize, freshOnly) =>
      claimDirtyBatch(db, { owner, batchSize, consumer: 'MATCH', freshOnly }),
    process: (work, batch) => {
      if (work.entityKind === 'SOURCE_RECORD') return resolveSourceRecord(db, work)
      if (work.entityKind === 'OPPORTUNITY')
        return recomputeOpportunity(db, work, batch, onDemandTypes, roleAiEnabled)
      // SENIOR / EXCLUSION / PROJECT_CLIENT (S5): enqueue the opportunities, then complete.
      return inTx(db, async (tx) => (await fanOutDirty(tx, work, fanout)).outcome)
    },
    fail: (work, code, opts) => failDirty(db, work, code, opts),
  }
}
