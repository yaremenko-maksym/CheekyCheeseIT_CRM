/**
 * smooth-scroll.ts — JS-driven in-page anchor scroll (§M.4). `framer-motion`'s
 * `animate()` is mocked to return a controllable fake `AnimationPlaybackControls`
 * (thenable + `.stop()`) so tests can (a) verify the right target Y against the
 * sticky header offset, (b) verify the shared motion tokens are used, (c) verify
 * `prefers-reduced-motion` bypasses `animate()` entirely, and (d) verify
 * cancellation — a repeat call, or a real wheel/touchstart gesture mid-animation,
 * must stop the in-flight animation instead of leaving two of them racing on
 * `window.scrollTo` (code-review fix-round finding).
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
const animateMock = vi.fn((..._args: unknown[]) => {
  const controls = makeFakeControls()
  controlsQueue.push(controls)
  return controls
})
vi.mock('framer-motion', () => ({
  animate: (...args: unknown[]) => animateMock(...args),
}))

function mockMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: reduced }) as unknown as typeof window.matchMedia,
  )
}

/** Flushes pending microtasks (Promise chains) AND at least one macrotask tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function stubAnchor(id: string, top: number, scrollY: number) {
  const el = document.createElement('div')
  el.id = id
  document.body.appendChild(el)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top } as DOMRect)
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true })
  const scrollToSpy = vi.fn()
  vi.stubGlobal('scrollTo', scrollToSpy)
  return scrollToSpy
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  animateMock.mockClear()
  controlsQueue = []
  document.body.innerHTML = ''
})

describe('smoothScrollToId', () => {
  it('no-ops when the target id does not exist in the document', async () => {
    mockMatchMedia(false)
    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('does-not-exist')
    expect(animateMock).not.toHaveBeenCalled()
  })

  it('reduced motion: scrolls instantly (no animate() call) to the header-offset target', async () => {
    mockMatchMedia(true)
    const scrollToSpy = stubAnchor('contact', 500, 0)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('contact')

    // targetY = 500 (rect.top) + 0 (scrollY) - 82 (66px nav + 16px breathing room)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 418)
    expect(animateMock).not.toHaveBeenCalled()
  })

  it('normal motion: hands off to animate() with the shared duration/easing tokens, driving scrollTo via onUpdate', async () => {
    mockMatchMedia(false)
    const scrollToSpy = stubAnchor('services', 900, 40)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    const { DUR_SMOOTH_SCROLL, EASE_SOFT } = await import('@/lib/motion')
    smoothScrollToId('services')

    expect(animateMock).toHaveBeenCalledTimes(1)
    const [from, to, options] = animateMock.mock.calls[0] as unknown as [
      number,
      number,
      Record<string, unknown>,
    ]
    expect(from).toBe(40) // window.scrollY at call time
    expect(to).toBe(858) // 900 + 40 - 82
    expect(options['duration']).toBe(DUR_SMOOTH_SCROLL)
    expect(options['ease']).toBe(EASE_SOFT)

    // Simulate a frame tick the way framer-motion's animate() would call it.
    ;(options['onUpdate'] as (v: number) => void)(777)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 777)
  })

  it('a repeat call before the first animation finishes stops the first — only one animate() stays active', async () => {
    mockMatchMedia(false)
    stubAnchor('services', 900, 40)
    stubAnchor('contact', 1800, 40)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('services')
    expect(controlsQueue).toHaveLength(1)
    const firstControls = controlsQueue[0]!
    expect(firstControls.stop).not.toHaveBeenCalled()

    // Rapid second click on a different anchor before the first finishes.
    smoothScrollToId('contact')
    await flush()

    expect(firstControls.stop).toHaveBeenCalledTimes(1)
    expect(controlsQueue).toHaveLength(2)
    expect(controlsQueue[1]!.stop).not.toHaveBeenCalled()
  })

  it("a wheel gesture mid-animation cancels it (stop()) instead of fighting the user's scroll", async () => {
    mockMatchMedia(false)
    stubAnchor('services', 900, 40)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('services')
    const controls = controlsQueue[0]!
    expect(controls.stop).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('wheel'))
    await flush()

    expect(controls.stop).toHaveBeenCalledTimes(1)
  })

  it('a touchstart gesture mid-animation cancels it the same way', async () => {
    mockMatchMedia(false)
    stubAnchor('services', 900, 40)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('services')
    const controls = controlsQueue[0]!

    window.dispatchEvent(new Event('touchstart'))
    await flush()

    expect(controls.stop).toHaveBeenCalledTimes(1)
  })

  it('the wheel/touchstart listeners are cleaned up once the animation finishes naturally (no lingering cancel-on-later-gesture)', async () => {
    mockMatchMedia(false)
    stubAnchor('services', 900, 40)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('services')
    const controls = controlsQueue[0]!

    // Animation finishes naturally (not interrupted).
    controls.resolve()
    await flush()

    // A gesture arriving well after natural completion must not call
    // .stop() again — the listeners should already be detached.
    window.dispatchEvent(new Event('wheel'))
    await flush()

    expect(controls.stop).not.toHaveBeenCalled()
  })
})
