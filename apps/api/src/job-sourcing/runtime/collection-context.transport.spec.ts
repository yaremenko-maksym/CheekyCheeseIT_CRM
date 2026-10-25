import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SourceBlockedError,
  SourceHttpStatusError,
  SourceRateLimitedError,
} from '../http/source-errors'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import type { HostBan } from '../scheduling/host-state'
import {
  BAN_WRITE_ATTEMPTS,
  type ContextDeps,
  type ContextInput,
  LATE_BAN_RETRY_MS,
  buildCollectionContext,
} from './collection-context'

/**
 * r5 Task 2.5 T6 — what the production context does with the statuses the transport now surfaces:
 * a non-refusal status is the ADAPTER's answer (AC 4), 401 / 451 ban like a 403 (AC 5), the typed
 * `Retry-After` reaches the ban, and a ban write that fails late is logged and retried (CR-M-6 /
 * SR-L-3). The transport, the ban writer and the logger are recording doubles.
 */
const RUN: ClaimedRun = {
  runId: '00000000-0000-4000-8000-0000000000aa',
  ownerToken: 'w:1',
  fencingEpoch: 3,
  sourceId: '00000000-0000-4000-8000-0000000000bb',
  cycleId: '00000000-0000-4000-8000-0000000000cc',
  attemptId: 'run-x',
  accountKey: null,
  sourceType: 'SMARTRECRUITERS_API',
  checkpoint: null,
}
const HOST = 'api.smartrecruiters.com'
const REQ = { url: `https://${HOST}/v1/companies/acme/postings/1` }

function world(over: {
  input?: Partial<ContextInput>
  transport: ContextDeps['transport']
  noLogger?: boolean
}) {
  const bans: HostBan[] = []
  const logs: string[] = []
  const attempts = { count: 0 }
  let banFailures = 0
  let hold: Promise<void> | null = null
  const deps: ContextDeps = {
    transport: over.transport,
    recordBan: async (ban) => {
      attempts.count += 1
      if (hold !== null) await hold
      if (banFailures > 0) {
        banFailures -= 1
        throw new Error('connection terminated: password=hunter2')
      }
      bans.push(ban)
    },
    savePage: async () => undefined,
    monotonicNow: () => 0,
    now: () => new Date('2026-10-25T10:00:00Z'),
    logger: over.noLogger === true ? undefined : { error: (m: string) => logs.push(m) },
  }
  const control = buildCollectionContext(deps, {
    run: RUN,
    hostKey: HOST,
    floorHours: 0,
    banScope: undefined,
    allowedHosts: [HOST],
    meter: null,
    secrets: [],
    policyVersion: 1,
    deadline: new Date('2026-10-25T11:00:00Z'),
    leaseMs: 60_000,
    pageWriteTimeoutMs: 5_000,
    ...over.input,
  })
  return {
    ...control,
    bans,
    logs,
    attempts,
    failBans: (n: number) => {
      banFailures = n
    },
    /** Every ban write waits until the returned function is called. */
    holdBans: () => {
      let release: () => void = () => undefined
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
  }
}

const throwing = (error: unknown) => async () => {
  throw error
}

afterEach(() => vi.useRealTimers())

describe('a surfaced status is the adapter`s answer (AC 4)', () => {
  it.each([404, 410, 500, 503])(
    'HTTP %i reaches the adapter as a response with that status and no body',
    async (status) => {
      const w = world({ transport: throwing(new SourceHttpStatusError(HOST, status)) })
      await expect(w.ctx.fetchText(REQ)).resolves.toEqual({
        status,
        bodyText: '',
        headers: {},
        etag: null,
      })
      expect(w.state.closed).toBeNull()
      expect(w.bans).toEqual([])
      expect(w.ctx.signal.aborted).toBe(false)
    },
  )
})

describe('401 and 451 ban exactly as a 403 does (AC 5)', () => {
  it.each([401, 403, 451])('HTTP %i on a HOST-scoped type records the host ban', async (status) => {
    const w = world({ transport: throwing(new SourceBlockedError(HOST, status)) })
    await expect(w.ctx.fetchText(REQ)).rejects.toBeInstanceOf(SourceBlockedError)
    expect(w.bans).toEqual([
      {
        hostKey: HOST,
        reason: `HTTP_${status}`,
        sourceId: RUN.sourceId,
        retryAfter: null,
        floorHours: 0,
      },
    ])
    expect(w.state).toMatchObject({ closed: 'BANNED', banCode: 'ACCESS_POLICY' })
  })

  it('a 451 bans the host even on a SOURCE-scoped type; a 401 there bans nothing', async () => {
    const legal = world({
      input: { banScope: 'SOURCE' },
      transport: throwing(new SourceBlockedError(HOST, 451)),
    })
    await expect(legal.ctx.fetchText(REQ)).rejects.toThrow()
    expect(legal.bans).toHaveLength(1)
    const auth = world({
      input: { banScope: 'SOURCE' },
      transport: throwing(new SourceBlockedError(HOST, 401)),
    })
    await expect(auth.ctx.fetchText(REQ)).rejects.toThrow()
    expect(auth.bans).toEqual([])
    expect(auth.state.closed).toBe('BANNED')
  })

  it('the typed Retry-After of a 429 and of a 403 reaches the ban', async () => {
    const limited = world({ transport: throwing(new SourceRateLimitedError(HOST, '259200')) })
    await expect(limited.ctx.fetchText(REQ)).rejects.toThrow()
    expect(limited.bans[0]).toMatchObject({ reason: 'HTTP_429', retryAfter: '259200' })
    const date = 'Wed, 28 Oct 2026 10:00:00 GMT'
    const blocked = world({ transport: throwing(new SourceBlockedError(HOST, 403, date)) })
    await expect(blocked.ctx.fetchText(REQ)).rejects.toThrow()
    expect(blocked.bans[0]).toMatchObject({ reason: 'HTTP_403', retryAfter: date })
  })
})

describe('a ban write that fails is never lost silently (CR-M-6 / SR-L-3)', () => {
  it('the last failed attempt is logged with our own sentence: host key and reason, no exception text', async () => {
    const w = world({ transport: throwing(new SourceRateLimitedError(HOST)) })
    w.failBans(BAN_WRITE_ATTEMPTS)
    await expect(w.ctx.fetchText(REQ)).rejects.toThrow()
    expect(w.state.unrecordedBan).toMatchObject({ reason: 'HTTP_429' })
    expect(w.logs).toEqual([
      `host ${HOST}: ban HTTP_429 could not be recorded after ${BAN_WRITE_ATTEMPTS} attempts`,
    ])
    expect(w.logs.join(' ')).not.toContain('hunter2')
  })

  it('drain waits for a ban write still retrying, so the worker reads its final state', async () => {
    const w = world({ transport: throwing(new SourceRateLimitedError(HOST)) })
    w.failBans(BAN_WRITE_ATTEMPTS)
    const release = w.holdBans()
    const pending = w.ctx.fetchText(REQ).catch(() => undefined)
    // the write has started and is held: the refusal is in progress
    await new Promise((r) => setTimeout(r, 0))
    expect(w.state.unrecordedBan).toBeNull()
    let drained = false
    const draining = w.drain().then(() => {
      drained = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(drained).toBe(false)
    release()
    await draining
    expect(w.state.unrecordedBan).toMatchObject({ reason: 'HTTP_429' })
    await pending
  })

  it('a LATE refusal whose ban write fails after drain is logged, then retried later until the host is paused', async () => {
    vi.useFakeTimers()
    let refuse: (e: unknown) => void = () => undefined
    const w = world({
      transport: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject
        }),
    })
    const pending = w.ctx.fetchText(REQ).catch(() => undefined)
    w.close('DEADLINE')
    await pending
    await w.drain()
    w.failBans(BAN_WRITE_ATTEMPTS)
    refuse(new SourceRateLimitedError(HOST, '7200'))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.bans).toEqual([])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain(`host ${HOST}: ban HTTP_429`)
    // nothing more until the late retry is due
    await vi.advanceTimersByTimeAsync(LATE_BAN_RETRY_MS - 1)
    expect(w.bans).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(w.bans).toEqual([
      {
        hostKey: HOST,
        reason: 'HTTP_429',
        sourceId: RUN.sourceId,
        retryAfter: '7200',
        floorHours: 0,
      },
    ])
    // a retry that succeeded says nothing more, and is not retried again
    await vi.advanceTimersByTimeAsync(10 * LATE_BAN_RETRY_MS)
    expect(w.logs).toHaveLength(1)
    expect(w.bans).toHaveLength(1)
  })

  it('a LATE refusal whose ban write succeeds is written once, and never scheduled again', async () => {
    vi.useFakeTimers()
    let refuse: (e: unknown) => void = () => undefined
    const w = world({
      transport: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject
        }),
    })
    const pending = w.ctx.fetchText(REQ).catch(() => undefined)
    w.close('DEADLINE')
    await pending
    await w.drain()
    refuse(new SourceRateLimitedError(HOST))
    await vi.advanceTimersByTimeAsync(10 * LATE_BAN_RETRY_MS)
    expect(w.attempts.count).toBe(1)
    expect(w.bans).toHaveLength(1)
    expect(w.logs).toEqual([])
  })

  it('without a logger, a late ban that stays unrecorded fails quietly (no unhandled rejection)', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      let refuse: (e: unknown) => void = () => undefined
      const w = world({
        noLogger: true,
        transport: () =>
          new Promise<string>((_resolve, reject) => {
            refuse = reject
          }),
      })
      const pending = w.ctx.fetchText(REQ).catch(() => undefined)
      w.close('DEADLINE')
      await pending
      await w.drain()
      w.failBans(2 * BAN_WRITE_ATTEMPTS)
      refuse(new SourceBlockedError(HOST, 451))
      await vi.advanceTimersByTimeAsync(LATE_BAN_RETRY_MS)
      vi.useRealTimers()
      await new Promise((r) => setTimeout(r, 10))
      expect(w.attempts.count).toBe(2 * BAN_WRITE_ATTEMPTS)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a late retry that fails as well says so, once, and stops', async () => {
    vi.useFakeTimers()
    let refuse: (e: unknown) => void = () => undefined
    const w = world({
      transport: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject
        }),
    })
    const pending = w.ctx.fetchText(REQ).catch(() => undefined)
    w.close('DEADLINE')
    await pending
    await w.drain()
    w.failBans(2 * BAN_WRITE_ATTEMPTS)
    refuse(new SourceBlockedError(HOST, 451))
    await vi.advanceTimersByTimeAsync(LATE_BAN_RETRY_MS)
    expect(w.bans).toEqual([])
    expect(w.logs).toEqual([
      `host ${HOST}: ban HTTP_451 could not be recorded after ${BAN_WRITE_ATTEMPTS} attempts`,
      `host ${HOST}: ban HTTP_451 could not be recorded after ${BAN_WRITE_ATTEMPTS} attempts`,
      `host ${HOST}: ban HTTP_451 for run ${RUN.runId} remains unrecorded after its late retry`,
    ])
    await vi.advanceTimersByTimeAsync(10 * LATE_BAN_RETRY_MS)
    expect(w.logs).toHaveLength(3)
  })

  it('a ban that fails BEFORE drain is left to the worker (flagged), not retried by the context', async () => {
    vi.useFakeTimers()
    const w = world({ transport: throwing(new SourceBlockedError(HOST, 403)) })
    w.failBans(BAN_WRITE_ATTEMPTS)
    await expect(w.ctx.fetchText(REQ)).rejects.toThrow()
    await w.drain()
    await vi.advanceTimersByTimeAsync(10 * LATE_BAN_RETRY_MS)
    expect(w.bans).toEqual([])
    expect(w.state.unrecordedBan).not.toBeNull()
  })
})
