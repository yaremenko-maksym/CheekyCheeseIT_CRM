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
import { i18n, type Messages as LinguiMessages } from '@lingui/core'
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
 * Every compiled catalog under the `@crm/shared-i18n-locales` alias
 * (vite.config.ts / vitest.config.ts), as a map of lazy loaders — NOT a
 * plain `import(\`@crm/shared-i18n-locales/${locale}/messages.po\`)`
 * template-literal dynamic import: Vite can only statically analyze a
 * dynamic import's variable portion when the literal prefix is relative
 * (`./`/`../`) — an ALIAS prefix makes it un-analyzable ("The above dynamic
 * import cannot be analyzed by Vite", `vite:import-analysis`), and at
 * runtime it falls through to the SSR module runner's `dynamicRequest`
 * fallback, which does NOT know about Vite's `resolve.alias` at all. Under
 * plain `vite build`/`vite dev` this merely threw `Cannot find module
 * '@crm/shared-i18n-locales/...'`; under StrykerJS's `@crm/web` mutation
 * run (`mutation-gate.mjs`) the SAME un-analyzable fallback crashed the
 * whole test runner with `EISDIR: illegal operation on a directory, read
 * .../apps/web/.stryker-tmp/sandbox-<id>` instead (verified — reproduced
 * both locally and matches the CI failure) — a StrykerJS/Vitest-runner
 * quirk in how that fallback path handles a coverage-instrumented caller,
 * not something worth chasing further once the actual fix is this simple.
 *
 * `import.meta.glob` sidesteps the whole class of failure: its pattern is
 * a STATIC literal (no interpolation inside the call itself — Vite's own
 * docs list "relative paths, absolute paths, or alias paths" as the
 * supported glob bases), so it resolves through the real alias-aware
 * resolver in every context — dev, build, and the Stryker sandbox alike
 * (verified directly against a live sandbox). Each match still lazy-loads
 * its own chunk (the returned loader is only invoked for the active
 * locale), so this keeps the original per-locale code-splitting.
 *
 * The glob PATTERN argument itself must stay a literal string node, not
 * just at authoring time but in the INSTRUMENTED source StrykerJS's mutation
 * run actually executes: Vite's `import.meta.glob` transform
 * (`parseImportGlob`) parses the call's own argument as AST at transform
 * time, before any test runs, and requires a literal there. Stryker's
 * StringLiteral mutator unconditionally wraps every string literal —
 * including this one — in a `mutantActive ? "" : (cov(), literal)` ternary
 * as part of plain instrumentation (this happens regardless of whether the
 * mutant is "active"; it is how Stryker tracks per-test coverage at all).
 * That ternary is no longer a literal node, so `parseImportGlob` throws a
 * hard parse error ("Expected ',', got '<eof>'") before Stryker's dry run
 * can even start — verified: this is exactly what crashed
 * `mutation-gate.mjs --changed` for `@crm/web` with that error until the
 * suppression below was added.
 *
 * The suppression comment below only takes effect when the ignored mutant
 * lands on the SAME source line the comment attaches to (Stryker's
 * `DirectiveBookkeeper` matches by `loc.start.line`, not by AST proximity —
 * verified directly: the original two-line form of this call, with the
 * pattern argument on its own line below the `const` line, left the
 * suppression a no-op and the mutant still fired). `CatalogModule` exists
 * so the whole call fits on one line under the project's 100-col
 * `printWidth` with the pattern literal on that SAME line.
 */
type CatalogModule = { messages: LinguiMessages }
// Stryker disable next-line StringLiteral: import.meta.glob's pattern argument must stay a literal string node in the INSTRUMENTED source, not just as authored — Vite's parseImportGlob parses it as AST at transform time and throws a hard parse error on Stryker's mutation-tracking ternary wrapper before any test can run (see the doc comment above this call).
const localeCatalogs = import.meta.glob<CatalogModule>('@crm/shared-i18n-locales/*/messages.po')

/**
 * Loads the compiled catalog for `locale` (via `@lingui/vite-plugin`'s
 * transform on the `.po` import — see `app/types/po.d.ts`), activates it on
 * the shared `i18n` instance, and mirrors the choice to `<html lang>` (a11y
 * / SEO contract) and the `pref_locale` cookie (so the NEXT page load's
 * `readPreLoginLocale()` — and the API's `resolveRequestLocale`, Task 4 —
 * see the same choice before any session exists).
 */
export async function activateLocale(locale: Locale): Promise<void> {
  const key = Object.keys(localeCatalogs).find((k) => k.endsWith(`/${locale}/messages.po`))
  // `noUncheckedIndexedAccess` (tsconfig.base.json): indexing `localeCatalogs`
  // with a `string` always types as `T | undefined`, independent of `key`'s
  // own narrowing above — the loader lookup needs its own guard.
  const loadCatalog = key ? localeCatalogs[key] : undefined
  if (!loadCatalog) {
    throw new Error(`activateLocale: no compiled catalog found for locale "${locale}"`)
  }
  const { messages } = await loadCatalog()
  i18n.loadAndActivate({ locale, messages })
  document.documentElement.lang = locale
  // `Secure` only over https: on dev (`http://localhost`) a cookie carrying
  // `Secure` is silently refused by the browser (and by happy-dom), which
  // would break `readPreLoginLocale()` on the very next page load in dev —
  // see `i18n.test.tsx` for the http/https pair that pins this branch.
  const secureFlag = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secureFlag}`
}

/** Currently active locale, read through `@lingui/react`'s `useLingui()` (re-renders on activation). */
export function useLocale(): Locale {
  const { i18n: instance } = useLingui()
  return (instance.locale as Locale) ?? DEFAULT_LOCALE
}

/**
 * fix-round 2 (CI-2, task-i18n-stage3a Task 7 — CR-M-1 regression): two
 * module-level markers, NOT React state — they must survive the
 * `<Fragment key={locale}>` remount `routes/__root.tsx`'s `LocaleScopedApp`
 * performs on every `activateLocale()` call, which recreates every
 * component below it (including `AuthProvider` and `LanguageSection`) with
 * fresh `useState`/`useRef`. A plain module-level binding is the only thing
 * that lives across that remount.
 *
 * The bug: `LanguageSection.choose()` (`components/user-profile/
 * LanguageSection.tsx`) calls `activateLocale(locale)` mid-flight — that
 * synchronously flips `i18n.locale`, which `LocaleScopedApp` reads via
 * `useLocale()` and remounts the whole authenticated tree on, INCLUDING
 * `AuthProvider` (`context/auth.tsx`). `AuthProvider`'s own session-locale-
 * sync effect then runs fresh on THAT remount and reads the `['auth','me']`
 * query's STILL-STALE cached `data.locale` — the `/users/me` PATCH that just
 * persisted the new locale server-side has not been reflected by a refetch
 * yet (that only happens once `choose()` calls `invalidate()`, AFTER
 * `activateLocale()` — and even then only once the network round-trip
 * resolves). The effect cannot tell that mismatch apart from a genuine
 * cross-device drift, so it "corrects" `i18n.locale` right back to the stale
 * value, undoing the switch and remounting again. `document.documentElement
 * .lang` and every reactive `aria-checked` settle on the OLD locale.
 *
 * fix-round 3 (CR-M-2, PR #706): an optimistic `['auth','me']` cache write
 * in `choose()` was tried as a replacement for this marker and reverted —
 * `invalidate()`'s refetch does not just close the synchronous remount
 * window above, it can ALSO come back with a value that still disagrees
 * with what was just activated. This marker protects against that: it lets
 * `AuthProvider`'s effect recognize a STALE `/auth/me` response and skip
 * "correcting" `i18n.locale` back to it.
 *
 * fix-round 4 (CR-M-4, PR #706): what is proven directly is narrower than
 * the earlier wording of this comment claimed. `locale-switcher.spec.ts`'s
 * `/auth/me` mock (`mockAuthAs`, `apps/e2e/tests/fixtures.ts`) is a
 * Playwright `page.route` handler — it always echoes the same session
 * object it was given, independent of any PATCH the test sent, so THAT
 * refetch is unconditionally stale by construction. That is a property of
 * the E2E mock, not evidence about the real backend: the real `GET
 * /auth/me` (`apps/api/src/auth/auth.controller.ts`) re-reads the user row
 * from the DB on every call and does not go stale the way the mock does.
 * In production the window this marker closes is narrower — an in-flight
 * refetch that started before the locale PATCH committed can still resolve
 * with the pre-PATCH value once it lands. A cache write only protects
 * against the FIRST read; it cannot tell a later, still-stale refetch
 * (mocked or real-but-racing) apart from a genuine cross-device correction
 * the way this marker does. Kept. (The marker is unconditionally cleared on
 * logout via `resetLocaleConfirmation` below, so this staleness window
 * never crosses a session boundary.)
 */
let confirmedUserLocale: Locale | null = null

/** Called by `LanguageSection.choose()` once the PATCH that persists `locale` server-side has succeeded. */
export function markLocaleConfirmedByUser(locale: Locale): void {
  confirmedUserLocale = locale
}

/**
 * Read by `AuthProvider`'s session-locale-sync effect. Deliberately NOT
 * consumed/cleared on a matching read (an earlier revision was — and broke
 * under React `<StrictMode>`, which double-invokes every effect in
 * development: the FIRST of the two invocations would consume the marker
 * and correctly skip, leaving the SECOND to see it already gone and
 * reactivate anyway — verified against a real dev-mode run, see fix-round 2
 * PR discussion). `clearConfirmedUserLocaleIfSettled` below is the one
 * legitimate place the marker goes away on a MATCHING read;
 * `resetLocaleConfirmation` below is the other — an unconditional one, for
 * session boundaries rather than a settled refetch.
 */
export function isLocaleConfirmedByUser(locale: Locale): boolean {
  return confirmedUserLocale === locale
}

/**
 * Called by `AuthProvider`'s effect once `data.locale` genuinely CATCHES UP
 * to `i18n.locale` (the `invalidate()` refetch `choose()` triggers finally
 * came back with the persisted value) — the marker has done its job and
 * clearing it here (rather than never) is what lets a LATER, genuine drift
 * (e.g. a real cross-device correction on a future login) be corrected
 * instead of silently swallowed by a marker left over from an earlier
 * switch. No-op if `locale` is not the currently marked one.
 */
export function clearConfirmedUserLocaleIfSettled(locale: Locale): void {
  if (confirmedUserLocale === locale) confirmedUserLocale = null
}

/**
 * CR-M-3 (fix-round 3, PR #706): unconditionally clears the marker,
 * independent of what it is currently set to. `confirmedUserLocale`'s
 * correctness relies on ONE invariant — logout/login is always a hard
 * `window.location.href` navigation (`lib/use-logout.ts`, the Google OAuth
 * `<a href>`, and every dev-login path all reload the page, which resets
 * every module-level binding in this file for free). If a future refactor
 * ever turns logout into an in-SPA `navigate()` to save the reload, THIS
 * marker would otherwise survive across users in the SAME tab: user A
 * switches to `en`, logs out before the settle-refetch above ever runs, and
 * user B logs in — `isLocaleConfirmedByUser(i18n.locale)` would still see
 * A's confirmation and silently block B's own session-locale sync. Wiring
 * this into `useLogout()` removes the reliance on hard-navigation instead of
 * merely documenting it; see `use-logout.spec.ts` for the pinning test.
 */
export function resetLocaleConfirmation(): void {
  confirmedUserLocale = null
}

/**
 * A `key`-driven remount unmounts the OLD button (the one that had DOM
 * focus) and mounts a BRAND NEW one — the browser does not auto-focus a
 * freshly created element, so without this, UX-M-3 (focus stays on the
 * clicked language option) breaks the instant `LocaleScopedApp` remounts
 * `LanguageSection`. `choose()` records which locale the user just picked
 * BEFORE that remount can happen; `LanguageSection`'s own mount effect
 * consumes the request once and, if it matches the locale it is now
 * rendering, re-focuses that option's button.
 *
 * fix-round 3 (CR-M-3 follow-up, PR #706): if `activateLocale()` itself
 * throws after a successful PATCH, `choose()`'s `catch` calls
 * `consumeLocaleSwitchFocus()` to discard the request it just queued —
 * otherwise it would sit here and steal focus on some LATER, unrelated
 * mount of `LanguageSection` instead of the interrupted one.
 */
let pendingFocusLocale: Locale | null = null

export function requestLocaleSwitchFocus(locale: Locale): void {
  pendingFocusLocale = locale
}

export function consumeLocaleSwitchFocus(): Locale | null {
  const locale = pendingFocusLocale
  pendingFocusLocale = null
  return locale
}
