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
import { i18n } from '@/lib/i18n'
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

// `activateLocale` wraps the REAL implementation by default (every existing
// test below relies on it actually flipping `i18n.locale`) — only the
// dedicated "activateLocale throws" test overrides it per-call via
// `mockRejectedValueOnce`. `consumeLocaleSwitchFocus`/`requestLocaleSwitchFocus`/
// `markLocaleConfirmedByUser`/`isLocaleConfirmedByUser` stay entirely real
// (spread from `original`).
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>()
  return { ...original, activateLocale: vi.fn(original.activateLocale) }
})

// Imported AFTER the mocks above so both resolve to the mocked module.
import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  activateLocale,
  consumeLocaleSwitchFocus,
  isLocaleConfirmedByUser,
  requestLocaleSwitchFocus,
  resetLocaleConfirmation,
} from '@/lib/i18n'

function Providers({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}

beforeEach(async () => {
  vi.clearAllMocks()
  // Drains any focus request / locale-confirmation marker a PREVIOUS test's
  // `choose()` call queued — both `pendingFocusLocale` and
  // `confirmedUserLocale` (`@/lib/i18n`) are module-level singletons, not
  // component state, so they survive across tests/unmounts in this file.
  // Several tests below call `choose()` without a matching remount that
  // would consume the focus request (the real remount only happens in
  // production via `LocaleScopedApp`'s `<Fragment key={locale}>`, which
  // these tests don't render) — without this, a stray request from an
  // earlier test would leak into the "mount-time focus restoration" tests
  // below and make them order-dependent.
  consumeLocaleSwitchFocus()
  resetLocaleConfirmation()
  // Real catalog load (not a stub) — the SAME activation path production
  // code takes, so a broken `activateLocale` wiring inside LanguageSection
  // would fail this the same way it would fail in the app. Goes through the
  // `vi.fn(original.activateLocale)` wrapper above, same as the component
  // under test — harmless, since no test below asserts on `activateLocale`'s
  // own call count (only on `i18n.locale`, `invalidateMock`, or `toast`).
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

  it('marks the toggle wrapper aria-busy and dims it while a choice is in flight, and clears it once the request settles (UX-M-2)', async () => {
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
    expect(wrapper.className).toContain('opacity-60')
    // NOT `disabled` on the button (UX-M-2, PR #696 fix-round 2) — a
    // disabled focused button drops DOM focus to `<body>` in Chromium and
    // never restores it. Blocking is delegated to the `pending` re-entry
    // guard in `choose`, not the wrapper's CSS (no `pointer-events-none`
    // either — see UX-M-3, fix-round 3, below).
    expect(enButton).not.toBeDisabled()

    resolvePatch({ data: {} })
    await waitFor(() => expect(wrapper).toHaveAttribute('aria-busy', 'false'))
    expect(wrapper.className).not.toContain('opacity-60')
  })

  it('a second click while a choice is already pending sends no second request (re-entry guard, UX-M-2)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const enButton = screen.getByTestId('locale-option-en')

    // `fireEvent` dispatches straight to the element, skipping any of
    // `userEvent`'s own hit-test/visibility checks — this isolates the
    // JS-level `pending` guard in `choose` as the thing blocking re-entry,
    // independent of whatever the wrapper's CSS happens to be.
    fireEvent.click(enButton)
    fireEvent.click(enButton)
    expect(api.patch).toHaveBeenCalledTimes(1)

    resolvePatch({ data: {} })
    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
  })

  it('a second real click during pending does not drop focus to <body> (UX-M-3)', async () => {
    let resolvePatch: (value: { data: unknown }) => void = () => {}
    const patchPromise = new Promise<{ data: unknown }>((resolve) => {
      resolvePatch = resolve
    })
    vi.mocked(api.patch).mockReturnValue(patchPromise)
    const user = userEvent.setup()
    render(<LanguageSection current="uk" />, { wrapper: Providers })
    const enButton = screen.getByTestId('locale-option-en')

    // Unlike `fireEvent`, `userEvent` goes through the same hit-test a real
    // mouse click does — it refuses to click an element covered by
    // `pointer-events: none`. Design review 5261064743 (UX-M-3) found that
    // fix-round 2's `pointer-events-none` on the wrapper made a second real
    // click during `pending` miss the button's hit-test entirely, landing
    // nowhere and dropping DOM focus to `<body>` in Chromium — the same
    // symptom UX-M-2 fixed, via a different mechanism. `pointer-events-none`
    // is gone as of this round; both clicks must land ON the button.
    await user.click(enButton)
    await user.click(enButton)

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(enButton).toHaveFocus()

    resolvePatch({ data: {} })
    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
    expect(enButton).toHaveFocus()
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

  // fix-round 3 (CR-H-1, PR #706) — the marker `choose()` writes so
  // `AuthProvider`'s locale-sync effect (`context/auth.tsx`) does not undo
  // this switch on its own next remount. CR-M-2 evaluated and REJECTED an
  // optimistic `['auth','me']` cache write as a replacement (see
  // `lib/i18n.ts`'s doc comment on `confirmedUserLocale` for why); the
  // marker itself is tested directly in `lib/__tests__/i18n.test.tsx`, this
  // only pins the CALL SITE here.
  it('marks the newly chosen locale as confirmed by the user once the PATCH succeeds', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockResolvedValue({ data: {} })
    render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-en'))

    await waitFor(() => expect(invalidateMock).toHaveBeenCalledTimes(1))
    expect(isLocaleConfirmedByUser('en')).toBe(true)
  })

  it('does not mark anything as confirmed when the PATCH fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patch).mockRejectedValue(new Error('network error'))
    render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-en'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(isLocaleConfirmedByUser('en')).toBe(false)
  })

  // fix-round 3 (CR-H-1, PR #706) — direct coverage for the mount-only
  // effect that restores focus after `LocaleScopedApp`'s remount (fix-round
  // 2, UX-M-3). Every OTHER test above only observes this effect
  // indirectly, through a full `choose()` round trip inside a SINGLE
  // render — none of them re-mounts the component the way the real remount
  // does, so this effect's own branches went unexercised (review: 9
  // survived + 3 no-coverage on `LanguageSection.tsx:68-74`).
  describe('mount-time focus restoration (fix-round 2 remount UX)', () => {
    it('focuses the requested locale option on mount when it matches current', () => {
      requestLocaleSwitchFocus('en')
      render(<LanguageSection current="en" />, { wrapper: Providers })
      expect(screen.getByTestId('locale-option-en')).toHaveFocus()
    })

    it('does not focus anything when the requested locale does not match current', () => {
      // A request queued for 'en' rendering with current="uk" — the cross-
      // device-sync case (`AuthProvider`'s OWN effect can also call
      // `activateLocale`, remounting this component with NO focus request
      // of its own queued — but a stray one from an unrelated earlier
      // switch must not hijack it).
      requestLocaleSwitchFocus('en')
      render(<LanguageSection current="uk" />, { wrapper: Providers })
      expect(screen.getByTestId('locale-option-en')).not.toHaveFocus()
      expect(screen.getByTestId('locale-option-uk')).not.toHaveFocus()
    })

    it('does not focus anything when no focus switch was requested', () => {
      render(<LanguageSection current="uk" />, { wrapper: Providers })
      expect(screen.getByTestId('locale-option-uk')).not.toHaveFocus()
      expect(screen.getByTestId('locale-option-en')).not.toHaveFocus()
    })

    it('consumes the request once — an unrelated LATER mount does not re-focus', () => {
      requestLocaleSwitchFocus('en')
      const { unmount } = render(<LanguageSection current="en" />, { wrapper: Providers })
      expect(screen.getByTestId('locale-option-en')).toHaveFocus()
      unmount()

      render(<LanguageSection current="en" />, { wrapper: Providers })
      expect(screen.getByTestId('locale-option-en')).not.toHaveFocus()
    })
  })

  it('discards a queued focus request when activateLocale throws after a successful PATCH (CR-M-3 follow-up)', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: {} })
    vi.mocked(activateLocale).mockRejectedValueOnce(new Error('chunk load failed'))
    const user = userEvent.setup()
    const { unmount } = render(<LanguageSection current="uk" />, { wrapper: Providers })

    await user.click(screen.getByTestId('locale-option-en'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    unmount()

    // Simulate an unrelated LATER mount that happens to render with
    // current="en" (e.g. a genuine cross-device sync reactivated it) — if
    // the stray focus request the failed switch above queued were not
    // discarded in `choose()`'s `catch`, this unrelated mount would
    // incorrectly steal focus from wherever the user's attention actually
    // is.
    render(<LanguageSection current="en" />, { wrapper: Providers })
    expect(screen.getByTestId('locale-option-en')).not.toHaveFocus()
  })
})
