// apps/web/app/test/i18n.tsx
// fix-round 1 (PR #697, SPEC-H-1). `@crm/shared/i18n/locales/<locale>/messages`
// does not resolve — `@crm/shared` aliases to a FILE
// (`packages/shared/src/index.ts`) in both `vite.config.ts` and
// `vitest.config.ts`, and Vite cannot append a subpath onto a file alias.
// `activateLocale` is the one working path: it goes through the
// `@crm/shared-i18n-locales` (directory) alias + `import.meta.glob`, the
// SAME runtime production code uses, already proven by
// `apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx`.
import type { ReactNode } from 'react'
import { I18nProvider } from '@lingui/react'
import { i18n, activateLocale } from '@/lib/i18n'
import type { Locale } from '@crm/shared'

/**
 * Activates the REAL compiled catalog for `locale` on the shared `i18n`
 * singleton that `useLingui()`/`useLocale()` read. Call it BEFORE
 * render/renderHook — this is not a React component, so a wrapper cannot
 * `await` inside itself.
 */
export async function loadCatalog(locale: Locale): Promise<void> {
  await activateLocale(locale)
}

/** `render`/`renderHook` wrapper sharing the SAME `i18n` singleton `loadCatalog` activates. */
export function I18nTestProvider({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}
