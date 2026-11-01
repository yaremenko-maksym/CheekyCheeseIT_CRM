import { describe, expect, it } from 'vitest'
import {
  SourceBlockedError,
  SourceHttpStatusError,
  SourceRateLimitedError,
} from '../http/source-errors'
import type { AccountMeter } from '../metering/account-meter.store'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import type { HostBan } from '../scheduling/host-state'
import {
  BAN_WRITE_ATTEMPTS,
  ContextRefusedError,
  type ContextDeps,
  type ContextInput,
  buildCollectionContext,
} from './collection-context'

/**
 * r5 Task 2.5 T7 — the production context's own guarantees, through its interface, with the
 * transport, the meter and the ban writer as recording doubles (the real-Postgres proofs are in
 * `job-run-worker.integration.spec.ts`).
 */
const RUN: ClaimedRun = {
  runId: '00000000-0000-4000-8000-0000000000aa',
  ownerToken: 'w:1',
  fencingEpoch: 3,
  sourceId: '00000000-0000-4000-8000-0000000000bb',
  cycleId: '00000000-0000-4000-8000-0000000000cc',
  attemptId: 'run-x',
  accountKey: 'jsearch:rapidapi-main',
  sourceType: 'JSEARCH_API',
  checkpoint: null,
}
const L = 60_000

function world(over: { input?: Partial<ContextInput>; transport?: ContextDeps['transport'] } = {}) {
  const events: string[] = []
  const bans: HostBan[] = []
  let banFailures = 0
  let mono = 1_000
  const meter: AccountMeter = {
    async reserve(unit, amount) {
      events.push('reserve')
      return { id: 'r1', unit, amount }
    },
    async markSent() {
      events.push('markSent')
    },
    async reconcile(_r, resolution) {
      events.push(`reconcile:${resolution}`)
    },
  }
  const deps: ContextDeps = {
    transport:
      over.transport ??
      (async (url) => {
        events.push(`send:${url}`)
        return 'body'
      }),
    recordBan: async (ban) => {
      events.push('ban')
      if (banFailures > 0) {
        banFailures -= 1
        throw new Error('db down')
      }
      bans.push(ban)
    },
    savePage: async () => {
      events.push('savePage')
    },
    monotonicNow: () => mono,
    now: () => new Date('2026-10-25T10:00:00Z'),
  }
  const control = buildCollectionContext(deps, {
    run: RUN,
    hostKey: 'jsearch.p.rapidapi.com',
    floorHours: 0,
    banScope: undefined,
    allowedHosts: ['jsearch.p.rapidapi.com'],
    requestsPerRun: 100,
    meter,
    secrets: ['k'],
    policyVersion: 1,
    deadline: new Date('2026-10-25T11:00:00Z'),
    leaseMs: L,
    pageWriteTimeoutMs: 5_000,
    ...over.input,
  })
  return {
    ...control,
    events,
    bans,
    failBans: (n: number) => {
      banFailures = n
    },
    advance: (ms: number) => {
      mono += ms
    },
  }
}

const REQ = { url: 'https://jsearch.p.rapidapi.com/search' }

async function refusal(p: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await p
  } catch (e) {
    return e as { code?: string }
  }
  throw new Error('expected a refusal')
}

describe('send permits (AC 6)', () => {
  it('a metered fetch without a committed markSent throws NOT_MARKED_SENT and sends nothing', async () => {
    const w = world()
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('NOT_MARKED_SENT')
    expect(w.events).toEqual([])
  })

  it('one markSent grants exactly one send', async () => {
    const w = world()
    const r = await w.ctx.meter.reserve('REQUEST', 1)
    // a metered context reserves on the account meter, never locally
    expect(r).toEqual({ id: 'r1', unit: 'REQUEST', amount: 1 })
    await w.ctx.meter.markSent(r!)
    await w.ctx.fetchText(REQ)
    const refused = await refusal(w.ctx.fetchText(REQ))
    expect(refused).toBeInstanceOf(ContextRefusedError)
    expect(refused).toMatchObject({
      name: 'ContextRefusedError',
      code: 'NOT_MARKED_SENT',
      message: 'a metered request was attempted without a committed markSent',
    })
    expect(w.events).toEqual(['reserve', 'markSent', `send:${REQ.url}`])
  })

  it('U11 (SR-H-1): a run sends at most its requestsPerRun requests; the next is refused before I/O', async () => {
    const w = world({ input: { meter: null, requestsPerRun: 1 } })
    await w.ctx.fetchText(REQ)
    const refused = await refusal(w.ctx.fetchText(REQ))
    expect(refused).toMatchObject({
      name: 'ContextRefusedError',
      code: 'REQUEST_CEILING',
      message: 'the run reached its request ceiling of 1',
    })
    // the (requestsPerRun+1)-th request never reached the transport
    expect(w.events.filter((e) => e.startsWith('send:'))).toHaveLength(1)
  })

  it('U11 (SR-H-1): a two-request run sends two, then refuses the third before I/O', async () => {
    const w = world({ input: { meter: null, requestsPerRun: 2 } })
    await w.ctx.fetchText(REQ)
    await w.ctx.fetchText(REQ)
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('REQUEST_CEILING')
    expect(w.events.filter((e) => e.startsWith('send:'))).toHaveLength(2)
  })

  it('U11 (SR-M-4): each redirect hop counts against the run (N redirects => N+1 requests)', async () => {
    const w = world({
      input: { meter: null, requestsPerRun: 5 },
      transport: async (_url, opts) => {
        opts.onHop?.() // redirect hop 1
        opts.onHop?.() // redirect hop 2
        return 'ok'
      },
    })
    await w.ctx.fetchText(REQ)
    // one initial request (counted by the context) + two redirect hops.
    expect(w.metrics().requestCount).toBe(3)
  })

  it('U11 (SR-M-4): a redirect chain that would exceed requestsPerRun is refused before the over-limit hop', async () => {
    const reached: number[] = []
    const w = world({
      input: { meter: null, requestsPerRun: 2 },
      transport: async (_url, opts) => {
        opts.onHop?.() // hop 1: count reaches 2
        reached.push(1)
        opts.onHop?.() // hop 2: ceiling -> throws BEFORE this hop is sent
        reached.push(2)
        return 'ok'
      },
    })
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('REQUEST_CEILING')
    // the second redirect hop's send never happened; only one initial + one redirect were counted.
    expect(reached).toEqual([1])
    expect(w.metrics().requestCount).toBe(2)
  })

  it('CR-M-5: buildCollectionContext refuses a requestsPerRun that is not a positive safe integer', () => {
    for (const bad of [Number.NaN, 1.5, 0, -1, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => world({ input: { requestsPerRun: bad } }), String(bad)).toThrow(RangeError)
    }
  })

  it('a metered reconcile settles on the account meter', async () => {
    const w = world()
    await w.ctx.meter.reconcile({ id: 'r1', unit: 'REQUEST', amount: 1 }, 'USED')
    expect(w.events).toEqual(['reconcile:USED'])
  })

  it('a markSent that fails grants nothing', async () => {
    const w = world()
    const meter = {
      reserve: async () => ({ id: 'r', unit: 'REQUEST' as const, amount: 1 }),
      markSent: async () => {
        throw new Error('db')
      },
      reconcile: async () => {},
    }
    const c = buildCollectionContext(
      { recordBan: async () => {}, savePage: async () => {}, transport: async () => 'x' },
      { ...baseInput(), meter },
    )
    await expect(c.ctx.meter.markSent({ id: 'r', unit: 'REQUEST', amount: 1 })).rejects.toThrow()
    expect((await refusal(c.ctx.fetchText(REQ))).code).toBe('NOT_MARKED_SENT')
    expect(w.events).toEqual([])
  })

  it('an unmetered context needs no permit, and reserves locally for free', async () => {
    const w = world({ input: { meter: null } })
    const r = await w.ctx.meter.reserve('REQUEST', 1)
    expect(r).toMatchObject({ unit: 'REQUEST', amount: 1 })
    expect(r?.id).toMatch(/^local-/)
    await w.ctx.meter.markSent(r!)
    await w.ctx.meter.reconcile(r!, 'USED')
    expect(await w.ctx.fetchText(REQ)).toEqual({
      status: 200,
      bodyText: 'body',
      headers: {},
      etag: null,
    })
    expect(w.events).toEqual([`send:${REQ.url}`])
  })

  it('the transport gets the adapter`s allowed hosts and the request`s own options', async () => {
    const seen: unknown[] = []
    const w = world({
      input: { meter: null },
      transport: async (url, opts) => {
        seen.push({ url, opts })
        return ''
      },
    })
    await w.ctx.fetchText({ url: REQ.url, method: 'POST', body: '{}', maxBytes: 10 })
    expect(seen).toEqual([
      {
        url: REQ.url,
        opts: {
          allowedHosts: ['jsearch.p.rapidapi.com'],
          method: 'POST',
          body: '{}',
          maxBytes: 10,
          onValidators: expect.any(Function),
          onHop: expect.any(Function),
        },
      },
    ])
  })
})

describe('run metrics (U2 AC 2)', () => {
  const bodies = ['{"jobs":[]}', 'ąę-€', '']

  it('a run of 3 requests records request_count 3 and bytes_read equal to the three bodies', async () => {
    let i = 0
    const w = world({ input: { meter: null }, transport: async () => bodies[i++] as string })
    for (let n = 0; n < 3; n += 1) await w.ctx.fetchText(REQ)
    // 11 + 8 (ą, ę: 2 bytes each; -: 1; €: 3) + 0, counted by hand.
    expect(w.metrics()).toEqual({
      requestCount: 3,
      bytesRead: 19,
      lastHttpStatus: 200,
      envelopeFingerprint: null,
      validatorsSeen: false,
    })
  })

  it('a fresh context has counted nothing', () => {
    const w = world({ input: { meter: null } })
    expect(w.metrics()).toEqual({
      requestCount: 0,
      bytesRead: 0,
      lastHttpStatus: null,
      envelopeFingerprint: null,
      validatorsSeen: false,
    })
  })

  it('a non-2xx answer counts its status and no bytes; any validator seen stays seen', async () => {
    let call = 0
    const w = world({
      input: { meter: null },
      transport: async (_url, opts) => {
        call += 1
        opts.onValidators?.(call === 1)
        if (call === 2) throw new SourceHttpStatusError('jsearch.p.rapidapi.com', 503)
        return 'ok'
      },
    })
    await w.ctx.fetchText(REQ)
    await w.ctx.fetchText(REQ)
    expect(w.metrics()).toMatchObject({
      requestCount: 2,
      bytesRead: 2,
      lastHttpStatus: 503,
      validatorsSeen: true,
    })
  })

  it.each([
    [new SourceRateLimitedError('jsearch.p.rapidapi.com', null), 429],
    [new SourceBlockedError('jsearch.p.rapidapi.com', 451, null), 451],
  ])('a refusal is the last status (%s)', async (error, status) => {
    const w = world({
      input: { meter: null },
      transport: async () => {
        throw error
      },
    })
    await w.ctx.fetchText(REQ).catch(() => undefined)
    expect(w.metrics()).toMatchObject({ requestCount: 1, lastHttpStatus: status })
  })

  it('a request that got no answer (a network error) leaves the last status as it was', async () => {
    let call = 0
    const w = world({
      input: { meter: null },
      transport: async () => {
        call += 1
        if (call === 2) throw new Error('socket hang up')
        return 'ok'
      },
    })
    await w.ctx.fetchText(REQ)
    await w.ctx.fetchText(REQ).catch(() => undefined)
    expect(w.metrics()).toMatchObject({ requestCount: 2, bytesRead: 2, lastHttpStatus: 200 })
  })

  it('the run keeps the FIRST envelope fingerprint it is given', () => {
    const w = world({ input: { meter: null } })
    w.ctx.observeEnvelope?.('a'.repeat(64))
    w.ctx.observeEnvelope?.('b'.repeat(64))
    expect(w.metrics().envelopeFingerprint).toBe('a'.repeat(64))
  })

  it('a request refused before the transport (closed context) is not counted', async () => {
    const w = world({ input: { meter: null } })
    w.close('CANCELLED')
    await w.ctx.fetchText(REQ).catch(() => undefined)
    expect(w.metrics().requestCount).toBe(0)
  })
})

function baseInput(): ContextInput {
  return {
    run: RUN,
    hostKey: 'jsearch.p.rapidapi.com',
    floorHours: 0,
    banScope: undefined,
    allowedHosts: ['jsearch.p.rapidapi.com'],
    requestsPerRun: 100,
    meter: null,
    secrets: [],
    policyVersion: 1,
    deadline: new Date('2099-01-01T00:00:00Z'),
    leaseMs: L,
    pageWriteTimeoutMs: 5_000,
  }
}

async function sendOnce(w: ReturnType<typeof world>) {
  const r = await w.ctx.meter.reserve('REQUEST', 1)
  await w.ctx.meter.markSent(r!)
  return w.ctx.fetchText(REQ)
}

describe('stop-on-ban in flight (AC 10, 12; SR-M-20, SR-M-21, SR-M-24)', () => {
  const blocked = async () => {
    throw new SourceBlockedError('jsearch.p.rapidapi.com', 403)
  }

  it('a 403 records the host ban BEFORE the adapter sees the error, then closes the run', async () => {
    const w = world({ transport: blocked })
    const r = await w.ctx.meter.reserve('REQUEST', 1)
    await w.ctx.meter.markSent(r!)
    w.events.length = 0
    await expect(w.ctx.fetchText(REQ)).rejects.toBeInstanceOf(SourceBlockedError)
    expect(w.events).toEqual(['ban'])
    expect(w.bans).toEqual([
      {
        hostKey: 'jsearch.p.rapidapi.com',
        reason: 'HTTP_403',
        sourceId: RUN.sourceId,
        retryAfter: null,
        floorHours: 0,
      },
    ])
    expect(w.state).toMatchObject({
      closed: 'BANNED',
      banCode: 'ACCESS_POLICY',
      unrecordedBan: null,
    })
    expect(w.ctx.signal.aborted).toBe(true)
  })

  it('after a ban, reserve, markSent and fetchText are all refused before the meter or the network', async () => {
    const w = world({ transport: blocked })
    await expect(sendOnce(w)).rejects.toThrow()
    w.events.length = 0
    expect((await refusal(w.ctx.meter.reserve('REQUEST', 1))).code).toBe('ACCESS_POLICY')
    expect(
      (await refusal(w.ctx.meter.markSent({ id: 'r1', unit: 'REQUEST', amount: 1 }))).code,
    ).toBe('ACCESS_POLICY')
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('ACCESS_POLICY')
    // settling what was already reserved stays possible
    await w.ctx.meter.reconcile({ id: 'r1', unit: 'REQUEST', amount: 1 }, 'RELEASED')
    expect(w.events).toEqual(['reconcile:RELEASED'])
  })

  it('a 429 bans the host whatever the scope, carrying a T6 Retry-After when the error has one', async () => {
    const w = world({
      input: { banScope: 'SOURCE', floorHours: 6 },
      transport: async () => {
        throw Object.assign(new SourceRateLimitedError('jsearch.p.rapidapi.com'), {
          retryAfter: '7200',
        })
      },
    })
    await expect(sendOnce(w)).rejects.toBeInstanceOf(SourceRateLimitedError)
    expect(w.bans).toEqual([
      {
        hostKey: 'jsearch.p.rapidapi.com',
        reason: 'HTTP_429',
        sourceId: RUN.sourceId,
        retryAfter: '7200',
        floorHours: 6,
      },
    ])
    expect(w.state.banCode).toBe('RATE_LIMIT')
    // the latched refusals carry the refused request's own code
    expect((await refusal(w.ctx.meter.reserve('REQUEST', 1))).code).toBe('RATE_LIMIT')
  })

  it('a run closed BANNED from outside refuses as an access-policy stop', async () => {
    const w = world()
    w.close('BANNED')
    expect((await refusal(w.ctx.meter.reserve('REQUEST', 1))).code).toBe('ACCESS_POLICY')
  })

  it('a 403 on a SOURCE-scoped type bans nothing, and still closes this run', async () => {
    const w = world({ input: { banScope: 'SOURCE' }, transport: blocked })
    await expect(sendOnce(w)).rejects.toBeInstanceOf(SourceBlockedError)
    expect(w.events).not.toContain('ban')
    expect(w.state.closed).toBe('BANNED')
  })

  it('a failing ban write is retried; after the last attempt the run is flagged unrecorded', async () => {
    const w = world({ transport: blocked })
    w.failBans(BAN_WRITE_ATTEMPTS)
    await expect(sendOnce(w)).rejects.toBeInstanceOf(SourceBlockedError)
    expect(w.events.filter((e) => e === 'ban')).toHaveLength(BAN_WRITE_ATTEMPTS)
    expect(w.state.unrecordedBan).toMatchObject({ reason: 'HTTP_403' })
    expect(w.state.closed).toBe('BANNED')
  })

  it('a ban write that succeeds on its last attempt is recorded, not flagged', async () => {
    const w = world({ transport: blocked })
    w.failBans(BAN_WRITE_ATTEMPTS - 1)
    await expect(sendOnce(w)).rejects.toThrow()
    expect(w.bans).toHaveLength(1)
    expect(w.state.unrecordedBan).toBeNull()
  })

  it.each(['DEADLINE', 'FENCED', 'CANCELLED'] as const)(
    'SR-M-2: closed %s while the request is in flight, a later 429 still records the host ban',
    async (reason) => {
      let refuse: (e: unknown) => void = () => undefined
      const w = world({
        input: { meter: null },
        transport: () =>
          new Promise<string>((_resolve, reject) => {
            refuse = reject
          }),
      })
      const pending = refusal(w.ctx.fetchText(REQ))
      w.close(reason)
      // the adapter has already been answered by the close ...
      expect((await pending).code).toBe(reason === 'FENCED' ? 'RUN_FENCED' : reason)
      expect(w.bans).toEqual([])
      // ... and the host refuses the request that was already on the wire
      refuse(new SourceRateLimitedError('jsearch.p.rapidapi.com'))
      await new Promise((r) => setTimeout(r, 0))
      expect(w.bans).toHaveLength(1)
      expect(w.bans[0]).toMatchObject({ reason: 'HTTP_429', hostKey: 'jsearch.p.rapidapi.com' })
      expect(w.state.banCode).toBe('RATE_LIMIT')
    },
  )

  it('a late non-ban failure after a close is swallowed (no unhandled rejection), and bans nothing', async () => {
    let refuse: (e: unknown) => void = () => undefined
    const w = world({
      input: { meter: null },
      transport: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject
        }),
    })
    const pending = refusal(w.ctx.fetchText(REQ))
    w.close('DEADLINE')
    await pending
    refuse(new Error('socket hang up'))
    await new Promise((r) => setTimeout(r, 0))
    expect(w.bans).toEqual([])
  })

  it('any other transport error closes nothing and bans nothing', async () => {
    const w = world({
      transport: async () => {
        throw new Error('host responded 500')
      },
    })
    await expect(sendOnce(w)).rejects.toThrow('host responded 500')
    expect(w.state.closed).toBeNull()
    expect(w.events).not.toContain('ban')
    // the latch stays open: the signal is not aborted and the run can send again
    expect(w.ctx.signal.aborted).toBe(false)
    await expect(sendOnce(w)).rejects.toThrow('host responded 500')
  })
})

describe('the local lease (SR-L-22) and the deadline', () => {
  it('a process frozen past L sends nothing on a permit it already holds', async () => {
    const w = world()
    const r = await w.ctx.meter.reserve('REQUEST', 1)
    await w.ctx.meter.markSent(r!)
    w.advance(L)
    w.events.length = 0
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('RUN_FENCED')
    expect(w.events).toEqual([])
    expect(w.state.closed).toBe('FENCED')
  })

  it('a heartbeat renews the lease from when it was sent', async () => {
    const w = world()
    w.advance(L - 10)
    w.renewLease(w.monotonicNow() - 5)
    w.advance(L - 6)
    await sendOnce(w)
    w.advance(1)
    expect((await refusal(sendOnce(w))).code).toBe('RUN_FENCED')
  })

  it('a renewal never moves the lease back', async () => {
    const w = world()
    w.renewLease(0)
    w.advance(L - 1)
    await expect(sendOnce(w)).resolves.toMatchObject({ status: 200 })
  })

  it('markSent re-checks the lease too', async () => {
    const w = world()
    w.advance(L)
    expect(
      (await refusal(w.ctx.meter.markSent({ id: 'r', unit: 'REQUEST', amount: 1 }))).code,
    ).toBe('RUN_FENCED')
    expect(w.events).toEqual([])
  })

  it('a request after the deadline is refused DEADLINE and closes the run', async () => {
    const w = world({ input: { deadline: new Date('2026-10-25T10:00:00Z') } })
    const r = await w.ctx.meter.reserve('REQUEST', 1)
    await w.ctx.meter.markSent(r!)
    w.events.length = 0
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('DEADLINE')
    expect(w.events).toEqual([])
    expect(w.state.closed).toBe('DEADLINE')
  })

  it('an abort ends an in-flight request that never settles, and the first close reason stands', async () => {
    const w = world({ input: { meter: null }, transport: () => new Promise<string>(() => {}) })
    const pending = refusal(w.ctx.fetchText(REQ))
    w.close('CANCELLED')
    w.close('FENCED')
    expect((await pending).code).toBe('CANCELLED')
    expect(w.state.closed).toBe('CANCELLED')
    expect((await refusal(w.ctx.fetchText(REQ))).code).toBe('CANCELLED')
  })
})

describe('a closed context and the defaults', () => {
  it.each([
    ['DEADLINE', 'DEADLINE'],
    ['FENCED', 'RUN_FENCED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)('closed %s, every send is refused %s with the reason named', async (reason, code) => {
    const w = world()
    w.close(reason)
    expect(await refusal(w.ctx.meter.reserve('REQUEST', 1))).toMatchObject({
      code,
      message: `the run is closed (${reason})`,
    })
    expect(w.ctx.signal.reason).toBe(reason)
    expect(w.events).toEqual([])
  })

  it('the lease refusal and the deadline refusal say what happened', async () => {
    const a = world()
    a.advance(L)
    expect(await refusal(a.ctx.fetchText(REQ))).toMatchObject({
      message: 'the run`s lease passed before this request',
    })
    const b = world({ input: { meter: null, deadline: new Date('2026-10-25T09:00:00Z') } })
    expect(await refusal(b.ctx.fetchText(REQ))).toMatchObject({
      message: 'the run`s deadline passed before this request',
    })
  })

  it('without injected clocks the context reads the real ones', async () => {
    const c = buildCollectionContext(
      { recordBan: async () => {}, savePage: async () => {}, transport: async () => 'ok' },
      { ...baseInput(), leaseMs: 1 },
    )
    const before = Date.now()
    expect(Math.abs(c.ctx.now().getTime() - before)).toBeLessThan(1_000)
    expect(c.monotonicNow()).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 5))
    expect((await refusal(c.ctx.fetchText(REQ))).code).toBe('RUN_FENCED')
  })

  it('without an injected transport it is boundedFetchText (which refuses an empty host list)', async () => {
    const c = buildCollectionContext(
      { recordBan: async () => {}, savePage: async () => {} },
      { ...baseInput(), allowedHosts: [] },
    )
    await expect(c.ctx.fetchText(REQ)).rejects.toThrow('invalid allowedHosts: empty list')
  })
})

describe('the other ports', () => {
  it('load returns the claim`s checkpoint when it parses, else a fresh start', async () => {
    const cp = {
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'a-1',
      position: { kind: 'CURSOR', page: 2, cursor: 'c2' },
      completedAt: '2026-10-25T00:00:00.000Z',
    }
    const ok = buildCollectionContext(
      { recordBan: async () => {}, savePage: async () => {} },
      { ...baseInput(), run: { ...RUN, checkpoint: cp } },
    )
    expect(await ok.ctx.checkpoints.load()).toMatchObject({ position: { page: 2, cursor: 'c2' } })
    const bad = buildCollectionContext(
      { recordBan: async () => {}, savePage: async () => {} },
      { ...baseInput(), run: { ...RUN, checkpoint: { nope: 1 } } },
    )
    expect(await bad.ctx.checkpoints.load()).toBeNull()
  })

  it('savePage goes to the ledger with the run`s handle and the page-write budget', async () => {
    const calls: unknown[] = []
    const c = buildCollectionContext(
      { recordBan: async () => {}, savePage: async (...a) => void calls.push(a) },
      baseInput(),
    )
    const page = { observations: [], checkpoint: {} as never }
    await c.ctx.checkpoints.savePage(page)
    expect(calls).toEqual([
      [{ runId: RUN.runId, ownerToken: 'w:1', fencingEpoch: 3 }, page, { timeoutMs: 5_000 }],
    ])
  })

  it('the run identity, policy, secrets and cache are the run`s own', async () => {
    const w = world()
    expect(w.ctx.run).toEqual({
      sourceId: RUN.sourceId,
      cycleId: RUN.cycleId,
      attemptId: 'run-x',
      fencingEpoch: 3,
    })
    expect([w.ctx.policyVersion, w.ctx.secrets]).toEqual([1, ['k']])
    expect(await w.ctx.cache.get('k')).toBeNull()
    await w.ctx.cache.put('k', { etag: 'e', bodyText: 'b' })
    expect(await w.ctx.cache.get('k')).toEqual({ etag: 'e', bodyText: 'b' })
    expect(w.ctx.now().toISOString()).toBe('2026-10-25T10:00:00.000Z')
  })
})
