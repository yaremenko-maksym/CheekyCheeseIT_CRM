/**
 * page-transition.ts — module-level "which variant should the next
 * navigation use" flag (docs/design/landing-redesign.md §M.3). Same
 * `vi.resetModules()` + dynamic re-import technique as
 * `prerender-hint.spec.ts` — the module's state is intentionally global, so
 * each test needs its own fresh instance.
 */
import { describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('@/lib/page-transition')
}

describe('page-transition', () => {
  it('defaults to the primary "wipe" variant before anything marks it light', async () => {
    const { consumePendingVariant } = await freshModule()
    expect(consumePendingVariant()).toBe('wipe')
  })

  it('markNextTransitionLight forces the next consumePendingVariant() call to return "light"', async () => {
    const { markNextTransitionLight, consumePendingVariant } = await freshModule()
    markNextTransitionLight()
    expect(consumePendingVariant()).toBe('light')
  })

  it('consumePendingVariant is a one-shot read — resets back to "wipe" immediately after being read', async () => {
    const { markNextTransitionLight, consumePendingVariant } = await freshModule()
    markNextTransitionLight()
    expect(consumePendingVariant()).toBe('light')
    // A second, unrelated navigation right after must NOT inherit the
    // override — only the primary "wipe" variant is the default.
    expect(consumePendingVariant()).toBe('wipe')
  })

  it('multiple markNextTransitionLight calls before a consume still only affect the single next read', async () => {
    const { markNextTransitionLight, consumePendingVariant } = await freshModule()
    markNextTransitionLight()
    markNextTransitionLight()
    expect(consumePendingVariant()).toBe('light')
    expect(consumePendingVariant()).toBe('wipe')
  })
})
