import { describe, expect, it } from 'vitest'

// Contract of the Animation.cancel shim in ./setup.ts: it marks the `finished`
// rejection handled (no unhandled-rejection report) WITHOUT hiding it from
// consumers. `p.catch(noop)` derives a new promise and does not consume `p`.
describe('Animation.cancel shim (setup.ts)', () => {
  it('still rejects `finished` with an AbortError for a consumer awaiting it', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], 1000)
    const observed = animation.finished
    animation.cancel()
    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    el.remove()
  })
})
