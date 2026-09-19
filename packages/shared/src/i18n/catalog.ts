import { setupI18n, type I18n } from '@lingui/core'
import type { Locale } from './locales'

/**
 * Compiled by `lingui compile --typescript` into `./locales/<locale>/messages.ts`
 * (gitignored). Two runtime shapes have to resolve, deliberately, not by accident:
 *  - dist build (tsc compiles this whole package, `messages.ts` included via the
 *    package's `include` glob, to `dist/i18n/locales/<locale>/messages.js`) — the
 *    extension-less `require(path)` below finds `.js` the normal Node way;
 *  - Vitest running straight against this TS source (task-i18n-stage2-task1-2.md
 *    override #4 / plan Task 2 step 6 note: `pnpm i18n:compile` only produces the
 *    `.ts` catalog, there is no compiled `.js` sibling yet) — plain `require`
 *    cannot find a bare specifier with a `.ts` file on disk (verified directly:
 *    Node's CJS resolver only probes `.js`/`.json`/`.node`), but Node ≥ 22's
 *    built-in TypeScript type-stripping CAN `require()` a `.ts` file when given
 *    its extension explicitly — confirmed empirically against this exact
 *    generated file with a plain, unflagged `node -e` script. So: try the
 *    production path first, and only on a genuine "not found" fall back to the
 *    explicit `.ts` path (re-throwing anything else, e.g. a real syntax error in
 *    the generated catalog, unchanged).
 */
function loadMessages(locale: Locale): Record<string, unknown> {
  const path = `./locales/${locale}/messages`
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS build; catalogs are generated files
    return (require(path) as { messages: Record<string, unknown> }).messages
  } catch (err) {
    const isModuleNotFound =
      err instanceof Error && 'code' in err && err.code === 'MODULE_NOT_FOUND'
    if (!isModuleNotFound) throw err
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see loadMessages doc comment above
    return (require(`${path}.ts`) as { messages: Record<string, unknown> }).messages
  }
}

/** One instance per request / per recipient — never activate a global singleton on the server. */
export function createI18n(locale: Locale): I18n {
  const i18n = setupI18n({ locale, messages: { [locale]: loadMessages(locale) } })
  return i18n
}
