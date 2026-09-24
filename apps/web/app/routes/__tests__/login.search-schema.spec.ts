/**
 * `login.tsx`'s `searchSchema` — regression test for a live crash found by
 * manual verification (task-user-emails-invite, §2), not by any prior test.
 *
 * TanStack Router's default search-param parser is a JSON-superset: a
 * numeric-looking query string like `?invited=1` is parsed into the JS
 * NUMBER `1` before `validateSearch` ever runs, not the string `'1'`. The
 * route used `z.enum(['1'])`, which only ever accepts the string — so a
 * real `?invited=1` redirect (the exact URL `AuthController.googleCallback`'s
 * invite-accept branch sends a person to on success) threw `SearchParamError`
 * and rendered the app's generic error boundary ("Что-то пошло не так")
 * instead of the success banner. Caught live via
 * `mcp__playwright__browser_navigate` to `/login?invited=1`, confirmed via
 * `mcp__playwright__browser_console_messages` — not by reading the code.
 *
 * These tests exercise `searchSchema` against the SHAPE the router actually
 * hands it (`{ invited: 1 }`, a real object with a number field), not
 * against a raw query string — `validateSearch` never sees a string here in
 * production, so a test that fed it `'1'` would not have caught this.
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { loadCatalog } from '@/test/i18n'
import { ERROR_MESSAGES, searchSchema } from '../login'

describe("login route searchSchema — invited param survives the router's JSON-superset parsing", () => {
  it('accepts the router-parsed shape for ?invited=1 (number 1, not string "1")', () => {
    const result = searchSchema.parse({ invited: 1 })
    expect(result.invited).toBe(true)
  })

  it('leaves invited undefined when the query param is absent (plain /login)', () => {
    const result = searchSchema.parse({})
    expect(result.invited).toBeUndefined()
  })

  it('rejects an unknown error code', () => {
    const bad = searchSchema.safeParse({ error: 'not_a_real_code' })
    expect(bad.success).toBe(false)
  })

  // Mutation gate: each array element in the `error` enum was previously a
  // `[Survived] StringLiteral` mutant (Stryker mutated e.g. 'unauthorized' →
  // '' and every unit test still passed — nothing here ever parsed THAT
  // specific value; only Playwright E2E did, via a real `?error=...`
  // navigation, which Stryker cannot execute — see
  // .claude/rules/common/mutation-gate-integration-specs.md). One parse per
  // value, independent of ERROR_MESSAGES, kills each one individually.
  const ERROR_CODES = [
    'unauthorized',
    'google_error',
    'invalid_state',
    'invite_email_mismatch',
    'invite_expired',
    'invite_used',
    'invite_invalid',
    'invite_account_taken',
    'account_mismatch',
    'account_disabled',
  ] as const

  it.each(ERROR_CODES)('accepts the exact error code %s', (code) => {
    const result = searchSchema.parse({ error: code })
    expect(result.error).toBe(code)
  })

  it('every ERROR_CODE above has a matching entry in ERROR_MESSAGES (and vice versa)', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort())
  })
})

// task-i18n-stage3a (Task 3), Step 1: `ERROR_MESSAGES` values are now
// `MessageDescriptor`s (msg-macro), not plain strings — a per-code
// StringLiteral mutation pin on the TEXT no longer applies (the text lives
// in the .po catalog, not in this module). The mutation gate's original
// target — Stryker turning e.g. 'unauthorized' → '' with every unit test
// still green — is still closed by two orthogonal checks below: the KEY
// list (which this file, independent of `login.tsx`, still hardcodes) and
// a resolution check that every code renders non-empty text on both
// shipped locales.
describe('login route ERROR_MESSAGES — every code resolves to real copy on uk and en', () => {
  // Independent from `ERROR_CODES` above (that one is compared against
  // `ERROR_MESSAGES`'s OWN keys — see "every ERROR_CODE above has a
  // matching entry" — so a corruption of `ERROR_MESSAGES`'s key set would
  // not be caught by a comparison against itself). This literal list is a
  // second, hand-typed source — a mutant that adds/drops/renames a key in
  // `login.tsx` shows up here as a set mismatch.
  const EXPECTED_CODES = [
    'unauthorized',
    'google_error',
    'invalid_state',
    'invite_email_mismatch',
    'invite_expired',
    'invite_used',
    'invite_invalid',
    'invite_account_taken',
    'account_mismatch',
    'account_disabled',
  ] as const

  it('ERROR_MESSAGES has exactly the expected set of keys', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...EXPECTED_CODES].sort())
  })

  it.each(EXPECTED_CODES)(
    'ERROR_MESSAGES.%s resolves to non-empty text on uk and en',
    async (code) => {
      await loadCatalog('uk')
      const uk = i18n._(ERROR_MESSAGES[code])
      expect(uk.length).toBeGreaterThan(0)

      await loadCatalog('en')
      const en = i18n._(ERROR_MESSAGES[code])
      expect(en.length).toBeGreaterThan(0)
      // The two locales must actually differ — catches a mutant (or a missed
      // translation) that leaves the en catalog falling back to the uk source
      // text for this specific code.
      expect(en).not.toBe(uk)
    },
  )
})
