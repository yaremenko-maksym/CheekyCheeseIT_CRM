/**
 * prerender-hint.ts — module-level flag `client.tsx` sets once before
 * `createRoot().render()` clears any prerendered markup. See terminal.tsx
 * for the consumer (hero typewriter hydration-flash fix, PR #398).
 *
 * `vi.resetModules()` + dynamic re-import per test — the module's state is
 * intentionally global/mutable (mirrors real page-load lifetime), so each
 * test needs its own fresh instance.
 */
import { describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('@/lib/prerender-hint')
}

describe('prerender-hint', () => {
  it('defaults to false before recordPrerenderedRoot is ever called', async () => {
    const { wasRootPrerendered } = await freshModule()
    expect(wasRootPrerendered()).toBe(false)
  })

  it('records true for a root element with existing children (prerendered markup)', async () => {
    const { recordPrerenderedRoot, wasRootPrerendered } = await freshModule()
    const root = document.createElement('div')
    root.appendChild(document.createElement('span'))
    recordPrerenderedRoot(root)
    expect(wasRootPrerendered()).toBe(true)
  })

  it('records false for an empty root element (plain CSR)', async () => {
    const { recordPrerenderedRoot, wasRootPrerendered } = await freshModule()
    const root = document.createElement('div')
    recordPrerenderedRoot(root)
    expect(wasRootPrerendered()).toBe(false)
  })

  it('records false for a null root (defensive default)', async () => {
    const { recordPrerenderedRoot, wasRootPrerendered } = await freshModule()
    recordPrerenderedRoot(null)
    expect(wasRootPrerendered()).toBe(false)
  })
})
