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
