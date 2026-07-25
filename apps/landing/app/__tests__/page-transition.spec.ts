/**
 * page-transition.ts — module-level "which direction should the next
 * navigation's lift enter from" flag (docs/design/landing-redesign.md
 * §M v3.1). Same `vi.resetModules()` + dynamic re-import technique as
 * `prerender-hint.spec.ts` — the module's state is intentionally global, so
 * each test needs its own fresh instance.
 */
import { describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('@/lib/page-transition')
}

describe('page-transition', () => {
  it('defaults to the "forward" direction before anything marks it back', async () => {
    const { consumePendingDirection } = await freshModule()
    expect(consumePendingDirection()).toBe('forward')
  })

  it('markNextTransitionBack forces the next consumePendingDirection() call to return "back"', async () => {
    const { markNextTransitionBack, consumePendingDirection } = await freshModule()
    markNextTransitionBack()
    expect(consumePendingDirection()).toBe('back')
  })

  it('consumePendingDirection is a one-shot read — resets back to "forward" immediately after being read', async () => {
    const { markNextTransitionBack, consumePendingDirection } = await freshModule()
    markNextTransitionBack()
    expect(consumePendingDirection()).toBe('back')
    // A second, unrelated navigation right after must NOT inherit the
    // override — only the "forward" direction is the default.
    expect(consumePendingDirection()).toBe('forward')
  })

  it('multiple markNextTransitionBack calls before a consume still only affect the single next read', async () => {
    const { markNextTransitionBack, consumePendingDirection } = await freshModule()
    markNextTransitionBack()
    markNextTransitionBack()
    expect(consumePendingDirection()).toBe('back')
    expect(consumePendingDirection()).toBe('forward')
  })
})
