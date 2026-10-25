import type { JobMeterUnit, JobMeterWindow, JobSourceType } from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { BoundedFetchOptions } from '../http/bounded-fetch'
import type { AccountMeter, MeterDb } from '../metering/account-meter.store'
import type { ClaimedRun, JobRunLedger, RunEnding } from '../ownership/job-run-ledger'
import type { LedgerCatalog } from '../ownership/ledger-catalog'
import { type RunHandle, isRunFenced } from '../ownership/run-ownership'
import {
  COLLECTION_ERROR_CODES,
  type CollectionBatch,
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
 * Persisted error messages are OUR sentences: a request report's message (built by
 * `buildRequestReport`, already redacted) redacted once more against this run's secrets, or a fixed
 * sentence for a thrown error. An upstream body or an exception's own text never reaches the row.
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
  readonly transport?: (url: string, opts: BoundedFetchOptions) => Promise<string>
  readonly monotonicNow?: () => number
  readonly now?: () => Date
  /** Releases what the worker owns (the heartbeat's reserved connection) at shutdown. */
  readonly close?: () => Promise<void>
}

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

/** The meter binding is refused: the source's meter is not the run's account (AC 13). */
export class MeterBindingRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeterBindingRefusedError'
  }
}

/** Owner-verified free plans: TheirStack bills RECORDs, 200 a calendar month (ADR T7). */
export const FREE_PLAN_METERS: Partial<
  Record<JobSourceType, { unit: JobMeterUnit; window: JobMeterWindow; limit: number }>
> = Object.freeze({ THEIRSTACK_API: { unit: 'RECORD', window: 'MONTH', limit: 200 } })

const KNOWN_CODES: ReadonlySet<string> = new Set(COLLECTION_ERROR_CODES)
const DESIGNED_STOPS: ReadonlySet<string> = new Set(['PAGE_CAP', 'COST_STOP', 'DEADLINE'])
const MESSAGE_MAX = 300

interface RunRow {
  configVersion: number
  config: Record<string, unknown>
  policyVersion: number
  hostKey: string | null
  manifestId: string | null
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
    const code = (e as { code?: unknown } | null)?.code
    const known = typeof code === 'string' && KNOWN_CODES.has(code) && code !== 'LEASE_EXPIRED'
    return {
      outcome: 'FAILED',
      errorCode: known ? (code as CollectionErrorCode) : 'ADAPTER_INVARIANT',
      errorMessage:
        e instanceof ContextRefusedError || isRunFenced(e)
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

  constructor(
    private readonly deps: WorkerDeps,
    options: Partial<WorkerOptions> & Pick<WorkerOptions, 'owner'>,
  ) {
    this.options = { ...DEFAULT_WORKER_OPTIONS, ...options }
    validateWorkerOptions(this.options, deps.ledger.options)
  }

  /** Nest calls this at shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.deps.close?.()
  }

  /** Worker start: recover runs a previous process left expired, once, before any claim (AC 16). */
  start(): Promise<number> {
    this.started ??= this.deps.ledger.recoverExpired()
    return this.started
  }

  /** One scheduled pass: claim up to the free slots and run them; each run's failure is its own. */
  async runDue(input: { cycleId: string; onlyIds?: readonly string[] }): Promise<RunReport[]> {
    await this.start()
    const free = this.options.poolSize - this.active
    if (free < 1) return []
    const { claimed } = await this.deps.ledger.claimDue({
      cycleId: input.cycleId,
      owner: this.options.owner,
      limit: free,
      ...(input.onlyIds !== undefined && { onlyIds: input.onlyIds }),
    })
    return Promise.all(claimed.map((run) => this.runClaimed(run)))
  }

  /** The manual path: one named source, claimed under the actor's manual cycle. */
  async runSource(input: { cycleId: string; sourceId: string; actor: string }) {
    await this.start()
    if (this.active >= this.options.poolSize)
      return { kind: 'REFUSED' as const, reason: 'POOL_FULL' as const }
    const claim = await this.deps.ledger.claimSource({ ...input, owner: this.options.owner })
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
    let secrets: readonly string[] = []
    let settled: Settled
    let control: RunControl | null = null
    try {
      secrets = this.deps.secretsFor(run.sourceType)
      const row = await this.readRun(run.runId)
      const adapter = this.deps.registry.get(run.sourceType)
      if (adapter?.contract !== 'REPORTING') throw new Error('not a reporting adapter')
      const windows = meterWindowsFor(run, row.meter)
      const meter: AccountMeter | null =
        windows === null ? null : this.deps.ledger.meterFor(run, windows)
      const entry = row.manifestId === null ? undefined : this.deps.catalog.entry(row.manifestId)
      const policy = row.hostKey === null ? undefined : this.deps.catalog.hostPolicy(row.hostKey)
      if (row.hostKey === null || policy === undefined)
        throw new Error('the run`s host has no policy')
      const config = adapter.provider.parseConfig({
        ...row.config,
        configVersion: row.configVersion,
      })
      control = buildCollectionContext(
        {
          recordBan: this.deps.recordBan,
          savePage: (h, page, o) => this.deps.ledger.savePage(h, page, o),
          ...(this.deps.transport !== undefined && { transport: this.deps.transport }),
          ...(this.deps.monotonicNow !== undefined && { monotonicNow: this.deps.monotonicNow }),
          ...(this.deps.now !== undefined && { now: this.deps.now }),
        },
        {
          run,
          hostKey: row.hostKey,
          floorHours: policy.floorHours,
          banScope: entry?.banScope,
          allowedHosts: adapter.allowedHosts,
          meter,
          secrets,
          policyVersion: row.policyVersion,
          deadline: new Date(
            (this.deps.now?.() ?? new Date()).getTime() + this.options.runDeadlineMs,
          ),
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
    const state = control?.state ?? { closed: null, banCode: null, unrecordedBan: null }
    const ending = endingOf(settled, state, secrets)
    let finished = true
    try {
      await this.deps.ledger.finish(handle, ending)
    } catch {
      // Fenced (recovery ends the run) or a database error: the run stays for recovery either way.
      finished = false
    }
    if (state.unrecordedBan !== null) {
      await this.deps.recordBan(state.unrecordedBan).catch(() => undefined)
    }
    let counts: RunReport['counts'] = null
    if (settled.kind === 'BATCH') {
      try {
        counts = toStoredReportCounts(settled.batch.counts)
      } catch {
        // The run row is already terminal with the counts savePage wrote (AC 5).
        counts = null
      }
    }
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
    const timers: ReturnType<typeof setTimeout>[] = []
    let stopped = false
    const beat = () => {
      timers.push(
        setTimeout(() => {
          if (stopped) return
          const sentAt = control.monotonicNow()
          this.deps.heartbeat(handle).then(
            (ok) => {
              if (ok) control.renewLease(sentAt)
              else control.close('FENCED')
            },
            // A heartbeat that could not reach the database proves nothing either way: the local
            // lease (SR-L-22) stops sends if it is never renewed.
            () => undefined,
          )
          beat()
        }, this.options.heartbeatMs),
      )
    }
    beat()
    let graceExpired: () => void = () => undefined
    const grace = new Promise<Settled>((resolve) => {
      graceExpired = () => resolve({ kind: 'UNSETTLED' })
    })
    timers.push(setTimeout(() => control.close('DEADLINE'), this.options.runDeadlineMs))
    timers.push(
      setTimeout(() => graceExpired(), this.options.runDeadlineMs + this.options.deadlineGraceMs),
    )
    try {
      return await Promise.race([
        work().then(
          (batch): Settled => ({ kind: 'BATCH', batch }),
          (error: unknown): Settled => ({ kind: 'THREW', error }),
        ),
        grace,
      ])
    } finally {
      stopped = true
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
    if (r === undefined) throw new Error('the claimed run has no row')
    return {
      configVersion: Number(r['config_version']),
      config: (r['config'] ?? {}) as Record<string, unknown>,
      policyVersion: Number(r['policy_version']),
      hostKey: typeof r['host_key'] === 'string' ? r['host_key'] : null,
      manifestId: typeof r['manifest_id'] === 'string' ? r['manifest_id'] : null,
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
