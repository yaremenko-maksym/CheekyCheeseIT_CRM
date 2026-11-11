/**
 * Under the React Compiler, a component that calls `i18n._(…)` during render
 * is memoized on the `i18n` singleton, whose identity never changes across
 * `activate()`. A same-instance re-render would therefore keep the old-locale
 * text. `LocaleScopedApp` (`__root.tsx`) keys the route tree by locale, so a
 * switch REMOUNTS it and the compiled caches start empty. This pins that
 * contract for a render-time `i18n._` read (the sibling
 * `__root.locale-remount.test.tsx` pins it for `formatAmount`).
 * Removing the root remount requires the 0.1a codemod first (render-time
 * `i18n._` / `i18n.locale` reads moved to `t` from `useLingui()`).
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@tanstack/react-router', async () => {
  const { ProbeLabel } = await import('@/test/fixtures/probe-label')
  return { createRootRoute: (options: unknown) => options, Outlet: ProbeLabel }
})

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { LocaleScopedApp } from './__root'

describe('LocaleScopedApp — a render-time i18n._ read follows a live locale switch', () => {
  it('shows the uk label, then the en label after activateLocale', async () => {
    await loadCatalog('uk')
    render(<LocaleScopedApp />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('probe-label').textContent).toBe('Дохід адміна')

    await act(async () => {
      await loadCatalog('en')
    })

    await waitFor(() => expect(screen.getByTestId('probe-label').textContent).toBe('Admin income'))
  })
})
