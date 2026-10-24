import { describe, expect, it } from 'vitest'
import {
  MAX_TRANSACTION_BUSINESS_YEAR,
  MIN_TRANSACTION_BUSINESS_YEAR,
  transactionBusinessDateFields,
  transactionBusinessDateSchema,
} from './finance/validation'

/**
 * SR-809-L-2 (retro review of PR #809) — `transactionBusinessDateSchema` only
 * asked "is this a real calendar day", so every year from 0000 to 9999 passed.
 * Year 0 then reached Postgres, which has no year 0 for `timestamptz`, and the
 * driver error surfaced as a 500 rather than a 400.
 *
 * The window here is the role-INDEPENDENT sanity floor. Whether a given date is
 * too far in the past, or in the future at all, depends on the caller's role and
 * on the flow, and is therefore decided server-side by the transaction-date
 * policy — not here (a Zod schema cannot see who is calling it).
 */
describe('transactionBusinessDateSchema — sane year window (SR-809-L-2)', () => {
  it('rejects year 0000, which Postgres timestamptz cannot store', () => {
    const result = transactionBusinessDateSchema.safeParse('0000-01-01')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('zod.DATE_YEAR_OUT_OF_RANGE')
  })

  it('rejects a far-future typo such as year 9999', () => {
    const result = transactionBusinessDateSchema.safeParse('9999-12-31')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('zod.DATE_YEAR_OUT_OF_RANGE')
  })

  it('rejects the year immediately below the window', () => {
    const justBelow = `${MIN_TRANSACTION_BUSINESS_YEAR - 1}-12-31`
    expect(transactionBusinessDateSchema.safeParse(justBelow).success).toBe(false)
  })

  it('rejects the year immediately above the window', () => {
    const justAbove = `${MAX_TRANSACTION_BUSINESS_YEAR + 1}-01-01`
    expect(transactionBusinessDateSchema.safeParse(justAbove).success).toBe(false)
  })

  it('accepts the first day of the window', () => {
    expect(
      transactionBusinessDateSchema.safeParse(`${MIN_TRANSACTION_BUSINESS_YEAR}-01-01`).success,
    ).toBe(true)
  })

  it('accepts the last day of the window', () => {
    expect(
      transactionBusinessDateSchema.safeParse(`${MAX_TRANSACTION_BUSINESS_YEAR}-12-31`).success,
    ).toBe(true)
  })

  it('still rejects a non-existent calendar day inside the window with the format error', () => {
    const result = transactionBusinessDateSchema.safeParse('2026-02-31')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('zod.DATE_FORMAT_YYYYMMDD')
  })

  it('still accepts an ordinary real day inside the window', () => {
    expect(transactionBusinessDateSchema.safeParse('2026-10-05').success).toBe(true)
  })
})

/**
 * SR-809-H-1 / owner decision D-2 — `backdateReason` is the transport for the
 * justification the server-side policy demands when an ADMIN/ACCOUNTANT dates a
 * row beyond the 31-day window. It ships as ONE spread with `txDate` so a writer
 * cannot accept the date while lacking the channel for its justification.
 *
 * Whether a reason is REQUIRED depends on the caller's role, which a schema
 * cannot see — that lives in `transaction-date-policy.ts`. What belongs here is
 * only the shape: optional, trimmed, and bounded so a free-text field cannot be
 * used to write unbounded data into the audit log.
 */
describe('transactionBusinessDateFields.backdateReason', () => {
  const schema = transactionBusinessDateFields.backdateReason

  it('is optional and nullable — most rows need no justification at all', () => {
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
  })

  it('trims, so the audit log never stores padding as content', () => {
    const result = schema.safeParse('   settled offline   ')
    expect(result.success).toBe(true)
    expect(result.data).toBe('settled offline')
  })

  it('accepts a reason at the length limit and rejects the first character past it', () => {
    expect(schema.safeParse('x'.repeat(500)).success).toBe(true)
    expect(schema.safeParse('x'.repeat(501)).success).toBe(false)
  })

  it('accepts an ordinary short reason — the bound is a ceiling, not a floor', () => {
    expect(schema.safeParse('late invoice').success).toBe(true)
  })
})
