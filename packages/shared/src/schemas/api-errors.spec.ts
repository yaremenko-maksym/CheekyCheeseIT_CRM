import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupI18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  API_ERROR_FALLBACK_EN,
  API_ERROR_MESSAGES,
  API_ERROR_PARAMS,
  apiErrorEnvelopeSchema,
  type ApiErrorCode,
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
// SR-L-2 (PR #702 fix-round 1): the source-of-truth invariant test below
// used to check the `uk` TS source (`API_ERROR_MESSAGES[code].message`)
// against `API_ERROR_PARAMS`, but only checked the COMPILED CATALOG side
// (the .po file translators actually edit) for `en`, never `uk` — a `uk`
// catalog entry could drift from its own declared params with nothing
// catching it. Read straight off disk for the same reason `EN_CATALOG_PATH`
// is (see its comment above).
const UK_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'uk', 'messages.po')

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

  it('API_ERROR_PARAMS matches the {token} set in the Ukrainian message, the English fallback, and both catalog strings, for every code (SR-M-1, SR-L-2)', () => {
    const enPoText = readFileSync(EN_CATALOG_PATH, 'utf-8')
    const ukPoText = readFileSync(UK_CATALOG_PATH, 'utf-8')
    for (const code of API_ERROR_CODES) {
      const declared = new Set<string>(API_ERROR_PARAMS[code])

      const ukTokens = tokenSet(API_ERROR_MESSAGES[code].message ?? '')
      expect(ukTokens, `${code}: Ukrainian message vs API_ERROR_PARAMS`).toEqual(declared)

      const enFallbackTokens = tokenSet(API_ERROR_FALLBACK_EN[code])
      expect(enFallbackTokens, `${code}: English fallback vs API_ERROR_PARAMS`).toEqual(declared)

      const enCatalogMatch = enPoText.match(
        new RegExp(`msgid "api-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(enCatalogMatch, `${code}: entry not found in en/messages.po`).not.toBeNull()
      const enCatalogTokens = tokenSet(enCatalogMatch?.[1] ?? '')
      expect(enCatalogTokens, `${code}: en catalog string vs API_ERROR_PARAMS`).toEqual(declared)

      // SR-L-2: same check against the uk catalog — previously unchecked.
      const ukCatalogMatch = ukPoText.match(
        new RegExp(`msgid "api-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(ukCatalogMatch, `${code}: entry not found in uk/messages.po`).not.toBeNull()
      const ukCatalogTokens = tokenSet(ukCatalogMatch?.[1] ?? '')
      expect(ukCatalogTokens, `${code}: uk catalog string vs API_ERROR_PARAMS`).toEqual(declared)
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
  // declared (`CONTRACT_TEMPLATE_MISSING`'s) — every `ParamsFor<C>` was
  // `never` after that, so the "code with declared params accepts EXACTLY
  // those keys" branch this test used to also pin had no real code to run
  // against. Reinstated below (SR-M-2, PR #702 fix-round 1) — see that test.
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

  // SR-M-2 (PR #702 fix-round 1) — reinstated against a real code with
  // params, per the note on the test above: task-i18n-stage4-task3 gave
  // `TEAM_UNEXPECTED_USER_ROLE` two (`expectedRole`, `actualRole`). This is
  // the "code WITH declared params" half `ParamsFor<C>` exists for — the
  // guarantee that a call site cannot pass an excess key alongside the
  // declared ones (SR-L-2 from #694: excess-property checking only fires
  // against a FRESH object literal, which is why every case below assigns a
  // literal directly, never a pre-built variable).
  it('ParamsFor<C> accepts exactly the declared keys and rejects an excess or missing key for a code WITH params (type-only, verified by tsc)', () => {
    const exact: ParamsFor<'TEAM_UNEXPECTED_USER_ROLE'> = {
      expectedRole: 'SENIOR',
      actualRole: 'JUNIOR',
    }
    const excess: ParamsFor<'TEAM_UNEXPECTED_USER_ROLE'> = {
      expectedRole: 'SENIOR',
      actualRole: 'JUNIOR',
      // @ts-expect-error — `extra` is not a declared param of this code.
      extra: 1,
    }
    // @ts-expect-error — missing the required `actualRole` key.
    const missing: ParamsFor<'TEAM_UNEXPECTED_USER_ROLE'> = { expectedRole: 'SENIOR' }

    expect([exact, excess, missing]).toHaveLength(3)
  })
})

/**
 * CR-H-1 (PR #702 fix-round 1, code-review round 1). `CONTRACT_ALREADY_
 * STATUS_CANNOT_REVERT` shipped with an ICU `select` on `status` that only
 * declared branches for `READY_TO_SIGN`/`SIGNED`/`CANCELLED` — the fourth
 * value the real throw site (`employee-contracts.service.ts::revert()`)
 * actually passes, `DRAFT`, silently fell into the generic `other` branch
 * ("контракт уже в іншому статусі" / "already in another status") — a lie,
 * since DRAFT is a perfectly well-known status. `DOCUMENT_UPLOAD_CATEGORY_
 * FORBIDDEN` had the same class of defect in the other direction (COPY-H-2:
 * a declared `CONTRACT` branch that no real call site ever reaches).
 *
 * This describe block is the systemic fix both findings asked for: for
 * every code with an ICU `select`, render EVERY value the real domain of
 * that param can take (both `uk` and `en`) and assert the result is NOT
 * what an unmatched value renders as (the `other` branch) — i.e. every real
 * value hits its OWN declared branch, never the fallback. A rendering equal
 * to the sentinel's `other`-branch text for a real value is exactly the bug
 * class both findings reported.
 *
 * "The real domain of that param" is deliberately NOT the full TypeScript
 * union a param's call sites happen to use elsewhere (e.g. the full
 * `DocumentCategory` union has 7 members; only 4 of them — RESUME, SCAN,
 * RECEIPT, LOGO — ever reach `DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN`'s throw
 * site, verified against `documents.service.ts::assertCanUpload` by both
 * COPY-H-2 and the security review) — testing the untyped-but-unreachable
 * remainder (CONTRACT/AVATAR/INVOICE) would fail for a reason that is not a
 * real bug (those values never occur here; a different code owns them).
 * Each `values` list below is the verified real domain, not the type.
 */
describe('select-based ICU branches render truthfully for every value that actually reaches them (CR-H-1)', () => {
  // A value guaranteed not to match ANY declared `select` branch — its
  // rendering IS the `other`-branch text, used as the baseline every real
  // value must NOT equal.
  const UNMATCHED_SENTINEL = '__NOT_A_REAL_ENUM_VALUE__'

  function renderUk(code: ApiErrorCode, params: Record<string, string>): string {
    const i18n = setupI18n({ locale: 'uk', messages: { uk: {} } })
    const ukMessage = API_ERROR_MESSAGES[code].message
    const options = ukMessage !== undefined ? { message: ukMessage } : undefined
    return i18n._(API_ERROR_MESSAGES[code].id, params, options)
  }

  function renderEn(code: ApiErrorCode, params: Record<string, string>): string {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
    return i18n._(`api-error.${code}`, params, { message: API_ERROR_FALLBACK_EN[code] })
  }

  it.each([
    {
      code: 'DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN' as const,
      param: 'category',
      values: ['RESUME', 'SCAN', 'RECEIPT', 'LOGO'],
    },
    {
      code: 'CONTRACT_ALREADY_STATUS_CANNOT_REVERT' as const,
      param: 'status',
      values: ['DRAFT', 'READY_TO_SIGN', 'SIGNED', 'CANCELLED'],
    },
  ])(
    '$code: every real $param value renders its own branch, not "other" (uk + en)',
    ({ code, param, values }) => {
      const otherUk = renderUk(code, { [param]: UNMATCHED_SENTINEL })
      const otherEn = renderEn(code, { [param]: UNMATCHED_SENTINEL })

      for (const value of values) {
        expect(renderUk(code, { [param]: value }), `${code} uk ${param}=${value}`).not.toBe(otherUk)
        expect(renderEn(code, { [param]: value }), `${code} en ${param}=${value}`).not.toBe(otherEn)
      }
    },
  )

  it('TEAM_UNEXPECTED_USER_ROLE: every Role value renders its own branch for both expectedRole and actualRole, not "other" (uk + en)', () => {
    const code = 'TEAM_UNEXPECTED_USER_ROLE' as const
    // All 6 roles (`roleSchema`, packages/shared/src/schemas/users.ts) — the
    // branch set is a 1:1 match with the full Role enum (unlike the category
    // case above), so testing the full type here is correct, not just an
    // observed subset.
    const ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

    const otherUkExpected = renderUk(code, {
      expectedRole: UNMATCHED_SENTINEL,
      actualRole: 'JUNIOR',
    })
    const otherEnExpected = renderEn(code, {
      expectedRole: UNMATCHED_SENTINEL,
      actualRole: 'JUNIOR',
    })
    for (const role of ROLES) {
      expect(
        renderUk(code, { expectedRole: role, actualRole: 'JUNIOR' }),
        `uk expectedRole=${role}`,
      ).not.toBe(otherUkExpected)
      expect(
        renderEn(code, { expectedRole: role, actualRole: 'JUNIOR' }),
        `en expectedRole=${role}`,
      ).not.toBe(otherEnExpected)
    }

    const otherUkActual = renderUk(code, {
      expectedRole: 'SENIOR',
      actualRole: UNMATCHED_SENTINEL,
    })
    const otherEnActual = renderEn(code, {
      expectedRole: 'SENIOR',
      actualRole: UNMATCHED_SENTINEL,
    })
    for (const role of ROLES) {
      expect(
        renderUk(code, { expectedRole: 'SENIOR', actualRole: role }),
        `uk actualRole=${role}`,
      ).not.toBe(otherUkActual)
      expect(
        renderEn(code, { expectedRole: 'SENIOR', actualRole: role }),
        `en actualRole=${role}`,
      ).not.toBe(otherEnActual)
    }
  })
})
