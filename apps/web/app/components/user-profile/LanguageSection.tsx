import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { LOCALES, type Locale } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { activateLocale } from '@/lib/i18n'

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
  // Disables both buttons while a choice is in flight — guards against a
  // second click firing a second PATCH before the first one's activation +
  // invalidation finished (the exact race the "no optimistic switch" rule
  // above is protecting against).
  const [pending, setPending] = useState(false)

  async function choose(locale: Locale) {
    // No `locale === current || pending` guard here (removed PR #696
    // fix-round 1, mutation-gate finding) — `SegmentedToggle` already
    // guarantees both halves before it ever calls `onChange`: its own
    // `onClick`/keydown handlers skip `option.value === value`, and its
    // `disabled` prop (bound to `pending` below) makes the buttons
    // unclickable at the DOM level while a choice is in flight. A guard
    // that can never see its own `false` branch triggered is dead code,
    // not defence-in-depth — mutating it away left every test green.
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
      toast.error(t`Не вдалося змінити мову інтерфейсу. Спробуйте ще раз.`)
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
        <SegmentedToggle
          value={current}
          onChange={choose}
          options={LOCALES.map((locale) => ({
            value: locale,
            label: LOCALE_LABELS[locale],
          }))}
          ariaLabel={t`Мова інтерфейсу`}
          testId="locale-option"
          disabled={pending}
          layoutId="locale-switcher"
          className="w-fit"
        />
        {/* Temporary migration-progress hint (copy-review COPY-M-2, PR #696
            fix-round 1) — see "## Допущения" in the PR body: removed once
            the module-by-module i18n migration reaches stage 6. */}
        <p className="text-xs text-muted-foreground">
          <Trans>Переклад інтерфейсу ще триває — частина екранів поки що російською.</Trans>
        </p>
      </CardContent>
    </Card>
  )
}
