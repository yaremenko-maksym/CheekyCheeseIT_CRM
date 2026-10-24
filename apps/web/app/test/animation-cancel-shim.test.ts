import { describe, expect, it } from 'vitest'

// Contract of the Animation.cancel shim in ./setup.ts, both halves:
//  1. cancel() with nobody listening must not emit an unhandled-rejection report
//     (the thing the shim exists for; red without the shim);
//  2. the rejection must stay visible to a consumer of `finished` (`p.catch(noop)`
//     derives a new promise and does not consume `p`).
describe('Animation.cancel shim (setup.ts)', () => {
  it('emits no unhandled rejection on cancel(), yet `finished` still rejects with an AbortError', async () => {
    const reports: unknown[] = []
    const onUnhandled = (reason: unknown) => reports.push(reason)
    process.on('unhandledRejection', onUnhandled)

    const el = document.createElement('div')
    document.body.appendChild(el)
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], 1000)
    const observed = animation.finished
    animation.cancel()

    // Node emits `unhandledRejection` after the microtask queue drains; wait past it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    process.off('unhandledRejection', onUnhandled)
    el.remove()

    expect(reports).toEqual([])
    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
  })
})
