import { randomUUID } from 'node:crypto'
import type { JobMeterUnit } from '@crm/shared'
import {
  type BoundedFetchOptions,
  boundedFetchText,
  transportOptionsFor,
} from '../http/bounded-fetch'
import {
  SourceBlockedError,
  SourceHttpStatusError,
  SourceRateLimitedError,
} from '../http/source-errors'
import type { AccountMeter } from '../metering/account-meter.store'
import type { ClaimedRun, RunMetrics, SavedPage } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import {
  type CachedResponse,
  type CollectionContext,
  type CollectionErrorCode,
  type FetchedText,
  type MeterReservation,
  type ValidatedCheckpoint,
  validatedCheckpointSchema,
} from '../providers/reporting-provider'
import type { BanScope } from '../scheduling/host-policy'
import { type HostBan, banTargetOf } from '../scheduling/host-state'

/**
 * THE PRODUCTION `CollectionContext` (r5 Task 2.5 T7; ADR 2026-10-24-job-source-run-ownership.md,
 * T7 and Option A "Stop-on-ban", "Lease, heartbeat and page writes").
 *
 * What it adds to the ports, and why each is HERE rather than trusted to an adapter:
 *
 *  - SEND PERMITS (CR-H-1). For a context bound to a meter, each committed `markSent` grants one
 *    permit and each `fetchText` consumes one; without a permit `fetchText` throws
 *    `NOT_MARKED_SENT` before any I/O. An adapter that forgets the awaited `markSent` is refused by
 *    the context, not trusted to remember. An unmetered context has nothing to mark, so no permit.
 *  - STOP-ON-BAN IN FLIGHT. On the transport's `SourceBlockedError` (403) or
 *    `SourceRateLimitedError` (429) the context LATCHES CLOSED first (SR-M-21), then records the
 *    host ban with a bounded retry, and only then rethrows to the adapter. A closed context refuses
 *    every further `reserve`, `markSent` and `fetchText` in process, before any transaction or I/O
 *    (SR-M-20): the owner pays for the one refused request and nothing after it. A 403 on a type
 *    whose ban scope is `SOURCE` bans nothing (SR-M-24); it still closes this run.
 *  - THE LOCAL LEASE (SR-L-22). Before a permit is consumed or a request marked sent, the context
 *    re-checks a lease deadline it tracks on the MONOTONIC clock (renewed by each successful
 *    heartbeat). A process frozen past `L` sends nothing on a stale permit: it closes as fenced.
 *  - THE DEADLINE. `fetchText` refuses once `deadline` has passed, whatever the adapter checked.
 *
 * `fetchText` is `boundedFetchText` pinned to the adapter's `allowedHosts` for this config, with the
 * request's own options (`transportOptionsFor`: method, headers, body, the declared `maxBytes`).
 * An adapter that declares no hosts is never claimed (`TRANSPORT_NOT_WIRED`).
 *
 * STATUSES (T6). A 2xx is a 200 with its body. A refusal (401 / 403 / 451, 429) is the typed error
 * above, and bans. ANY OTHER status is the adapter's answer, not a failure of ours: it is returned
 * as a response with that status and NO body (the transport cancels it unread), so an adapter's
 * "a detail 404 is an answer" path is reachable and a 5xx is the adapter's `UPSTREAM`, never
 * `TRANSIENT_NETWORK`. There is no retry here or in the transport: a failed request is retried by
 * the next run, on cadence and backoff (T3), so one run never multiplies its requests.
 * U2 METRICS. Each request handed to the transport is counted, with the UTF-8 bytes of the body it
 * returned, the status of the last answered request, and whether any answer carried a validator
 * (the transport's `onValidators`, ADR section 7 step 1: observed, not yet used); `metrics()` is
 * what the worker hands to `finish`.
 * Headers and validators are not surfaced: a response carries no headers and no ETag, so the cache
 * below never holds a validator and no conditional request is sent.
 *
 * LATE BANS (CR-M-6 / SR-L-3). The worker `drain`s the context before it reads `state`, so a ban
 * write still retrying is finished first. A refusal that arrives after the drain (a request still on
 * the wire when the run ended) is nobody's to read any more: its failed write is logged and retried
 * once more after `LATE_BAN_RETRY_MS`, then said to remain unrecorded.
 */

export type ClosedReason = 'BANNED' | 'FENCED' | 'DEADLINE' | 'CANCELLED'

/** A refusal of the production context. `code` is the collection code the run reports. */
export class ContextRefusedError extends Error {
  constructor(
    readonly code: CollectionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContextRefusedError'
  }
}

const CLOSED_CODE: Readonly<Record<ClosedReason, CollectionErrorCode>> = {
  BANNED: 'ACCESS_POLICY',
  FENCED: 'RUN_FENCED',
  DEADLINE: 'DEADLINE',
  CANCELLED: 'CANCELLED',
}

/** The bounded retry of a ban write (SR-M-21): this many attempts, then the run is flagged. */
export const BAN_WRITE_ATTEMPTS = 3

/** How long after a late ban write failed the context tries it once more (CR-M-6 / SR-L-3). */
export const LATE_BAN_RETRY_MS = 30_000

type Refusal = SourceBlockedError | SourceRateLimitedError

const isRefusal = (error: unknown): error is Refusal =>
  error instanceof SourceBlockedError || error instanceof SourceRateLimitedError

export interface ContextDeps {
  /** The transport. Production: `boundedFetchText`. */
  readonly transport?: ((url: string, opts: BoundedFetchOptions) => Promise<string>) | undefined
  /** T8's `recordHostBan`, bound to the database. */
  readonly recordBan: (ban: HostBan) => Promise<unknown>
  /** The page write (the record store's `saveObservationPage`), with the page-write budget. */
  readonly savePage: (
    h: RunHandle,
    page: SavedPage,
    options: { readonly timeoutMs: number },
  ) => Promise<void>
  /** Monotonic milliseconds. Production: `performance.now`. */
  readonly monotonicNow?: (() => number) | undefined
  /** Wall clock, for `ctx.now()`. Production: `new Date()`. */
  readonly now?: (() => Date) | undefined
  /** Where an unrecorded ban is said. Only our own sentences reach it, never exception text. */
  readonly logger?: { error(message: string): void } | undefined
}

export interface ContextInput {
  readonly run: ClaimedRun
  /** The source's `job_sources.host_key` (a reporting source always has one, or it is not claimed). */
  readonly hostKey: string
  /** The host's merged policy floor (`HostPolicy.floorHours`), for the ban's pause length. */
  readonly floorHours: number
  /** The type's ban scope (SR-M-24); absent bans the host. */
  readonly banScope: BanScope | undefined
  readonly allowedHosts: readonly string[]
  /**
   * U11 (SR-H-1): the most requests this run may send, the run's type `requestsPerRun`. The per-host
   * budget counts a STARTED run as this figure, so the run must not be able to exceed it — the
   * `requestsPerRun`+1-th `fetchText` is refused before any I/O. Must be a positive integer.
   */
  readonly requestsPerRun: number
  /** `null` for an unmetered source: no permit, reservations are local and free. */
  readonly meter: AccountMeter | null
  readonly secrets: readonly string[]
  readonly policyVersion: number
  readonly deadline: Date
  /** `L`: the lease a successful heartbeat renews. */
  readonly leaseMs: number
  /** `H`: a page write's budget. */
  readonly pageWriteTimeoutMs: number
}

/** What the worker holds besides the context: the controls and what happened. */
export interface RunControl {
  readonly ctx: CollectionContext
  /** Close the context (idempotent; the FIRST reason stands) and abort its signal. */
  close(reason: ClosedReason): void
  /** A heartbeat sent at monotonic `sentAt` succeeded: the lease runs `L` from then. */
  renewLease(sentAt: number): void
  /** The context's monotonic clock, for the heartbeat's `sentAt`. */
  monotonicNow(): number
  /** U2: what the run's requests amounted to so far, for `finish` (ADR section 10). */
  metrics(): RunMetrics
  /**
   * Wait for every ban write already started, so `state` is final; from then on a ban write that
   * fails is the context's own to log and retry (CR-M-6 / SR-L-3). Never rejects. Gives up after
   * `timeoutMs` (CR-M-1): a write still in flight is then flagged `unrecordedBan`, so the worker
   * writes it again after `finish`.
   */
  drain(timeoutMs: number): Promise<void>
  readonly state: {
    readonly closed: ClosedReason | null
    /** The refused request's code (`ACCESS_POLICY` / `RATE_LIMIT`) when the run was banned. */
    readonly banCode: CollectionErrorCode | null
    /** A host ban that could not be written; the worker retries it after `finish` (SR-M-21). */
    readonly unrecordedBan: HostBan | null
  }
}

export function buildCollectionContext(deps: ContextDeps, input: ContextInput): RunControl {
  const transport = deps.transport ?? boundedFetchText
  const mono = deps.monotonicNow ?? (() => performance.now())
  const now = deps.now ?? (() => new Date())
  const { run, meter } = input
  const handle: RunHandle = {
    runId: run.runId,
    ownerToken: run.ownerToken,
    fencingEpoch: run.fencingEpoch,
  }
  const controller = new AbortController()
  // ONE listener per run: an in-flight request is abandoned the moment the run closes, whatever
  // the transport does (it has its own timeout but no signal of ours).
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(closedError()))
  })
  aborted.catch(() => undefined)
  const cache = new Map<string, CachedResponse>()
  let closed: ClosedReason | null = null
  let banCode: CollectionErrorCode | null = null
  let unrecordedBan: HostBan | null = null
  let permits = 0
  let leaseDeadline = mono() + input.leaseMs
  // U2 run metrics: every request handed to the transport, the bodies it returned, the status of
  // the last answered one, whether any carried a validator, and the first envelope fingerprint.
  let requestCount = 0
  let bytesRead = 0
  let lastHttpStatus: number | null = null
  let validatorsSeen = false
  let envelopeFingerprint: string | null = null
  const logger = deps.logger
  /** Ban writes in progress, and whether the worker has drained them (CR-M-6 / SR-L-3). */
  const pending = new Set<Promise<void>>()
  /** The bans those writes carry, for a drain that gives up on them (CR-M-1). */
  const writing = new Set<HostBan>()
  let drained = false
  const track = (write: Promise<void>): Promise<void> => {
    pending.add(write)
    return write.finally(() => pending.delete(write))
  }

  const close = (reason: ClosedReason) => {
    closed ??= reason
    controller.abort(reason)
  }

  /** A closed run's refusal. A banned run refuses with the refused request's own code (403 / 429). */
  function closedError(): ContextRefusedError {
    const reason = closed as ClosedReason
    return new ContextRefusedError(banCode ?? CLOSED_CODE[reason], `the run is closed (${reason})`)
  }

  /** Every refusal of a closed context happens here, before any transaction or I/O. */
  const assertOpen = () => {
    if (closed !== null) throw closedError()
  }

  /** SR-L-22: a frozen process does not act on a lease it may have lost. */
  const assertLease = () => {
    if (mono() >= leaseDeadline) {
      close('FENCED')
      throw new ContextRefusedError('RUN_FENCED', 'the run`s lease passed before this request')
    }
  }

  async function onRefusal(error: Refusal): Promise<void> {
    const status = error instanceof SourceBlockedError ? error.status : 429
    banCode = status === 429 ? 'RATE_LIMIT' : 'ACCESS_POLICY'
    // LATCH FIRST (SR-M-21): every further reserve / markSent / fetchText is refused from here.
    // The signal is aborted by `fetchText` once this refusal has reached the adapter; aborting
    // here would make the request lose the race to its own close.
    closed ??= 'BANNED'
    if (banTargetOf(input.banScope, status) !== 'HOST') return
    const ban: HostBan = {
      hostKey: input.hostKey,
      reason: `HTTP_${status}`,
      sourceId: run.sourceId,
      retryAfter: error.retryAfter,
      floorHours: input.floorHours,
    }
    writing.add(ban)
    const failed = await recordWithRetry(ban).finally(() => writing.delete(ban))
    if (failed === null) return
    if (!drained) {
      unrecordedBan = failed
      return
    }
    // Late: the worker has read `state` already, so nobody else will retry this ban.
    setTimeout(() => {
      void recordWithRetry(ban).then((still) => {
        if (still !== null) {
          logger?.error(
            `host ${ban.hostKey}: ban ${ban.reason} for run ${run.runId} remains unrecorded after its late retry`,
          )
        }
      })
    }, LATE_BAN_RETRY_MS).unref()
  }

  /** The ban, or null once written; after the last failed attempt the ban itself, logged. */
  async function recordWithRetry(ban: HostBan): Promise<HostBan | null> {
    for (let attempt = 1; attempt <= BAN_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await deps.recordBan(ban)
        return null
      } catch {
        // retried; the exception text is not logged (it may carry connection details)
      }
    }
    logger?.error(
      `host ${ban.hostKey}: ban ${ban.reason} could not be recorded after ${BAN_WRITE_ATTEMPTS} attempts`,
    )
    return ban
  }

  const ctx: CollectionContext = {
    run: {
      sourceId: run.sourceId,
      cycleId: run.cycleId,
      attemptId: run.attemptId,
      fencingEpoch: run.fencingEpoch,
    },
    policyVersion: input.policyVersion,
    signal: controller.signal,
    deadline: input.deadline,
    now,
    secrets: input.secrets,
    observeEnvelope(fingerprint) {
      envelopeFingerprint ??= fingerprint
    },
    async fetchText(request): Promise<FetchedText> {
      assertOpen()
      if (now().getTime() >= input.deadline.getTime()) {
        close('DEADLINE')
        throw new ContextRefusedError('DEADLINE', 'the run`s deadline passed before this request')
      }
      // SR-L-22: the lease is re-validated before a permit is consumed.
      assertLease()
      // U11 (SR-H-1): a true upper bound. The run may send at most its declared `requestsPerRun`
      // requests; the next one is refused BEFORE any I/O and before a permit is consumed, so the
      // per-host budget (which counts a STARTED run as that figure) can never be breached.
      if (requestCount >= input.requestsPerRun) {
        throw new ContextRefusedError(
          'REQUEST_CEILING',
          `the run reached its request ceiling of ${input.requestsPerRun}`,
        )
      }
      if (meter !== null) {
        if (permits < 1) {
          throw new ContextRefusedError(
            'NOT_MARKED_SENT',
            'a metered request was attempted without a committed markSent',
          )
        }
        permits -= 1
      }
      // The refusal handler rides on the TRANSPORT promise, not on the race (SR-M-2): a request
      // already on the wire when the run closes (deadline, lost lease, cancel) can still be refused
      // by the host, and that ban is recorded even though nobody awaits the answer any more. When
      // the request is still awaited, the pause is written BEFORE the adapter sees the refusal.
      requestCount += 1
      const answer = transport(request.url, {
        allowedHosts: input.allowedHosts,
        ...transportOptionsFor(request),
        onValidators: (seen) => {
          validatorsSeen ||= seen
        },
      }).then(
        (body) => {
          bytesRead += Buffer.byteLength(body)
          lastHttpStatus = 200
          return body
        },
        async (error: unknown) => {
          if (error instanceof SourceHttpStatusError) lastHttpStatus = error.status
          if (isRefusal(error)) {
            lastHttpStatus = error instanceof SourceBlockedError ? error.status : 429
            await track(onRefusal(error))
          }
          throw error
        },
      )
      // When the race below is lost to a close, nobody awaits `answer`: its failure is expected.
      answer.catch(() => undefined)
      try {
        const bodyText = await Promise.race([answer, aborted])
        return { status: 200, bodyText, headers: {}, etag: null }
      } catch (error) {
        // Any other status is the adapter's answer (T6): its status, never its body.
        if (error instanceof SourceHttpStatusError) {
          return { status: error.status, bodyText: '', headers: {}, etag: null }
        }
        // A refusal of THIS request: the run is latched already; now abort its signal too.
        if (isRefusal(error)) controller.abort(closed)
        throw error
      }
    },
    meter: {
      async reserve(unit: JobMeterUnit, amount: number): Promise<MeterReservation | null> {
        assertOpen()
        if (meter === null) return { id: `local-${randomUUID()}`, unit, amount }
        return meter.reserve(unit, amount)
      },
      async markSent(reservation) {
        assertOpen()
        assertLease()
        if (meter === null) return
        await meter.markSent(reservation)
        permits += 1
      },
      async reconcile(reservation, resolution, incurred) {
        // Not closed by a refusal: settling what was already reserved is bookkeeping, not spend.
        if (meter === null) return
        await meter.reconcile(reservation, resolution, incurred)
      },
    },
    checkpoints: {
      async load(): Promise<ValidatedCheckpoint | null> {
        const parsed = validatedCheckpointSchema.safeParse(run.checkpoint)
        return parsed.success ? parsed.data : null
      },
      savePage: (page) => deps.savePage(handle, page, { timeoutMs: input.pageWriteTimeoutMs }),
    },
    // shortcut: a per-run in-memory cache, so a 304 can only reuse a body of the same run; a
    // durable response cache arrives with T6's conditional requests (the transport surfaces no
    // validators before it).
    cache: {
      async get(key) {
        return cache.get(key) ?? null
      },
      async put(key, value) {
        cache.set(key, value)
      },
    },
  }

  return {
    ctx,
    close,
    renewLease: (sentAt) => {
      // From when the heartbeat was SENT, not when it answered: the database extended the lease
      // at some instant after `sentAt`, so this deadline is never later than the real one.
      leaseDeadline = Math.max(leaseDeadline, sentAt + input.leaseMs)
    },
    monotonicNow: mono,
    metrics: () => ({
      requestCount,
      bytesRead,
      lastHttpStatus,
      envelopeFingerprint,
      validatorsSeen,
    }),
    drain: async (timeoutMs) => {
      // CR-M-1: bounded. A write that never settles must not keep the run from `finish`.
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'EXPIRED'>((resolve) => {
        timer = setTimeout(() => resolve('EXPIRED'), timeoutMs)
        timer.unref()
      })
      try {
        // A write that finishes may not start another, but loop anyway: the set is the truth.
        while (pending.size > 0) {
          if ((await Promise.race([Promise.allSettled([...pending]), expired])) === 'EXPIRED') {
            // Still writing: flag it, so the worker's HOST_BAN_UNRECORDED path writes it again.
            unrecordedBan ??= [...writing][0] ?? null
            break
          }
        }
      } finally {
        clearTimeout(timer)
        drained = true
      }
    },
    state: {
      get closed() {
        return closed
      },
      get banCode() {
        return banCode
      },
      get unrecordedBan() {
        return unrecordedBan
      },
    },
  }
}
