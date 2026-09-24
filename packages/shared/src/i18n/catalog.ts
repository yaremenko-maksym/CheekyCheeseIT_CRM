import { setupI18n, type I18n } from '@lingui/core'
import { compileMessage } from '@lingui/message-utils/compileMessage'
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
    // Both real locales ('uk', 'en') always resolve on one of the two require
    // paths, so every reachable error through the public
    // createI18n(locale: Locale) API is a genuine MODULE_NOT_FOUND — this
    // guard's OTHER branch (a differently-coded error, e.g. a corrupted
    // compiled catalog) cannot be reached without corrupting a file on disk
    // from the test itself, which would be testing the filesystem, not this
    // code. catalog.spec.ts's "propagates a genuinely missing catalog" test
    // exercises this exact line (both requires throw MODULE_NOT_FOUND for an
    // unknown locale) and would fail if either mutant below changed the
    // OBSERVABLE outcome for that case; it doesn't, because both variants
    // agree with the real code on every error this module can actually
    // produce.
    const isModuleNotFound =
      // Stryker disable next-line ConditionalExpression,LogicalOperator: only a genuine MODULE_NOT_FOUND is reachable through createI18n's public Locale union, so forcing this true/false or swapping && for || is unobservable without corrupting a file on disk from the test itself.
      err instanceof Error && 'code' in err && err.code === 'MODULE_NOT_FOUND'
    // Stryker disable next-line ConditionalExpression: forcing `if (false)` never re-throws, indistinguishable from correct behavior since only a genuine MODULE_NOT_FOUND is reachable here (see isModuleNotFound above).
    if (!isModuleNotFound) throw err
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see loadMessages doc comment above
    return (require(`${path}.ts`) as { messages: Record<string, unknown> }).messages
  }
}

/**
 * One instance per request / per recipient — never activate a global singleton on the server.
 *
 * task-i18n-stage4-task6 (Уточнения оркестратора п.1, same fix as `apps/api/src/common/api-
 * error.ts`'s `interpolate()`, SR-M-1 PR #704 fix-round 1): `@lingui/core`'s `I18n` constructor
 * only self-registers `compileMessage` as the message compiler when
 * `process.env.NODE_ENV !== 'production'` — the compiled catalog (`lingui compile --typescript`)
 * ships its messages as an already-parsed array form that needs no runtime compiler, but any
 * `i18n._(id, params, { message })` call whose `id` is missing from the compiled catalog (a
 * drifted `pnpm i18n:extract`, or a caller that only ever uses the inline fallback) falls back to
 * the RAW ICU `message` string — which on prod (`NODE_ENV=production`) would render verbatim
 * (braces and all) instead of being parsed, exactly the defect #704 found in `api-error.ts`.
 * Registering the compiler explicitly, unconditionally, makes every `createI18n()` instance behave
 * identically in dev/test and prod regardless of that env-gated default.
 */
export function createI18n(locale: Locale): I18n {
  const i18n = setupI18n({ locale, messages: { [locale]: loadMessages(locale) } })
  i18n.setMessagesCompiler(compileMessage)
  return i18n
}
