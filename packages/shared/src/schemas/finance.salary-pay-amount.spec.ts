/**
 * task-salary-pay-amount — the shared contract for paying a salary with a
 * hand-entered amount.
 *
 * Pins (AC4 / AC5 / ceiling):
 *   - `paySalarySchema.paidAmount` is optional (legacy callers unchanged),
 *     positive-only, and carries the SAME BIZ-13 ceiling as
 *     `createSalarySchema.amount` — asserted by referencing one constant, so
 *     the two cannot drift apart in a future edit.
 *   - `transactionSchema` round-trips the obligation snapshot
 *     (originalAmount / originalCurrency / exchangeRate) AND still parses every
 *     legacy DTO that has no such fields.
 *   - `salaryPaidAmountDeviation` warns on both sides of the threshold — the
 *     typo guard's whole purpose is that it fires on «300 instead of 30 000»
 *     while staying silent on an honest bank-rate spread.
 */
import { describe, expect, it } from 'vitest'
import { MIN_TRANSACTION_AMOUNT } from './money'
import {
  MAX_TRANSACTION_AMOUNT,
  SALARY_PAID_AMOUNT_WARN_THRESHOLD,
  createSalarySchema,
  paySalarySchema,
  salaryPaidAmountDeviation,
  transactionSchema,
} from './finance'

const BASE_PAY = {
  fundingSource: 'ADMIN_PERSONAL' as const,
  payerAdminId: '11111111-1111-4111-8111-111111111111',
  currency: 'UAH' as const,
  receiptExternalUrl: 'https://example.com/receipt.pdf',
}

describe('paySalarySchema — paidAmount (task-salary-pay-amount)', () => {
  it('parses without paidAmount — legacy callers keep working', () => {
    const result = paySalarySchema.safeParse(BASE_PAY)
    expect(result.success).toBe(true)
    expect(result.data?.paidAmount).toBeUndefined()
  })

  it('accepts a hand-entered paid amount', () => {
    const result = paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 30_000 })
    expect(result.success).toBe(true)
    expect(result.data?.paidAmount).toBe(30_000)
  })

  it('rejects zero and negative amounts (a salary is never closed by paying nothing)', () => {
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 0 }).success).toBe(false)
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: -1 }).success).toBe(false)
  })

  it('carries the SAME ceiling as createSalarySchema.amount (both sides of the boundary)', () => {
    expect(
      paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: MAX_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
    expect(
      paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: MAX_TRANSACTION_AMOUNT + 1 }).success,
    ).toBe(false)

    // The ceiling is the same ONE the create side enforces — not a re-typed literal.
    const createBase = {
      receiverId: '22222222-2222-4222-8222-222222222222',
      salaryMonth: '2026-08',
    }
    expect(
      createSalarySchema.safeParse({ ...createBase, amount: MAX_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
    expect(
      createSalarySchema.safeParse({ ...createBase, amount: MAX_TRANSACTION_AMOUNT + 1 }).success,
    ).toBe(false)
  })

  // security-review PR #485 (MED-1): a value the numeric(18,6) column cannot
  // store without loss must not be accepted at all — «1e-7» used to validate,
  // then be written as 0.000000, closing the obligation with a ZERO payment.
  it('rejects an amount below what the column can store (would round to 0.000000)', () => {
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 1e-7 }).success).toBe(false)
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 0.0000005 }).success).toBe(false)
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 1e-12 }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount (boundary: passes)', () => {
    const result = paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: MIN_TRANSACTION_AMOUNT })
    expect(result.success).toBe(true)
    // …and it survives the trip to the column verbatim, not as «1e-6».
    expect(String(MIN_TRANSACTION_AMOUNT)).toBe('0.000001')
  })

  it('rejects more decimals than the column keeps (silent rounding, not an error)', () => {
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 100.1234567 }).success).toBe(false)
    // …but the full scale of the column is fine.
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 100.123456 }).success).toBe(true)
  })

  it('rejects NaN and both infinities (they would reach the balance gate as NaN)', () => {
    expect(paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: Number.NaN }).success).toBe(false)
    expect(
      paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: Number.POSITIVE_INFINITY }).success,
    ).toBe(false)
    expect(
      paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: Number.NEGATIVE_INFINITY }).success,
    ).toBe(false)
  })

  it('explains WHY in Russian, and reports a tiny amount as too small (not as too precise)', () => {
    const tiny = paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 1e-7 })
    expect(tiny.success).toBe(false)
    expect((tiny.error?.issues ?? [])[0]?.message).toContain('слишком мала')

    const precise = paySalarySchema.safeParse({ ...BASE_PAY, paidAmount: 1.1234567 })
    expect(precise.success).toBe(false)
    expect((precise.error?.issues ?? [])[0]?.message).toContain('знаков после запятой')
  })

  it('still forces USDT for a company-account payout (existing refine untouched)', () => {
    const result = paySalarySchema.safeParse({
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'UAH',
      paidAmount: 100,
      receiptExternalUrl: 'https://etherscan.io/tx/0xabc',
    })
    expect(result.success).toBe(false)
  })
})

describe('transactionSchema — obligation snapshot (AC4)', () => {
  const BASE_TX = {
    id: '33333333-3333-4333-8333-333333333333',
    type: 'SALARY',
    status: 'PAID',
    amount: '30000',
    currency: 'UAH',
    senderId: null,
    senderLabel: 'Admin',
    senderName: null,
    receiverId: null,
    receiverLabel: 'Employee',
    receiverName: null,
    projectId: null,
    projectName: null,
    payoutRequestId: null,
    seniorSharePercent: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    txFromAddress: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: '2026-08',
    txDate: null,
    createdBy: '44444444-4444-4444-8444-444444444444',
    createdAt: '2026-08-05T10:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
  }

  it('round-trips the obligation alongside the paid fact', () => {
    const result = transactionSchema.safeParse({
      ...BASE_TX,
      originalAmount: '800',
      originalCurrency: 'USD',
      exchangeRate: '37.5',
    })
    expect(result.success).toBe(true)
    // The FACT of the payment…
    expect(result.data?.amount).toBe('30000')
    expect(result.data?.currency).toBe('UAH')
    // …and the OBLIGATION it settled — both present, neither overwritten.
    expect(result.data?.originalAmount).toBe('800')
    expect(result.data?.originalCurrency).toBe('USD')
    expect(result.data?.exchangeRate).toBe('37.5')
  })

  it('parses a legacy row that has no snapshot at all (additive, not breaking)', () => {
    const result = transactionSchema.safeParse(BASE_TX)
    expect(result.success).toBe(true)
    expect(result.data?.originalAmount).toBeUndefined()
    expect(result.data?.originalCurrency).toBeUndefined()
    expect(result.data?.exchangeRate).toBeUndefined()
  })

  it('accepts explicit nulls (unpaid / non-salary rows come back null from the DB)', () => {
    const result = transactionSchema.safeParse({
      ...BASE_TX,
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
    })
    expect(result.success).toBe(true)
  })
})

describe('salaryPaidAmountDeviation — typo guard (AC5)', () => {
  it('stays silent within tolerance: a real bank spread over the NBU rate', () => {
    // Expected 35 800 UAH at the NBU rate; the bank actually gave 36 500 (~2%).
    expect(salaryPaidAmountDeviation(36_500, 35_800)).toBeNull()
  })

  it('stays silent exactly AT the threshold (boundary is inclusive-tolerant)', () => {
    const expected = 1000
    const atThreshold = expected * (1 + SALARY_PAID_AMOUNT_WARN_THRESHOLD)
    expect(salaryPaidAmountDeviation(atThreshold, expected)).toBeNull()
  })

  it('fires just PAST the threshold', () => {
    const expected = 1000
    const past = expected * (1 + SALARY_PAID_AMOUNT_WARN_THRESHOLD) + 1
    const deviation = salaryPaidAmountDeviation(past, expected)
    expect(deviation).not.toBeNull()
    expect(deviation!).toBeGreaterThan(SALARY_PAID_AMOUNT_WARN_THRESHOLD)
  })

  it('fires loudly on the order-of-magnitude slip it exists for (300 vs 30 000)', () => {
    const deviation = salaryPaidAmountDeviation(300, 30_000)
    expect(deviation).not.toBeNull()
    expect(Math.round(deviation! * 100)).toBe(99)
  })

  it('fires on an overpayment too, not just an underpayment', () => {
    expect(salaryPaidAmountDeviation(300_000, 30_000)).not.toBeNull()
  })

  it('says nothing when there is no usable expectation or input', () => {
    expect(salaryPaidAmountDeviation(100, 0)).toBeNull()
    expect(salaryPaidAmountDeviation(100, Number.NaN)).toBeNull()
    expect(salaryPaidAmountDeviation(Number.NaN, 100)).toBeNull()
    expect(salaryPaidAmountDeviation(0, 100)).toBeNull()
  })
})
