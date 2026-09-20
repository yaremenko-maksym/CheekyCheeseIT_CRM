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
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
    // Fixed catalog string (copy-review COPY-H-1, PR #696 fix-round 1) —
    // NOT whatever `getApiErrorMessage` would have returned. `uk` is the
    // source locale, so the compiled catalog's msgstr equals the msgid.
    // No trailing period (copy-review COPY-L-3, PR #696 fix-round 2) — matches
    // every other `api-error.*` catalog string's convention.
    expect(toast.error).toHaveBeenCalledWith('Не вдалося змінити мову інтерфейсу. Спробуйте ще раз')
    expect(i18n.locale).toBe('uk')
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('the two locale buttons expose the radiogroup/radio a11y contract, with an accessible group name', () => {
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    // Accessible name comes from `SegmentedToggle`'s `ariaLabel` prop, fed
    // through the `t` macro (COPY-M-1/CR-M-1, PR #696 fix-round 1) — a
    // dropped/empty catalog string here would leave the radiogroup unnamed.
    expect(screen.getByRole('radiogroup', { name: 'Мова інтерфейсу' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it("renders each locale's own name as its button label", () => {
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    expect(screen.getByTestId('locale-option-uk')).toHaveTextContent('Українська')
    expect(screen.getByTestId('locale-option-en')).toHaveTextContent('English')
  })

  it('marks the toggle wrapper aria-busy and pointer-events-none while a choice is in flight, and clears it once the request settles (UX-M-2)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const enButton = screen.getByTestId('locale-option-en')
    // The wrapper `<div>` around `SegmentedToggle` — not the buttons
    // themselves (see below).
    const wrapper = screen.getByTestId('locale-switcher-wrapper')

    fireEvent.click(enButton)

    // `choose` is `async`, so its body runs synchronously up to the first
    // `await api.patch(...)` — `setPending(true)` has already run by the
    // time `fireEvent.click` returns, no `waitFor` needed for this half.
    expect(wrapper).toHaveAttribute('aria-busy', 'true')
    expect(wrapper.className).toContain('pointer-events-none')
    // NOT `disabled` on the button (UX-M-2, PR #696 fix-round 2) — a
    // disabled focused button drops DOM focus to `<body>` in Chromium and
    // never restores it. Blocking is delegated to the wrapper's CSS + the
    // `pending` re-entry guard in `choose`.
    expect(enButton).not.toBeDisabled()

    resolvePatch({ data: {} })
    await waitFor(() => expect(wrapper).toHaveAttribute('aria-busy', 'false'))
    expect(wrapper.className).not.toContain('pointer-events-none')
  })

  it('a second click while a choice is already pending sends no second request (re-entry guard, UX-M-2)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const enButton = screen.getByTestId('locale-option-en')

    // Both clicks reach `choose` directly (`fireEvent`, not `userEvent`,
    // bypasses the wrapper's `pointer-events-none` hit-testing) — this
    // proves the JS-level `pending` guard, not just the CSS, blocks re-entry.
    fireEvent.click(enButton)
    fireEvent.click(enButton)
    expect(api.patch).toHaveBeenCalledTimes(1)

    resolvePatch({ data: {} })
    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
  })

  it('keeps DOM focus on the clicked button through and after the mutation (UX-M-2)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    const user = userEvent.setup()
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const enButton = screen.getByTestId('locale-option-en')

    await user.click(enButton)
    expect(enButton).toHaveFocus()

    resolvePatch({ data: {} })
    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
    // Was `<body>` before the fix — Chromium drops focus from a button the
    // instant it's disabled mid-interaction and never gives it back.
    expect(enButton).toHaveFocus()
  })

  it('keeps DOM focus on the newly-selected button after ArrowRight, through and after the mutation (UX-M-2)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    const user = userEvent.setup()
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const ukButton = screen.getByTestId('locale-option-uk')
    const enButton = screen.getByTestId('locale-option-en')

    ukButton.focus()
    await user.keyboard('{ArrowRight}')
    expect(enButton).toHaveFocus()

    resolvePatch({ data: {} })
    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
    expect(enButton).toHaveFocus()
  })
})
