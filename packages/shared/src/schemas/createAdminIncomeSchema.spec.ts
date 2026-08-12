/**
 * task-admin-income-unified (2026-08-12) — unit pins for `createAdminIncomeSchema`
 * and its two `.superRefine` rules (`refineAdminIncomeCompanyAccountUsdt`,
 * the receipt-mandatory currency resolver). This schema had NO dedicated
 * test file before this task — every check it enforces was only exercised
 * indirectly through the API/UI layers, which is exactly why the mutation
 * gate found real gaps here on the first unscoped (`@crm/shared`-inclusive)
 * run.
 */
import { describe, expect, it } from 'vitest'
import { COMPANY_ACCOUNT_RECEIVER, createAdminIncomeSchema } from './finance'

const OTHER_ADMIN_UUID = '11111111-1111-4111-8111-111111111111'
const PROJECT_UUID = '22222222-2222-4222-8222-222222222222'

function basePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    projectId: PROJECT_UUID,
    amount: 500,
    currency: 'USD',
    receiptExternalUrl: 'https://example.com/receipt.pdf',
    ...overrides,
  }
}

describe('COMPANY_ACCOUNT_RECEIVER', () => {
  it('is the exact sentinel string the server and the web dialog both match on', () => {
    expect(COMPANY_ACCOUNT_RECEIVER).toBe('COMPANY_ACCOUNT')
  })
})

describe('createAdminIncomeSchema — refineAdminIncomeCompanyAccountUsdt', () => {
  it('rejects receiverId=COMPANY_ACCOUNT with a non-USDT currency, issue on the currency path', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({ receiverId: COMPANY_ACCOUNT_RECEIVER, currency: 'USD' }),
    )
    expect(result.success).toBe(false)
    const issue = !result.success
      ? result.error.issues.find((i) => i.message.includes('счёта компании'))
      : undefined
    expect(issue).toBeDefined()
    expect(issue?.path).toEqual(['currency'])
    expect(issue?.code).toBe('custom')
  })

  it('receiverId=COMPANY_ACCOUNT with currency OMITTED entirely does NOT also raise the contradiction issue — the guard reads currency only when it is present, avoiding a confusing double-error alongside the base "required" error', () => {
    const { currency: _currency, ...withoutCurrency } = basePayload({
      receiverId: COMPANY_ACCOUNT_RECEIVER,
    })
    const result = createAdminIncomeSchema.safeParse(withoutCurrency)
    expect(result.success).toBe(false)
    const contradictionIssue = !result.success
      ? result.error.issues.find((i) => i.message.includes('счёта компании'))
      : undefined
    expect(contradictionIssue).toBeUndefined()
  })

  it('accepts receiverId=COMPANY_ACCOUNT with currency=USDT (no contradiction)', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({
        receiverId: COMPANY_ACCOUNT_RECEIVER,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc',
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts a non-COMPANY_ACCOUNT receiverId with any currency — the contradiction check never fires', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({ receiverId: OTHER_ADMIN_UUID, currency: 'USD' }),
    )
    expect(result.success).toBe(true)
  })
})

describe('createAdminIncomeSchema — receipt currency resolver (COMPANY_ACCOUNT → USDT, else d.currency)', () => {
  it('receiverId=COMPANY_ACCOUNT forces the EFFECTIVE currency to USDT for the receipt check — a non-explorer link is rejected even though the raw `currency` field says USDT', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({
        receiverId: COMPANY_ACCOUNT_RECEIVER,
        currency: 'USDT',
        receiptExternalUrl: 'https://example.com/not-an-explorer-link',
      }),
    )
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toMatch(/blockchain-explorer/)
  })

  it('receiverId=a specific admin resolves the EFFECTIVE currency to `data.currency` (USD here) — a plain https link is accepted, explorer-only does NOT apply', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({
        receiverId: OTHER_ADMIN_UUID,
        currency: 'USD',
        receiptExternalUrl: 'https://example.com/plain-receipt.pdf',
      }),
    )
    expect(result.success).toBe(true)
  })

  it('receiverId=undefined (legacy default) ALSO resolves to `data.currency` — same non-COMPANY_ACCOUNT branch', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({ currency: 'USD', receiptExternalUrl: 'https://example.com/plain-receipt.pdf' }),
    )
    expect(result.success).toBe(true)
  })

  it('the effective currency is selected by receiverId, NOT by data.currency — with a (separately rejected) contradictory currency, the receipt gate still demands an explorer link, proving it never falls through to `d.currency`', () => {
    const result = createAdminIncomeSchema.safeParse(
      basePayload({
        receiverId: COMPANY_ACCOUNT_RECEIVER,
        currency: 'USD',
        receiptExternalUrl: 'https://example.com/plain-receipt.pdf',
      }),
    )
    expect(result.success).toBe(false)
    const receiptIssue = !result.success
      ? result.error.issues.find((i) => i.message.match(/blockchain-explorer/))
      : undefined
    expect(receiptIssue).toBeDefined()
  })
})
