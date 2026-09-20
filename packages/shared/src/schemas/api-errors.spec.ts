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

// SR-M-1 (PR #694 round 1) — the `en` catalog string for each code, read
// straight off disk rather than via `@crm/shared`'s compiled catalog
// (`i18n:compile` output is gitignored and only covers the locale the app
// actually loads at runtime): the source of truth for "what token set does
// the shipped English text use" is this .po file, same as
// `copy-reviewer`/translators edit directly.
const EN_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po')

function tokenSet(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1])
      .filter((token): token is string => token !== undefined),
  )
}

describe('api-errors', () => {
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

  // SR-M-1 — compile-time regression guard for `ParamsFor<C>` itself (not
  // just its current values above): a code with no declared params accepts
  // NO third argument at all (`never`, not `{}` — the empty-object type
  // does not catch excess properties, verified empirically before choosing
  // this shape, see `ParamsFor`'s doc comment in `./api-errors.ts`), and a
  // code with declared params accepts EXACTLY those keys, no more, no
  // fewer. This runs under `pnpm --filter @crm/shared typecheck` (unlike
  // `apps/api/**/*.spec.ts`, this package's tsconfig does not exclude spec
  // files) — a loosened pin fails the typecheck gate, not silently.
  it('ParamsFor<C> rejects excess/missing keys at compile time (type-only, verified by tsc)', () => {
    // @ts-expect-error — GENERIC declares no params; ParamsFor<'GENERIC'> is `never`.
    const generic: ParamsFor<'GENERIC'> = { extra: 1 }
    // @ts-expect-error — `role` is required for this code; {} is missing it.
    const missingRole: ParamsFor<'CONTRACT_TEMPLATE_MISSING'> = {}
    // @ts-expect-error — `legalName` is not declared for this code.
    const extraKey: ParamsFor<'CONTRACT_TEMPLATE_MISSING'> = { role: 'ADMIN', legalName: 'x' }
    const valid: ParamsFor<'CONTRACT_TEMPLATE_MISSING'> = { role: 'ADMIN' }

    // No runtime behavior to assert — a wrong pin above fails `tsc`, not this
    // expectation. Referencing the four bindings keeps them (and the
    // `@ts-expect-error` directives, which TS also flags if left unused)
    // meaningful rather than dead code.
    expect([generic, missingRole, extraKey, valid]).toHaveLength(4)
  })
})
