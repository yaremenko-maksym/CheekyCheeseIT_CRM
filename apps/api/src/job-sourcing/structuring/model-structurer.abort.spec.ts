import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '@crm/inference'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HtmlStructurerRequest } from './html-structurer.port'
import { InMemoryModelBudget } from './model-budget.port'
import { ModelStructurer } from './model-structurer'

const PAGE = 'Senior Go Engineer at Acme, Kyiv.'
const TIMEOUT_MS = 5_000
const HOLD_MS = 20_000

const GOOD: ExtractionResult<unknown> = {
  ok: true,
  data: {
    extractionVersion: 'v',
    records: [
      {
        title: 'Senior Go Engineer',
        uncertainty: 0.1,
        evidence: [{ field: 'title', quote: 'Senior Go Engineer' }],
      },
    ],
  },
}

/** Every call hangs until the spec settles it; `calls` shows what reached the port and when. */
function hangingPort() {
  const calls: ExtractionRequest<unknown>[] = []
  const settlers: ((result: ExtractionResult<unknown>) => void)[] = []
  const port: ExtractionPort = {
    extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      calls.push(req as ExtractionRequest<unknown>)
      return new Promise((resolve) => {
        settlers.push(resolve as (result: ExtractionResult<unknown>) => void)
      })
    },
  }
  return { port, calls, settlers }
}

const request = (over: Partial<HtmlStructurerRequest> = {}): HtmlStructurerRequest => ({
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records: [{ id: 'a', url: 'https://jobs.example.com/vacancy/a', text: PAGE }],
  extractionVersion: 'html-v1',
  ...over,
})

describe('ModelStructurer: abort and hold (ADR 5.5.3, 5.5.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(budget = new InMemoryModelBudget()) {
    const fake = hangingPort()
    const structurer = new ModelStructurer({
      port: fake.port,
      budget,
      timeoutMs: TIMEOUT_MS,
      abandonedHoldMs: HOLD_MS,
    })
    return { ...fake, structurer, budget }
  }

  it('a timeout aborts the call it abandons', async () => {
    const { structurer, calls } = setup()
    const run = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    expect(calls[0]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls[0]?.signal?.aborted).toBe(true)
    await expect(run).resolves.toMatchObject({ kind: 'EXTRACTOR_FAILED', code: 'TIMEOUT' })
  })

  it("the cycle's abort aborts the call in flight", async () => {
    const { structurer, calls } = setup()
    const cycle = new AbortController()
    const run = structurer.structure(request({ signal: cycle.signal }))
    await vi.advanceTimersByTimeAsync(10)
    expect(calls[0]?.signal?.aborted).toBe(false)
    cycle.abort()
    await expect(run).resolves.toMatchObject({ kind: 'EXTRACTOR_FAILED', code: 'CANCELLED' })
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it('an abandoned call commits exactly the time it took, and keeps its slot', async () => {
    const budget = new InMemoryModelBudget()
    const commit = vi.spyOn(budget, 'commit')
    const { structurer } = setup(budget)
    const run = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await run
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[1]).toEqual({ localMs: TIMEOUT_MS })
    expect(budget.snapshot()).toMatchObject({ committed: 1, reserved: 0 })
  })

  it('a cancelled call commits the time until the abort', async () => {
    const budget = new InMemoryModelBudget()
    const commit = vi.spyOn(budget, 'commit')
    const { structurer } = setup(budget)
    const cycle = new AbortController()
    const run = structurer.structure(request({ signal: cycle.signal }))
    await vi.advanceTimersByTimeAsync(1_234)
    cycle.abort()
    await run
    expect(commit.mock.calls[0]?.[1]).toEqual({ localMs: 1_234 })
  })

  it('an abandoned call that ran past the local limit refuses the next reservation', async () => {
    const { structurer, settlers, calls } = setup(new InMemoryModelBudget(20, TIMEOUT_MS))
    const first = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await first
    settlers[0]?.(GOOD)
    const second = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(0)
    await expect(second).resolves.toMatchObject({
      kind: 'BUDGET_EXHAUSTED',
      cause: 'CYCLE_LIMIT',
    })
    expect(calls).toHaveLength(1)
  })

  it('the route stays held after the abort until the call settles: one in flight', async () => {
    const { structurer, calls, settlers } = setup()
    const first = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await first
    const second = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(1)
    settlers[0]?.(GOOD)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    settlers[1]?.(GOOD)
    await expect(second).resolves.toMatchObject({ kind: 'EXTRACTED' })
  })

  it('a port that ignores the signal holds the route only up to the cap', async () => {
    const { structurer, calls, settlers } = setup()
    const first = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await first
    const second = structurer.structure(request())
    await vi.advanceTimersByTimeAsync(HOLD_MS - TIMEOUT_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    settlers[1]?.(GOOD)
    await expect(second).resolves.toMatchObject({ kind: 'EXTRACTED' })
  })
})
