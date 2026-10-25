import { randomUUID } from 'node:crypto'
import type { JobMeterUnit } from '@crm/shared'
import {
  type BoundedFetchOptions,
  boundedFetchText,
  transportOptionsFor,
} from '../http/bounded-fetch'
import { SourceBlockedError, SourceRateLimitedError } from '../http/source-errors'
import type { AccountMeter } from '../metering/account-meter.store'
import type { ClaimedRun, SavedPage } from '../ownership/job-run-ledger'
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
 * `fetchText` is `boundedFetchText` at its DEFAULT caps and the adapter's `allowedHosts` (T6 owns
 * transport options). Until T6 that list is empty and the ledger never claims such a source
 * (`TRANSPORT_NOT_WIRED`). The transport answers with the body only, so a response carries status
 * 200, no headers and no ETag: conditional requests begin when T6 surfaces them.
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

export interface ContextDeps {
  /** The transport. Production: `boundedFetchText`. */
  readonly transport?: ((url: string, opts: BoundedFetchOptions) => Promise<string>) | undefined
  /** T8's `recordHostBan`, bound to the database. */
  readonly recordBan: (ban: HostBan) => Promise<unknown>
  /** The ledger's `savePage`, with the page-write budget. */
  readonly savePage: (
    h: RunHandle,
    page: SavedPage,
    options: { readonly timeoutMs: number },
  ) => Promise<void>
  /** Monotonic milliseconds. Production: `performance.now`. */
  readonly monotonicNow?: (() => number) | undefined
  /** Wall clock, for `ctx.now()`. Production: `new Date()`. */
  readonly now?: (() => Date) | undefined
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
  readonly state: {
    readonly closed: ClosedReason | null
    /** The refused request's code (`ACCESS_POLICY` / `RATE_LIMIT`) when the run was banned. */
    readonly banCode: CollectionErrorCode | null
    /** A host ban that could not be written; the worker retries it after `finish` (SR-M-21). */
    readonly unrecordedBan: HostBan | null
  }
}

function retryAfterOf(error: unknown): string | null {
  // T6 adds `retryAfter` to the transport errors; read it when present.
  const value = (error as { retryAfter?: unknown }).retryAfter
  return typeof value === 'string' ? value : null
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

  async function onRefusal(error: SourceBlockedError | SourceRateLimitedError): Promise<void> {
    const status = error instanceof SourceBlockedError ? error.status : 429
    banCode = status === 429 ? 'RATE_LIMIT' : 'ACCESS_POLICY'
    close('BANNED')
    // `banTargetOf` reads anything but a literal SOURCE (an absent scope included) as HOST.
    if (banTargetOf(input.banScope as BanScope, status) !== 'HOST') return
    const ban: HostBan = {
      hostKey: input.hostKey,
      reason: `HTTP_${status}`,
      sourceId: run.sourceId,
      retryAfter: retryAfterOf(error),
      floorHours: input.floorHours,
    }
    for (let attempt = 1; attempt <= BAN_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await deps.recordBan(ban)
        return
      } catch {
        // retried; after the last attempt the run is flagged below
      }
    }
    unrecordedBan = ban
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
    async fetchText(request): Promise<FetchedText> {
      assertOpen()
      if (now().getTime() >= input.deadline.getTime()) {
        close('DEADLINE')
        throw new ContextRefusedError('DEADLINE', 'the run`s deadline passed before this request')
      }
      // SR-L-22: the lease is re-validated before a permit is consumed.
      assertLease()
      if (meter !== null) {
        if (permits < 1) {
          throw new ContextRefusedError(
            'NOT_MARKED_SENT',
            'a metered request was attempted without a committed markSent',
          )
        }
        permits -= 1
      }
      try {
        const bodyText = await Promise.race([
          transport(request.url, {
            allowedHosts: input.allowedHosts,
            ...transportOptionsFor(request),
          }),
          aborted,
        ])
        return { status: 200, bodyText, headers: {}, etag: null }
      } catch (error) {
        if (error instanceof SourceBlockedError || error instanceof SourceRateLimitedError) {
          // The pause is written BEFORE the adapter sees the refusal.
          await onRefusal(error)
        }
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
