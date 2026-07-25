/**
 * lift-transition.ts — the imperative exit half of the lift cross-fade
 * (docs/design/landing-redesign.md §M v3.1 step 4). `framer-motion`'s
 * `animate()` is mocked so the test can assert exactly what it was called
 * with, same technique previously used for the removed `scrim-transition.ts`
 * spec.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

let animateCalls: unknown[][] = []
const animateMock = vi.fn((...args: unknown[]) => {
  animateCalls.push(args)
  return { then: (onFulfilled?: () => void) => Promise.resolve().then(onFulfilled) }
})
vi.mock('framer-motion', () => ({
  animate: (...args: unknown[]) => animateMock(...args),
}))

async function freshModule() {
  vi.resetModules()
  animateCalls = []
  animateMock.mockClear()
  return import('@/lib/lift-transition')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('playLiftExit', () => {
  it('is a no-op when el is null', async () => {
    const { playLiftExit } = await freshModule()
    playLiftExit(null, false)
    expect(animateMock).not.toHaveBeenCalled()
  })

  it('is a no-op when reducedMotion is true, even with a real element', async () => {
    const { playLiftExit } = await freshModule()
    playLiftExit(document.createElement('div'), true)
    expect(animateMock).not.toHaveBeenCalled()
  })

  it('animates opacity 1->0 and y 0->LIFT_OFFSET_EXIT with DUR_LIFT_EXIT/EASE_SOFT', async () => {
    const { playLiftExit } = await freshModule()
    const { DUR_LIFT_EXIT, EASE_SOFT, LIFT_OFFSET_EXIT } = await import('@/lib/motion')
    const el = document.createElement('div')

    playLiftExit(el, false)

    expect(animateMock).toHaveBeenCalledTimes(1)
    const [target, keyframes, options] = animateMock.mock.calls[0] as [
      HTMLElement,
      { opacity: number[]; y: number[] },
      { duration: number; ease: unknown },
    ]
    expect(target).toBe(el)
    expect(keyframes).toEqual({ opacity: [1, 0], y: [0, LIFT_OFFSET_EXIT] })
    expect(options.duration).toBe(DUR_LIFT_EXIT)
    expect(options.ease).toBe(EASE_SOFT)
  })
})
