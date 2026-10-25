import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WindowDeps, runCollectionWindow } from './collection-window'

/**
 * r5 Task 2.5 T5 — the window loop over fakes (real timers, tens of milliseconds). The real
 * Postgres cases (claims, fencing, cycle rows) are in `collection-window.integration.spec.ts`.
 */
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

function deps(over: {
  recoverExpired?: () => Promise<number>
  closeCycle?: () => Promise<boolean>
  countDue?: () => Promise<number>
  startDue?: WindowDeps['worker']['startDue']
  active?: () => number
}) {
  const ledger = {
    recoverExpired: vi.fn(over.recoverExpired ?? (() => Promise.resolve(0))),
    closeCycle: vi.fn(over.closeCycle ?? (() => Promise.resolve(true))),
    countDue: vi.fn(over.countDue ?? (() => Promise.resolve(0))),
  }
  const worker = {
    startDue: vi.fn(
      over.startDue ?? (() => Promise.resolve({ claimed: 0, settled: Promise.resolve([]) })),
    ),
    get activeRuns() {
      return over.active?.() ?? 0
    },
  }
  return { ledger, worker, logger } as unknown as WindowDeps & {
    ledger: typeof ledger
    worker: typeof worker
  }
}

const input = { cycleId: 'c1', types: ['ARBEITNOW_API' as const], windowMs: 400, intervalMs: 20 }

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('runCollectionWindow', () => {
  it('ends DRAINED when nothing is claimable and nothing runs, and closes the cycle', async () => {
    const d = deps({})
    const summary = await runCollectionWindow(d, input)
    expect(summary).toMatchObject({
      ended: 'DRAINED',
      iterations: 1,
      claimed: 0,
      cycleClosed: true,
    })
    expect(d.ledger.closeCycle).toHaveBeenCalledWith('c1')
    // strict: an absent `onlyIds` is an absent key, not `onlyIds: undefined`
    expect(d.worker.startDue.mock.calls[0]?.[0]).toStrictEqual({
      cycleId: 'c1',
      onlyTypes: ['ARBEITNOW_API'],
    })
    expect(d.ledger.countDue.mock.calls[0]?.[0]).toStrictEqual({ onlyTypes: ['ARBEITNOW_API'] })
  })

  it('calls recoverExpired on EVERY iteration (SR-M-19)', async () => {
    let n = 0
    const d = deps({
      startDue: () => {
        n += 1
        return Promise.resolve({ claimed: n <= 3 ? 1 : 0, settled: Promise.resolve([]) })
      },
      active: () => 0,
    })
    // claimed 1,1,1 keep it going (active is 0 but claimedNow > 0); the 4th pass drains.
    const summary = await runCollectionWindow(d, input)
    expect(summary).toMatchObject({ ended: 'DRAINED', iterations: 4, claimed: 3 })
    expect(d.ledger.recoverExpired).toHaveBeenCalledTimes(4)
  })

  it('a throwing or rejecting step does not stop the later steps, and nothing is rethrown', async () => {
    const d = deps({
      recoverExpired: () => Promise.reject(new Error('db down')),
      startDue: () => Promise.reject(new Error('claim down')),
      closeCycle: () => Promise.reject(new Error('close down')),
    })
    const summary = await runCollectionWindow(d, input)
    expect(summary).toMatchObject({ ended: 'DRAINED', cycleClosed: false })
    expect(d.worker.startDue).toHaveBeenCalledTimes(1)
    expect(d.ledger.closeCycle).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('recoverExpired failed (Error)'),
    )
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('closing the cycle failed'))
  })

  it('AC 5: ends at the window even while work is claimed on every pass and a run never ends', async () => {
    const d = deps({
      startDue: () => Promise.resolve({ claimed: 1, settled: new Promise(() => undefined) }),
      active: () => 1,
    })
    const t0 = performance.now()
    const summary = await runCollectionWindow(d, input)
    const elapsed = performance.now() - t0
    expect(summary.ended).toBe('WINDOW')
    expect(summary.cycleClosed).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(input.windowMs - 5)
    expect(elapsed).toBeLessThan(input.windowMs + 150)
  })

  it('AC 12: a hung claim and a hung recoverExpired cannot stretch the window', async () => {
    const d = deps({
      recoverExpired: () => new Promise(() => undefined),
      startDue: () => new Promise(() => undefined),
      active: () => 1,
    })
    const t0 = performance.now()
    const summary = await runCollectionWindow(d, input)
    expect(summary.ended).toBe('WINDOW')
    expect(performance.now() - t0).toBeLessThan(input.windowMs + 150)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not settle within the window'),
    )
  })

  it('wakes early when a run finishes, instead of sleeping the whole interval', async () => {
    let n = 0
    let running = 0
    const d = deps({
      startDue: () => {
        n += 1
        if (n === 1) {
          running = 1
          return Promise.resolve({
            claimed: 1,
            settled: new Promise((r) =>
              setTimeout(() => {
                running = 0
                r([])
              }, 30),
            ),
          })
        }
        return Promise.resolve({ claimed: 0, settled: Promise.resolve([]) })
      },
      active: () => running,
    })
    const t0 = performance.now()
    const summary = await runCollectionWindow(d, { ...input, intervalMs: 5_000, windowMs: 10_000 })
    expect(summary).toMatchObject({ ended: 'DRAINED', iterations: 2 })
    expect(performance.now() - t0).toBeLessThan(1_000)
  })

  it('keeps waiting while sources of the set are still due behind a busy host, then drains', async () => {
    let due = 3
    const d = deps({ countDue: () => Promise.resolve(due--) })
    const summary = await runCollectionWindow(d, input)
    // due reads 3, 2, 1, then 0: the fourth empty pass ends the window
    expect(summary).toMatchObject({ ended: 'DRAINED', iterations: 4, claimed: 0 })
    expect(d.ledger.countDue).toHaveBeenCalledWith({ onlyTypes: ['ARBEITNOW_API'] })
  })

  it('a failed due count counts as nothing due: a sick database ends the window', async () => {
    const d = deps({ countDue: () => Promise.reject(new Error('db down')) })
    const summary = await runCollectionWindow(d, input)
    expect(summary).toMatchObject({ ended: 'DRAINED', iterations: 1 })
  })

  it('passes the spec seam onlyIds to both the claim and the count', async () => {
    const d = deps({})
    await runCollectionWindow(d, { ...input, onlyIds: ['id-1'] })
    expect(d.worker.startDue.mock.calls[0]?.[0]).toStrictEqual({
      cycleId: 'c1',
      onlyTypes: ['ARBEITNOW_API'],
      onlyIds: ['id-1'],
    })
    expect(d.ledger.countDue).toHaveBeenCalledWith({
      onlyTypes: ['ARBEITNOW_API'],
      onlyIds: ['id-1'],
    })
  })

  it('a window already over at the start claims nothing and still closes the cycle', async () => {
    const d = deps({})
    const summary = await runCollectionWindow(d, {
      ...input,
      startedAt: performance.now() - 10_000,
    })
    expect(summary).toMatchObject({ ended: 'WINDOW', iterations: 0, cycleClosed: true })
    expect(d.worker.startDue).not.toHaveBeenCalled()
  })

  it('a window with exactly 0 ms left runs no pass (the boundary is exclusive)', async () => {
    const d = deps({})
    const summary = await runCollectionWindow(
      { ...d, monotonicNow: () => 100 },
      { ...input, windowMs: 100, startedAt: 0 },
    )
    expect(summary.iterations).toBe(0)
    expect(d.worker.startDue).not.toHaveBeenCalled()
  })

  it('names the step that failed or hung, and logs how the window ended', async () => {
    const d = deps({
      startDue: () => Promise.reject(new Error('x')),
      countDue: () => Promise.reject(new Error('y')),
    })
    await runCollectionWindow(d, input)
    expect(logger.error).toHaveBeenCalledWith('collection window: claim failed (Error)')
    expect(logger.error).toHaveBeenCalledWith('collection window: countDue failed (Error)')
    expect(logger.log).toHaveBeenCalledWith(
      'collection window DRAINED: iterations=1, claimed=0, running=0',
    )
    const hung = deps({ recoverExpired: () => new Promise(() => undefined), active: () => 1 })
    await runCollectionWindow(hung, { ...input, windowMs: 60 })
    expect(logger.warn).toHaveBeenCalledWith(
      'collection window: recoverExpired did not settle within the window',
    )
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('collection window WINDOW:'))
  })

  it('leaves no timer behind once it has returned', async () => {
    vi.useFakeTimers()
    const d = deps({})
    await runCollectionWindow(d, { ...input, windowMs: 10_000 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not spin on a run that has already finished (the pending set is pruned)', async () => {
    let n = 0
    const d = deps({
      startDue: () => {
        n += 1
        return Promise.resolve({
          claimed: n === 1 ? 1 : 0,
          settled: Promise.resolve([]),
        })
      },
      active: () => 1, // something (another claim) keeps the window open
    })
    const summary = await runCollectionWindow(d, { ...input, windowMs: 300, intervalMs: 50 })
    expect(summary.ended).toBe('WINDOW')
    expect(summary.iterations).toBeGreaterThanOrEqual(3)
    expect(summary.iterations).toBeLessThan(12) // ~ 300 / 50, not thousands
  })
})
