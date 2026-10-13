/**
 * payout.spec.ts — bounds + conditional-requirement pins for the payout-side
 * write schemas in `./payout`. Hand-written literals only.
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  confirmPayoutSchema,
  createPayoutRequestSchema,
  manualConfirmPayoutSchema,
  payPayoutRequestSchema,
  settleSeniorPayoutSchema,
  updateProjectFinanceSettingsSchema,
} from './payout'

const UUID = 'a0000000-0000-4000-8000-000000000001'
const UUID2 = 'a0000000-0000-4000-8000-000000000002'
const HASH = `0x${'ab12'.repeat(16)}`
const PLAIN_LINK = 'https://example.com/receipt/1'

function issues(r: {
  error?: z.ZodError
}): Array<{ code: string; message: string; path: unknown }> {
  return (r.error?.issues ?? []).map((i) => ({ code: i.code, message: i.message, path: i.path }))
}

const MIN_LENGTH_ISSUE = [{ code: 'custom', message: 'zod.TX_HASH_MIN_LENGTH', path: ['txHash'] }]

describe('createPayoutRequestSchema.transactionIds', () => {
  it('needs at least one id and allows several', () => {
    expect(createPayoutRequestSchema.safeParse({ transactionIds: [] }).success).toBe(false)
    expect(createPayoutRequestSchema.safeParse({ transactionIds: [UUID] }).success).toBe(true)
    expect(createPayoutRequestSchema.safeParse({ transactionIds: [UUID, UUID2] }).success).toBe(
      true,
    )
  })
})

describe('payPayoutRequestSchema — txHash is required unless simulating', () => {
  const parse = (v: unknown) => payPayoutRequestSchema.safeParse(v)

  it('an omitted txHash is an issue on the txHash path', () => {
    expect(issues(parse({}))).toEqual(MIN_LENGTH_ISSUE)
  })

  it('the length check is on the TRIMMED value and the minimum is exactly 10', () => {
    expect(issues(parse({ txHash: '123456789' }))).toEqual(MIN_LENGTH_ISSUE)
    expect(parse({ txHash: '1234567890' }).success).toBe(true)
    expect(issues(parse({ txHash: '   0x12   ' }))).toEqual(MIN_LENGTH_ISSUE)
  })

  it('a simulateResult waives the txHash requirement', () => {
    expect(parse({ simulateResult: 'success' }).success).toBe(true)
    expect(parse({ simulateResult: 'error' }).success).toBe(true)
    expect(parse({ simulateResult: 'maybe' }).success).toBe(false)
  })

  it('caps txHash at 255 characters', () => {
    expect(parse({ txHash: 'x'.repeat(255) }).success).toBe(true)
    expect(parse({ txHash: 'x'.repeat(256) }).success).toBe(false)
  })
})

describe('manualConfirmPayoutSchema', () => {
  const parse = (v: unknown) => manualConfirmPayoutSchema.safeParse(v)

  it('txHash may be absent, null, empty or a real hash — and nothing else', () => {
    expect(parse({ method: 'CASH' }).success).toBe(true)
    expect(parse({ method: 'CASH', txHash: null }).success).toBe(true)
    expect(parse({ method: 'CASH', txHash: undefined }).success).toBe(true)
    expect(parse({ method: 'CASH', txHash: '' }).success).toBe(true)
    expect(parse({ method: 'COMPANY_ACCOUNT', txHash: HASH }).success).toBe(true)
    const bad = parse({ method: 'CASH', txHash: 'not-a-hash' })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toBe('zod.TX_HASH_FORMAT_OR_EMPTY')
  })

  it('caps note at 1000 characters', () => {
    expect(parse({ method: 'CASH', note: 'x'.repeat(1000) }).success).toBe(true)
    expect(parse({ method: 'CASH', note: 'x'.repeat(1001) }).success).toBe(false)
    expect(parse({ method: 'CASH', note: null }).success).toBe(true)
  })
})

describe('updateProjectFinanceSettingsSchema.seniorSharePercentOverride', () => {
  it('is an int 0..100, nullable and optional', () => {
    const parse = (v: unknown) =>
      updateProjectFinanceSettingsSchema.safeParse({ seniorSharePercentOverride: v }).success
    for (const ok of [0, 1, 50, 99, 100, null, undefined]) expect(parse(ok)).toBe(true)
    for (const bad of [-1, 101, 0.5]) expect(parse(bad)).toBe(false)
  })
})

describe('confirmPayoutSchema', () => {
  const parse = (v: unknown) => confirmPayoutSchema.safeParse(v)
  const lax = '00000000-0000-0000-0000-000000000001'

  it('defaults the method to CRYPTO, which then requires a txHash of at least 10 characters', () => {
    expect(issues(parse({ recipientAdminId: lax }))).toEqual(MIN_LENGTH_ISSUE)
    expect(parse({ recipientAdminId: lax, txHash: '1234567890' }).data?.method).toBe('CRYPTO')
    expect(issues(parse({ recipientAdminId: lax, method: 'CRYPTO', txHash: '123456789' }))).toEqual(
      MIN_LENGTH_ISSUE,
    )
  })

  it('CRYPTO measures the TRIMMED txHash', () => {
    expect(
      issues(parse({ recipientAdminId: lax, method: 'CRYPTO', txHash: '   0x12   ' })),
    ).toEqual(MIN_LENGTH_ISSUE)
  })

  it('CASH needs no txHash', () => {
    const r = parse({ recipientAdminId: lax, method: 'CASH' })
    expect(r.success).toBe(true)
    expect(r.data?.method).toBe('CASH')
  })

  it('recipientAdminId is a UUID-shaped string with the exact message, and txHash is capped at 255', () => {
    for (const bad of ['x' + lax, lax + 'x', 'nope']) {
      const r = parse({ recipientAdminId: bad, method: 'CASH' })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.message).toBe('Invalid UUID')
    }
    expect(parse({ recipientAdminId: lax, method: 'CASH', txHash: 'x'.repeat(255) }).success).toBe(
      true,
    )
    expect(parse({ recipientAdminId: lax, method: 'CASH', txHash: 'x'.repeat(256) }).success).toBe(
      false,
    )
  })
})

describe('settleSeniorPayoutSchema', () => {
  const parse = (v: unknown) => settleSeniorPayoutSchema.safeParse(v)

  it('every stated currency is accepted, anything else is not', () => {
    for (const currency of ['USDT', 'USD', 'EUR', 'UAH']) {
      expect(
        parse({
          fundingSource: 'ADMIN_PERSONAL',
          currency,
          receiptExternalUrl: currency === 'USDT' ? 'https://etherscan.io/tx/0xabc' : PLAIN_LINK,
        }).success,
      ).toBe(true)
    }
    expect(
      parse({ fundingSource: 'ADMIN_PERSONAL', currency: 'GBP', receiptExternalUrl: PLAIN_LINK })
        .success,
    ).toBe(false)
  })

  it('COMPANY_ACCOUNT forces an explorer link even when the stated currency is not USDT', () => {
    const r = parse({
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'UAH',
      receiptExternalUrl: PLAIN_LINK,
    })
    expect(issues(r).map((i) => i.message)).toEqual([
      'zod.COMPANY_ACCOUNT_USDT_ONLY',
      'zod.RECEIPT_USDT_LINK_REQUIRED',
    ])
  })

  it('an omitted currency counts as USDT for the receipt rule, and is not flagged for COMPANY_ACCOUNT', () => {
    expect(
      issues(parse({ fundingSource: 'ADMIN_PERSONAL', receiptExternalUrl: PLAIN_LINK })).map(
        (i) => i.message,
      ),
    ).toEqual(['zod.RECEIPT_USDT_LINK_REQUIRED'])
    expect(
      parse({
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc',
      }).success,
    ).toBe(true)
  })

  it('rejects a txDate in the future and accepts a past one', () => {
    const base = {
      fundingSource: 'ADMIN_PERSONAL',
      currency: 'USD',
      receiptExternalUrl: PLAIN_LINK,
    }
    expect(issues(parse({ ...base, txDate: '2999-01-01' }))).toEqual([
      { code: 'custom', message: 'zod.DATE_NOT_IN_FUTURE', path: ['txDate'] },
    ])
    expect(parse({ ...base, txDate: '2020-01-01' }).success).toBe(true)
    expect(parse({ ...base, txDate: null }).success).toBe(true)
    expect(parse(base).success).toBe(true)
  })
})
