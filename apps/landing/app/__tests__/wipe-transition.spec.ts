/**
 * wipe-transition.ts — the cancellable "yellow caret" page-transition sweep
 * (§M.3). `framer-motion`'s `animate()` is mocked to return a controllable
 * fake `AnimationPlaybackControls` (thenable + `.stop()`) so tests can drive
 * each phase (wipe-in / wipe-out / reset) deterministically instead of
 * depending on real animation timing — and, critically, prove the
 * double-click guard (code-review fix-round finding): a second
 * `runWipeTransition()` call before the first finishes must `.stop()` the
 * first's in-flight animation and prevent its `onMidSweep` from EVER firing,
 * so a rapid double-click can never leave two `animate()` calls racing on
 * the same overlay node, nor a stuck mid-screen overlay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeControls {
  then: Promise<void>['then']
  stop: ReturnType<typeof vi.fn>
  resolve: () => void
}

function makeFakeControls(): FakeControls {
  let resolveFn!: () => void
  let rejectFn!: (reason?: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  const stop = vi.fn(() => rejectFn(new Error('stopped')))
  return { then: promise.then.bind(promise), stop, resolve: () => resolveFn() }
}

let controlsQueue: FakeControls[] = []
let animateCalls: unknown[][] = []
const animateMock = vi.fn((...args: unknown[]) => {
  animateCalls.push(args)
  const controls = makeFakeControls()
  controlsQueue.push(controls)
  return controls
})
vi.mock('framer-motion', () => ({
  animate: (...args: unknown[]) => animateMock(...args),
}))

/** Flushes pending microtasks (Promise chains) AND at least one macrotask tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function freshModule() {
  vi.resetModules()
  animateCalls = []
  controlsQueue = []
  animateMock.mockClear()
  return import('@/lib/wipe-transition')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runWipeTransition', () => {
  it('runs wipe-in -> onMidSweep -> wipe-out -> reset in order, resolving once', async () => {
    const { runWipeTransition } = await freshModule()
    const overlay = document.createElement('div')
    const onMidSweep = vi.fn()

    const runPromise = runWipeTransition(overlay, Promise.resolve(), onMidSweep)
    await flush()

    // call 0: the initial cancelWipeTransition() reset (no-op, nothing was
    // running yet); call 1: wipe-in.
    expect(controlsQueue).toHaveLength(2)
    expect(onMidSweep).not.toHaveBeenCalled()

    controlsQueue[1]!.resolve() // wipe-in finishes
    await flush()
    expect(onMidSweep).toHaveBeenCalledTimes(1)

    // call 2: wipe-out.
    expect(controlsQueue).toHaveLength(3)
    controlsQueue[2]!.resolve() // wipe-out finishes
    await runPromise

    // call 3: final instant reset off-screen.
    expect(animateCalls).toHaveLength(4)
    const [target, keyframes, options] = animateCalls[3] as [unknown, unknown, { duration: number }]
    expect(target).toBe(overlay)
    expect(keyframes).toEqual({ x: '-100%' })
    expect(options.duration).toBe(0)
  })

  it('a second run() before the first finishes cancels the first — its onMidSweep never fires, only the second completes', async () => {
    const { runWipeTransition } = await freshModule()
    const overlay = document.createElement('div')
    const onMidSweep1 = vi.fn()
    const onMidSweep2 = vi.fn()

    // First click — waits on a promise that never resolves on its own
    // (irrelevant: it gets superseded before that matters).
    void runWipeTransition(overlay, new Promise<void>(() => {}), onMidSweep1)
    await flush()
    const run1WipeIn = controlsQueue[1]!
    expect(run1WipeIn.stop).not.toHaveBeenCalled()

    // Rapid second click before the first's wipe-in even resolves.
    const run2 = runWipeTransition(overlay, Promise.resolve(), onMidSweep2)
    await flush()

    // Starting the second run stopped the first's in-flight animation.
    expect(run1WipeIn.stop).toHaveBeenCalledTimes(1)

    // Let the second run's own wipe-in resolve.
    const run2WipeIn = controlsQueue[3]!
    run2WipeIn.resolve()
    await flush()

    expect(onMidSweep2).toHaveBeenCalledTimes(1)
    expect(onMidSweep1).not.toHaveBeenCalled()

    // Finish the second run all the way through.
    const run2WipeOut = controlsQueue[4]!
    run2WipeOut.resolve()
    await run2
    await flush()

    expect(onMidSweep1).not.toHaveBeenCalled()
    // Only ONE reset-off-screen call happened as part of run2's own
    // completion (plus the two cancel-reset calls at each run's start) —
    // never two competing "final" resets landing out of order.
    const resetCalls = animateCalls.filter((call) => {
      const [, keyframes, options] = call as [unknown, { x?: string }, { duration: number }]
      return keyframes.x === '-100%' && options.duration === 0
    })
    // call0 (run1 start), call2 (run2 start, which also cancels run1), and
    // the final reset after run2's wipe-out = 3 total "-100%ms 0" calls.
    expect(resetCalls).toHaveLength(3)
  })

  it('a third rapid click supersedes the second the same way (not just pairwise)', async () => {
    const { runWipeTransition } = await freshModule()
    const overlay = document.createElement('div')
    const onMidSweep1 = vi.fn()
    const onMidSweep2 = vi.fn()
    const onMidSweep3 = vi.fn()

    void runWipeTransition(overlay, new Promise<void>(() => {}), onMidSweep1)
    await flush()
    void runWipeTransition(overlay, new Promise<void>(() => {}), onMidSweep2)
    await flush()
    const run3 = runWipeTransition(overlay, Promise.resolve(), onMidSweep3)
    await flush()

    // wipe-ins: index1 (run1), index3 (run2), index5 (run3)
    expect(controlsQueue[1]!.stop).toHaveBeenCalledTimes(1) // run1 superseded by run2
    expect(controlsQueue[3]!.stop).toHaveBeenCalledTimes(1) // run2 superseded by run3

    controlsQueue[5]!.resolve() // run3's wipe-in
    await flush()
    expect(onMidSweep3).toHaveBeenCalledTimes(1)
    expect(onMidSweep1).not.toHaveBeenCalled()
    expect(onMidSweep2).not.toHaveBeenCalled()

    controlsQueue[6]!.resolve() // run3's wipe-out
    await run3
  })
})

describe('cancelWipeTransition', () => {
  it('stops any active animation and resets the overlay off-screen', async () => {
    const { runWipeTransition, cancelWipeTransition } = await freshModule()
    const overlay = document.createElement('div')

    void runWipeTransition(overlay, new Promise<void>(() => {}), vi.fn())
    await flush()
    const wipeIn = controlsQueue[1]!
    expect(wipeIn.stop).not.toHaveBeenCalled()

    cancelWipeTransition(overlay)

    expect(wipeIn.stop).toHaveBeenCalledTimes(1)
    const lastCall = animateCalls[animateCalls.length - 1] as [
      unknown,
      { x: string },
      { duration: number },
    ]
    expect(lastCall[1]).toEqual({ x: '-100%' })
    expect(lastCall[2]).toEqual({ duration: 0 })
  })

  it('is a safe no-op (still resets, no throw) when nothing is currently animating', async () => {
    const { cancelWipeTransition } = await freshModule()
    const overlay = document.createElement('div')
    expect(() => cancelWipeTransition(overlay)).not.toThrow()
    expect(animateMock).toHaveBeenCalledTimes(1)
  })
})
