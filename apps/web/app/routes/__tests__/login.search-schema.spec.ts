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
    'invite_invalid',
    'invite_expired',
    'invite_used',
    'invite_email_mismatch',
  ] as const

  it.each(ERROR_CODES)('accepts the exact error code %s', (code) => {
    const result = searchSchema.parse({ error: code })
    expect(result.error).toBe(code)
  })

  it('every ERROR_CODE above has a matching entry in ERROR_MESSAGES (and vice versa)', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort())
  })
})

describe('login route ERROR_MESSAGES — exact Russian copy per error code', () => {
  // Independent literals, not derived from the source file — a mutant that
  // empties one of these strings fails here even though rendering still
  // "works" (an empty banner is not a passing UI).
  const EXPECTED: Record<string, string> = {
    unauthorized: 'Ваш email не авторизован. Обратитесь к администратору.',
    google_error: 'Ошибка Google OAuth. Попробуйте снова.',
    invalid_state: 'Сессия истекла. Пожалуйста, попробуйте снова.',
    invite_email_mismatch:
      'Аккаунт Google не совпадает с адресом из приглашения. Обратитесь к администратору, если это ошибка.',
    invite_expired:
      'Срок действия приглашения истёк. Попросите администратора отправить его заново.',
    invite_used: 'Это приглашение уже использовано.',
    invite_invalid: 'Ссылка приглашения недействительна.',
  }

  it.each(Object.entries(EXPECTED))(
    'ERROR_MESSAGES.%s is the exact approved copy',
    (code, expected) => {
      expect(ERROR_MESSAGES[code]).toBe(expected)
    },
  )
})
