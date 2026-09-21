// fix-round 1 (PR #697, SPEC-H-1). `apps/e2e` не видит ни `@crm/shared`, ни
// `@crm/shared-i18n-locales` (оба — Vite-алиасы apps/web, e2e через Vite не
// идёт). Скомпилированный каталог — плоский объект без импортов, читаем его
// напрямую по относительному пути (требует `pnpm i18n:compile` ПЕРЕД
// прогоном — уже в порядке команд каждого Task-Step).
//
// fix-round 2 (PR #699, CI-3/CI-4): this fixture was written but never
// actually CALLED from any spec until this round wired `loadMessages` into
// three E2E files — the first real exercise found TWO bugs a static review
// could not have caught (both need a live Playwright run to surface):
//  1. `await import(path)` on an EXTENSIONLESS path resolves through Node's
//     native ESM loader (Playwright's own CJS transform only rewrites the
//     STATIC top-level `import` above, not a dynamic call at runtime), which
//     does not do CJS-style extension search and tries to parse the target
//     as plain JS — `SyntaxError: Unexpected token 'export'` on the
//     generated catalog's own `export const messages = …` line. `require()`
//     (this file already relies on `__dirname`, i.e. runs through
//     Playwright's CJS transform, so `require` is available) resolves an
//     extensionless specifier the normal Node CJS way AND Node ≥ 22's
//     built-in type-stripping lets it load a bare `.ts` file directly —
//     same fallback `packages/shared/src/i18n/catalog.ts`'s own
//     `loadMessages` already relies on, just without that file's compiled-JS
//     branch (this catalog is TS-only — `pnpm i18n:compile` never emits a
//     `.js` sibling here, see that file's own header comment).
//  2. The return type was `Record<string, string>`, but `lingui compile`'s
//     actual runtime shape is `Record<string, string[]>` — even a plain,
//     variable-free message compiles to a ONE-element array (ICU
//     MessageFormat's "compiled AST" representation: an array of literal
//     string / placeholder parts). `.join('')` collapses that safely for
//     every id in this registry (none carry `{variable}` interpolation).
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(__filename)

const LOCALES_DIR = join(__dirname, '../../../packages/shared/src/i18n/locales')

/** Скомпилированный каталог `locale`: id сообщения (хеш от исходного текста —
 *  генерируется `lingui extract`, НЕ сам текст, см.
 *  https://lingui.dev/guides/explicit-vs-generated-ids) -> локализованная
 *  строка. Id для НОВОГО ассерта — `pnpm i18n:extract`, затем
 *  `grep -B2 'msgstr "<исходный uk-текст>"' packages/shared/src/i18n/locales/uk/messages.po`. */
export async function loadMessages(locale: 'uk' | 'en'): Promise<Record<string, string>> {
  const mod = require(join(LOCALES_DIR, locale, 'messages')) as {
    messages: Record<string, string | string[]>
  }
  const flat: Record<string, string> = {}
  for (const [id, value] of Object.entries(mod.messages)) {
    flat[id] = Array.isArray(value) ? value.join('') : value
  }
  return flat
}

/**
 * fix-round 1 (SPEC-H-1). Confirms `text` is a REAL, current entry of
 * `messages` (as returned by `loadMessages`) before a spec uses it in a
 * Playwright assertion — throws loudly, with the exact text that no longer
 * matches, instead of letting a stale hardcoded literal silently drift from
 * what `nav-sidebar.tsx` (or any migrated component) actually renders.
 *
 * This is NOT id-based indirection: `lingui`'s generated ids are a SHA-256
 * hash of the source text itself (`@lingui/message-utils/generateMessageId`,
 * confirmed by hand against this catalog: `generateMessageId('Дашборд')` ===
 * `'7Lq/RH'`, the literal key `messages['7Lq/RH']` resolves to in the
 * compiled catalog) — so a copy change to the SOURCE text changes its own id
 * too; there is no id stable enough to survive a copy-review wording change
 * without also updating the call site, whether the call site holds the id or
 * the text. Reimplementing the hash inline (to look up "the current text for
 * this stable id") was tried and abandoned: a hand-rolled `sha256(text)`
 * matched neither this package's algorithm nor a simpler guess, and getting
 * it subtly wrong here would look up a WRONG entry rather than fail loudly —
 * worse than the stale-literal bug this exists to catch. Importing
 * `@lingui/message-utils` directly would fix that, but it is not a
 * dependency of `apps/e2e` (`grep '@lingui' apps/e2e/package.json` — none) —
 * adding one needs the user's explicit sign-off per this repo's dependency
 * policy, out of scope for a copy-review fix round.
 *
 * What this DOES catch, today, with zero new dependencies: exactly the bug
 * SPEC-H-1 reported — a spec asserting text the catalog no longer contains
 * at all (e.g. the pre-migration Russian nav labels) fails with a clear
 * "not in catalog" error instead of a confusing Playwright timeout.
 */
export function assertInCatalog(messages: Record<string, string>, text: string): string {
  if (!Object.values(messages).includes(text)) {
    throw new Error(
      `assertInCatalog: ${JSON.stringify(text)} is not a current catalog entry. ` +
        `The source text likely changed — check packages/shared/src/i18n/locales/uk/messages.po.`,
    )
  }
  return text
}
