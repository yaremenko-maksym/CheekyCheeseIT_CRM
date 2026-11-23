import { Logger } from '@nestjs/common'
import type { DecisionPort, DecisionRequest } from '@crm/inference'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callWriter,
  decideRetrying,
  JEV_RETRY_DELAY_MS,
  NO_WRITER_PACE,
  WRITER_CALL_GAP_MS,
  WRITER_RETRY_DELAY_MS,
  writerPace,
  type WriterPace,
} from './model-retry'

const req: DecisionRequest = {
  state: { a: 1 },
  questions: [{ id: 'q', kind: 'noul', instructions: 'Is it?' }],
}
const OK = { ok: true as const, answers: [] }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Settles `p` while advancing fake time by `ms`; resolves to whether it settled in that window. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false
  void p.then(
    () => (done = true),
    () => (done = true),
  )
  await vi.advanceTimersByTimeAsync(ms)
  return done
}

describe('the constants', () => {
  it('a writer retry waits 20 s, the gap is 2 s, a Jev retry 5 s', () => {
    expect(WRITER_RETRY_DELAY_MS).toBe(20_000)
    expect(WRITER_CALL_GAP_MS).toBe(2_000)
    expect(JEV_RETRY_DELAY_MS).toBe(5_000)
  })
})

describe('writerPace', () => {
  it('the first call has no gap; the next waits until 2 s after the first started', async () => {
    const pace = writerPace(() => Infinity)
    expect(await settledWithin(pace.gap(), 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    const second = pace.gap()
    expect(await settledWithin(second, 1_499)).toBe(false)
    expect(await settledWithin(second, 1)).toBe(true)
    expect(Date.now()).toBe(2_000)
  })

  it('no wait once the gap has already passed', async () => {
    const pace = writerPace(() => Infinity)
    await pace.gap()
    await vi.advanceTimersByTimeAsync(WRITER_CALL_GAP_MS)
    expect(await settledWithin(pace.gap(), 0)).toBe(true)
  })

  it('retryDelay sleeps exactly 20 s, then true', async () => {
    const pace = writerPace(() => WRITER_RETRY_DELAY_MS)
    const delayed = pace.retryDelay()
    expect(await settledWithin(delayed, WRITER_RETRY_DELAY_MS - 1)).toBe(false)
    expect(await settledWithin(delayed, 1)).toBe(true)
    await expect(delayed).resolves.toBe(true)
  })

  it('retryDelay is false at once when less than the delay is left of the budget', async () => {
    const pace = writerPace(() => WRITER_RETRY_DELAY_MS - 1)
    const delayed = pace.retryDelay()
    expect(await settledWithin(delayed, 0)).toBe(true)
    await expect(delayed).resolves.toBe(false)
  })

  it('NO_WRITER_PACE never waits and never retries', async () => {
    expect(await settledWithin(NO_WRITER_PACE.gap(), 0)).toBe(true)
    expect(await settledWithin(NO_WRITER_PACE.gap(), 0)).toBe(true)
    await expect(NO_WRITER_PACE.retryDelay()).resolves.toBe(false)
  })
})

type Reply = { kind: 'ok' } | { kind: 'unavailable'; reason: string }
const down = (reason = 'RATE_LIMITED'): Reply => ({ kind: 'unavailable', reason })
const up: Reply = { kind: 'ok' }

function harness(replies: Reply[], pace: WriterPace = writerPace(() => Infinity)) {
  const order: string[] = []
  const call = vi.fn(async () => {
    order.push(`call@${Date.now()}`)
    return replies.shift() ?? up
  })
  const beforeModelCall = vi.fn(async () => {
    order.push(`check@${Date.now()}`)
  })
  return { call, beforeModelCall, order, deps: { pace, beforeModelCall } }
}

describe('callWriter', () => {
  it('an ok reply is returned after one budget check, no retry', async () => {
    const h = harness([up])
    await expect(callWriter(h.deps, h.call)).resolves.toEqual(up)
    expect(h.order).toEqual(['check@0', 'call@0'])
  })

  it('unavailable then ok → the ok reply, the retry 20 s later and checked again', async () => {
    const h = harness([down(), up])
    const p = callWriter(h.deps, h.call)
    await vi.advanceTimersByTimeAsync(WRITER_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual(up)
    expect(h.order).toEqual(['check@0', 'call@0', 'check@20000', 'call@20000'])
  })

  it('unavailable twice → the second unavailable reply, never a third call', async () => {
    const h = harness([down('TIMEOUT'), down('PROVIDER_ERROR'), up])
    const p = callWriter(h.deps, h.call)
    await vi.advanceTimersByTimeAsync(3 * WRITER_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual(down('PROVIDER_ERROR'))
    expect(h.call).toHaveBeenCalledTimes(2)
  })

  it.each(['LIMITS_EXHAUSTED', 'NOT_CONFIGURED', 'INVALID_INPUT'])(
    '%s is returned at once, no retry',
    async (reason) => {
      const h = harness([down(reason), up])
      const p = callWriter(h.deps, h.call)
      expect(await settledWithin(p, 0)).toBe(true)
      await expect(p).resolves.toEqual(down(reason))
      expect(h.call).toHaveBeenCalledTimes(1)
    },
  )

  it('no retry when the delay would end past the run budget', async () => {
    const h = harness(
      [down(), up],
      writerPace(() => WRITER_RETRY_DELAY_MS - 1),
    )
    const p = callWriter(h.deps, h.call)
    expect(await settledWithin(p, 0)).toBe(true)
    await expect(p).resolves.toEqual(down())
    expect(h.call).toHaveBeenCalledTimes(1)
  })

  it('a run lost during the delay throws from the second check, no second call', async () => {
    const h = harness([down(), up])
    const lost = new Error('lost')
    h.beforeModelCall.mockResolvedValueOnce(undefined).mockRejectedValueOnce(lost)
    const p = callWriter(h.deps, h.call)
    const caught = p.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(WRITER_RETRY_DELAY_MS)
    expect(await caught).toBe(lost)
    expect(h.call).toHaveBeenCalledTimes(1)
  })

  it('consecutive writer calls of one run start 2 s apart', async () => {
    const h = harness([up, up])
    await callWriter(h.deps, h.call)
    const p = callWriter(h.deps, h.call)
    await vi.advanceTimersByTimeAsync(WRITER_CALL_GAP_MS)
    await p
    expect(h.order).toEqual(['check@0', 'call@0', 'check@2000', 'call@2000'])
  })
})

describe('decideRetrying', () => {
  const warn = () => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

  it('ok at once → the result, one call, no log', async () => {
    const log = warn()
    const decide = vi.fn<DecisionPort['decide']>().mockResolvedValue(OK)
    await expect(decideRetrying({ decide }, req)).resolves.toEqual(OK)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('RATE_LIMITED then ok → the answer, the retry 5 s later with the same request', async () => {
    const log = warn()
    const decide = vi
      .fn<DecisionPort['decide']>()
      .mockResolvedValueOnce({ ok: false, code: 'RATE_LIMITED' })
      .mockResolvedValueOnce(OK)
    const p = decideRetrying({ decide }, req)
    expect(await settledWithin(p, JEV_RETRY_DELAY_MS - 1)).toBe(false)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(await settledWithin(p, 1)).toBe(true)
    await expect(p).resolves.toEqual(OK)
    expect(decide).toHaveBeenNthCalledWith(2, req)
    expect(log).not.toHaveBeenCalled()
  })

  it('RATE_LIMITED twice → the code, never a third call, one structured log line', async () => {
    const log = warn()
    const decide = vi.fn<DecisionPort['decide']>().mockResolvedValue({
      ok: false,
      code: 'RATE_LIMITED',
    })
    const p = decideRetrying({ decide }, req)
    await vi.advanceTimersByTimeAsync(3 * JEV_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual({ ok: false, code: 'RATE_LIMITED' })
    expect(decide).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      event: 'jev_decision_unavailable',
      provider: 'jev',
      cause: 'RATE_LIMITED',
      attempts: 2,
    })
  })

  it('TIMEOUT then PROVIDER_ERROR → the last code', async () => {
    warn()
    const decide = vi
      .fn<DecisionPort['decide']>()
      .mockResolvedValueOnce({ ok: false, code: 'TIMEOUT' })
      .mockResolvedValueOnce({ ok: false, code: 'PROVIDER_ERROR' })
    const p = decideRetrying({ decide }, req)
    await vi.advanceTimersByTimeAsync(JEV_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('a thrown port is retried; thrown twice → its error name, never the message', async () => {
    const log = warn()
    const decide = vi.fn<DecisionPort['decide']>().mockRejectedValue(new TypeError('jane@x.test'))
    const p = decideRetrying({ decide }, req)
    await vi.advanceTimersByTimeAsync(JEV_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual({ ok: false, code: 'TypeError' })
    expect(decide).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0]?.[0]).not.toContain('jane')
  })

  it('a thrown non-Error is unknown', async () => {
    warn()
    const decide = vi.fn<DecisionPort['decide']>().mockRejectedValue('x')
    const p = decideRetrying({ decide }, req)
    await vi.advanceTimersByTimeAsync(JEV_RETRY_DELAY_MS)
    await expect(p).resolves.toEqual({ ok: false, code: 'unknown' })
  })

  it.each(['INVALID_OUTPUT', 'NOT_CONFIGURED', 'LIMITS_EXHAUSTED'] as const)(
    '%s is returned at once, no retry, no log',
    async (code) => {
      const log = warn()
      const decide = vi.fn<DecisionPort['decide']>().mockResolvedValue({ ok: false, code })
      const p = decideRetrying({ decide }, req)
      expect(await settledWithin(p, 0)).toBe(true)
      await expect(p).resolves.toEqual({ ok: false, code })
      expect(decide).toHaveBeenCalledTimes(1)
      expect(log).not.toHaveBeenCalled()
    },
  )
})
