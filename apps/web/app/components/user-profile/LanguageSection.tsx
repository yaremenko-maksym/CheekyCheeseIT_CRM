import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { toast } from 'sonner'
import { LOCALES, type Locale } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
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
  // Disables both buttons while a choice is in flight — guards against a
  // second click firing a second PATCH before the first one's activation +
  // invalidation finished (the exact race the "no optimistic switch" rule
  // above is protecting against).
  const [pending, setPending] = useState(false)

  async function choose(locale: Locale) {
    if (locale === current || pending) return
    setPending(true)
    try {
      await api.patch('/users/me', { locale })
      await activateLocale(locale)
      invalidate()
    } catch (err) {
      toast.error(getApiErrorMessage(err))
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
      <CardContent>
        <div role="radiogroup" className="flex gap-2">
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              role="radio"
              aria-checked={locale === current}
              disabled={pending}
              data-testid={`locale-option-${locale}`}
              onClick={() => choose(locale)}
              className="rounded-md border border-border px-3 py-2 text-sm transition-colors aria-checked:border-primary aria-checked:bg-primary/10 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {LOCALE_LABELS[locale]}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
