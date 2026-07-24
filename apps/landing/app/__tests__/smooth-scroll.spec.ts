/**
 * smooth-scroll.ts — JS-driven in-page anchor scroll (§M.4). `framer-motion`'s
 * `animate()` is mocked so the test controls exactly when/how `onUpdate`
 * fires instead of depending on real rAF timing — the module under test only
 * needs to be proven to (a) compute the right target Y against the sticky
 * header offset, (b) hand that off to `animate()` with the shared motion
 * tokens, and (c) bypass `animate()` entirely under reduced-motion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const animateMock = vi.fn()
vi.mock('framer-motion', () => ({
  animate: (...args: unknown[]) => animateMock(...args),
}))

function mockMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: reduced }) as unknown as typeof window.matchMedia,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  animateMock.mockClear()
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
    const el = document.createElement('div')
    el.id = 'contact'
    document.body.appendChild(el)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect)
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    const scrollToSpy = vi.fn()
    vi.stubGlobal('scrollTo', scrollToSpy)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    smoothScrollToId('contact')

    // targetY = 500 (rect.top) + 0 (scrollY) - 82 (66px nav + 16px breathing room)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 418)
    expect(animateMock).not.toHaveBeenCalled()
  })

  it('normal motion: hands off to animate() with the shared duration/easing tokens, driving scrollTo via onUpdate', async () => {
    mockMatchMedia(false)
    const el = document.createElement('div')
    el.id = 'services'
    document.body.appendChild(el)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 900 } as DOMRect)
    Object.defineProperty(window, 'scrollY', { value: 40, configurable: true })
    const scrollToSpy = vi.fn()
    vi.stubGlobal('scrollTo', scrollToSpy)

    const { smoothScrollToId } = await import('@/lib/smooth-scroll')
    const { DUR_SMOOTH_SCROLL, EASE_STANDARD } = await import('@/lib/motion')
    smoothScrollToId('services')

    expect(animateMock).toHaveBeenCalledTimes(1)
    const [from, to, options] = animateMock.mock.calls[0] as [
      number,
      number,
      Record<string, unknown>,
    ]
    expect(from).toBe(40) // window.scrollY at call time
    expect(to).toBe(858) // 900 + 40 - 82
    expect(options['duration']).toBe(DUR_SMOOTH_SCROLL)
    expect(options['ease']).toBe(EASE_STANDARD)

    // Simulate a frame tick the way framer-motion's animate() would call it.
    ;(options['onUpdate'] as (v: number) => void)(777)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 777)
  })
})
