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
  // Tracks whether a choice is in flight — dims the wrapper (`opacity-60` +
  // `aria-busy`) and guards re-entry in `choose` below, blocking a second
  // click from firing a second PATCH before the first one's activation +
  // invalidation finished (the exact race the "no optimistic switch" rule
  // above is protecting against). Deliberately NOT wired to
  // `SegmentedToggle`'s `disabled` prop — see `choose`'s comment (UX-M-2).
  // Also deliberately NOT `pointer-events-none` on the wrapper (PR #696
  // fix-round 3, UX-M-3): that class makes the wrapper miss the browser's
  // hit-test, so a real mouse click during `pending` lands on nothing and
  // Chromium drops focus to `<body>` — the exact same symptom UX-M-2 fixed,
  // just via a different trigger. Leaving pointer input on the button and
  // relying on the JS-level guard below keeps the click landing ON the
  // button, so focus never has anywhere else to go.
  const [pending, setPending] = useState(false)

  async function choose(locale: Locale) {
    // `pending` half is back (PR #696 fix-round 2, UX-M-2) — fix-round 1
    // removed the whole guard as dead code because `SegmentedToggle`'s
    // `disabled` prop (bound to `pending`) made the buttons unclickable at
    // the DOM level while a choice was in flight. That very `disabled` is
    // what UX-M-2 found: Chromium drops DOM focus to `<body>` when a
    // focused button is disabled mid-interaction, and never restores it.
    // `SegmentedToggle` below no longer receives `disabled`, so `pending`
    // is guarded here instead — a second click/keypress while a request is
    // in flight is now a no-op rather than a second PATCH. Covered by the
    // "re-entry guard" unit test below.
    //
    // Stryker disable next-line ConditionalExpression: `locale === current`
    // stays genuinely unreachable through the UI — `SegmentedToggle`'s own
    // onClick (`if (option.value === value) return`) and its keydown
    // handler (`if (target.value !== value) { onChange(target.value) }`)
    // already stop it from ever calling `choose` with the active locale,
    // same as when fix-round 1 removed this exact clause for the same
    // reason. Kept anyway as defence-in-depth for a future caller of
    // `choose` that does not go through `SegmentedToggle` — deleting it
    // would silently re-open that door with nothing left to catch it.
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
            restored. `opacity-60` signals the wait visually; `aria-busy`
            announces it to assistive tech. Deliberately no
            `pointer-events-none` here (UX-M-2's first attempt, reverted in
            fix-round 3 as UX-M-3): blocking the hit-test the same way
            `disabled` blocked it reproduces the identical `<body>`
            focus-loss on a second real mouse click during `pending`, just
            through a different mechanism. Clicks stay routed to the
            button; re-entry is guarded in `choose` above instead. */}
        <div
          aria-busy={pending}
          data-testid="locale-switcher-wrapper"
          className={cn(pending && 'opacity-60')}
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
