import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type EnrichmentRecord,
  hostGapMs,
  InMemoryEnrichmentState,
  InMemoryHostGate,
  MIN_HOST_GAP_MS,
  realSleep,
} from './html-ports'

describe('hostGapMs', () => {
  it('is 3 s without a Crawl-delay, or when the delay is smaller', () => {
    expect(MIN_HOST_GAP_MS).toBe(3_000)
    expect(hostGapMs(null)).toBe(3_000)
    expect(hostGapMs(0)).toBe(3_000)
    expect(hostGapMs(2)).toBe(3_000)
    expect(hostGapMs(3)).toBe(3_000)
  })

  it('honours a Crawl-delay larger than 3 s', () => {
    expect(hostGapMs(10)).toBe(10_000)
    expect(hostGapMs(3.5)).toBe(3_500)
  })
})

describe('InMemoryHostGate (fake clock)', () => {
  function gate() {
    let now = 1_000_000
    const slept: number[] = []
    const g = new InMemoryHostGate(
      () => now,
      async (ms) => {
        slept.push(ms)
        now += ms
      },
    )
    return { g, slept, advance: (ms: number) => (now += ms) }
  }

  it('lets the first request to an origin go at once', async () => {
    const { g, slept } = gate()
    await g.acquire('https://a.example', 3_000)
    expect(slept).toEqual([])
  })

  it('waits out the remaining gap for the next request to the same origin', async () => {
    const { g, slept, advance } = gate()
    await g.acquire('https://a.example', 3_000)
    advance(1_000)
    await g.acquire('https://a.example', 3_000)
    expect(slept).toEqual([2_000])
  })

  it('does not wait once the gap has already passed', async () => {
    const { g, slept, advance } = gate()
    await g.acquire('https://a.example', 3_000)
    advance(3_000)
    await g.acquire('https://a.example', 3_000)
    expect(slept).toEqual([])
  })

  it('keeps origins independent', async () => {
    const { g, slept } = gate()
    await g.acquire('https://a.example', 3_000)
    await g.acquire('https://b.example', 3_000)
    expect(slept).toEqual([])
  })

  it('spaces concurrent callers by the gap (the slot is reserved before the wait)', async () => {
    const now = 0
    const slept: number[] = []
    const g = new InMemoryHostGate(
      () => now,
      async (ms) => {
        slept.push(ms)
      },
    )
    await Promise.all([
      g.acquire('https://a.example', 5_000),
      g.acquire('https://a.example', 5_000),
      g.acquire('https://a.example', 5_000),
    ])
    expect(slept).toEqual([5_000, 10_000])
  })

  describe('default clock and sleep', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('really waits the gap on a fake timer', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
      const g = new InMemoryHostGate()
      await g.acquire('https://a.example', 3_000)
      let released = false
      const second = g.acquire('https://a.example', 3_000).then(() => {
        released = true
      })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(released).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await second
      expect(released).toBe(true)
    })

    it('passes the signal to the sleep, and an abort during the wait rejects at once (CR-M-5)', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const g = new InMemoryHostGate()
      const controller = new AbortController()
      await g.acquire('https://a.example', 60_000, controller.signal)
      const waiting = g.acquire('https://a.example', 60_000, controller.signal)
      controller.abort(new Error('cancelled'))
      await expect(waiting).rejects.toThrow('cancelled')
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

describe('realSleep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects at once on an already-aborted signal, without a timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(realSleep(1_000, controller.signal)).rejects.toThrow('gone')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes its abort listener when the wait ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const slept = realSleep(10, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    await slept
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
  })

  it('resolves after the time without a signal, and is not rejected by a later abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    let done = false
    const slept = realSleep(1_000, controller.signal).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await slept
    expect(done).toBe(true)
    controller.abort()
    let unsignalled = false
    const plain = realSleep(5).then(() => {
      unsignalled = true
    })
    await vi.advanceTimersByTimeAsync(5)
    await plain
    expect(unsignalled).toBe(true)
  })
})

describe('InMemoryEnrichmentState', () => {
  it('returns null for an unknown key and the stored record otherwise', async () => {
    const state = new InMemoryEnrichmentState()
    expect(await state.get('k')).toBeNull()
    const record: EnrichmentRecord = {
      attempts: 1,
      lastAttemptAt: new Date(0),
      succeededAt: new Date(0),
      error: null,
      nextDueAt: new Date(1),
      contentHash: 'h',
      validator: null,
      url: 'https://jobs.example/a',
      parserVersion: 'p1',
      policyVersion: 1,
      modelPending: false,
    }
    await state.put('k', record)
    expect(await state.get('k')).toBe(record)
    expect(state.records.size).toBe(1)
  })
})
