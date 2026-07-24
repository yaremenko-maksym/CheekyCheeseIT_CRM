/**
 * Terminal — hero typewriter initial-state fix (ui-ux-designer Mode B
 * fidelity review, PR #398, HIGH): a genuine first mount over prerendered
 * markup must render the first snippet already fully typed (matching what
 * `scripts/prerender.mjs` captured) instead of resetting to empty and
 * re-animating it — but a later SPA-navigation remount, or a first mount
 * that was NOT prerendered, must still type from scratch as before.
 *
 * `terminal.tsx`'s `terminalHasMountedOnce` and `prerender-hint.ts`'s
 * `wasPrerendered` are both module-level state — `vi.resetModules()` +
 * dynamic re-import between tests gives each test its own fresh instance of
 * both, so tests don't leak mount-order state into each other.
 */
import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshTerminalModule() {
  vi.resetModules()
  const prerenderHint = await import('@/lib/prerender-hint')
  const { Terminal } = await import('@/components/marketing/terminal')
  return { prerenderHint, Terminal }
}

/** The hero terminal's own accessible root — see terminal.tsx's `role="img"`. */
function getTerminalRoot() {
  return screen.getByRole('img', { name: /Animated code editor/i })
}

describe('Terminal — prerender-hydration initial state', () => {
  afterEach(() => {
    cleanup()
  })

  it('first mount over prerendered markup renders snippet 0 fully typed immediately (no erase-and-retype)', async () => {
    const { prerenderHint, Terminal } = await freshTerminalModule()
    const fakeRoot = document.createElement('div')
    fakeRoot.appendChild(document.createElement('span')) // non-empty => "was prerendered"
    prerenderHint.recordPrerenderedRoot(fakeRoot)

    render(<Terminal />)

    // First snippet's own distinguishing content — see SNIPPETS[0] in
    // terminal.tsx — present on the VERY FIRST render, not after a delay.
    expect(getTerminalRoot().textContent).toContain('realtime multimodal inference')
    expect(getTerminalRoot().textContent).toContain('Pipeline.load')
    expect(getTerminalRoot().textContent).toContain(
      'return { "labels": out.labels, "ms": out.latency }',
    )
  })

  it('a later remount (SPA navigation) types from scratch even though the page was originally prerendered', async () => {
    const { prerenderHint, Terminal } = await freshTerminalModule()
    const fakeRoot = document.createElement('div')
    fakeRoot.appendChild(document.createElement('span'))
    prerenderHint.recordPrerenderedRoot(fakeRoot)

    // First mount consumes the "skip typing" allowance (home -> ...).
    const first = render(<Terminal />)
    expect(getTerminalRoot().textContent).toContain('realtime multimodal inference')
    first.unmount()

    // Second mount of the SAME module instance = SPA navigation back to
    // home ("... -> careers -> home") — must NOT reuse the allowance.
    render(<Terminal />)
    expect(getTerminalRoot().textContent ?? '').not.toContain('realtime multimodal inference')
  })

  it('first mount WITHOUT prerendered markup (plain CSR, e.g. local dev) types from scratch', async () => {
    const { prerenderHint, Terminal } = await freshTerminalModule()
    const emptyRoot = document.createElement('div') // no children => was NOT prerendered
    prerenderHint.recordPrerenderedRoot(emptyRoot)

    render(<Terminal />)

    expect(getTerminalRoot().textContent ?? '').not.toContain('realtime multimodal inference')
  })

  it('recordPrerenderedRoot(null) is treated as not-prerendered (defensive default)', async () => {
    const { prerenderHint, Terminal } = await freshTerminalModule()
    prerenderHint.recordPrerenderedRoot(null)

    render(<Terminal />)

    expect(getTerminalRoot().textContent ?? '').not.toContain('realtime multimodal inference')
  })
})
