// task-i18n-stage2 (Task 6) — the single browser-side `@lingui/core`
// instance and the runtime that activates a locale on it: before the first
// paint (pre-login, from a cookie / navigator.language), and again whenever
// the authenticated session's `locale` differs (see `context/auth.tsx`).
//
// Unlike the Node-side `createI18n()` (packages/shared/src/i18n/catalog.ts,
// one instance per request/recipient, never a global singleton — a server
// can serve many users at once), the browser has exactly one active user at
// a time, so a single module-level `i18n` instance mirrors how
// `@lingui/react`'s `I18nProvider` and `useLingui()` are meant to be used —
// see `routes/__root.tsx`.
import { i18n } from '@lingui/core'
import { useLingui } from '@lingui/react'
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, resolveLocale, type Locale } from '@crm/shared'

export { i18n }

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1]
}

/**
 * Locale to activate before the first authenticated response arrives:
 * `pref_locale` cookie (set by a previous `activateLocale` call — see
 * below) → `navigator.language` → `uk` (`DEFAULT_LOCALE`). Never reads
 * session data — this runs in `client.tsx` before `AuthProvider` exists.
 */
export function readPreLoginLocale(): Locale {
  return resolveLocale([readCookie(LOCALE_COOKIE_NAME), navigator.language])
}

/**
 * Loads the compiled catalog for `locale` (via `@lingui/vite-plugin`'s
 * transform on the `.po` import — see `app/types/po.d.ts`), activates it on
 * the shared `i18n` instance, and mirrors the choice to `<html lang>` (a11y
 * / SEO contract) and the `pref_locale` cookie (so the NEXT page load's
 * `readPreLoginLocale()` — and the API's `resolveRequestLocale`, Task 4 —
 * see the same choice before any session exists).
 *
 * Imported through the `@crm/shared-i18n-locales` alias (vite.config.ts /
 * vitest.config.ts), NOT `@crm/shared/i18n/locales/...` as a deep import
 * off the package's own alias: that alias resolves to a FILE
 * (`src/index.ts`), and Vite's alias replacement would append the
 * remainder onto the file path — invalid. It is also NOT a hand-counted
 * relative path (`../../../../packages/shared/...`): that literal is
 * correct for this file's real on-disk location, but StrykerJS
 * (`mutation-gate.mjs`) instruments `@crm/web` by copying the WHOLE
 * package two levels deeper, into `apps/web/.stryker-tmp/sandbox-<id>/` —
 * from there the same relative path silently resolves to
 * `apps/web/packages/shared/...`, which does not exist, and the import
 * rejects (verified — this broke the mutation gate's dry run before the
 * alias was introduced). The alias is built from a filesystem walk-up to
 * `.git` in both configs, so it resolves correctly regardless of nesting.
 */
export async function activateLocale(locale: Locale): Promise<void> {
  const { messages } = await import(`@crm/shared-i18n-locales/${locale}/messages.po`)
  i18n.loadAndActivate({ locale, messages })
  document.documentElement.lang = locale
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`
}

/** Currently active locale, read through `@lingui/react`'s `useLingui()` (re-renders on activation). */
export function useLocale(): Locale {
  const { i18n: instance } = useLingui()
  return (instance.locale as Locale) ?? DEFAULT_LOCALE
}
