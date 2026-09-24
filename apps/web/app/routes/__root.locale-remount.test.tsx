/**
 * __root.locale-remount.test.tsx — task-i18n-stage3a (Task 2), fix-round 1
 * (CR-M-1).
 *
 * `LocaleScopedApp` (see `__root.tsx`) keys the whole route tree by the
 * ACTIVE locale so a component that reads `formatAmount`/`formatAmountUsd`
 * (or any other `i18n.locale`-reading helper) OUTSIDE `useLingui()`/
 * `<Trans>` still picks up a mid-session language switch — those helpers
 * read the shared `i18n` singleton at CALL time, not through React context,
 * so nothing forces them to re-run on their own.
 *
 * `Outlet` is mocked to a tiny probe: it renders `formatAmount(1500, 'USDT')`
 * and bumps a module-level mount counter in a mount-only `useEffect` — the
 * counter is what proves a REMOUNT happened (a plain re-render would leave
 * it unchanged), and the formatted text is what proves the new instance
 * picked up the new locale.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { formatAmount } from '@/lib/format-amount'

let mountCount = 0

vi.mock('@tanstack/react-router', () => ({
  // `__root.tsx`'s own module-top-level `export const Route =
  // createRootRoute({ component: RootDocument })` runs the moment this
  // module is imported below — it needs SOME callable here, even though
  // this test never touches `Route` itself (it imports `LocaleScopedApp`
  // directly, bypassing the router entirely).
  createRootRoute: (options: unknown) => options,
  Outlet: () => {
    useEffect(() => {
      mountCount += 1
    }, [])
    return <div data-testid="probe-amount">{formatAmount(1500, 'USDT')}</div>
  },
}))

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Imported AFTER the mocks above are registered (hoisted by vitest anyway,
// but keeping the import last documents the dependency for a human reader).
import { LocaleScopedApp } from './__root'

beforeEach(() => {
  mountCount = 0
})

describe('LocaleScopedApp — remounts the route tree on locale change (CR-M-1)', () => {
  it('mounts once on the initial render, with uk-formatted output', async () => {
    await loadCatalog('uk')
    render(<LocaleScopedApp />, { wrapper: I18nTestProvider })
    await waitFor(() => expect(mountCount).toBe(1))
    // `.textContent` directly, not `toHaveTextContent` — that matcher's
    // whitespace normalizer treats U+00A0 as ordinary whitespace and would
    // hide exactly the join character `formatMoney` (COPY-L-3) cares about.
    expect(screen.getByTestId('probe-amount').textContent).toBe('1 500,00 USDT')
  })

  it('remounts (not just re-renders) and switches formatting after activateLocale changes the locale', async () => {
    await loadCatalog('uk')
    render(<LocaleScopedApp />, { wrapper: I18nTestProvider })
    await waitFor(() => expect(mountCount).toBe(1))

    await act(async () => {
      await loadCatalog('en')
    })

    // A remount, not a same-instance re-render: the mount-only effect fires
    // again. A mutation that dropped the `key` (e.g. deleted `key={locale}`
    // or froze it to a constant) would leave `mountCount` at 1 forever, even
    // though `formatAmount`'s OWN output is locale-correct either way once
    // read fresh — the counter is what this test needs that the text alone
    // could not prove.
    await waitFor(() => expect(mountCount).toBe(2))
    expect(screen.getByTestId('probe-amount').textContent).toBe('1,500.00 USDT')
  })

  it('does not double-mount on the very first render (key is not accidentally already-changing)', async () => {
    await loadCatalog('uk')
    render(<LocaleScopedApp />, { wrapper: I18nTestProvider })
    await waitFor(() => expect(mountCount).toBe(1))
    // Give React a further tick with nothing changing — still exactly one
    // mount, not two, from the initial render alone.
    await new Promise((r) => setTimeout(r, 0))
    expect(mountCount).toBe(1)
  })
})
