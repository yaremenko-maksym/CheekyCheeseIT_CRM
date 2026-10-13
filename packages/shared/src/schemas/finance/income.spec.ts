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
      for (const bad of [
        'x2026-07',
        '2026-07x',
        '2026-7',
        '202-07',
        '20266-07',
        'abcd-07',
        '2026-ab',
        '2026-0',
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
