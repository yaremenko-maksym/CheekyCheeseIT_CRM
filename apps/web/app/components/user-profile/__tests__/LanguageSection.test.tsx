/**
 * LanguageSection.test.tsx — task-i18n-stage2 (Task 7), AC7.
 *
 * Covers the plan's contract (docs/superpowers/plans/
 * 2026-09-19-crm-i18n-stage2-foundation.md, Task 7, Step 1):
 *   - choosing a locale PATCHes `/users/me`, then activates the catalog
 *     client-side (`i18n.locale` changes), then invalidates the auth query.
 *   - no optimistic switch: a failed PATCH never activates the new locale.
 *   - clicking the already-active locale is a no-op (no request).
 *   - the active locale is exposed via `aria-checked`, not just visually.
 *
 * `<Trans>` (and `useLocale`, elsewhere) both go through `@lingui/react`'s
 * `useLingui()`, which THROWS without an `I18nProvider` ancestor — every
 * render below goes through the real, shared `i18n` singleton (imported
 * from `@/lib/i18n`, the SAME instance `activateLocale` mutates), wrapped
 * in `I18nProvider`, mirroring `i18n-smoke.test.tsx` / `i18n.test.tsx`.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { I18nProvider } from '@lingui/react'
import type { ReactNode } from 'react'
import { i18n, activateLocale } from '@/lib/i18n'
import { LanguageSection } from '../LanguageSection'

const invalidateMock = vi.fn()
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ invalidate: invalidateMock }),
}))

vi.mock('@/lib/axios', () => ({
  api: { patch: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

// Imported AFTER the mocks above so both resolve to the mocked module.
import { api } from '@/lib/axios'
import { toast } from 'sonner'

function Providers({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}

beforeEach(async () => {
  vi.clearAllMocks()
  // Real catalog load (not a stub) — the SAME activation path production
  // code takes, so a broken `activateLocale` wiring inside LanguageSection
  // would fail this the same way it would fail in the app.
  await activateLocale('uk')
})

describe('LanguageSection', () => {
  it('PATCHes the locale, activates it client-side, then invalidates the auth query — in that order', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockResolvedValue({ data: {} })
    render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-en'))

    expect(api.patch).toHaveBeenCalledWith('/users/me', { locale: 'en' })
    await waitFor(() => expect(i18n.locale).toBe('en'))
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })

  it('marks the current locale aria-checked=true and the other one aria-checked=false', () => {
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    expect(screen.getByTestId('locale-option-uk')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('locale-option-en')).toHaveAttribute('aria-checked', 'false')
  })

  it('clicking the already-active locale sends no request and never invalidates', async () => {
    const user = userEvent.setup()
    render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-uk'))

    expect(api.patch).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('a failed PATCH shows an error toast and never activates the new locale (no optimistic switch)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockRejectedValue(new Error('network error'))
    render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-en'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(i18n.locale).toBe('uk')
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('the two locale buttons expose the radiogroup/radio a11y contract', () => {
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })
})
