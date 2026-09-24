import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/catalog'
import {
  AMOUNT_DECIMAL_PLACES,
  MIN_TRANSACTION_AMOUNT,
  SALARY_AMOUNT_DECIMAL_PLACES,
  MIN_SALARY_AMOUNT,
} from './money'
import { MAX_TRANSACTION_AMOUNT, COMPANY_REQUISITES_MAX } from './finance'
import { RESUME_LIMITS } from './resume'
import {
  ZOD_ERROR_CODES,
  ZOD_ERROR_FALLBACK_EN,
  ZOD_ERROR_MESSAGES,
  zodErrorFallbackText,
} from './zod-errors'

const EN_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po')

describe('ZOD_ERROR_MESSAGES', () => {
  it('RNOKPP_FORMAT has a uk message descriptor', () => {
    const i18n = createI18n('uk')
    const message = ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.message
    expect(
      i18n._(
        ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.id,
        undefined,
        message !== undefined ? { message } : undefined,
      ),
    ).toBe('Введіть 10 цифр РНОКПП')
  })

  it('every code has a message descriptor with an explicit id matching the code', () => {
    for (const code of ZOD_ERROR_CODES) {
      expect(ZOD_ERROR_MESSAGES[code].id).toBe(`zod-error.${code}`)
      expect(ZOD_ERROR_MESSAGES[code].message?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every code has a non-empty English fallback', () => {
    for (const code of ZOD_ERROR_CODES) {
      expect(ZOD_ERROR_FALLBACK_EN[code].length).toBeGreaterThan(0)
    }
  })

  it('ZOD_ERROR_FALLBACK_EN equals the en catalog string exactly, for every code', () => {
    const poText = readFileSync(EN_CATALOG_PATH, 'utf-8')
    for (const code of ZOD_ERROR_CODES) {
      const enCatalogMatch = poText.match(
        new RegExp(`msgid "zod-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(enCatalogMatch, `${code}: entry not found in en/messages.po`).not.toBeNull()
      expect(ZOD_ERROR_FALLBACK_EN[code], `${code}: fallback vs en catalog`).toBe(
        enCatalogMatch?.[1] ?? '',
      )
    }
  })

  it('every code resolves to non-empty text through createI18n for both locales', () => {
    for (const locale of ['uk', 'en'] as const) {
      const i18n = createI18n(locale)
      for (const code of ZOD_ERROR_CODES) {
        const descriptor = ZOD_ERROR_MESSAGES[code]
        const options =
          descriptor.message !== undefined ? { message: descriptor.message } : undefined
        const text = i18n._(descriptor.id, undefined, options)
        expect(text.length, `${code} (${locale})`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * fix-round 1, SPEC-M-1: the module doc-comment on `zod-errors.ts` claims a
 * baked-in number in a message text is pinned against its live constant "so
 * a future change to either drifts loudly (a failing test)" — this describes
 * were the tests below, which did not exist until this round. Every literal
 * digit sequence baked into a message is derived from the SAME constant here
 * (`.toLocaleString('en-US')`, comma thousands separator for en, the same
 * string with commas swapped for spaces for uk — matches both locales'
 * existing formatting in the registry text without depending on Node's ICU
 * data for a `uk-UA` Intl locale).
 */
describe('numbers baked into ZOD_ERROR_MESSAGES/ZOD_ERROR_FALLBACK_EN pin the live constant', () => {
  it('TRANSACTION_AMOUNT_TOO_SMALL pins MIN_TRANSACTION_AMOUNT', () => {
    const digits = MIN_TRANSACTION_AMOUNT.toFixed(AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_TOO_SMALL.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_TOO_SMALL).toContain(digits)
  })

  it('TRANSACTION_AMOUNT_TOO_MANY_DECIMALS pins AMOUNT_DECIMAL_PLACES', () => {
    const digits = String(AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_TOO_MANY_DECIMALS.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_TOO_MANY_DECIMALS).toContain(digits)
  })

  it('SALARY_AMOUNT_TOO_SMALL pins MIN_SALARY_AMOUNT', () => {
    const digits = MIN_SALARY_AMOUNT.toFixed(SALARY_AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.SALARY_AMOUNT_TOO_SMALL.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.SALARY_AMOUNT_TOO_SMALL).toContain(digits)
  })

  it('SALARY_AMOUNT_TOO_MANY_DECIMALS pins SALARY_AMOUNT_DECIMAL_PLACES', () => {
    const digits = String(SALARY_AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.SALARY_AMOUNT_TOO_MANY_DECIMALS.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.SALARY_AMOUNT_TOO_MANY_DECIMALS).toContain(digits)
  })

  it('TRANSACTION_AMOUNT_EXCEEDS_MAX pins MAX_TRANSACTION_AMOUNT', () => {
    const en = MAX_TRANSACTION_AMOUNT.toLocaleString('en-US')
    const uk = en.replace(/,/g, ' ')
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_EXCEEDS_MAX.message).toContain(uk)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_EXCEEDS_MAX).toContain(en)
  })

  it('REQUISITES_TOO_LONG pins COMPANY_REQUISITES_MAX', () => {
    const en = COMPANY_REQUISITES_MAX.toLocaleString('en-US')
    const uk = en.replace(/,/g, ' ')
    expect(ZOD_ERROR_MESSAGES.REQUISITES_TOO_LONG.message).toContain(uk)
    expect(ZOD_ERROR_FALLBACK_EN.REQUISITES_TOO_LONG).toContain(en)
  })

  // fix-round 1, COPY-M-5: the "40" in RESUME_TEXT_TOO_SHORT's text is not a
  // separate literal a copy-edit could silently drift out of sync with the
  // schema's real threshold — it is pinned against the live constant, same
  // as the numbers above.
  it('RESUME_TEXT_TOO_SHORT pins RESUME_LIMITS.minExtractableChars', () => {
    const digits = String(RESUME_LIMITS.minExtractableChars)
    expect(ZOD_ERROR_MESSAGES.RESUME_TEXT_TOO_SHORT.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.RESUME_TEXT_TOO_SHORT).toContain(digits)
  })
})

/**
 * fix-round 3, COPY-M-13. `SHARE_PERCENT_RANGE_1_100`/`SHARE_PERCENT_RANGE_0_100`
 * have no shared numeric constant to pin against (unlike the `money.ts`/
 * `finance.ts` amounts above — these are hand-rolled `onBlur` bounds inline
 * in the form components, not exported from `@crm/shared`). The invariant
 * this suite CAN check without one: the uk message and the en fallback name
 * the SAME two numbers, so a future copy-edit to one locale cannot silently
 * drift the stated range away from the other's.
 */
describe('SHARE_PERCENT_RANGE codes carry the same numbers in uk and en', () => {
  const digitsOf = (text: string) => text.match(/\d+/g) ?? []

  it('SHARE_PERCENT_RANGE_1_100: uk and en text, and both say 1 and 100', () => {
    expect(ZOD_ERROR_MESSAGES.SHARE_PERCENT_RANGE_1_100.message).toBe('Вкажіть від 1 до 100')
    expect(ZOD_ERROR_FALLBACK_EN.SHARE_PERCENT_RANGE_1_100).toBe('Enter a value from 1 to 100')
    expect(digitsOf(ZOD_ERROR_MESSAGES.SHARE_PERCENT_RANGE_1_100.message ?? '')).toEqual([
      '1',
      '100',
    ])
    expect(digitsOf(ZOD_ERROR_FALLBACK_EN.SHARE_PERCENT_RANGE_1_100)).toEqual(['1', '100'])
  })

  it('SHARE_PERCENT_RANGE_0_100: uk and en text, and both say 0 and 100', () => {
    expect(ZOD_ERROR_MESSAGES.SHARE_PERCENT_RANGE_0_100.message).toBe('Вкажіть від 0 до 100')
    expect(ZOD_ERROR_FALLBACK_EN.SHARE_PERCENT_RANGE_0_100).toBe('Enter a value from 0 to 100')
    expect(digitsOf(ZOD_ERROR_MESSAGES.SHARE_PERCENT_RANGE_0_100.message ?? '')).toEqual([
      '0',
      '100',
    ])
    expect(digitsOf(ZOD_ERROR_FALLBACK_EN.SHARE_PERCENT_RANGE_0_100)).toEqual(['0', '100'])
  })
})

describe('zodErrorFallbackText', () => {
  it('translates a coded zod.<CODE> message to its English fallback', () => {
    expect(zodErrorFallbackText('zod.RECEIPT_REQUIRED')).toBe(
      ZOD_ERROR_FALLBACK_EN.RECEIPT_REQUIRED,
    )
  })

  it('passes a non-coded message through unchanged', () => {
    expect(zodErrorFallbackText('Cannot transfer to yourself')).toBe('Cannot transfer to yourself')
  })

  it('passes an unknown zod.<CODE>-shaped message through unchanged', () => {
    expect(zodErrorFallbackText('zod.NOT_A_REAL_CODE')).toBe('zod.NOT_A_REAL_CODE')
  })

  /**
   * mutation-gate closure: without this test, both `!message.startsWith('zod.')`
   * mutants (the condition forced to `false`, and the literal `'zod.'` gutted to
   * `''`) survive — a message with no `zod.` prefix at all still lands on the
   * "passes through unchanged, `?? message`" fallback purely by coincidence
   * whenever `message.slice(4)` does not happen to collide with a real code, so
   * the two tests above cannot distinguish "the early return actually ran" from
   * "it didn't, but the fallback masked it". This message is constructed so a
   * BROKEN early-return (message never returned as-is) slices off its first 4
   * characters into `RECEIPT_REQUIRED` — a REAL code — and returns that code's
   * English text instead of the message verbatim, which the assertion below
   * catches.
   */
  it("a non-coded message whose 4th-character-onward slice collides with a real code is NOT mistaken for one (pins the actual startsWith('zod.') check, not just the fallback)", () => {
    const message = 'abcdRECEIPT_REQUIRED'
    expect(message.startsWith('zod.')).toBe(false)
    expect(zodErrorFallbackText(message)).toBe(message)
  })

  /**
   * fix-round 3, SR-L-1. `ZOD_ERROR_FALLBACK_EN` is an ordinary object
   * literal — `['__proto__']`/`['constructor']`/`['toString']` resolve to
   * INHERITED, non-`undefined` values (`Object.prototype` itself, and two
   * functions), so a bracket-index-then-`?? message` fallback would return
   * an object/function instead of a string for each. The `isZodErrorCode`
   * allow-list guard must return `message` verbatim for all three.
   */
  it.each(['zod.__proto__', 'zod.constructor', 'zod.toString'])(
    'treats %s as an unknown code, not a prototype lookup — returns the message verbatim as a string',
    (message) => {
      const result = zodErrorFallbackText(message)
      expect(typeof result).toBe('string')
      expect(result).toBe(message)
    },
  )
})
