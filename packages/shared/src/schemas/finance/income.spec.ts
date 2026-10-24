/**
 * income.spec.ts — field bounds and receipt-currency wiring of the write-side
 * schemas in `./income`. Hand-written literals only (see read-dtos.spec.ts).
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  adminUpdateTransactionSchema,
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createDropIncomeSchema,
  createExpenseSchema,
  createSalarySchema,
  createSeniorIncomeSchema,
  createUsdtIncomeSchema,
  paySalarySchema,
  salaryPartSchema,
  salaryPartsQuerySchema,
  salaryPartsResponseSchema,
  updateDropIncomeSchema,
  updateSeniorIncomeSchema,
  validateTransactionSchema,
} from './income'

const UUID = 'a0000000-0000-4000-8000-000000000001'
const UUID2 = 'a0000000-0000-4000-8000-000000000002'
const PLAIN_LINK = 'https://example.com/receipt/1'
const EXPLORER_LINK = 'https://etherscan.io/tx/0xabc123'
const CURRENCIES = ['USDT', 'USD', 'EUR', 'UAH'] as const

/** [] when exactly USDT/USD/EUR/UAH are accepted; otherwise the offending inputs. */
function acceptsEveryCurrency(field: z.ZodType): string[] {
  const bad: string[] = []
  for (const c of CURRENCIES) if (!field.safeParse(c).success) bad.push(`rejects ${c}`)
  for (const c of ['GBP', '']) if (field.safeParse(c).success) bad.push(`accepts "${c}"`)
  return bad
}

/** [] when a string of exactly `max` characters is accepted and `max + 1` is not. */
function maxLength(field: z.ZodType, max: number): string[] {
  const bad: string[] = []
  if (!field.safeParse('x'.repeat(max)).success) bad.push(`rejects ${max} chars`)
  if (field.safeParse('x'.repeat(max + 1)).success) bad.push(`accepts ${max + 1} chars`)
  return bad
}

function messages(r: { error?: z.ZodError }): string[] {
  return (r.error?.issues ?? []).map((i) => i.message)
}

describe('every currency field accepts exactly USDT / USD / EUR / UAH', () => {
  const fields: Array<[string, z.ZodType]> = [
    ['createAdminIncome', createAdminIncomeSchema.shape.currency],
    ['createSeniorIncome', createSeniorIncomeSchema.shape.currency],
    ['createDropIncome', createDropIncomeSchema.shape.currency],
    ['updateSeniorIncome', updateSeniorIncomeSchema.shape.currency],
    ['updateDropIncome', updateDropIncomeSchema.shape.currency],
    ['createExpense', createExpenseSchema.shape.currency],
    ['createSalary', createSalarySchema.shape.currency],
    ['createAdminTransfer', createAdminTransferSchema.shape.currency],
    ['adminUpdateTransaction', adminUpdateTransactionSchema.shape.currency],
    ['paySalary', paySalarySchema.shape.currency],
  ]
  for (const [name, field] of fields) {
    it(name, () => expect(acceptsEveryCurrency(field)).toEqual([]))
  }
})

describe('notes is capped at 1000 characters on every write schema', () => {
  const fields: Array<[string, z.ZodType]> = [
    ['createAdminIncome', createAdminIncomeSchema.shape.notes],
    ['createUsdtIncome', createUsdtIncomeSchema.shape.notes],
    ['createSeniorIncome', createSeniorIncomeSchema.shape.notes],
    ['createDropIncome', createDropIncomeSchema.shape.notes],
    ['updateSeniorIncome', updateSeniorIncomeSchema.shape.notes],
    ['updateDropIncome', updateDropIncomeSchema.shape.notes],
    ['createExpense', createExpenseSchema.shape.notes],
    ['createSalary', createSalarySchema.shape.notes],
    ['createAdminTransfer', createAdminTransferSchema.shape.notes],
    ['adminUpdateTransaction', adminUpdateTransactionSchema.shape.notes],
    ['paySalary', paySalarySchema.shape.notes],
  ]
  for (const [name, field] of fields) {
    it(name, () => {
      expect(maxLength(field, 1000)).toEqual([])
      expect(field.safeParse(null).success).toBe(true)
      expect(field.safeParse(undefined).success).toBe(true)
    })
  }
})

describe('createSalarySchema.currency default', () => {
  it('is USD when omitted', () => {
    const r = createSalarySchema.safeParse({
      receiverId: UUID,
      amount: 10,
      salaryMonth: '2026-07',
      idempotencyKey: UUID2,
    })
    expect(r.data?.currency).toBe('USD')
  })
})

describe('validateTransactionSchema', () => {
  it('keeps both fields and accepts exactly validate / reject', () => {
    const body = { action: 'reject', rejectionReason: 'wrong amount' }
    expect(validateTransactionSchema.parse(body)).toEqual(body)
    expect(validateTransactionSchema.safeParse({ action: 'validate' }).success).toBe(true)
    expect(validateTransactionSchema.safeParse({ action: 'approve' }).success).toBe(false)
    expect(validateTransactionSchema.safeParse({ action: '' }).success).toBe(false)
  })

  it('caps rejectionReason at 500 characters', () => {
    expect(maxLength(validateTransactionSchema.shape.rejectionReason, 500)).toEqual([])
  })
})

describe('createExpenseSchema.category / adminUpdateTransactionSchema.category', () => {
  it('is 1..255 characters', () => {
    for (const field of [
      createExpenseSchema.shape.category,
      adminUpdateTransactionSchema.shape.category,
    ]) {
      expect(field.safeParse('').success).toBe(false)
      expect(field.safeParse('r').success).toBe(true)
      expect(maxLength(field, 255)).toEqual([])
    }
  })
})

describe('salaryMonth is exactly YYYY-MM (createSalary + adminUpdateTransaction)', () => {
  const fields: Array<[string, z.ZodType]> = [
    ['createSalary', createSalarySchema.shape.salaryMonth],
    ['adminUpdateTransaction', adminUpdateTransactionSchema.shape.salaryMonth],
  ]
  for (const [name, field] of fields) {
    it(name, () => {
      expect(field.safeParse('2026-07').success).toBe(true)
      expect(field.safeParse('2026-01').success).toBe(true)
      expect(field.safeParse('2026-12').success).toBe(true)
      for (const bad of [
        'x2026-07',
        '2026-07x',
        '2026-7',
        '202-07',
        '20266-07',
        'abcd-07',
        '2026-ab',
        '2026-0',
        '2026-13',
        '2026-00',
        '2026-99',
      ]) {
        const r = field.safeParse(bad)
        expect(r.success).toBe(false)
        expect(r.error?.issues[0]?.message).toBe('Format YYYY-MM')
      }
    })
  }
})

describe('mandatory-receipt effective currency per schema', () => {
  it('createDropIncome: a USDT income needs an explorer link, a USD one accepts any https link', () => {
    const base = { projectId: UUID, amount: 10, idempotencyKey: UUID2 }
    const usdtPlain = createDropIncomeSchema.safeParse({
      ...base,
      currency: 'USDT',
      receiptExternalUrl: PLAIN_LINK,
    })
    expect(messages(usdtPlain)).toEqual(['zod.RECEIPT_USDT_LINK_REQUIRED'])
    expect(
      createDropIncomeSchema.safeParse({
        ...base,
        currency: 'USDT',
        receiptExternalUrl: EXPLORER_LINK,
      }).success,
    ).toBe(true)
    expect(
      createDropIncomeSchema.safeParse({ ...base, currency: 'USD', receiptExternalUrl: PLAIN_LINK })
        .success,
    ).toBe(true)
  })

  it('createExpense: COMPANY_ACCOUNT forces an explorer link even when the stated currency is not USDT', () => {
    const base = { amount: 10, currency: 'UAH', category: 'rent', receiptExternalUrl: PLAIN_LINK }
    const company = createExpenseSchema.safeParse({ ...base, fundingSource: 'COMPANY_ACCOUNT' })
    expect(messages(company)).toEqual([
      'zod.COMPANY_ACCOUNT_USDT_ONLY',
      'zod.RECEIPT_USDT_LINK_REQUIRED',
    ])
    // Not a company-funded expense -> the stated currency decides -> a plain link is fine.
    expect(
      createExpenseSchema.safeParse({ ...base, fundingSource: 'ADMIN_PERSONAL' }).success,
    ).toBe(true)
    expect(createExpenseSchema.safeParse(base).success).toBe(true)
  })

  it('paySalary: COMPANY_ACCOUNT forces an explorer link even when the stated currency is not USDT', () => {
    const base = { currency: 'UAH', receiptExternalUrl: PLAIN_LINK }
    const company = paySalarySchema.safeParse({ ...base, fundingSource: 'COMPANY_ACCOUNT' })
    expect(messages(company)).toEqual([
      'zod.COMPANY_ACCOUNT_USDT_ONLY',
      'zod.RECEIPT_USDT_LINK_REQUIRED',
    ])
    expect(
      paySalarySchema.safeParse({ ...base, fundingSource: 'ADMIN_PERSONAL', payerAdminId: UUID })
        .success,
    ).toBe(true)
  })
})

describe('paySalarySchema.paidAmount / txHash', () => {
  const base = {
    fundingSource: 'ADMIN_PERSONAL',
    currency: 'USD',
    receiptExternalUrl: PLAIN_LINK,
  }

  it('reports a non-storable paidAmount as a custom issue on the paidAmount path', () => {
    const r = paySalarySchema.safeParse({ ...base, paidAmount: 0 })
    expect(r.success).toBe(false)
    expect(r.error?.issues).toHaveLength(1)
    expect(r.error?.issues[0]).toMatchObject({
      code: 'custom',
      message: 'zod.AMOUNT_MUST_BE_POSITIVE',
      path: ['paidAmount'],
    })
  })

  it('accepts a storable paidAmount and an omitted one', () => {
    expect(paySalarySchema.safeParse({ ...base, paidAmount: 12.5 }).success).toBe(true)
    expect(paySalarySchema.safeParse(base).success).toBe(true)
  })

  it('caps txHash at 255 characters', () => {
    expect(maxLength(paySalarySchema.shape.txHash, 255)).toEqual([])
    expect(paySalarySchema.shape.txHash.safeParse(null).success).toBe(true)
  })
})

/**
 * SR-795-M-1 / owner decision D-3 — the read behind the create dialog's
 * "this month already has N parts" panel. These three schemas shipped with no
 * spec at all, which the mutation gate reported as survivors rather than as an
 * opinion: every bound below was mutable without a test noticing.
 *
 * Literals are hand-written, never derived from the schema under test.
 */
describe('salary-parts schemas (SR-795-M-1)', () => {
  const PART = {
    id: UUID,
    amount: 1500,
    currency: 'USD' as const,
    status: 'PENDING' as const,
    salaryOrigin: 'MANUAL' as const,
    txDate: '2026-09-30T00:00:00.000Z',
    notes: 'part 1',
  }

  describe('salaryPartsQuerySchema', () => {
    it('requires both a uuid receiver and a well-formed month', () => {
      expect(salaryPartsQuerySchema.safeParse({ receiverId: UUID, month: '2026-09' }).success).toBe(
        true,
      )
      expect(salaryPartsQuerySchema.safeParse({ month: '2026-09' }).success).toBe(false)
      expect(salaryPartsQuerySchema.safeParse({ receiverId: UUID }).success).toBe(false)
    })

    it('rejects a receiver that is not a uuid', () => {
      expect(
        salaryPartsQuerySchema.safeParse({ receiverId: 'recv-1', month: '2026-09' }).success,
      ).toBe(false)
    })

    it('rejects an impossible month — the server would otherwise read a month nothing writes', () => {
      for (const month of ['2026-13', '2026-00', '2026-9', '202609', '2026-09-01', '']) {
        expect(salaryPartsQuerySchema.safeParse({ receiverId: UUID, month }).success).toBe(false)
      }
      for (const month of ['2026-01', '2026-12']) {
        expect(salaryPartsQuerySchema.safeParse({ receiverId: UUID, month }).success).toBe(true)
      }
    })

    it('says WHICH month shape it wanted — the message is what a 400 carries', () => {
      const r = salaryPartsQuerySchema.safeParse({ receiverId: UUID, month: '2026-13' })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.message).toBe('month must be YYYY-MM')
    })
  })

  describe('salaryPartSchema', () => {
    it('accepts the shape the endpoint actually returns', () => {
      expect(salaryPartSchema.safeParse(PART).success).toBe(true)
    })

    it('allows a legacy NULL origin but no value outside the union', () => {
      expect(salaryPartSchema.safeParse({ ...PART, salaryOrigin: null }).success).toBe(true)
      expect(salaryPartSchema.safeParse({ ...PART, salaryOrigin: 'CRON' }).success).toBe(true)
      expect(salaryPartSchema.safeParse({ ...PART, salaryOrigin: 'ADJUSTED' }).success).toBe(true)
      expect(salaryPartSchema.safeParse({ ...PART, salaryOrigin: 'Manual' }).success).toBe(false)
      expect(salaryPartSchema.safeParse({ ...PART, salaryOrigin: 'LEGACY' }).success).toBe(false)
    })

    it('admits only the three states an operator weighs a new part against', () => {
      for (const status of ['PENDING', 'PAID', 'LOCKED']) {
        expect(salaryPartSchema.safeParse({ ...PART, status }).success).toBe(true)
      }
      // A cancelled or rejected row is not an obligation; the service filters
      // them out, and the DTO refuses them if one ever slipped through.
      for (const status of ['CANCELLED', 'REJECTED', 'VALIDATED', 'pending']) {
        expect(salaryPartSchema.safeParse({ ...PART, status }).success).toBe(false)
      }
    })

    it('admits every currency a salary can be nominated in, and nothing else', () => {
      // Written out one by one: a single 'USD' case leaves the other three
      // literals free to change into anything, and a salary part really can be
      // in EUR or UAH (the panel showed 1 234,5 EUR on a real stack).
      for (const currency of CURRENCIES) {
        expect(salaryPartSchema.safeParse({ ...PART, currency }).success).toBe(true)
      }
      for (const currency of ['GBP', 'usd', '', 'BTC']) {
        expect(salaryPartSchema.safeParse({ ...PART, currency }).success).toBe(false)
      }
    })

    it('keeps amount a number and txDate an ISO datetime or null', () => {
      expect(salaryPartSchema.safeParse({ ...PART, amount: '1500' }).success).toBe(false)
      expect(salaryPartSchema.safeParse({ ...PART, txDate: null }).success).toBe(true)
      expect(salaryPartSchema.safeParse({ ...PART, txDate: '2026-09-30' }).success).toBe(false)
    })

    it('requires an id that is a uuid, and notes that may be null', () => {
      expect(salaryPartSchema.safeParse({ ...PART, id: 'tx-1' }).success).toBe(false)
      expect(salaryPartSchema.safeParse({ ...PART, notes: null }).success).toBe(true)
    })
  })

  describe('salaryPartsResponseSchema', () => {
    it('carries the receiver and month back, with the parts list', () => {
      const parsed = salaryPartsResponseSchema.parse({
        receiverId: UUID,
        month: '2026-09',
        parts: [PART],
      })
      expect(parsed.parts).toHaveLength(1)
      expect(parsed.parts[0]?.amount).toBe(1500)
      expect(parsed.receiverId).toBe(UUID)
      expect(parsed.month).toBe('2026-09')
    })

    it('accepts an empty list — a month with no parts is the normal case', () => {
      expect(
        salaryPartsResponseSchema.safeParse({ receiverId: UUID, month: '2026-09', parts: [] })
          .success,
      ).toBe(true)
    })

    it('refuses a malformed month and a malformed part on the way out, not only in', () => {
      const badMonth = salaryPartsResponseSchema.safeParse({
        receiverId: UUID,
        month: '2026-13',
        parts: [],
      })
      expect(badMonth.success).toBe(false)
      expect(badMonth.error?.issues[0]?.message).toBe("Expected 'YYYY-MM' format")
      expect(
        salaryPartsResponseSchema.safeParse({
          receiverId: UUID,
          month: '2026-09',
          parts: [{ ...PART, status: 'CANCELLED' }],
        }).success,
      ).toBe(false)
    })
  })
})
