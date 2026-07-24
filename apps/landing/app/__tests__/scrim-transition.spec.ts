/**
 * scrim-transition.ts — the cancellable dark-scrim + thin caret-line
 * page-transition sweep (§M.3/§M.3.0 HOTFIX, replaces the old full-screen
 * "wipe"). `framer-motion`'s `animate()` is mocked to return a controllable
 * fake `AnimationPlaybackControls` (thenable + `.stop()`) so tests can drive
 * each phase (scrim-in / scrim-out / reset) deterministically instead of
 * depending on real animation timing — and, critically, prove the
 * double-click guard: a second `runScrimTransition()` call before the first
 * finishes must `.stop()` the first's in-flight animations and prevent its
 * `onMidSweep` from EVER firing, so a rapid double-click can never leave
 * `animate()` calls racing on the same overlay nodes, nor a stuck
 * mid-animation scrim/caret.
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
  return import('@/lib/scrim-transition')
}

function makeElements() {
  return { scrim: document.createElement('div'), caret: document.createElement('div') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runScrimTransition', () => {
  it('runs scrim-in+caret-sweep (parallel) -> onMidSweep -> scrim-out -> reset, resolving once', async () => {
    const { runScrimTransition } = await freshModule()
    const elements = makeElements()
    const onMidSweep = vi.fn()

    const runPromise = runScrimTransition(elements, Promise.resolve(), onMidSweep)
    await flush()

    // call 0-1: cancelScrimTransition()'s initial reset (scrim opacity:0,
    // caret x:-15vw — nothing was running yet); call 2: scrim-in;
    // call 3: caret-sweep (fired in parallel, NOT gated together below).
    expect(controlsQueue).toHaveLength(4)
    expect(onMidSweep).not.toHaveBeenCalled()

    controlsQueue[2]!.resolve() // scrim-in finishes (caret-sweep is NOT awaited in the gate)
    await flush()
    expect(onMidSweep).toHaveBeenCalledTimes(1)

    // call 4: scrim-out.
    expect(controlsQueue).toHaveLength(5)
    controlsQueue[4]!.resolve() // scrim-out finishes
    await runPromise

    // Final reset: scrim transparent, caret parked off-screen (same order
    // as cancelScrimTransition).
    const [scrimResetCall, caretResetCall] = animateCalls.slice(-2) as [
      [unknown, { opacity: number }, { duration: number }],
      [unknown, { x: string }, { duration: number }],
    ]
    expect(scrimResetCall[1]).toEqual({ opacity: 0 })
    expect(scrimResetCall[2]).toEqual({ duration: 0 })
    expect(caretResetCall[1]).toEqual({ x: '-15vw' })
    expect(caretResetCall[2]).toEqual({ duration: 0 })
  })

  it('uses the shared EASE_SOFT curve and HOTFIX durations for every phase', async () => {
    const { runScrimTransition } = await freshModule()
    const { DUR_SCRIM_IN, DUR_CARET_SWEEP, DUR_SCRIM_OUT, EASE_SOFT } = await import('@/lib/motion')
    const elements = makeElements()

    void runScrimTransition(elements, Promise.resolve(), vi.fn())
    await flush()

    const scrimInCall = animateCalls[2] as [unknown, unknown, { duration: number; ease: unknown }]
    const caretSweepCall = animateCalls[3] as [
      unknown,
      unknown,
      { duration: number; ease: unknown },
    ]
    expect(scrimInCall[2].duration).toBe(DUR_SCRIM_IN)
    expect(scrimInCall[2].ease).toBe(EASE_SOFT)
    expect(caretSweepCall[2].duration).toBe(DUR_CARET_SWEEP)
    expect(caretSweepCall[2].ease).toBe(EASE_SOFT)

    controlsQueue[2]!.resolve()
    await flush()
    const scrimOutCall = animateCalls[4] as [unknown, unknown, { duration: number; ease: unknown }]
    expect(scrimOutCall[2].duration).toBe(DUR_SCRIM_OUT)
    expect(scrimOutCall[2].ease).toBe(EASE_SOFT)
  })

  it('a second run() before the first finishes cancels the first — its onMidSweep never fires, only the second completes', async () => {
    const { runScrimTransition } = await freshModule()
    const elements = makeElements()
    const onMidSweep1 = vi.fn()
    const onMidSweep2 = vi.fn()

    // First click — waits on a promise that never resolves on its own
    // (irrelevant: it gets superseded before that matters).
    void runScrimTransition(elements, new Promise<void>(() => {}), onMidSweep1)
    await flush()
    const run1ScrimIn = controlsQueue[2]!
    const run1CaretSweep = controlsQueue[3]!
    expect(run1ScrimIn.stop).not.toHaveBeenCalled()

    // Rapid second click before the first's scrim-in even resolves.
    const run2 = runScrimTransition(elements, Promise.resolve(), onMidSweep2)
    await flush()

    // Starting the second run stopped BOTH of the first run's in-flight animations.
    expect(run1ScrimIn.stop).toHaveBeenCalledTimes(1)
    expect(run1CaretSweep.stop).toHaveBeenCalledTimes(1)

    // Let the second run's own scrim-in resolve (index 6: cancel-reset x2,
    // run1 scrim-in+caret x2, run2 cancel-reset x2, run2 scrim-in).
    const run2ScrimIn = controlsQueue[6]!
    run2ScrimIn.resolve()
    await flush()

    expect(onMidSweep2).toHaveBeenCalledTimes(1)
    expect(onMidSweep1).not.toHaveBeenCalled()

    // Finish the second run all the way through.
    const run2ScrimOut = controlsQueue[8]!
    run2ScrimOut.resolve()
    await run2
    await flush()

    expect(onMidSweep1).not.toHaveBeenCalled()
  })

  it('a third rapid click supersedes the second the same way (not just pairwise)', async () => {
    const { runScrimTransition } = await freshModule()
    const elements = makeElements()
    const onMidSweep1 = vi.fn()
    const onMidSweep2 = vi.fn()
    const onMidSweep3 = vi.fn()

    void runScrimTransition(elements, new Promise<void>(() => {}), onMidSweep1)
    await flush()
    void runScrimTransition(elements, new Promise<void>(() => {}), onMidSweep2)
    await flush()
    const run3 = runScrimTransition(elements, Promise.resolve(), onMidSweep3)
    await flush()

    // scrim-in/caret-sweep pairs: indices 2-3 (run1), 6-7 (run2), 10-11 (run3)
    // — each run's cancelScrimTransition() also emits its own 2 reset calls
    // (4-5 for run2's cancel, 8-9 for run3's cancel) before its own pair.
    expect(controlsQueue[2]!.stop).toHaveBeenCalledTimes(1) // run1 scrim-in superseded by run2
    expect(controlsQueue[3]!.stop).toHaveBeenCalledTimes(1) // run1 caret-sweep superseded by run2
    expect(controlsQueue[6]!.stop).toHaveBeenCalledTimes(1) // run2 scrim-in superseded by run3
    expect(controlsQueue[7]!.stop).toHaveBeenCalledTimes(1) // run2 caret-sweep superseded by run3

    controlsQueue[10]!.resolve() // run3's scrim-in
    await flush()
    expect(onMidSweep3).toHaveBeenCalledTimes(1)
    expect(onMidSweep1).not.toHaveBeenCalled()
    expect(onMidSweep2).not.toHaveBeenCalled()

    controlsQueue[12]!.resolve() // run3's scrim-out
    await run3

    expect(onMidSweep1).not.toHaveBeenCalled()
    expect(onMidSweep2).not.toHaveBeenCalled()
  })
})

describe('cancelScrimTransition', () => {
  it('stops any active animations and resets both layers to idle', async () => {
    const { runScrimTransition, cancelScrimTransition } = await freshModule()
    const elements = makeElements()

    void runScrimTransition(elements, new Promise<void>(() => {}), vi.fn())
    await flush()
    const scrimIn = controlsQueue[2]!
    const caretSweep = controlsQueue[3]!
    expect(scrimIn.stop).not.toHaveBeenCalled()

    cancelScrimTransition(elements)

    expect(scrimIn.stop).toHaveBeenCalledTimes(1)
    expect(caretSweep.stop).toHaveBeenCalledTimes(1)
    const [scrimResetCall, caretResetCall] = animateCalls.slice(-2) as [
      [unknown, { opacity: number }, { duration: number }],
      [unknown, { x: string }, { duration: number }],
    ]
    expect(scrimResetCall[1]).toEqual({ opacity: 0 })
    expect(scrimResetCall[2]).toEqual({ duration: 0 })
    expect(caretResetCall[1]).toEqual({ x: '-15vw' })
    expect(caretResetCall[2]).toEqual({ duration: 0 })
  })

  it('is a safe no-op (still resets, no throw) when nothing is currently animating', async () => {
    const { cancelScrimTransition } = await freshModule()
    const elements = makeElements()
    expect(() => cancelScrimTransition(elements)).not.toThrow()
    expect(animateMock).toHaveBeenCalledTimes(2) // scrim reset + caret reset
  })
})
