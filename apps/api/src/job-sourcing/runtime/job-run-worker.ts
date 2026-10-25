import type { JobMeterUnit, JobMeterWindow, JobSourceType } from '@crm/shared'
import { Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { BoundedFetchOptions } from '../http/bounded-fetch'
import type { AccountMeter, MeterDb } from '../metering/account-meter.store'
import type { ClaimedRun, JobRunLedger, RunEnding } from '../ownership/job-run-ledger'
import type { LedgerCatalog } from '../ownership/ledger-catalog'
import { type RunHandle, isRunFenced } from '../ownership/run-ownership'
import {
  type CollectionBatch,
  collectionCodeOf,
  type CollectionErrorCode,
  redactText,
  toStoredReportCounts,
} from '../providers/reporting-provider'
import type { JobSourceRegistry } from '../registry/job-source-registry'
import type { HostBan } from '../scheduling/host-state'
import { ContextRefusedError, type RunControl, buildCollectionContext } from './collection-context'

/**
 * THE RUN WORKER (r5 Task 2.5 T7; ADR 2026-10-24-job-source-run-ownership.md, T7). It runs
 * `REPORTING` adapters, and only through the ledger: `claimDue` / `claimSource` -> `runClaimed`.
 * Nothing else in the codebase runs a reporting adapter (SR-M-23); DOU stays on the legacy path.
 *
 *  - It calls `recoverExpired` ONCE, before its first claim (AC 16).
 *  - A bounded pool: at most `poolSize` runs at once; a claim asks for the free slots, never more.
 *  - Per run: a heartbeat every `H` on its OWN connection (`deps.heartbeat`, pool `N + 1`); a
 *    heartbeat that finds the run fenced closes the context. A per-run deadline aborts the signal,
 *    and after a grace period a run whose adapter has not settled is ended `PARTIAL` / `DEADLINE`
 *    by the worker itself (SR-M-18), so a never-settling request cannot hold the host forever.
 *  - The run row is ended BEFORE anything is summarised: a summary that fails to build leaves the
 *    run terminal with the counts `savePage` already wrote (AC 5). One run's failure is caught and
 *    reported, never thrown: it cannot block another (AC 4).
 *  - A ban the context could not write is written again after `finish` (SR-M-21): `recordHostBan`
 *    is monotone and a same-source repeat is a no-op, so the retry is safe.
 *
 * Persisted error messages: a fixed sentence, our own refusal sentences (`ContextRefusedError`,
 * `RunSetupError`), or a failed batch's last request-report message. That last one is built by the
 * adapter loop (`buildRequestReport`, already redacted) and redacted once more against this run's
 * secrets and capped, but it CAN carry text the loop took from an exception, e.g. the meter store's
 * message in a SmartRecruiters `PERSISTENCE` report. A foreign exception thrown out of the adapter
 * itself persists only its class name. Logs carry our sentences and class names only.
 */

export const POOL_SIZE_CEILING = 8

export interface WorkerOptions {
  /** The ledger owner prefix of this process (`[a-z0-9._-]`). */
  readonly owner: string
  /** `N`, the bounded pool (1..`POOL_SIZE_CEILING`). */
  readonly poolSize: number
  /** `H`: the heartbeat interval and a page write's budget; `3 H <= L`. */
  readonly heartbeatMs: number
  /** The per-run deadline (#1138 SR-M-1). With the grace, within the ledger's `RUN_MAX_AGE`. */
  readonly runDeadlineMs: number
  /** How long after the deadline an unsettled adapter is waited for before the worker ends the run. */
  readonly deadlineGraceMs: number
}

export const DEFAULT_WORKER_OPTIONS: Omit<WorkerOptions, 'owner'> = Object.freeze({
  poolSize: 2,
  heartbeatMs: 60_000,
  runDeadlineMs: 60 * 60_000,
  deadlineGraceMs: 2 * 60_000,
})

export interface WorkerDeps {
  readonly ledger: Pick<
    JobRunLedger,
    'claimDue' | 'claimSource' | 'finish' | 'recoverExpired' | 'savePage' | 'meterFor' | 'options'
  >
  /** The ledger's `heartbeat` on a connection reserved for it. */
  readonly heartbeat: (h: RunHandle) => Promise<boolean>
  readonly registry: JobSourceRegistry
  readonly catalog: LedgerCatalog
  /** Reads the claimed run's row, its source and its meter. */
  readonly db: MeterDb
  readonly recordBan: (ban: HostBan) => Promise<unknown>
  /** What the run's reports must never show: the type's credentials. */
  readonly secretsFor: (type: JobSourceType) => readonly string[]
  readonly transport?: ((url: string, opts: BoundedFetchOptions) => Promise<string>) | undefined
  readonly monotonicNow?: (() => number) | undefined
  readonly now?: (() => Date) | undefined
  /** Releases what the worker owns (the heartbeat's reserved connection) at shutdown. */
  readonly close?: () => Promise<void>
  /**
   * Where the worker records what it swallows (T7 CR-M-3): a failed `finish`, a ban it could not
   * write, a heartbeat that could not reach the database. Our sentences and error class names only,
   * never an exception's own text. Default: the Nest logger.
   */
  readonly logger?: Pick<Logger, 'error' | 'warn'> | undefined
}

/** A thrown value's class name, the only part of a foreign error the worker logs. */
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e)

/** What one run came to. `finished` is false when the ledger refused the ending (fenced). */
export interface RunReport {
  readonly runId: string
  readonly sourceId: string
  readonly sourceType: JobSourceType
  readonly outcome: RunEnding['outcome']
  readonly errorCode: CollectionErrorCode | null
  readonly finished: boolean
  /** The batch's counts, or null when there was no batch or its summary could not be built. */
  readonly counts: { received: number; invalid: number; normalized: number } | null
}

/**
 * The worker could not set the run up (its row, adapter, host policy). Our own sentence, so the run
 * row may carry it; it never wraps an upstream or exception text.
 */
export class RunSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunSetupError'
  }
}

/** The meter binding is refused: the source's meter is not the run's account (AC 13). */
export class MeterBindingRefusedError extends RunSetupError {
  constructor(message: string) {
    super(message)
    this.name = 'MeterBindingRefusedError'
  }
}

/** Owner-verified free plans: TheirStack bills RECORDs, 200 a calendar month (ADR T7). */
export const FREE_PLAN_METERS: Partial<
  Record<JobSourceType, { unit: JobMeterUnit; window: JobMeterWindow; limit: number }>
> = Object.freeze({ THEIRSTACK_API: { unit: 'RECORD', window: 'MONTH', limit: 200 } })

const DESIGNED_STOPS: ReadonlySet<string> = new Set(['PAGE_CAP', 'COST_STOP', 'DEADLINE'])
const MESSAGE_MAX = 300

interface RunRow {
  configVersion: number
  config: Record<string, unknown>
  policyVersion: number
  hostKey: string
  manifestId: string
  meter: {
    accountKey: string
    unit: JobMeterUnit
    window: JobMeterWindow
    limit: number | null
  } | null
}

/**
 * The meter binding of a claimed run, or null for an unmetered source. The account is the RUN
 * ROW's `account_key` (SR-L-11) and is never recomputed: the source's CURRENT meter must still be
 * that account's, or the binding is refused -- even when `account_meter_id` changed after the claim
 * (AC 13). A free-plan type is bound only to a meter of its owner-verified shape and limit.
 */
export function meterWindowsFor(
  run: Pick<ClaimedRun, 'accountKey' | 'sourceId' | 'sourceType'>,
  meter: RunRow['meter'],
): Partial<Record<JobMeterUnit, JobMeterWindow>> | null {
  const currentKey = meter?.accountKey ?? `#source:${run.sourceId}`
  if (currentKey !== run.accountKey) {
    throw new MeterBindingRefusedError('the source`s meter is not the claimed run`s account')
  }
  const plan = FREE_PLAN_METERS[run.sourceType]
  if (plan !== undefined) {
    const fits =
      meter !== null &&
      meter.unit === plan.unit &&
      meter.window === plan.window &&
      meter.limit !== null &&
      meter.limit <= plan.limit
    if (!fits) {
      throw new MeterBindingRefusedError(
        `${run.sourceType} is bound only to a ${plan.unit} / ${plan.window} meter of at most ${plan.limit}`,
      )
    }
  }
  return meter === null ? null : { [meter.unit]: meter.window }
}

export function validateWorkerOptions(
  o: WorkerOptions,
  ledger: { leaseMs: number; runMaxAgeMs: number },
): void {
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(o.owner)) throw new RangeError('worker: invalid owner')
  if (!positive(o.poolSize) || o.poolSize > POOL_SIZE_CEILING) {
    throw new RangeError(`worker: poolSize must be 1..${POOL_SIZE_CEILING}`)
  }
  if (!positive(o.heartbeatMs) || 3 * o.heartbeatMs > ledger.leaseMs) {
    throw new RangeError('worker: the heartbeat interval must be at most a third of the lease')
  }
  if (!positive(o.runDeadlineMs) || !positive(o.deadlineGraceMs)) {
    throw new RangeError('worker: the deadline and its grace are positive')
  }
  if (o.runDeadlineMs + o.deadlineGraceMs > ledger.runMaxAgeMs) {
    throw new RangeError('worker: the deadline and its grace must end within RUN_MAX_AGE')
  }
}

type Settled =
  | { readonly kind: 'BATCH'; readonly batch: CollectionBatch }
  | { readonly kind: 'THREW'; readonly error: unknown }
  | { readonly kind: 'UNSETTLED' }

/** The summary's counts, or null when the batch's own counts do not balance (AC 5). */
function summaryCounts(counts: CollectionBatch['counts']): RunReport['counts'] {
  try {
    return toStoredReportCounts(counts)
  } catch {
    return null
  }
}

function cap(text: string, secrets: readonly string[]): string {
  return redactText(text, secrets).slice(0, MESSAGE_MAX)
}

/** How a run ends, from what the adapter returned and what the context saw (ADR "Every way a run ends"). */
export function endingOf(
  settled: Settled,
  state: RunControl['state'],
  secrets: readonly string[],
): RunEnding {
  if (state.closed === 'BANNED') {
    return state.unrecordedBan !== null
      ? {
          outcome: 'FAILED',
          errorCode: 'HOST_BAN_UNRECORDED',
          errorMessage: 'the host refused a request and its ban could not be recorded',
        }
      : {
          outcome: 'FAILED',
          errorCode: state.banCode ?? 'ACCESS_POLICY',
          errorMessage: 'the host refused a request; the run stopped',
        }
  }
  if (state.closed === 'FENCED') {
    // Whatever the adapter returned, a run that lost its lease claims nothing.
    return {
      outcome: 'FAILED',
      errorCode: 'RUN_FENCED',
      errorMessage: 'the run lost its lease (fenced out) before it ended',
    }
  }
  if (settled.kind === 'UNSETTLED' || state.closed === 'DEADLINE') {
    return {
      outcome: 'PARTIAL',
      errorCode: 'DEADLINE',
      errorMessage:
        settled.kind === 'UNSETTLED'
          ? 'the adapter did not settle within the deadline grace'
          : 'the run reached its deadline',
    }
  }
  if (settled.kind === 'THREW') {
    const e = settled.error
    const code = collectionCodeOf(e)
    return {
      outcome: 'FAILED',
      // LEASE_EXPIRED is recovery's alone (`validateEnding` refuses it from a live worker).
      errorCode: code === null || code === 'LEASE_EXPIRED' ? 'ADAPTER_INVARIANT' : code,
      errorMessage:
        e instanceof ContextRefusedError || e instanceof RunSetupError || isRunFenced(e)
          ? cap((e as Error).message, secrets)
          : `the adapter threw ${e instanceof Error ? e.name : typeof e}`,
    }
  }
  const { batch } = settled
  if (batch.outcome === 'SUCCEEDED') return { outcome: 'SUCCEEDED', errorCode: null }
  if (batch.outcome === 'CANCELLED') {
    return { outcome: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: 'the run was cancelled' }
  }
  const last = [...batch.requests].reverse().find((r) => r.error !== null)?.error ?? null
  const code: CollectionErrorCode =
    last === null || last.code === 'LEASE_EXPIRED' ? 'ADAPTER_INVARIANT' : last.code
  return {
    outcome: DESIGNED_STOPS.has(code) ? 'PARTIAL' : 'FAILED',
    errorCode: code,
    errorMessage:
      last === null ? 'the batch failed without a request error' : cap(last.message, secrets),
  }
}

export class JobRunWorker {
  readonly options: WorkerOptions

  private started: Promise<number> | null = null

  private active = 0

  private readonly now: () => Date

  private readonly logger: Pick<Logger, 'error' | 'warn'>

  constructor(
    private readonly deps: WorkerDeps,
    options: Partial<WorkerOptions> & Pick<WorkerOptions, 'owner'>,
  ) {
    this.options = { ...DEFAULT_WORKER_OPTIONS, ...options }
    validateWorkerOptions(this.options, deps.ledger.options)
    this.now = deps.now ?? (() => new Date())
    this.logger = deps.logger ?? new Logger(JobRunWorker.name)
  }

  /** Nest calls this at shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.deps.close?.()
  }

  /**
   * Worker start: recover runs a previous process left expired, once, before any claim (AC 16). A
   * recovery that FAILED is not remembered (CR-M-1): the next pass tries again rather than
   * awaiting the same rejection forever.
   */
  start(): Promise<number> {
    this.started ??= this.deps.ledger.recoverExpired().catch((error: unknown) => {
      this.started = null
      this.logger.error(`run worker start-up recovery failed (${nameOf(error)}); retried next pass`)
      throw error
    })
    return this.started
  }

  /** One scheduled pass: claim up to the free slots and run them; each run's failure is its own. */
  async runDue(input: { cycleId: string; onlyIds?: readonly string[] }): Promise<RunReport[]> {
    await this.start()
    const free = this.options.poolSize - this.active
    if (free < 1) return []
    // The slots are held WHILE the claim runs, so two passes at once cannot both claim them.
    this.active += free
    let claimed: ClaimedRun[]
    try {
      ;({ claimed } = await this.deps.ledger.claimDue({
        cycleId: input.cycleId,
        owner: this.options.owner,
        limit: free,
        onlyIds: input.onlyIds,
      }))
    } finally {
      this.active -= free
    }
    // `runClaimed` takes its slot synchronously, before this pass yields again.
    return Promise.all(claimed.map((run) => this.runClaimed(run)))
  }

  /** The manual path: one named source, claimed under the actor's manual cycle. */
  async runSource(input: { cycleId: string; sourceId: string; actor: string }) {
    await this.start()
    if (this.active >= this.options.poolSize) {
      return { kind: 'REFUSED' as const, reason: 'POOL_FULL' as const }
    }
    this.active += 1
    let claim: Awaited<ReturnType<WorkerDeps['ledger']['claimSource']>>
    try {
      claim = await this.deps.ledger.claimSource({ ...input, owner: this.options.owner })
    } finally {
      this.active -= 1
    }
    if (claim.kind === 'REFUSED') return claim
    return { kind: 'RAN' as const, report: await this.runClaimed(claim.run) }
  }

  /** Run one claimed run to its end. Never throws. */
  async runClaimed(run: ClaimedRun): Promise<RunReport> {
    this.active += 1
    try {
      return await this.execute(run)
    } finally {
      this.active -= 1
    }
  }

  private async execute(run: ClaimedRun): Promise<RunReport> {
    const handle: RunHandle = {
      runId: run.runId,
      ownerToken: run.ownerToken,
      fencingEpoch: run.fencingEpoch,
    }
    // Stryker disable next-line ArrayDeclaration: read only when `secretsFor` itself threw, and then the ending is that error's class name, which no secret can redact
    let secrets: readonly string[] = []
    let settled: Settled
    let control: RunControl | null = null
    try {
      secrets = this.deps.secretsFor(run.sourceType)
      const row = await this.readRun(run.runId)
      const adapter = this.deps.registry.get(run.sourceType)
      if (adapter?.contract !== 'REPORTING') {
        throw new RunSetupError(`${run.sourceType} has no reporting adapter`)
      }
      const windows = meterWindowsFor(run, row.meter)
      const meter: AccountMeter | null =
        windows === null ? null : this.deps.ledger.meterFor(run, windows)
      // The claim resolved both through the same catalog (T3), so they exist for a claimed run;
      // read again here only for what the context needs, and refused if either vanished.
      const entry = this.deps.catalog.entry(row.manifestId)
      const policy = this.deps.catalog.hostPolicy(row.hostKey)
      if (entry === undefined || policy === undefined) {
        throw new RunSetupError('the run`s catalog entry or host policy is gone')
      }
      const config = adapter.provider.parseConfig({
        ...row.config,
        configVersion: row.configVersion,
      })
      control = buildCollectionContext(
        {
          recordBan: this.deps.recordBan,
          savePage: (h, page, o) => this.deps.ledger.savePage(h, page, o),
          transport: this.deps.transport,
          monotonicNow: this.deps.monotonicNow,
          now: this.now,
          logger: this.logger,
        },
        {
          run,
          hostKey: row.hostKey,
          floorHours: policy.floorHours,
          banScope: entry.banScope,
          allowedHosts: adapter.allowedHostsFor(config),
          meter,
          secrets,
          policyVersion: row.policyVersion,
          deadline: new Date(this.now().getTime() + this.options.runDeadlineMs),
          leaseMs: this.deps.ledger.options.leaseMs,
          pageWriteTimeoutMs: this.options.heartbeatMs,
        },
      )
      settled = await this.collect(
        control,
        () => adapter.provider.collectReport(config, control!.ctx),
        handle,
      )
    } catch (error) {
      settled = { kind: 'THREW', error }
    }
    // A ban write still retrying is finished before `state` is read (CR-M-6 / SR-L-3); one that
    // starts after this is the context's own to log and retry.
    await control?.drain()
    const state = control?.state ?? { closed: null, banCode: null, unrecordedBan: null }
    const ending = endingOf(settled, state, secrets)
    let finished = true
    try {
      await this.deps.ledger.finish(handle, ending)
    } catch (error) {
      // Fenced (recovery ends the run) or a database error: the run stays for recovery either way,
      // and the two are told apart in the log (CR-M-3).
      finished = false
      if (isRunFenced(error)) {
        this.logger.warn(`run ${run.runId} was fenced out before it finished; recovery ends it`)
      } else {
        this.logger.error(
          `run ${run.runId} could not be finished (${nameOf(error)}); left for recovery`,
        )
      }
    }
    if (state.unrecordedBan !== null) {
      const ban = state.unrecordedBan
      await this.deps.recordBan(ban).catch((error: unknown) => {
        this.logger.error(
          `host ${ban.hostKey} refused run ${run.runId} (${ban.reason}) and its ban could not be recorded (${nameOf(error)})`,
        )
      })
    }
    const counts = settled.kind === 'BATCH' ? summaryCounts(settled.batch.counts) : null
    return {
      runId: run.runId,
      sourceId: run.sourceId,
      sourceType: run.sourceType,
      outcome: ending.outcome,
      errorCode: ending.errorCode,
      finished,
      counts,
    }
  }

  /** Run the adapter under the heartbeat loop, the deadline and its grace. */
  private async collect(
    control: RunControl,
    work: () => Promise<CollectionBatch>,
    handle: RunHandle,
  ): Promise<Settled> {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const beat = () => {
      timers.add(
        setTimeout(() => {
          const sentAt = control.monotonicNow()
          // Inside a promise, so a heartbeat that THROWS (not only rejects) is caught too (CR-M-2):
          // a throw in a timer callback would be an uncaught exception and stop the loop.
          Promise.resolve()
            .then(() => this.deps.heartbeat(handle))
            .then(
              (ok) => {
                if (ok) control.renewLease(sentAt)
                else control.close('FENCED')
              },
              // A heartbeat that could not reach the database proves nothing either way: the local
              // lease (SR-L-22) stops sends if it is never renewed.
              (error: unknown) => {
                this.logger.warn(`run ${handle.runId}: heartbeat failed (${nameOf(error)})`)
              },
            )
          beat()
        }, this.options.heartbeatMs),
      )
    }
    beat()
    timers.add(setTimeout(() => control.close('DEADLINE'), this.options.runDeadlineMs))
    const grace = new Promise<Settled>((resolve) => {
      timers.add(
        setTimeout(
          () => resolve({ kind: 'UNSETTLED' }),
          this.options.runDeadlineMs + this.options.deadlineGraceMs,
        ),
      )
    })
    try {
      return await Promise.race([
        work().then(
          (batch): Settled => ({ kind: 'BATCH', batch }),
          (error: unknown): Settled => ({ kind: 'THREW', error }),
        ),
        grace,
      ])
    } finally {
      for (const t of timers) clearTimeout(t)
      // Whatever the adapter does after this, it does through a closed context.
      control.close('CANCELLED')
    }
  }

  private async readRun(runId: string): Promise<RunRow> {
    const { rows } = await this.deps.db.execute(
      sql`SELECT r.config_version, r.source_config_snapshot AS config, s.policy_version, s.host_key,
                 s.manifest_id, m.account_key AS meter_account_key, m.unit AS meter_unit,
                 m.window_kind AS meter_window, m.limit_amount AS meter_limit
            FROM job_collection_runs r
            JOIN job_sources s ON s.id = r.source_id
            LEFT JOIN job_account_meters m ON m.id = s.account_meter_id
           WHERE r.id = ${runId}::uuid`,
    )
    const r = rows[0]
    if (r === undefined) throw new RunSetupError('the claimed run has no row')
    const hostKey = r['host_key']
    const manifestId = r['manifest_id']
    // A claim requires both (T3's gate); a row without them was changed after the claim.
    if (typeof hostKey !== 'string' || typeof manifestId !== 'string') {
      throw new RunSetupError('the run`s source has no host key or manifest entry')
    }
    return {
      configVersion: Number(r['config_version']),
      config: r['config'] as Record<string, unknown>,
      policyVersion: Number(r['policy_version']),
      hostKey,
      manifestId,
      meter:
        typeof r['meter_account_key'] === 'string'
          ? {
              accountKey: r['meter_account_key'],
              unit: r['meter_unit'] as JobMeterUnit,
              window: r['meter_window'] as JobMeterWindow,
              limit: r['meter_limit'] === null ? null : Number(r['meter_limit']),
            }
          : null,
    }
  }
}
