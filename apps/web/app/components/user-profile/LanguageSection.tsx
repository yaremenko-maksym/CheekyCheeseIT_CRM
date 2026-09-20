import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { LOCALES, type Locale } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { activateLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * task-i18n-stage2 (Task 7) — self-service interface language switch, shown
 * only on the viewer's OWN profile overview (`OverviewTab` gates the render
 * on `mode === 'self'` — see there). Two radio-style buttons, uk/en.
 *
 * Deliberately no optimistic switch: `users.locale` on the server (Task 3)
 * is the source of truth, so `activateLocale` (the browser-side catalog
 * swap + `<html lang>` + `pref_locale` cookie — see `@/lib/i18n`) only runs
 * AFTER the PATCH resolves. A request that never reaches the server, or
 * comes back 4xx/5xx, must never leave the UI showing a locale the backend
 * does not know about (spec §4.6 / plan Task 7 Step 2).
 */
// Each language's own name for itself — not translated (a literal, same as
// the plan's Step 2 snippet: "Українська"/"English" name themselves).
// eslint-disable-next-line lingui/no-unlocalized-strings -- language names, not UI copy: a language never needs translating into itself
const LOCALE_LABELS: Record<Locale, string> = { uk: 'Українська', en: 'English' }

export function LanguageSection({ current }: { current: Locale }) {
  const { invalidate } = useAuth()
  const { t } = useLingui()
  // Tracks whether a choice is in flight — blocks pointer input on the
  // wrapper (`pointer-events-none`) and re-entry in `choose` below, guarding
  // against a second click firing a second PATCH before the first one's
  // activation + invalidation finished (the exact race the "no optimistic
  // switch" rule above is protecting against). Deliberately NOT wired to
  // `SegmentedToggle`'s `disabled` prop — see `choose`'s comment (UX-M-2).
  const [pending, setPending] = useState(false)

  async function choose(locale: Locale) {
    // Re-entry guard is back (PR #696 fix-round 2, UX-M-2) — fix-round 1
    // removed it as dead code because `SegmentedToggle`'s `disabled` prop
    // (bound to `pending`) made the buttons unclickable at the DOM level
    // while a choice was in flight, so this branch could never fire. That
    // very `disabled` is what UX-M-2 found: Chromium drops DOM focus to
    // `<body>` when a focused button is disabled mid-interaction, and never
    // restores it. `SegmentedToggle` below no longer receives `disabled` —
    // pending is now guarded here instead, so a second click/keypress while
    // a request is in flight (or a repeat of the already-active locale)
    // is a no-op rather than a second PATCH.
    if (pending || locale === current) return
    setPending(true)
    try {
      await api.patch('/users/me', { locale })
      await activateLocale(locale)
      invalidate()
    } catch {
      // Fixed catalog string, NOT `getApiErrorMessage(err)` — that helper
      // can surface a Russian `STATUS_MESSAGES` string or backend message
      // (copy-review COPY-H-1, PR #696 fix-round 1). This toast has exactly
      // one scenario ("could not save the language choice"), so a catalog
      // string beats trying to relay whatever the backend said.
      toast.error(t`Не вдалося змінити мову інтерфейсу. Спробуйте ще раз`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <Trans>Мова інтерфейсу</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Wrapper carries the pending state instead of `disabled` on
            `SegmentedToggle` (UX-M-2, PR #696 fix-round 2): a disabled
            button loses DOM focus to `<body>` in Chromium and it is never
            restored. `pointer-events-none` blocks clicks without touching
            focusability or tab order; `aria-busy` announces the wait to
            assistive tech. Re-entry is guarded in `choose` above instead of
            at the DOM level. */}
        <div
          aria-busy={pending}
          data-testid="locale-switcher-wrapper"
          className={cn(pending && 'pointer-events-none opacity-60')}
        >
          <SegmentedToggle
            value={current}
            onChange={choose}
            options={LOCALES.map((locale) => ({
              value: locale,
              label: LOCALE_LABELS[locale],
            }))}
            ariaLabel={t`Мова інтерфейсу`}
            testId="locale-option"
            layoutId="locale-switcher"
            className="w-fit"
          />
        </div>
        {/* Temporary migration-progress hint (copy-review COPY-M-2, PR #696
            fix-round 1; text shortened in fix-round 2, COPY-L-4 — "interface"
            already named in the card title two lines up) — see "## Допущения"
            in the PR body: removed once the module-by-module i18n migration
            reaches stage 6. */}
        <p className="text-xs text-muted-foreground">
          <Trans>Переклад ще триває — частина екранів поки що російською.</Trans>
        </p>
      </CardContent>
    </Card>
  )
}
