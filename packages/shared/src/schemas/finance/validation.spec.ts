/**
 * validation.spec.ts — pins for the pure validation helpers that live in
 * `./validation` (split out of the old single-file `schemas/finance.ts`).
 *
 * Every expected value below is a hand-written literal taken from the contract
 * the helper documents (the https-only receipt rule, the explorer allowlist,
 * the `zod.<CODE>` keys) — never recomputed with the helper's own logic.
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  extractOnChainTxHash,
  isExplorerUrl,
  mandatoryReceiptRefine,
  receiptFields,
  receiptXorMessage,
  refineAdminIncomeCompanyAccountUsdt,
  refineCompanyAccountUsdt,
  salaryPaidAmountDeviation,
} from './validation'

type Issue = { code?: string; message?: string; path?: unknown }

function collect(): { ctx: z.RefinementCtx; issues: Issue[] } {
  const issues: Issue[] = []
  const ctx = { addIssue: (i: Issue) => void issues.push(i) } as unknown as z.RefinementCtx
  return { ctx, issues }
}

const UUID = 'a0000000-0000-4000-8000-000000000001'
const HASH = `0x${'ab12'.repeat(16)}`

describe('receiptFields.receiptExternalUrl — https-only write-side rule', () => {
  const field = receiptFields.receiptExternalUrl

  it('accepts an https link, any scheme casing, null and undefined', () => {
    expect(field.safeParse('https://example.com/r/1').success).toBe(true)
    expect(field.safeParse('HTTPS://example.com/r/1').success).toBe(true)
    expect(field.safeParse(null).success).toBe(true)
    expect(field.safeParse(undefined).success).toBe(true)
  })

  it('rejects an http link with the exact message', () => {
    const r = field.safeParse('http://example.com/r/1')
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.message).toBe('Receipt URL must use https scheme')
  })

  it('rejects an http link that merely CONTAINS an https url later (the scheme must be at the start)', () => {
    expect(field.safeParse('http://example.com/?next=https://evil.example/').success).toBe(false)
  })
})

describe('receiptXorMessage', () => {
  it('is the exact message + path the XOR refine reports', () => {
    expect(receiptXorMessage).toEqual({
      message: 'Receipt must be either a document upload OR an external URL — not both',
      path: ['receiptExternalUrl'],
    })
  })
})

describe('isExplorerUrl — authority parsing', () => {
  it('accepts a bare userinfo prefix, user:pass userinfo and an explicit port on an allowlisted host', () => {
    expect(isExplorerUrl('https://@etherscan.io/tx/1')).toBe(true)
    expect(isExplorerUrl('https://user@etherscan.io/tx/1')).toBe(true)
    expect(isExplorerUrl('https://user:pw@etherscan.io/tx/1')).toBe(true)
    expect(isExplorerUrl('https://etherscan.io:443/tx/1')).toBe(true)
    expect(isExplorerUrl('https://user@etherscan.io:443/tx/1')).toBe(true)
  })

  it('accepts a query-only or fragment-only remainder (something after the host)', () => {
    expect(isExplorerUrl('https://etherscan.io?tx=1')).toBe(true)
    expect(isExplorerUrl('https://etherscan.io#tx')).toBe(true)
  })

  it('strips ONLY a leading www. — a www. in the middle of the host is a different host', () => {
    expect(isExplorerUrl('https://www.etherscan.io/tx/1')).toBe(true)
    expect(isExplorerUrl('https://etherscan.www.io/tx/1')).toBe(false)
    expect(isExplorerUrl('https://www.www.etherscan.io/tx/1')).toBe(false)
  })

  it('requires the string to START with https:// and to be a single line', () => {
    expect(isExplorerUrl('xhttps://etherscan.io/tx/1')).toBe(false)
    expect(isExplorerUrl(' https://etherscan.io/tx/1')).toBe(false)
    expect(isExplorerUrl('https://etherscan.io/tx/1\nanother line')).toBe(false)
  })

  it('rejects a userinfo that names an allowlisted host but really points elsewhere', () => {
    expect(isExplorerUrl('https://etherscan.io@evil.example/tx/1')).toBe(false)
    expect(isExplorerUrl('https://evil.example:80@evil.example/tx/1')).toBe(false)
  })
})

describe('mandatoryReceiptRefine — issue shape', () => {
  const refine = mandatoryReceiptRefine(
    (d: { receiptExternalUrl?: string; receiptDocumentId?: string; cur?: string }) => d.cur,
  )

  it('reports a missing receipt as a custom issue on receiptExternalUrl', () => {
    const { ctx, issues } = collect()
    refine({ cur: 'USD' }, ctx)
    expect(issues).toEqual([
      { code: 'custom', message: 'zod.RECEIPT_REQUIRED', path: ['receiptExternalUrl'] },
    ])
  })

  it('reports a forbidden file on a USDT row on the receiptDocumentId path', () => {
    const { ctx, issues } = collect()
    refine({ receiptDocumentId: UUID, cur: 'USDT' }, ctx)
    expect(issues).toEqual([
      { code: 'custom', message: 'zod.RECEIPT_USDT_LINK_ONLY', path: ['receiptDocumentId'] },
    ])
  })

  it('reports both-present on the receiptDocumentId path (the doc id is checked first)', () => {
    const { ctx, issues } = collect()
    refine({ receiptDocumentId: UUID, receiptExternalUrl: 'https://e.example/x', cur: 'USD' }, ctx)
    expect(issues).toEqual([
      { code: 'custom', message: 'zod.RECEIPT_BOTH_NOT_ALLOWED', path: ['receiptDocumentId'] },
    ])
  })

  it('adds nothing when the receipt is valid for the effective currency', () => {
    const { ctx, issues } = collect()
    refine({ receiptExternalUrl: 'https://etherscan.io/tx/1', cur: 'USDT' }, ctx)
    refine({ receiptDocumentId: UUID, cur: 'USD' }, ctx)
    expect(issues).toEqual([])
  })
})

describe('refineCompanyAccountUsdt — COMPANY_ACCOUNT is USDT-only', () => {
  const expected = [
    { code: 'custom', message: 'zod.COMPANY_ACCOUNT_USDT_ONLY', path: ['currency'] },
  ]

  it('flags an explicit non-USDT currency', () => {
    const { ctx, issues } = collect()
    refineCompanyAccountUsdt({ fundingSource: 'COMPANY_ACCOUNT', currency: 'UAH' }, ctx)
    expect(issues).toEqual(expected)
  })

  it('does NOT flag an omitted currency, USDT, another funding source or no funding source', () => {
    const { ctx, issues } = collect()
    refineCompanyAccountUsdt({ fundingSource: 'COMPANY_ACCOUNT' }, ctx)
    refineCompanyAccountUsdt({ fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ctx)
    refineCompanyAccountUsdt({ fundingSource: 'ADMIN_PERSONAL', currency: 'UAH' }, ctx)
    refineCompanyAccountUsdt({ currency: 'UAH' }, ctx)
    expect(issues).toEqual([])
  })
})

describe('refineAdminIncomeCompanyAccountUsdt — company receiver is USDT-only', () => {
  it('flags an explicit non-USDT currency for the COMPANY_ACCOUNT receiver', () => {
    const { ctx, issues } = collect()
    refineAdminIncomeCompanyAccountUsdt({ receiverId: 'COMPANY_ACCOUNT', currency: 'EUR' }, ctx)
    expect(issues).toEqual([
      { code: 'custom', message: 'zod.COMPANY_ACCOUNT_USDT_ONLY', path: ['currency'] },
    ])
  })

  it('does NOT flag USDT, or any currency for a personal receiver', () => {
    const { ctx, issues } = collect()
    refineAdminIncomeCompanyAccountUsdt({ receiverId: 'COMPANY_ACCOUNT', currency: 'USDT' }, ctx)
    refineAdminIncomeCompanyAccountUsdt({ receiverId: UUID, currency: 'EUR' }, ctx)
    expect(issues).toEqual([])
  })
})

describe('extractOnChainTxHash', () => {
  it('lowercases a hash and finds it inside an explorer link', () => {
    expect(extractOnChainTxHash(HASH.toUpperCase().replace('0X', '0x'))).toBe(HASH)
    expect(extractOnChainTxHash(`https://etherscan.io/tx/${HASH}`)).toBe(HASH)
  })

  it('returns null for null, undefined, empty and non-hash input', () => {
    expect(extractOnChainTxHash(null)).toBeNull()
    expect(extractOnChainTxHash(undefined)).toBeNull()
    expect(extractOnChainTxHash('')).toBeNull()
    expect(extractOnChainTxHash('0xSIM1234')).toBeNull()
  })
})

describe('salaryPaidAmountDeviation — non-finite inputs are "not comparable"', () => {
  it('returns null when EITHER side is infinite or NaN, even with a finite counterpart', () => {
    expect(salaryPaidAmountDeviation(Infinity, 100)).toBeNull()
    expect(salaryPaidAmountDeviation(100, Infinity)).toBeNull()
    expect(salaryPaidAmountDeviation(NaN, 100)).toBeNull()
    expect(salaryPaidAmountDeviation(100, NaN)).toBeNull()
    expect(salaryPaidAmountDeviation(Infinity, Infinity)).toBeNull()
  })

  it('still reports a finite deviation above the threshold', () => {
    expect(salaryPaidAmountDeviation(300, 30000)).toBeCloseTo(0.99, 10)
  })
})
