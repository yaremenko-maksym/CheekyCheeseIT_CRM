import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  API_ERROR_FALLBACK_EN,
  API_ERROR_MESSAGES,
  API_ERROR_PARAMS,
  apiErrorEnvelopeSchema,
  type ParamsFor,
} from './api-errors'
import { AUTH_USERS_PROJECTS_ERROR_CODES } from './api-errors/auth-users-projects'
import { BASE_ERROR_CODES } from './api-errors/base'
import { DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES } from './api-errors/documents-contracts-notifications'
import { FINANCE_INVOICES_ERROR_CODES } from './api-errors/finance-invoices'

// SR-M-1 (PR #694 round 1) — the `en` catalog string for each code, read
// straight off disk rather than via `@crm/shared`'s compiled catalog
// (`i18n:compile` output is gitignored and only covers the locale the app
// actually loads at runtime): the source of truth for "what token set does
// the shipped English text use" is this .po file, same as
// `copy-reviewer`/translators edit directly.
const EN_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po')

/**
 * task-i18n-stage4-task3. The naive `/\{(\w+)\}/g` this replaced only
 * matched a BARE `{token}` — it could not see a top-level ICU `select`
 * declaration (`{role, select, ...}`, comma before the close brace, never
 * matched at all) and, worse, misread an ALL-ASCII option label nested
 * inside one (`... JUNIOR {Джуніор} HR {HR} ...` — Cyrillic option labels
 * are invisible to `\w`, but `{HR}` alone reads as a perfectly-shaped bare
 * token) as though it were a second declared param. Both failure modes are
 * silent: a code declaring `{ role: [] }` params.  This walks the string
 * once, brace-depth aware, and captures only the variable name of each
 * TOP-LEVEL `{name}` or `{name, select, ...}` / `{name, plural, ...}`
 * expression — never a name nested inside one — matching how `i18n._()`
 * itself parses ICU MessageFormat (verified against `@lingui/core`'s
 * `i18n._()` output at the call sites that use `select`, task-i18n-stage4-
 * task3 PR body).
 */
function tokenSet(text: string): Set<string> {
  const tokens = new Set<string>()
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') {
      i++
      continue
    }
    let j = i + 1
    let name = ''
    while (j < text.length && /\w/.test(text[j] as string)) {
      name += text[j]
      j++
    }
    if (name && (text[j] === '}' || text[j] === ',')) {
      tokens.add(name)
    }
    // Skip to the matching close brace for this top-level expression so
    // nested option braces (`{Джуніор}`, `{HR}`, …) are never re-scanned
    // as though they were top-level declarations.
    let depth = 1
    let k = i + 1
    while (k < text.length && depth > 0) {
      if (text[k] === '{') depth++
      else if (text[k] === '}') depth--
      k++
    }
    i = depth === 0 ? k : k + 1
  }
  return tokens
}

describe('api-errors', () => {
  // task-i18n-stage4-task1 (barrel split, SPEC-M-1) — the barrel
  // (`./api-errors/index.ts`) spreads four module arrays into one
  // `API_ERROR_CODES`; a `spread` silently lets a later module's key
  // clobber an earlier one's (last-write-wins, `as const` catches nothing
  // here — it only asserts the LITERAL type, not cross-array uniqueness).
  // Two modules defining the same code would both typecheck and both
  // pass every other test in this file (the clobbered message is simply
  // never read), so this is the only place duplication across module
  // files gets caught at all.
  it('no error code is declared in more than one module file', () => {
    const perModule = [
      ['base', BASE_ERROR_CODES],
      ['auth-users-projects', AUTH_USERS_PROJECTS_ERROR_CODES],
      ['finance-invoices', FINANCE_INVOICES_ERROR_CODES],
      ['documents-contracts-notifications', DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES],
    ] as const
    const seenIn = new Map<string, string>()
    for (const [moduleName, codes] of perModule) {
      for (const code of codes) {
        const owner = seenIn.get(code)
        expect(owner, `${code} declared in both ${owner} and ${moduleName}`).toBeUndefined()
        seenIn.set(code, moduleName)
      }
    }
    // The combined barrel must be exactly the concatenation — catches a
    // module file that exists but was never spread into the barrel too.
    expect(seenIn.size).toBe(API_ERROR_CODES.length)
  })

  it('every code has a message descriptor with an explicit id matching the code', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES[code].id).toBe(`api-error.${code}`)
      expect(API_ERROR_MESSAGES[code].message?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every code has a non-empty English fallback', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_FALLBACK_EN[code].length).toBeGreaterThan(0)
    }
  })

  it('envelope accepts a minimal valid body', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 403,
        code: 'TOS_ACCEPT_IMPERSONATION',
        message: 'x',
      }).success,
    ).toBe(true)
  })

  it('envelope accepts string/number params', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 404,
        code: 'CONTRACT_TEMPLATE_MISSING',
        params: { role: 'SENIOR', attempt: 2 },
        message: 'x',
      }).success,
    ).toBe(true)
  })

  // Mutation-gate finding (PR #694 round 2, whole-PR --changed scope): the
  // suite had no test distinguishing `z.union([z.string(), z.number()])`
  // from a broken/narrower union for the `params` value type — only the
  // accept case above was pinned. A boolean value is neither, so it must
  // fail validation; without this, the value-type union could be weakened
  // (or the whole record loosened to `z.any()`) with every existing test
  // still green.
  it('rejects a params value that is neither string nor number', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 404,
        code: 'CONTRACT_TEMPLATE_MISSING',
        params: { role: true },
        message: 'x',
      }).success,
    ).toBe(false)
  })

  it('rejects a code outside the registry', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({ statusCode: 403, code: 'NOPE', message: 'x' }).success,
    ).toBe(false)
  })

  it('rejects a body missing the required message field', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 403,
        code: 'TOS_ACCEPT_IMPERSONATION',
      }).success,
    ).toBe(false)
  })

  it('API_ERROR_PARAMS matches the {token} set in the Ukrainian message, the English fallback, and the en catalog string, for every code (SR-M-1)', () => {
    const poText = readFileSync(EN_CATALOG_PATH, 'utf-8')
    for (const code of API_ERROR_CODES) {
      const declared = new Set<string>(API_ERROR_PARAMS[code])

      const ukTokens = tokenSet(API_ERROR_MESSAGES[code].message ?? '')
      expect(ukTokens, `${code}: Ukrainian message vs API_ERROR_PARAMS`).toEqual(declared)

      const enFallbackTokens = tokenSet(API_ERROR_FALLBACK_EN[code])
      expect(enFallbackTokens, `${code}: English fallback vs API_ERROR_PARAMS`).toEqual(declared)

      const enCatalogMatch = poText.match(
        new RegExp(`msgid "api-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(enCatalogMatch, `${code}: entry not found in en/messages.po`).not.toBeNull()
      const enCatalogTokens = tokenSet(enCatalogMatch?.[1] ?? '')
      expect(enCatalogTokens, `${code}: en catalog string vs API_ERROR_PARAMS`).toEqual(declared)
    }
  })

  it('API_ERROR_FALLBACK_EN equals the en catalog string exactly, for every code (COPY-M-4)', () => {
    const poText = readFileSync(EN_CATALOG_PATH, 'utf-8')
    for (const code of API_ERROR_CODES) {
      const enCatalogMatch = poText.match(
        new RegExp(`msgid "api-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(enCatalogMatch, `${code}: entry not found in en/messages.po`).not.toBeNull()
      expect(API_ERROR_FALLBACK_EN[code], `${code}: fallback vs en catalog`).toBe(
        enCatalogMatch?.[1] ?? '',
      )
    }
  })

  // SR-M-1 — compile-time regression guard for `ParamsFor<C>` itself: a code
  // with no declared params accepts NO third argument at all (`never`, not
  // `{}` — the empty-object type does not catch excess properties, verified
  // empirically before choosing this shape, see `ParamsFor`'s doc comment in
  // `./api-errors.ts`). This runs under `pnpm --filter @crm/shared typecheck`
  // (unlike `apps/api/**/*.spec.ts`, this package's tsconfig does not exclude
  // spec files) — a loosened pin fails the typecheck gate, not silently.
  //
  // COPY-M-6 (PR #694 round 3) removed `role`, the only param any code
  // declared (`CONTRACT_TEMPLATE_MISSING`'s) — every `ParamsFor<C>` is
  // `never` now, so the "code with declared params accepts EXACTLY those
  // keys" branch this test used to also pin has no real code to run against.
  // Reinstate it against whichever code stage 3 next gives params to, rather
  // than keeping it synthetic.
  it('ParamsFor<C> rejects any third argument at compile time when a code declares no params (type-only, verified by tsc)', () => {
    // @ts-expect-error — GENERIC declares no params; ParamsFor<'GENERIC'> is `never`.
    const generic: ParamsFor<'GENERIC'> = { extra: 1 }
    // @ts-expect-error — CONTRACT_TEMPLATE_MISSING no longer declares params
    // (COPY-M-6); ParamsFor<'CONTRACT_TEMPLATE_MISSING'> is `never` too.
    const contractTemplateMissing: ParamsFor<'CONTRACT_TEMPLATE_MISSING'> = { role: 'ADMIN' }

    // No runtime behavior to assert — a wrong pin above fails `tsc`, not this
    // expectation. Referencing the bindings keeps them (and the
    // `@ts-expect-error` directives, which TS also flags if left unused)
    // meaningful rather than dead code.
    expect([generic, contractTemplateMissing]).toHaveLength(2)
  })
})
