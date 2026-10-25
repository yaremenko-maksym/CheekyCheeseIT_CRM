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
import { dueSourcesPredicate } from '../scheduling/due-sources.query'
import { cadenceHoursAtFloor, claimHostSlot } from '../scheduling/host-state'
import type { LedgerCatalog } from './ledger-catalog'
import {
  type ClaimRefusal,
  type LedgerOptions,
  type RunEndOutcome,
  backoffMs,
  claimGate,
  endingEffect,
  refusalWrite,
  resolveLedgerOptions,
  validateEnding,
} from './ledger-policy'
import {
  type RunHandle,
  RunFencedError,
  assertOwned,
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
 * !! MERGING THIS MAKES NO SOURCE RUNNABLE: nothing in production constructs a ledger until T7, and
 * no adapter declares `allowedHosts` until T6, so every claim is refused `TRANSPORT_NOT_WIRED`.
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

/** Why `claimSource` refused, beyond the gates: the due predicate's own terms, a lock, a race. */
export type ManualRefusal =
  | ClaimRefusal
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'NOT_ACTIVE'
  | 'NO_MANIFEST_ENTRY'
  | 'TRIGGER_MODE'
  | 'FAILURE_CAP'
  | 'COOLING_DOWN'
  | 'ALREADY_RUNNING'
  | 'LOCK_TIMEOUT'
  | 'CONFLICT'

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

export class JobRunLedger {
  readonly options: LedgerOptions

  constructor(
    private readonly db: LedgerDb,
    private readonly registry: JobSourceRegistry,
    private readonly catalog: LedgerCatalog,
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
    const { rows } = await this.db.execute(
      sql`WITH ins AS (
            INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
            VALUES (${input.trigger}::job_collection_trigger, ${key}, ${actor}::uuid)
            ON CONFLICT (trigger, trigger_key) DO NOTHING RETURNING id)
          SELECT id FROM ins
          UNION ALL
          SELECT id FROM job_collection_cycles WHERE trigger = ${input.trigger}::job_collection_trigger AND trigger_key = ${key}
          LIMIT 1`,
    )
    const id = rows[0]?.['id']
    if (typeof id !== 'string') throw new Error('openCycle: no cycle row')
    return { cycleId: id }
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
    readonly onlyIds?: readonly string[]
  }): Promise<{ claimed: ClaimedRun[]; refused: ClaimRefused[] }> {
    this.assertOwner(input.owner)
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
      throw new RangeError('claimDue: invalid limit')
    }
    const cycle = await this.readCycle(input.cycleId)
    if (cycle.trigger !== 'SCHEDULED') throw new RangeError('claimDue: needs a scheduled cycle')
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
          const row = await this.pickDue(tx, tried, input.onlyIds)
          if (row === undefined) return { kind: 'EMPTY' as const }
          const sourceId = String(row['id'])
          tried.push(sourceId)
          const verdict = await this.gateAndHost(tx, row)
          if (verdict.kind === 'REFUSED') {
            await this.writeRefusal(tx, sourceId, verdict.reason, verdict.opensAt)
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
        const term = manualTermRefusal(row)
        if (term !== null) throw new Rollback(term)
        const verdict = await this.gateAndHost(tx, row)
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

  /** Step 1 of a scheduled claim: one due source, locked, skipping the ones already tried. */
  private async pickDue(
    tx: DrizzleTx,
    tried: readonly string[],
    onlyIds: readonly string[] | undefined,
  ): Promise<Row | undefined> {
    const scope =
      onlyIds === undefined ? sql`true` : sql`job_sources.id = ANY(${toUuidArray(onlyIds)})`
    const { rows } = await tx.execute(
      sql`SELECT job_sources.*, ${RUN_ACCOUNT_KEY} AS run_account_key, ${METER_KEY} AS meter_key,
            clock_timestamp() AS db_now
          FROM job_sources
          WHERE ${dueSourcesPredicate('SCHEDULED', { maxConsecutiveFailures: this.options.maxConsecutiveFailures })}
            AND ${NOT_RUNNING} AND ${HOST_IDLE}
            AND NOT (job_sources.id = ANY(${toUuidArray(tried)})) AND ${scope}
          ORDER BY job_sources.next_attempt_at, job_sources.id
          FOR UPDATE OF job_sources SKIP LOCKED
          LIMIT 1`,
    )
    return rows[0]
  }

  /** Steps 2 and 3 on the locked row: the gates, then T8's host slot with the CATALOG's policy. */
  private async gateAndHost(
    tx: DrizzleTx,
    row: Row,
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
    const gate = claimGate({ adapter, entry, dbNow, meterKey })
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

  /** The refusal write-back of a SCHEDULED claim; never touches `consecutive_failures`. */
  private async writeRefusal(
    tx: DrizzleTx,
    sourceId: string,
    reason: ClaimRefusal,
    opensAt: Date | null,
  ): Promise<void> {
    const write = refusalWrite(reason, opensAt)
    if (write.kind === 'NONE') return
    const next =
      write.kind === 'UNTIL'
        ? sql`${write.at.toISOString()}::timestamptz`
        : sql`clock_timestamp() + make_interval(secs => ${this.options.refusalRecheckMs / 1000})`
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
    const attemptId = `run-${randomUUID()}`
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
            COALESCE((SELECT CASE WHEN l.config_version = s.config_version AND l.outcome <> 'SUCCEEDED'
                                   AND l.error_code IS DISTINCT FROM 'CURSOR_CYCLE' THEN l.checkpoint END
                        FROM job_collection_runs l WHERE l.source_id = s.id
                       ORDER BY l.fencing_epoch DESC LIMIT 1), '{}'::jsonb),
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

  /**
   * Persist one page's observations AND its checkpoint, together, under `assertOwned` ("Crash
   * resume"). Records are upserted in ascending natural-key order (namespace, identity key), so two
   * runs whose records overlap lock them in the same order. Only the identity row is written here;
   * revisions belong to the observation store.
   */
  async savePage(h: RunHandle, page: SavedPage): Promise<void> {
    const checkpoint = validatedCheckpointSchema.parse(page.checkpoint)
    const seen = new Set<string>()
    const unique: SourceObservation['identity'][] = []
    for (const o of page.observations) {
      const k = JSON.stringify([o.identity.namespace, o.identity.identityKey])
      if (seen.has(k)) continue
      seen.add(k)
      unique.push(o.identity)
    }
    unique.sort((a, b) =>
      a.namespace === b.namespace
        ? compare(a.identityKey, b.identityKey)
        : compare(a.namespace, b.namespace),
    )
    await this.db.transaction(async (tx) => {
      const owned = await assertOwned(tx, h)
      const { rows: src } = await tx.execute(
        sql`SELECT type FROM job_sources WHERE id = ${owned.sourceId}::uuid`,
      )
      const type = src[0]?.['type']
      let created = 0
      for (const id of unique) {
        if (id.provider !== type)
          throw new RangeError('savePage: an observation of another source type')
        const { rows } = await tx.execute(
          sql`INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
              VALUES (${id.provider}::job_source_type, ${id.namespace}, ${id.identityKind}::job_identity_kind, ${id.identityKey})
              ON CONFLICT (source_type, namespace, identity_key)
              DO UPDATE SET last_observed_at = clock_timestamp(), updated_at = clock_timestamp()
              RETURNING (xmax = 0) AS inserted`,
        )
        if (rows[0]?.['inserted'] === true) created += 1
      }
      const received = page.observations.length
      await tx.execute(
        sql`UPDATE job_collection_runs
               SET checkpoint = ${JSON.stringify(checkpoint)}::jsonb,
                   received = received + ${received},
                   created = created + ${created},
                   unchanged = unchanged + ${unique.length - created},
                   duplicates = duplicates + ${received - unique.length},
                   updated_at = clock_timestamp()
             WHERE id = ${owned.runId}::uuid`,
      )
    }, READ_COMMITTED)
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
      sql`SELECT manifest_id, min_interval_hours, consecutive_failures FROM job_sources WHERE id = ${head.sourceId}::uuid FOR UPDATE`,
    )
    const source = src[0]
    if (source === undefined) throw new Error('endRun: the run`s source vanished')
    const meters = await lockAccountMeters(tx, head.accountKey)
    const { rows: locked } = await tx.execute(
      sql`SELECT received, updated_at > created_at AS paged FROM job_collection_runs WHERE ${runPredicate} FOR UPDATE`,
    )
    const run = locked[0]
    if (run === undefined) return false
    await settleRunReservations(tx, head.runId, meters)
    const message =
      ending.errorMessage === undefined || ending.errorMessage === null
        ? null
        : ending.errorMessage.slice(0, ERROR_MESSAGE_MAX)
    await tx.execute(
      sql`UPDATE job_collection_runs
             SET outcome = ${ending.outcome}::job_collection_outcome, error_code = ${ending.errorCode},
                 error_message = ${message}, ended_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = ${head.runId}::uuid`,
    )
    await this.account(tx, head, source, ending, run['paged'] === true, Number(run['received']) > 0)
    return true
  }

  /** "Failure accounting": write `job_sources` by how the run ended (the source row is locked). */
  private async account(
    tx: DrizzleTx,
    head: { sourceId: string; accountKey: string },
    source: Row,
    ending: RunEnding,
    paged: boolean,
    nonEmpty: boolean,
  ): Promise<void> {
    const manifestId = source['manifest_id']
    const entry = typeof manifestId === 'string' ? this.catalog.entry(manifestId) : undefined
    const stored = source['min_interval_hours']
    const { hours } = cadenceHoursAtFloor(
      typeof stored === 'number' ? stored : null,
      entry?.floorHours ?? 0,
      entry?.intervalHours ?? 24,
    )
    const cadence = sql`clock_timestamp() + make_interval(hours => ${hours})`
    const effect = endingEffect(ending.outcome, ending.errorCode, paged)
    const id = head.sourceId
    if (effect === 'SUCCESS') {
      await tx.execute(
        sql`UPDATE job_sources SET consecutive_failures = 0, cooldown_until = NULL, next_attempt_at = ${cadence},
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
              updated_at = clock_timestamp()
            WHERE id = ${id}::uuid`,
      )
      return
    }
    const next =
      effect === 'COST_STOP'
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

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A uuid[] parameter: drizzle would spread a JS array into a row constructor, so pass it as text. */
function toUuidArray(ids: readonly string[]): SQL {
  for (const id of ids) if (!UUID.test(id)) throw new RangeError('not a uuid')
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/** The first failing term of the manual due predicate, in `isDue`'s order, or null if all pass. */
export function manualTermRefusal(row: Row): ManualRefusal | null {
  if (row['t_enabled'] !== true) return 'DISABLED'
  if (row['t_active'] !== true) return 'NOT_ACTIVE'
  if (row['t_manifest'] !== true) return 'NO_MANIFEST_ENTRY'
  if (row['t_trigger'] !== true) return 'TRIGGER_MODE'
  if (row['t_cap'] !== true) return 'FAILURE_CAP'
  if (row['t_cool'] !== true) return 'COOLING_DOWN'
  if (row['t_idle'] !== true) return 'ALREADY_RUNNING'
  // The host term of the predicate: a NULL key, or a paused host.
  if (row['t_due'] !== true) return row['host_key'] === null ? 'HOST_KEY_MISSING' : 'HOST_PAUSED'
  return null
}
