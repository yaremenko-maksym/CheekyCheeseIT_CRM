import { randomUUID } from 'node:crypto'
import type { JobMeterUnit, JobMeterWindow, JobSourceType } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { DrizzleTx } from '../../database/types'
import {
  type AccountMeter,
  type MeterDb,
  createAccountMeter,
  lockAccountMeters,
  settleRunReservations,
} from '../metering/account-meter.store'
import type { SourceObservation } from '../normalize/observation'
import {
  type CollectionErrorCode,
  type ValidatedCheckpoint,
  validatedCheckpointSchema,
} from '../providers/reporting-provider'
import type { JobSourceRegistry } from '../registry/job-source-registry'
import { MAX_EARLY_DUE_SLACK_MS } from '../scheduling/due-policy'
import { dueSourcesPredicate } from '../scheduling/due-sources.query'
import { type SqlExecutor, claimHostSlot } from '../scheduling/host-state'
import type { LedgerCatalog } from './ledger-catalog'
import { type LegacyClaimInput, claimLegacy, isLegacyKind } from './legacy-run-claim'
import {
  type ClaimRefusal,
  type LedgerOptions,
  type ManualRefusal,
  type RunEndOutcome,
  backoffMs,
  claimGate,
  endingEffect,
  isSweepable,
  manualTermRefusal,
  nextAttemptAt,
  nextSlowdownLevel,
  refusalWrite,
  resolveLedgerOptions,
  validateEnding,
} from './ledger-policy'
import {
  type OwnedRun,
  RUN_ATTEMPT_PREFIX,
  type RunHandle,
  RunFencedError,
  isWellFormedHandle,
  ownershipPredicate,
} from './run-ownership'

/**
 * THE RUN LEDGER (r5 Task 2.5 T3; ADR docs/architecture/2026-10-24-job-source-run-ownership.md,
 * "Option A"). The ONLY writer of the ownership and scheduling columns ("Who writes which column";
 * `write-gate.spec.ts` enforces it): `job_collection_runs` (owner, epoch, lease, outcome, counts,
 * checkpoint, account key) and `job_sources`' attempt history, backoff and failure counter.
 *
 * Rules every operation follows:
 *  - one SHORT transaction, pinned to READ COMMITTED; no lock is held across network I/O;
 *  - the clock is the DATABASE's: every time comparison is SQL over `clock_timestamp()`; a database
 *    instant is only ever passed to pure functions (`activationOf`, `readinessAt`) or written back;
 *  - one source per claim transaction; a refused source rolls back or commits only its refusal;
 *  - locks follow the global order job_sources -> job_source_hosts -> job_account_meters (by id) ->
 *    job_collection_runs -> job_account_meter_reservations -> page tables (by natural key).
 *
 * THE ACCOUNT-LEVEL SPEND BOUND (SR-L-23). The failure cap is per SOURCE, so N sources on one paid
 * account can each fail `MAX_CONSECUTIVE_FAILURES` (3) times before all are capped: in the worst
 * case the account spends up to `3 × page × N` per meter reset (a run that spends one page and
 * fails), on top of whatever successful runs spend. Raising N on one account raises the bound
 * linearly; `job-run-ledger.accounting.integration.spec.ts` pins it for N = 2.
 *
 * !! A reporting adapter is claimed only once it is registered AND wired (`REPORTING_WIRING`, T6);
 * the production registry holds DOU only, which is refused `NOT_ACTIVATABLE`.
 */

export type LedgerDb = MeterDb

/** A run the ledger handed to an executor: its handle plus what the executor needs to start. */
export interface ClaimedRun extends RunHandle {
  readonly sourceId: string
  readonly cycleId: string
  readonly attemptId: string
  /** The run row's account key, the ONLY key a meter binding of this run may use (SR-L-11). */
  readonly accountKey: string
  readonly sourceType: JobSourceType
  /** The checkpoint the claim chose ("Crash resume"), or null for a fresh start. */
  readonly checkpoint: unknown
}

export interface ClaimRefused {
  readonly sourceId: string
  readonly reason: ClaimRefusal
}

/** Source fetch strategy U3: a sweep claim or count -- its cycle and the sources it skips. */
export interface SweepScope {
  readonly cycleId: string
  readonly skipIds: readonly string[]
}

/**
 * CR-M-1 / SR-M-1 / CR-M-3: a run started this long before the sweep cycle opened, or later, counts
 * as the source's run "around the sweep". One tick period (10 min) PLUS one tick window (9 min):
 * a run of the 07:50 tick starts anywhere in 07:50..07:59 (its window), and both that claim and
 * the sweep cycle's opening carry cron and latency jitter. Anchored on the sweep cycle's own
 * `started_at`, a plain 10-minute window made the 07:50 tick's first claims a coin flip. Tied to
 * `TICK_WINDOW_MS` by the cron spec; the ledger does not import the cron module.
 */
export const SWEEP_RECENT_RUN_MS = 19 * 60_000

export type ManualClaim =
  | { readonly kind: 'CLAIMED'; readonly run: ClaimedRun }
  | { readonly kind: 'REFUSED'; readonly reason: ManualRefusal }

export type CycleInput =
  | { readonly trigger: 'SCHEDULED'; readonly triggerKey: string }
  | { readonly trigger: 'MANUAL'; readonly triggerKey: string; readonly actor: string }

export interface RunEnding {
  readonly outcome: RunEndOutcome
  readonly errorCode: CollectionErrorCode | null
  /** Sanitized sentence, never an upstream body; cut to the column's 500 characters. */
  readonly errorMessage?: string | null
  /** U2: what the run's context counted. Absent (recovery), the metric columns stay NULL. */
  readonly metrics?: RunMetrics
}

/** U2 (ADR section 10): the run metrics `finish` writes onto `job_collection_runs`. */
export interface RunMetrics {
  readonly requestCount: number
  readonly bytesRead: number
  /** The last answered request's HTTP status; null when no request was answered. */
  readonly lastHttpStatus: number | null
  /** sha256 hex of the first decoded response's field names; null when none was decoded. */
  readonly envelopeFingerprint: string | null
  readonly validatorsSeen: boolean
}

export interface SavedPage {
  readonly observations: readonly SourceObservation[]
  readonly checkpoint: ValidatedCheckpoint
}

const OWNER = /^[a-z0-9][a-z0-9._-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRIGGER_KEY_MAX = 200
const ERROR_MESSAGE_MAX = 500
const RESET_REASON_MAX = 500
const READ_COMMITTED = { isolationLevel: 'read committed' } as const

type Row = Record<string, unknown>

/** The database's error code, through drizzle's wrapper (`cause`) or on a raw `pg` error. */
function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } }
  const code = e.cause?.code ?? e.code
  return typeof code === 'string' ? code : undefined
}

/** A database instant as a `Date` (drizzle hands `timestamptz` back as text). Never a clock read. */
function instant(value: unknown): Date | null {
  const at = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return at !== null && Number.isFinite(at.getTime()) ? at : null
}

/** A sentinel thrown inside a transaction to roll it back with a reason, never surfaced. */
class Rollback extends Error {
  constructor(readonly reason: ManualRefusal) {
    super(reason)
  }
}

// The claim queries read `job_sources` UNALIASED, because the T4/T8 predicate they reuse
// (`dueSourcesPredicate`) is written against the table's own name.

/** The meter's account key of the source row, or NULL when it has no meter row. */
const METER_KEY = sql.raw(
  `(SELECT m.account_key FROM job_account_meters m WHERE m.id = job_sources.account_meter_id)`,
)

/** The run's account key: the meter's key, or the synthetic per-source key (T1b). */
const RUN_ACCOUNT_KEY = sql.raw(
  `COALESCE((SELECT m.account_key FROM job_account_meters m WHERE m.id = job_sources.account_meter_id), '#source:' || job_sources.id::text)`,
)

/** The "already running" term (T3): no STARTED run of this source or of its account. */
const NOT_RUNNING = sql.raw(`NOT EXISTS (SELECT 1 FROM job_collection_runs r
    WHERE r.outcome = 'STARTED' AND (r.source_id = job_sources.id OR r.account_key =
      COALESCE((SELECT m.account_key FROM job_account_meters m WHERE m.id = job_sources.account_meter_id), '#source:' || job_sources.id::text)))`)

/**
 * The busy-host FILTER (SR-M-19): no non-expired STARTED run on the source's host. A filter, not a
 * recorded refusal: a source behind a busy host is simply not picked, so a dozen of them cannot
 * exhaust the scan before a claimable source on another host is reached.
 */
const HOST_IDLE =
  sql.raw(`NOT EXISTS (SELECT 1 FROM job_collection_runs r JOIN job_sources hs ON hs.id = r.source_id
    WHERE hs.host_key = job_sources.host_key AND r.outcome = 'STARTED' AND r.lease_expires_at > clock_timestamp())`)

/**
 * The checkpoint "Crash resume" hands a new run: the latest run's (greatest epoch among those
 * `before` admits), if it has the same config version, did not succeed and did not end
 * `CURSOR_CYCLE` -- else `{}`. One expression for the claim and for `endRun`'s "a page was saved".
 */
const inheritedCheckpoint = (sourceId: SQL, configVersion: SQL, before: SQL): SQL =>
  sql`COALESCE((SELECT CASE WHEN l.config_version = ${configVersion} AND l.outcome <> 'SUCCEEDED'
                         AND l.error_code IS DISTINCT FROM 'CURSOR_CYCLE' THEN l.checkpoint END
              FROM job_collection_runs l WHERE l.source_id = ${sourceId} AND ${before}
             ORDER BY l.fencing_epoch DESC LIMIT 1), '{}'::jsonb)`

export class JobRunLedger {
  readonly options: LedgerOptions

  constructor(
    private readonly db: LedgerDb,
    private readonly registry: JobSourceRegistry,
    /** Read-only for the ledger's consumers (T7 worker, T9 listing): the one catalog it claims by. */
    readonly catalog: LedgerCatalog,
    options: Partial<LedgerOptions> = {},
  ) {
    this.options = resolveLedgerOptions(options)
  }

  // -------------------------------------------------------------------------
  // Cycles
  // -------------------------------------------------------------------------

  /**
   * `openCycle(trigger, actor?, triggerKey)` (SR-L-19): one row per `(trigger, trigger_key)` -- two
   * replicas opening the same scheduled cycle get the same id. A MANUAL cycle names its actor and a
   * SCHEDULED one has none (`ck_job_collection_cycles_manual_has_actor`), checked here first.
   */
  async openCycle(input: CycleInput): Promise<{ cycleId: string }> {
    const key = input.triggerKey
    if (typeof key !== 'string' || !/\S/.test(key) || key.length > TRIGGER_KEY_MAX) {
      throw new RangeError('openCycle: invalid trigger key')
    }
    const actor = input.trigger === 'MANUAL' ? input.actor : null
    if (input.trigger === 'MANUAL' && !(typeof actor === 'string' && UUID.test(actor))) {
      throw new RangeError('openCycle: a manual cycle names its actor')
    }
    if (input.trigger !== 'MANUAL' && input.trigger !== 'SCHEDULED') {
      throw new RangeError('openCycle: invalid trigger')
    }
    // CR-M-1: a no-op DO UPDATE, not DO NOTHING + re-SELECT -- the loser of a simultaneous insert
    // waits on the winner's row and RETURNs it; a SELECT in the same statement would read the
    // statement's old snapshot and find nothing.
    const { rows } = await this.db.execute(
      sql`INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
          VALUES (${input.trigger}::job_collection_trigger, ${key}, ${actor}::uuid)
          ON CONFLICT (trigger, trigger_key) DO UPDATE SET trigger_key = EXCLUDED.trigger_key
          RETURNING id`,
    )
    const id = rows[0]?.['id']
    if (typeof id !== 'string') throw new Error('openCycle: no cycle row')
    return { cycleId: id }
  }

  /**
   * Close a scheduled cycle at the end of its handler's window (SR-L-19): `status = 'CLOSED'` with
   * its closing instant (`ck_job_collection_cycles_closed_pair`). Idempotent -- two replicas share
   * one cycle row and the first closing instant stays. Returns whether THIS call closed it.
   */
  async closeCycle(cycleId: string): Promise<boolean> {
    if (!UUID.test(cycleId)) throw new RangeError('invalid cycle id')
    const { rows } = await this.db.execute(
      sql`UPDATE job_collection_cycles SET status = 'CLOSED', closed_at = clock_timestamp()
           WHERE id = ${cycleId}::uuid AND status = 'OPEN' RETURNING id`,
    )
    return rows.length === 1
  }

  /**
   * How many sources of the scope pass the scheduled due predicate right now, WHETHER OR NOT one
   * can be claimed this instant (a busy host, a running account). A handler's window keeps waiting
   * while this is non-zero: a source behind another replica's run is claimed once that run ends. A
   * claim refusal moves the source's `next_attempt_at` out, so a refused source stops counting --
   * except a host-timed one (`HOST_RATE_GAP`) whose slot opens within `lookaheadMs`: that source
   * counts, because the window claims it once the gap opens. `lookaheadMs` is clamped to
   * `MAX_EARLY_DUE_SLACK_MS` (10 min), the longest forward look the due predicate takes; a
   * persistent refusal is pushed `REFUSAL_RECHECK` (hours) out and never counts.
   */
  async countDue(input: {
    readonly onlyIds?: readonly string[] | undefined
    readonly onlyTypes?: readonly JobSourceType[] | undefined
    readonly lookaheadMs?: number | undefined
    /** U3: count with the sweep predicate of that cycle, minus the window's skipped sources. */
    readonly sweep?: SweepScope | undefined
  }): Promise<number> {
    const lookahead = Math.min(
      Math.max(0, Math.floor(input.lookaheadMs ?? 0)),
      MAX_EARLY_DUE_SLACK_MS,
    )
    const predicate =
      input.sweep === undefined
        ? dueSourcesPredicate('SCHEDULED', {
            maxConsecutiveFailures: this.options.maxConsecutiveFailures,
            cadenceSlackMs: lookahead,
          })
        : await this.sweepPredicate(input.sweep)
    const { rows } = await this.db.execute(
      sql`SELECT count(*)::int AS n FROM job_sources
          WHERE ${predicate} AND ${scopeOf(input.onlyIds, input.onlyTypes)}`,
    )
    return Number(rows[0]?.['n'] ?? 0)
  }

  // -------------------------------------------------------------------------
  // Claims
  // -------------------------------------------------------------------------

  /**
   * The scheduled claim (ADR "Claiming"): at most `limit` runs, in at most `maxClaimScan`
   * candidate transactions, each on ONE source picked by the due predicate with `FOR UPDATE SKIP
   * LOCKED`. A refused source joins `$tried` and its refusal is committed, so it never stays at the
   * head of the queue. `onlyIds` narrows the pick to a set of rows and has no production caller: it
   * exists so a spec on a shared database claims only its own rows (the same seam as
   * `findDueSources`).
   */
  async claimDue(input: {
    readonly cycleId: string
    readonly owner: string
    readonly limit: number
    readonly onlyIds?: readonly string[] | undefined
    /** T5: a handler claims its own type set only (API types at 05:00, HTML types at 02:30). */
    readonly onlyTypes?: readonly JobSourceType[] | undefined
    /**
     * U3: claim with the sweep predicate (ADR section 5) instead of the cadence term. Its `cycleId`
     * must be this claim's cycle.
     */
    readonly sweep?: SweepScope | undefined
  }): Promise<{ claimed: ClaimedRun[]; refused: ClaimRefused[] }> {
    this.assertOwner(input.owner)
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
      throw new RangeError('claimDue: invalid limit')
    }
    const cycle = await this.readCycle(input.cycleId)
    if (cycle.trigger !== 'SCHEDULED') throw new RangeError('claimDue: needs a scheduled cycle')
    if (input.sweep !== undefined && input.sweep.cycleId !== cycle.id) {
      throw new RangeError('claimDue: the sweep names another cycle')
    }
    const predicate =
      input.sweep === undefined
        ? dueSourcesPredicate('SCHEDULED', {
            maxConsecutiveFailures: this.options.maxConsecutiveFailures,
          })
        : await this.sweepPredicate(input.sweep)
    const claimed: ClaimedRun[] = []
    const refused: ClaimRefused[] = []
    const tried: string[] = []
    for (
      let scan = 0;
      scan < this.options.maxClaimScan && claimed.length < input.limit;
      scan += 1
    ) {
      const triedBefore = tried.length
      try {
        const step = await this.db.transaction(async (tx) => {
          const row = await this.pickDue(tx, predicate, tried, input.onlyIds, input.onlyTypes)
          if (row === undefined) return { kind: 'EMPTY' as const }
          const sourceId = String(row['id'])
          tried.push(sourceId)
          const verdict = await this.gateAndHost(tx, row, true)
          if (verdict.kind === 'REFUSED') {
            await this.writeRefusal(
              tx,
              sourceId,
              verdict.reason,
              verdict.opensAt,
              input.sweep !== undefined,
            )
            return { kind: 'REFUSED' as const, refusal: { sourceId, reason: verdict.reason } }
          }
          const run = await this.insertRun(tx, row, cycle, input.owner, verdict.adapterVersion)
          return { kind: 'CLAIMED' as const, run }
        }, READ_COMMITTED)
        if (step.kind === 'EMPTY') break
        if (step.kind === 'REFUSED') refused.push(step.refusal)
        else claimed.push(step.run)
      } catch (error) {
        // A single-flight index (23505) refused this source only: its transaction rolled back, and
        // it is already in `tried`. Anything else, or a failure before a source was picked, throws.
        if (pgCode(error) !== '23505' || tried.length === triedBefore) throw error
      }
    }
    return { claimed, refused }
  }

  /**
   * The manual claim (ADR "claimSource"): the same steps for one named source, minus the cadence
   * term and nothing else, under `lock_timeout` (SR-L-16) -- it returns a refusal rather than
   * waiting behind a `finish`. A manual refusal moves nothing.
   */
  async claimSource(input: {
    readonly cycleId: string
    readonly owner: string
    readonly sourceId: string
    readonly actor: string
  }): Promise<ManualClaim> {
    this.assertOwner(input.owner)
    if (!UUID.test(input.sourceId)) return { kind: 'REFUSED', reason: 'NOT_FOUND' }
    const cycle = await this.readCycle(input.cycleId)
    if (cycle.trigger !== 'MANUAL' || cycle.requestedBy !== input.actor) {
      throw new RangeError('claimSource: needs the actor`s own manual cycle')
    }
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('lock_timeout', ${`${this.options.claimLockTimeoutMs}ms`}, true)`,
        )
        const { rows } = await tx.execute(
          sql`SELECT job_sources.*, ${RUN_ACCOUNT_KEY} AS run_account_key, ${METER_KEY} AS meter_key,
                clock_timestamp() AS db_now,
                job_sources.enabled AS t_enabled,
                job_sources.admin_state = 'ACTIVE' AS t_active,
                job_sources.manifest_id IS NOT NULL AS t_manifest,
                job_sources.trigger_mode IN ('BOTH', 'MANUAL') AS t_trigger,
                job_sources.consecutive_failures < ${this.options.maxConsecutiveFailures} AS t_cap,
                (job_sources.cooldown_until IS NULL OR job_sources.cooldown_until <= clock_timestamp()) AS t_cool,
                ${dueSourcesPredicate('MANUAL', { maxConsecutiveFailures: this.options.maxConsecutiveFailures })} AS t_due,
                ${NOT_RUNNING} AS t_idle
              FROM job_sources WHERE job_sources.id = ${input.sourceId}::uuid FOR UPDATE OF job_sources`,
        )
        const row = rows[0]
        if (row === undefined) throw new Rollback('NOT_FOUND')
        // The kind first (AC 18): DOU is refused for being LEGACY, not for its missing manifest id.
        if (this.registry.get(row['type'] as JobSourceType)?.contract !== 'REPORTING') {
          throw new Rollback('NOT_ACTIVATABLE')
        }
        const term = manualTermRefusal(row)
        if (term !== null) throw new Rollback(term)
        const verdict = await this.gateAndHost(tx, row, false)
        if (verdict.kind === 'REFUSED') throw new Rollback(verdict.reason)
        const run = await this.insertRun(tx, row, cycle, input.owner, verdict.adapterVersion)
        return { kind: 'CLAIMED' as const, run }
      }, READ_COMMITTED)
    } catch (error) {
      if (error instanceof Rollback) return { kind: 'REFUSED', reason: error.reason }
      const code = pgCode(error)
      if (code === '55P03') return { kind: 'REFUSED', reason: 'LOCK_TIMEOUT' }
      if (code === '23505') return { kind: 'REFUSED', reason: 'CONFLICT' }
      throw error
    }
  }

  /** Task 4.6 S6c: the LEGACY (DOU) claim, `claimLegacy` in `legacy-run-claim.ts` (ADR D-1). */
  async claimLegacyRun(input: LegacyClaimInput): Promise<ManualClaim> {
    this.assertOwner(input.owner)
    if (!UUID.test(input.sourceId)) return { kind: 'REFUSED', reason: 'NOT_FOUND' }
    return claimLegacy(input, {
      db: this.db,
      registry: this.registry,
      lockTimeoutMs: this.options.claimLockTimeoutMs,
      runAccountKey: RUN_ACCOUNT_KEY,
      readCycle: (id) => this.readCycle(id),
      insertRun: (tx, row, cycle, version) => this.insertRun(tx, row, cycle, input.owner, version),
      sqlState: pgCode,
    })
  }

  /** Step 1 of a scheduled claim: one due source, locked, skipping the ones already tried. */
  private async pickDue(
    tx: DrizzleTx,
    predicate: SQL,
    tried: readonly string[],
    onlyIds: readonly string[] | undefined,
    onlyTypes: readonly JobSourceType[] | undefined,
  ): Promise<Row | undefined> {
    const scope = scopeOf(onlyIds, onlyTypes)
    const { rows } = await tx.execute(
      sql`SELECT job_sources.*, ${RUN_ACCOUNT_KEY} AS run_account_key, ${METER_KEY} AS meter_key,
            clock_timestamp() AS db_now
          FROM job_sources
          WHERE ${predicate}
            AND ${NOT_RUNNING} AND ${HOST_IDLE}
            AND NOT (job_sources.id = ANY(${toUuidArray(tried)})) AND ${scope}
          ORDER BY job_sources.next_attempt_at, job_sources.id
          FOR UPDATE OF job_sources SKIP LOCKED
          LIMIT 1`,
    )
    return rows[0]
  }

  /**
   * U3: the sweep predicate (ADR section 5) narrowed to the sweepable manifest entries
   * (`isSweepable`: an interval profile, no fixed slots) and minus the window's skipped sources.
   * The profile lives in code, so the entries are resolved here from the stored manifest ids.
   *
   * CR-M-1 / SR-M-1 / CR-M-3: a source is swept ONCE around the sweep (ADR section 5 as amended by
   * Master). The sweep also skips a source with ANY run (any cycle) started since
   * `SWEEP_RECENT_RUN_MS` (19 min) before the sweep cycle opened (the 07:50 tick, wherever in its
   * window it claimed, and every later tick), or inside its provider floor
   * (`floorHours`, which a cadence-free claim would otherwise bypass).
   */
  private async sweepPredicate(sweep: SweepScope): Promise<SQL> {
    const { rows } = await this.db.execute(
      sql`SELECT DISTINCT manifest_id FROM job_sources WHERE manifest_id IS NOT NULL`,
    )
    // The query excludes NULL; an id the catalog does not know is not sweepable (fail closed).
    const ids: string[] = []
    const floors: number[] = []
    for (const id of rows.map((r) => String(r['manifest_id']))) {
      const entry = this.catalog.entry(id)
      if (!isSweepable(entry)) continue
      ids.push(id)
      floors.push(Math.ceil(entry.floorHours * 60))
    }
    const due = dueSourcesPredicate('SCHEDULED', {
      maxConsecutiveFailures: this.options.maxConsecutiveFailures,
      sweepCycleId: sweep.cycleId,
    })
    return sql`${due} AND job_sources.manifest_id = ANY(${toTextArray(ids)})
      AND NOT (job_sources.id = ANY(${toUuidArray(sweep.skipIds)}))
      AND NOT EXISTS (SELECT 1 FROM job_collection_runs rr
        WHERE rr.source_id = job_sources.id
          AND (rr.started_at >= (SELECT c.started_at FROM job_collection_cycles c WHERE c.id = ${sweep.cycleId}::uuid)
                 - make_interval(secs => ${SWEEP_RECENT_RUN_MS / 1000})
               OR rr.started_at > clock_timestamp() - make_interval(mins => (
                 SELECT f.minutes FROM unnest(${toTextArray(ids)}, ${toIntArray(floors)}) AS f(id, minutes)
                  WHERE f.id = job_sources.manifest_id))))`
  }

  /** Steps 2 and 3 on the locked row: the gates, then T8's host slot with the CATALOG's policy. */
  private async gateAndHost(
    tx: DrizzleTx,
    row: Row,
    scheduled: boolean,
  ): Promise<
    | { kind: 'GRANTED'; adapterVersion: string }
    | { kind: 'REFUSED'; reason: ClaimRefusal; opensAt: Date | null }
  > {
    const type = row['type'] as JobSourceType
    const adapter = this.registry.get(type)
    const manifestId = row['manifest_id']
    const entry = typeof manifestId === 'string' ? this.catalog.entry(manifestId) : undefined
    const dbNow = instant(row['db_now'])
    if (dbNow === null) throw new Error('claim: the database clock was unreadable')
    const meterKey = typeof row['meter_key'] === 'string' ? row['meter_key'] : null
    const gate = claimGate({ adapter, entry, dbNow, meterKey, scheduled })
    if (gate !== null) return { kind: 'REFUSED', reason: gate, opensAt: null }
    const hostKey = row['host_key']
    const policy = typeof hostKey === 'string' ? this.catalog.hostPolicy(hostKey) : undefined
    if (policy === undefined) return { kind: 'REFUSED', reason: 'HOST_KEY_MISSING', opensAt: null }
    const slot = await claimHostSlot(tx, hostKey as string, policy)
    if (!slot.granted) return { kind: 'REFUSED', reason: slot.reason, opensAt: slot.opensAt }
    // claimGate refused any adapter that is not REPORTING with a version.
    return {
      kind: 'GRANTED',
      adapterVersion: (adapter as { adapterVersion: string }).adapterVersion,
    }
  }

  /**
   * The refusal write-back of a SCHEDULED claim; never touches `consecutive_failures`. A SWEEP
   * refusal never moves `next_attempt_at` EARLIER (SR-M-1): the sweep picks sources that are not
   * due by their own slot, and pulling one forward to a host gap would hand it to the next tick,
   * a second run beside the sweep's own retry.
   */
  private async writeRefusal(
    tx: DrizzleTx,
    sourceId: string,
    reason: ClaimRefusal,
    opensAt: Date | null,
    swept: boolean,
  ): Promise<void> {
    const write = refusalWrite(reason, opensAt)
    if (write.kind === 'NONE') return
    const moved =
      write.kind === 'UNTIL'
        ? sql`${write.at.toISOString()}::timestamptz`
        : sql`clock_timestamp() + make_interval(secs => ${this.options.refusalRecheckMs / 1000})`
    const next =
      write.kind === 'NEVER'
        ? sql`NULL::timestamptz`
        : swept
          ? sql`GREATEST(job_sources.next_attempt_at, ${moved})`
          : moved
    await tx.execute(
      sql`UPDATE job_sources SET last_error_code = ${reason}, next_attempt_at = ${next}, updated_at = clock_timestamp() WHERE id = ${sourceId}::uuid`,
    )
  }

  /**
   * Step 4: insert the run. Fresh attempt id and owner token; epoch = the source's greatest + 1;
   * a lease of `L`, never past `RUN_MAX_AGE`; the account key read under the claim's locks; and
   * the checkpoint "Crash resume" chooses: the LATEST run's (greatest epoch), if it has the same
   * config version, did not succeed and did not end `CURSOR_CYCLE` -- else a fresh start.
   */
  private async insertRun(
    tx: DrizzleTx,
    row: Row,
    cycle: { id: string; trigger: string },
    owner: string,
    adapterVersion: string,
  ): Promise<ClaimedRun> {
    const sourceId = String(row['id'])
    const attemptId = `${RUN_ATTEMPT_PREFIX}${randomUUID()}`
    const ownerToken = `${owner}:${randomUUID()}`
    const leaseS = this.options.leaseMs / 1000
    const maxAgeS = this.options.runMaxAgeMs / 1000
    const { rows } = await tx.execute(
      sql`INSERT INTO job_collection_runs (source_id, cycle_id, attempt_id, config_version,
            source_config_snapshot, adapter_version, trigger, owner_token, fencing_epoch,
            lease_expires_at, checkpoint, account_key)
          SELECT s.id, ${cycle.id}::uuid, ${attemptId}, s.config_version, s.config, ${adapterVersion},
            ${cycle.trigger}::job_collection_trigger, ${ownerToken},
            COALESCE((SELECT max(r.fencing_epoch) FROM job_collection_runs r WHERE r.source_id = s.id), 0) + 1,
            LEAST(clock_timestamp() + make_interval(secs => ${leaseS}), now() + make_interval(secs => ${maxAgeS})),
            ${inheritedCheckpoint(sql`s.id`, sql`s.config_version`, sql`true`)},
            ${String(row['run_account_key'])}
          FROM job_sources s WHERE s.id = ${sourceId}::uuid
          RETURNING id, fencing_epoch, checkpoint, account_key`,
    )
    const run = rows[0]
    if (run === undefined) throw new Error('claim: the run insert returned no row')
    await tx.execute(
      sql`UPDATE job_sources SET last_attempt_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = ${sourceId}::uuid`,
    )
    const cp = run['checkpoint']
    const empty = cp === null || (typeof cp === 'object' && Object.keys(cp as object).length === 0)
    return {
      runId: String(run['id']),
      ownerToken,
      fencingEpoch: Number(run['fencing_epoch']),
      sourceId,
      cycleId: cycle.id,
      attemptId,
      accountKey: String(run['account_key']),
      sourceType: row['type'] as JobSourceType,
      checkpoint: empty ? null : cp,
    }
  }

  private async readCycle(
    cycleId: string,
  ): Promise<{ id: string; trigger: string; requestedBy: string | null }> {
    if (!UUID.test(cycleId)) throw new RangeError('invalid cycle id')
    const { rows } = await this.db.execute(
      sql`SELECT id, trigger, requested_by FROM job_collection_cycles WHERE id = ${cycleId}::uuid AND status = 'OPEN'`,
    )
    const c = rows[0]
    if (c === undefined) throw new RangeError('no open cycle with that id')
    return {
      id: String(c['id']),
      trigger: String(c['trigger']),
      requestedBy: c['requested_by'] === null ? null : String(c['requested_by']),
    }
  }

  private assertOwner(owner: string): void {
    if (typeof owner !== 'string' || !OWNER.test(owner)) throw new RangeError('invalid owner')
  }

  // -------------------------------------------------------------------------
  // A running run
  // -------------------------------------------------------------------------

  /**
   * Extend the lease (SR-M-18: never past `started_at + RUN_MAX_AGE`). False when nothing changed:
   * the executor is fenced out and must abort its signal with `RUN_FENCED`.
   */
  async heartbeat(h: RunHandle): Promise<boolean> {
    if (!isWellFormedHandle(h)) return false
    const { rows } = await this.db.execute(
      sql`UPDATE job_collection_runs
             SET lease_expires_at = LEAST(clock_timestamp() + make_interval(secs => ${this.options.leaseMs / 1000}),
                                          started_at + make_interval(secs => ${this.options.runMaxAgeMs / 1000}))
           WHERE ${ownershipPredicate(h)} RETURNING 1 AS ok`,
    )
    return rows.length === 1
  }

  /**
   * The meter binding of a claimed run (what T7 hands the adapter): bound to the run's OWN account
   * key, attempt and ownership, so every reserve / markSent / reconcile is fenced.
   */
  meterFor(run: ClaimedRun, windows: Partial<Record<JobMeterUnit, JobMeterWindow>>): AccountMeter {
    return createAccountMeter(this.db, {
      accountKey: run.accountKey,
      windows,
      attemptId: run.attemptId,
      cycleId: run.cycleId,
      runId: run.runId,
      ownerToken: run.ownerToken,
      fencingEpoch: run.fencingEpoch,
    })
  }

  // -------------------------------------------------------------------------
  // Ending a run
  // -------------------------------------------------------------------------

  /**
   * End a run the executor still owns: settle its open reservations, make the terminal transition,
   * and write `job_sources` per "Failure accounting". Fenced -> `RunFencedError`; recovery ends that
   * run. `finish` never writes a host ban.
   */
  async finish(h: RunHandle, ending: RunEnding): Promise<void> {
    validateEnding(ending.outcome, ending.errorCode)
    if (!isWellFormedHandle(h)) throw new RunFencedError('a malformed run handle owns nothing')
    const head = await this.runHead(h.runId)
    if (head === undefined) throw new RunFencedError()
    await this.db.transaction(async (tx) => {
      const ended = await this.endRun(tx, head, ownershipPredicate(h), ending)
      if (!ended) throw new RunFencedError()
    }, READ_COMMITTED)
  }

  /**
   * End every run whose lease expired: `FAILED` / `LEASE_EXPIRED`, settled like `finish`, one
   * transaction per run; a run that changed since it was read (finished, or its lease renewed) is
   * skipped under its lock. Returns how many were recovered.
   */
  async recoverExpired(): Promise<number> {
    const { rows } = await this.db.execute(
      sql`SELECT id FROM job_collection_runs WHERE outcome = 'STARTED' AND lease_expires_at < clock_timestamp() ORDER BY lease_expires_at LIMIT 500`,
    )
    let recovered = 0
    for (const r of rows) {
      const head = await this.runHead(String(r['id']))
      if (head === undefined) continue
      const ended = await this.db.transaction(
        (tx) =>
          this.endRun(
            tx,
            head,
            sql`id = ${head.runId}::uuid AND outcome = 'STARTED' AND lease_expires_at < clock_timestamp()`,
            { outcome: 'FAILED', errorCode: 'LEASE_EXPIRED', errorMessage: 'the lease expired' },
          ),
        READ_COMMITTED,
      )
      if (ended) recovered += 1
    }
    return recovered
  }

  /**
   * Backstop to `finish` and recovery: any open reservation whose run is terminal is settled by the
   * end-of-run rules, one run per transaction. Returns how many reservations were settled.
   */
  async sweepOrphanReservations(): Promise<number> {
    const { rows } = await this.db.execute(
      sql`SELECT DISTINCT r.id, r.account_key FROM job_account_meter_reservations res
            JOIN job_collection_runs r ON r.id = res.run_id
           WHERE r.outcome <> 'STARTED' AND res.status IN ('RESERVED', 'SENT', 'UNCERTAIN')
           LIMIT 500`,
    )
    let settled = 0
    for (const r of rows) {
      settled += await this.db.transaction(async (tx) => {
        const meters = await lockAccountMeters(tx, String(r['account_key']))
        return settleRunReservations(tx, String(r['id']), meters)
      }, READ_COMMITTED)
    }
    return settled
  }

  /** The immutable facts of a run, read without a lock (written once at insert). */
  private async runHead(
    runId: string,
  ): Promise<{ runId: string; sourceId: string; accountKey: string } | undefined> {
    const { rows } = await this.db.execute(
      sql`SELECT id, source_id, account_key FROM job_collection_runs WHERE id = ${runId}::uuid`,
    )
    const r = rows[0]
    if (r === undefined) return undefined
    return {
      runId: String(r['id']),
      sourceId: String(r['source_id']),
      accountKey: String(r['account_key']),
    }
  }

  /**
   * The shared body of `finish` and recovery, in the table's lock order: the source row, the
   * account's meters (by id), the run row under `runPredicate`, then its reservations. False when
   * the run no longer matches the predicate (fenced, already ended, lease renewed).
   */
  private async endRun(
    tx: DrizzleTx,
    head: { runId: string; sourceId: string; accountKey: string },
    runPredicate: SQL,
    ending: RunEnding,
  ): Promise<boolean> {
    const { rows: src } = await tx.execute(
      sql`SELECT type, manifest_id, consecutive_failures, slowdown_level FROM job_sources WHERE id = ${head.sourceId}::uuid FOR UPDATE`,
    )
    const source = src[0]
    if (source === undefined) throw new Error('endRun: the run`s source vanished')
    const meters = await lockAccountMeters(tx, head.accountKey)
    // "A page was saved" (SR-M-22) from what only a page write (`writePageProgress`) writes (SR-M-1): observations
    // received, or a checkpoint moved off the one the claim inherited. Never `updated_at`.
    const { rows: locked } = await tx.execute(
      sql`SELECT r.received, (r.received > 0 OR r.checkpoint IS DISTINCT FROM
                 ${inheritedCheckpoint(sql`r.source_id`, sql`r.config_version`, sql`l.fencing_epoch < r.fencing_epoch`)}) AS paged
            FROM job_collection_runs r WHERE ${runPredicate} FOR UPDATE OF r`,
    )
    const run = locked[0]
    if (run === undefined) return false
    await settleRunReservations(tx, head.runId, meters)
    // U1b: the database clock, read ONCE after every lock is held, is both the run's `ended_at` and
    // the `now` its next slot is computed from (ADR U1b).
    const { rows: clock } = await tx.execute(sql`SELECT clock_timestamp() AS db_now`)
    const dbNow = instant(clock[0]?.['db_now'])
    if (dbNow === null) throw new Error('endRun: the database clock was unreadable')
    const endedAt = sql`${dbNow.toISOString()}::timestamptz`
    const message =
      ending.errorMessage === undefined || ending.errorMessage === null
        ? null
        : ending.errorMessage.slice(0, ERROR_MESSAGE_MAX)
    const m = ending.metrics
    await tx.execute(
      sql`UPDATE job_collection_runs
             SET outcome = ${ending.outcome}::job_collection_outcome, error_code = ${ending.errorCode},
                 error_message = ${message}, ended_at = ${endedAt}, updated_at = clock_timestamp(),
                 request_count = ${m?.requestCount ?? null}::integer, bytes_read = ${m?.bytesRead ?? null}::bigint,
                 last_http_status = ${m?.lastHttpStatus ?? null}::smallint,
                 envelope_fingerprint = ${m?.envelopeFingerprint ?? null}::text,
                 validators_seen = ${m?.validatorsSeen ?? null}::boolean
           WHERE id = ${head.runId}::uuid`,
    )
    await this.account(tx, head, source, ending, {
      dbNow,
      paged: run['paged'] === true,
      nonEmpty: Number(run['received']) > 0,
    })
    return true
  }

  /** "Failure accounting": write `job_sources` by how the run ended (the source row is locked). */
  private async account(
    tx: DrizzleTx,
    head: { sourceId: string; accountKey: string },
    source: Row,
    ending: RunEnding,
    at: { dbNow: Date; paged: boolean; nonEmpty: boolean },
  ): Promise<void> {
    // Task 4.6 S6c (ADR Q5): a LEGACY run ends on its run row only -- no cap, no backoff (SR-M-17).
    if (isLegacyKind(this.registry.get(source['type'] as JobSourceType))) return
    const { paged, nonEmpty } = at
    const manifestId = source['manifest_id']
    const entry = typeof manifestId === 'string' ? this.catalog.entry(manifestId) : undefined
    const effect = endingEffect(ending.outcome, ending.errorCode, paged)
    // U2 (ADR section 4): the level this ending moves the source to, and the slot it produces.
    const level = nextSlowdownLevel(Number(source['slowdown_level']), ending.errorCode, effect)
    // U1b: the entry's next slot (`nextSlot`), never `min_interval_hours`; NULL for a null profile,
    // which the due predicate never selects ("A NULL next_attempt_at is not due").
    const slot = nextAttemptAt(at.dbNow, String(manifestId), entry, level)
    const cadence = slot === null ? sql`NULL::timestamptz` : sql`${slot.toISOString()}::timestamptz`
    const id = head.sourceId
    if (effect === 'SUCCESS') {
      await tx.execute(
        sql`UPDATE job_sources SET consecutive_failures = 0, cooldown_until = NULL, next_attempt_at = ${cadence},
              slowdown_level = ${level},
              last_success_at = clock_timestamp(),
              last_nonempty_at = CASE WHEN ${nonEmpty} THEN clock_timestamp() ELSE last_nonempty_at END,
              last_error_code = NULL, last_error_message = NULL, updated_at = clock_timestamp()
            WHERE id = ${id}::uuid`,
      )
      return
    }
    if (effect === 'FAILURE') {
      const failures = Number(source['consecutive_failures']) + 1
      const backoffS =
        backoffMs(failures, this.options.backoffBaseMs, this.options.backoffMaxMs) / 1000
      await tx.execute(
        sql`UPDATE job_sources SET consecutive_failures = consecutive_failures + 1,
              cooldown_until = clock_timestamp() + make_interval(secs => ${backoffS}),
              next_attempt_at = ${cadence}, last_error_code = ${ending.errorCode},
              slowdown_level = ${level}, updated_at = clock_timestamp()
            WHERE id = ${id}::uuid`,
      )
      return
    }
    // Compile-time exhaustiveness: a new EndingEffect fails here until it is given its own write.
    const remaining: 'NEUTRAL' | 'COST_STOP' = effect
    const next =
      // GREATEST ignores a NULL, so a null-profile source must not reach it: it stays unscheduled.
      remaining === 'COST_STOP' && slot !== null
        ? sql`GREATEST(${cadence}, (SELECT max(m.resets_at) FROM job_account_meters m WHERE m.account_key = ${head.accountKey}))`
        : cadence
    await tx.execute(
      sql`UPDATE job_sources SET next_attempt_at = ${next}, last_error_code = ${ending.errorCode},
            updated_at = clock_timestamp()
          WHERE id = ${id}::uuid`,
    )
  }

  // -------------------------------------------------------------------------
  // ADMIN exit (T9 calls it)
  // -------------------------------------------------------------------------

  /**
   * Reset a source's failure cap (SR-L-25): counter 0, no cooldown, due now, and ONE
   * `RESET_FAILURES` entry appended to `admin_state_history` IN SQL (`|| jsonb_build_array(…)`),
   * never read-modify-write, so a concurrent admin-state toggle's append survives. RBAC is the
   * caller's (T9). False for an unknown source.
   */
  async resetFailures(input: {
    readonly sourceId: string
    readonly actor: string
    readonly reason: string
  }): Promise<boolean> {
    if (!UUID.test(input.sourceId) || !UUID.test(input.actor)) {
      throw new RangeError('resetFailures: invalid id')
    }
    const reason = input.reason
    if (typeof reason !== 'string' || !/\S/.test(reason) || reason.length > RESET_REASON_MAX) {
      throw new RangeError('resetFailures: a reason of 1..500 characters is required')
    }
    const { rows } = await this.db.transaction(
      (tx) =>
        tx.execute(
          sql`UPDATE job_sources
                 SET consecutive_failures = 0, cooldown_until = NULL, next_attempt_at = clock_timestamp(),
                     admin_state_history = admin_state_history || jsonb_build_array(jsonb_build_object(
                       'kind', 'RESET_FAILURES', 'actor', ${input.actor}::text, 'at', clock_timestamp(),
                       'reason', ${reason}::text)),
                     updated_at = clock_timestamp()
               WHERE id = ${input.sourceId}::uuid RETURNING 1 AS ok`,
        ),
      READ_COMMITTED,
    )
    return rows.length === 1
  }
}

/**
 * A page's checkpoint and counters, inside the caller's transaction (r5 Task 4.5: the record
 * store's page write). It lives here so the ledger stays the one writer of `job_collection_runs`
 * (write-gate.spec.ts). FENCED BY CONSTRUCTION (SR-M-1 / CR-M-1): it takes the `OwnedRun` that
 * `assertOwned` returned for this handle AND repeats the ownership predicate in its WHERE, so a
 * stale handle updates nothing and gets `RunFencedError`. Since Task 4.6 it is the ONLY writer of a
 * page's counters (the ledger's own `savePage` was folded onto the store).
 *
 * `checkpoint: null` keeps the stored checkpoint and adds only the counters: the worker splits a
 * page above the store's cap into chunks and moves the checkpoint with the LAST chunk only, so a
 * crash between chunks resumes from the page, never past it.
 */
export async function writePageProgress(
  tx: SqlExecutor,
  h: RunHandle,
  owned: OwnedRun,
  page: {
    checkpoint: ValidatedCheckpoint | null
    received: number
    unique: number
    created: number
    /** U2: the newest `published_at` among the page's observations; null when none carried one. */
    newestPublishedAt: Date | null
  },
): Promise<void> {
  if (owned.runId !== h.runId) throw new RunFencedError('the owned run is not this handle`s run')
  const checkpoint =
    page.checkpoint === null
      ? null
      : JSON.stringify(validatedCheckpointSchema.parse(page.checkpoint))
  const newest = page.newestPublishedAt?.toISOString() ?? null
  // GREATEST ignores a NULL on either side, so the column keeps the newest instant any page saw.
  const { rows } = await tx.execute(
    sql`UPDATE job_collection_runs
           SET checkpoint = COALESCE(${checkpoint}::jsonb, checkpoint), received = received + ${page.received},
               created = created + ${page.created}, unchanged = unchanged + ${page.unique - page.created},
               duplicates = duplicates + ${page.received - page.unique}, updated_at = clock_timestamp(),
               newest_item_published_at = GREATEST(newest_item_published_at, ${newest}::timestamptz)
         WHERE ${ownershipPredicate(h)} RETURNING 1 AS ok`,
  )
  if (rows.length !== 1) throw new RunFencedError()
}

/** The `onlyIds` / `onlyTypes` narrowing of a scheduled pick or count; absent = no narrowing. */
function scopeOf(
  onlyIds: readonly string[] | undefined,
  onlyTypes: readonly JobSourceType[] | undefined,
): SQL {
  const ids = onlyIds === undefined ? sql`true` : sql`job_sources.id = ANY(${toUuidArray(onlyIds)})`
  const types =
    onlyTypes === undefined
      ? sql`true`
      : sql`job_sources.type::text = ANY(${toTypeArray(onlyTypes)})`
  return sql`${ids} AND ${types}`
}

function toTypeArray(types: readonly string[]): SQL {
  for (const t of types) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(t)) throw new RangeError('not a type')
  return sql`${`{${types.join(',')}}`}::text[]`
}

/** A text[] parameter as an array literal, every element quoted and escaped. Exported for its spec. */
export function toTextArray(values: readonly string[]): SQL {
  const quoted = values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`)
  return sql`${`{${quoted.join(',')}}`}::text[]`
}

/** An int[] parameter. The callers pass whole minutes; anything else fails in Postgres's cast. */
function toIntArray(values: readonly number[]): SQL {
  return sql`${`{${values.join(',')}}`}::int[]`
}

/** A uuid[] parameter: drizzle would spread a JS array into a row constructor, so pass it as text. */
function toUuidArray(ids: readonly string[]): SQL {
  for (const id of ids) if (!UUID.test(id)) throw new RangeError('not a uuid')
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}
