/**
 * finance.receipts.spec.ts — unit tests for the mandatory-receipt feature
 * (task-receipts-backend): the blockchain-explorer allowlist + isExplorerUrl,
 * the shared receiptMandatoryError rule, and the currency-aware mandatory
 * refine applied to the create/pay schemas + the attach/replace body schema.
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCKCHAIN_EXPLORER_HOSTS,
  isExplorerUrl,
  receiptMandatoryError,
  attachReceiptSchema,
  createSeniorIncomeSchema,
  createUsdtIncomeSchema,
  createAdminTransferSchema,
  createDividendSchema,
  paySalarySchema,
  settleSeniorPayoutSchema,
} from './finance'

const UUID = 'a0000000-0000-4000-8000-000000000001'
const UUID2 = 'a0000000-0000-4000-8000-000000000002'
const EXPLORER_URL = 'https://etherscan.io/tx/0xabc123def456'

// ── isExplorerUrl + allowlist ────────────────────────────────────────────────

describe('BLOCKCHAIN_EXPLORER_HOSTS + isExplorerUrl', () => {
  it('accepts a tx link on every allowlisted host', () => {
    for (const host of BLOCKCHAIN_EXPLORER_HOSTS) {
      expect(isExplorerUrl(`https://${host}/tx/0xabc123`)).toBe(true)
    }
  })

  it('accepts a www. prefixed explorer host', () => {
    expect(isExplorerUrl('https://www.etherscan.io/tx/0xabc123')).toBe(true)
  })

  it('is case-insensitive on the host', () => {
    expect(isExplorerUrl('https://Etherscan.IO/tx/0xabc123')).toBe(true)
  })

  it('accepts a hash-routed explorer link (tronscan keeps the tx id in the fragment)', () => {
    expect(isExplorerUrl('https://tronscan.org/#/transaction/abc123def')).toBe(true)
  })

  it('rejects an unknown / random domain', () => {
    expect(isExplorerUrl('https://evil.com/tx/0xabc123')).toBe(false)
  })

  it('rejects a look-alike subdomain attack (etherscan.io.evil.com)', () => {
    expect(isExplorerUrl('https://etherscan.io.evil.com/tx/0xabc123')).toBe(false)
  })

  // LOW (review round 1, security-reviewer): userinfo look-alike — the browser
  // treats everything before the LAST '@' as userinfo and 'evil.com' as the
  // REAL host; a naive substring/prefix check on the url could be fooled into
  // thinking 'etherscan.io' is the host. isExplorerUrl strips the userinfo
  // segment before the allowlist check, so this must resolve to the real host
  // (evil.com, not allowlisted) and be rejected.
  it('rejects a userinfo look-alike (https://etherscan.io@evil.com/...)', () => {
    expect(isExplorerUrl('https://etherscan.io@evil.com/tx/0xabc123')).toBe(false)
  })

  it('rejects a userinfo-with-password look-alike (https://etherscan.io:x@evil.com/...)', () => {
    expect(isExplorerUrl('https://etherscan.io:x@evil.com/tx/0xabc123')).toBe(false)
  })

  it('rejects an http (non-https) explorer link', () => {
    expect(isExplorerUrl('http://etherscan.io/tx/0xabc123')).toBe(false)
  })

  it('rejects javascript: scheme', () => {
    expect(isExplorerUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects data: URI', () => {
    expect(isExplorerUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('rejects a bare explorer host with no path', () => {
    expect(isExplorerUrl('https://etherscan.io')).toBe(false)
    expect(isExplorerUrl('https://etherscan.io/')).toBe(false)
  })

  it('rejects a non-url string', () => {
    expect(isExplorerUrl('not-a-url')).toBe(false)
  })
})

// ── receiptMandatoryError (shared pure rule) ─────────────────────────────────

describe('receiptMandatoryError', () => {
  it('errors when neither doc nor url present (mandatory)', () => {
    expect(receiptMandatoryError({}, 'USD')).toBeTruthy()
    expect(
      receiptMandatoryError({ receiptDocumentId: null, receiptExternalUrl: null }, 'USD'),
    ).toBeTruthy()
  })

  it('errors when both present (XOR)', () => {
    expect(
      receiptMandatoryError({ receiptDocumentId: UUID, receiptExternalUrl: EXPLORER_URL }, 'USD'),
    ).toBeTruthy()
  })

  it('USDT + file → error (explorer-only)', () => {
    expect(receiptMandatoryError({ receiptDocumentId: UUID }, 'USDT')).toBeTruthy()
  })

  it('USDT + explorer url → ok', () => {
    expect(receiptMandatoryError({ receiptExternalUrl: EXPLORER_URL }, 'USDT')).toBeNull()
  })

  it('USDT + non-explorer url → error', () => {
    expect(receiptMandatoryError({ receiptExternalUrl: 'https://evil.com/x' }, 'USDT')).toBeTruthy()
  })

  it('non-USDT + file → ok', () => {
    expect(receiptMandatoryError({ receiptDocumentId: UUID }, 'USD')).toBeNull()
  })

  it('non-USDT + any http(s) url → ok', () => {
    expect(
      receiptMandatoryError({ receiptExternalUrl: 'https://drive.google.com/f/1' }, 'UAH'),
    ).toBeNull()
  })
})

// ── currency-aware mandatory refine on the create schemas ────────────────────

describe('createSeniorIncomeSchema — mandatory + currency-aware', () => {
  const base = { projectId: UUID, amount: 100 }

  it('rejects when receipt is missing (mandatory on server)', () => {
    expect(createSeniorIncomeSchema.safeParse({ ...base, currency: 'USD' }).success).toBe(false)
  })

  it('non-USDT accepts a file receipt', () => {
    expect(
      createSeniorIncomeSchema.safeParse({ ...base, currency: 'USD', receiptDocumentId: UUID2 })
        .success,
    ).toBe(true)
  })

  it('non-USDT accepts any http(s) url', () => {
    expect(
      createSeniorIncomeSchema.safeParse({
        ...base,
        currency: 'UAH',
        receiptExternalUrl: 'https://drive.google.com/f/1',
      }).success,
    ).toBe(true)
  })

  it('USDT rejects a file receipt', () => {
    expect(
      createSeniorIncomeSchema.safeParse({ ...base, currency: 'USDT', receiptDocumentId: UUID2 })
        .success,
    ).toBe(false)
  })

  it('USDT rejects a non-explorer url', () => {
    expect(
      createSeniorIncomeSchema.safeParse({
        ...base,
        currency: 'USDT',
        receiptExternalUrl: 'https://drive.google.com/f/1',
      }).success,
    ).toBe(false)
  })

  it('USDT accepts an explorer url', () => {
    expect(
      createSeniorIncomeSchema.safeParse({
        ...base,
        currency: 'USDT',
        receiptExternalUrl: EXPLORER_URL,
      }).success,
    ).toBe(true)
  })

  it('rejects when both doc and url are present (XOR)', () => {
    expect(
      createSeniorIncomeSchema.safeParse({
        ...base,
        currency: 'USD',
        receiptDocumentId: UUID2,
        receiptExternalUrl: 'https://drive.google.com/f/1',
      }).success,
    ).toBe(false)
  })
})

describe('createUsdtIncomeSchema — explorer-only mandatory receipt', () => {
  const base = {
    projectId: UUID,
    amount: 100,
    currency: 'USDT',
    receiverId: UUID2,
    idempotencyKey: UUID,
  }

  it('rejects without a receipt', () => {
    expect(createUsdtIncomeSchema.safeParse(base).success).toBe(false)
  })

  it('rejects a file receipt (explorer-only)', () => {
    expect(createUsdtIncomeSchema.safeParse({ ...base, receiptDocumentId: UUID2 }).success).toBe(
      false,
    )
  })

  it('accepts an explorer url', () => {
    expect(
      createUsdtIncomeSchema.safeParse({ ...base, receiptExternalUrl: EXPLORER_URL }).success,
    ).toBe(true)
  })
})

describe('createDividendSchema — explorer-only mandatory receipt', () => {
  const base = { amount: 100, idempotencyKey: UUID }

  it('rejects without a receipt', () => {
    expect(createDividendSchema.safeParse(base).success).toBe(false)
  })

  it('rejects a file receipt', () => {
    expect(createDividendSchema.safeParse({ ...base, receiptDocumentId: UUID2 }).success).toBe(
      false,
    )
  })

  it('accepts an explorer url', () => {
    expect(
      createDividendSchema.safeParse({ ...base, receiptExternalUrl: EXPLORER_URL }).success,
    ).toBe(true)
  })
})

describe('createAdminTransferSchema — mandatory, default USDT → explorer-only', () => {
  const base = { receiverId: UUID2, amount: 100 }

  it('rejects without a receipt', () => {
    expect(createAdminTransferSchema.safeParse(base).success).toBe(false)
  })

  it('default currency USDT rejects a file receipt', () => {
    expect(createAdminTransferSchema.safeParse({ ...base, receiptDocumentId: UUID }).success).toBe(
      false,
    )
  })

  it('default currency USDT accepts an explorer url', () => {
    expect(
      createAdminTransferSchema.safeParse({ ...base, receiptExternalUrl: EXPLORER_URL }).success,
    ).toBe(true)
  })

  it('explicit UAH currency accepts a file receipt', () => {
    expect(
      createAdminTransferSchema.safeParse({ ...base, currency: 'UAH', receiptDocumentId: UUID })
        .success,
    ).toBe(true)
  })
})

describe('paySalarySchema — effective currency (COMPANY_ACCOUNT → USDT)', () => {
  it('COMPANY_ACCOUNT rejects a file receipt (USDT → explorer-only)', () => {
    expect(
      paySalarySchema.safeParse({
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        receiptDocumentId: UUID,
      }).success,
    ).toBe(false)
  })

  it('COMPANY_ACCOUNT accepts an explorer url', () => {
    expect(
      paySalarySchema.safeParse({
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        receiptExternalUrl: EXPLORER_URL,
      }).success,
    ).toBe(true)
  })

  it('ADMIN_PERSONAL UAH accepts a file receipt', () => {
    expect(
      paySalarySchema.safeParse({
        fundingSource: 'ADMIN_PERSONAL',
        currency: 'UAH',
        receiptDocumentId: UUID,
      }).success,
    ).toBe(true)
  })

  it('rejects when receipt missing', () => {
    expect(
      paySalarySchema.safeParse({ fundingSource: 'ADMIN_PERSONAL', currency: 'UAH' }).success,
    ).toBe(false)
  })
})

describe('settleSeniorPayoutSchema — effective currency (COMPANY_ACCOUNT → USDT)', () => {
  it('COMPANY_ACCOUNT rejects a file receipt', () => {
    expect(
      settleSeniorPayoutSchema.safeParse({
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        receiptDocumentId: UUID,
      }).success,
    ).toBe(false)
  })

  it('COMPANY_ACCOUNT accepts an explorer url', () => {
    expect(
      settleSeniorPayoutSchema.safeParse({
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        receiptExternalUrl: EXPLORER_URL,
      }).success,
    ).toBe(true)
  })

  it('ADMIN_PERSONAL USD accepts a file receipt', () => {
    expect(
      settleSeniorPayoutSchema.safeParse({
        fundingSource: 'ADMIN_PERSONAL',
        currency: 'USD',
        receiptDocumentId: UUID,
      }).success,
    ).toBe(true)
  })
})

// ── attachReceiptSchema (attach/replace body) ────────────────────────────────

describe('attachReceiptSchema', () => {
  it('accepts a document id', () => {
    expect(attachReceiptSchema.safeParse({ receiptDocumentId: UUID }).success).toBe(true)
  })

  it('accepts an external url', () => {
    expect(attachReceiptSchema.safeParse({ receiptExternalUrl: EXPLORER_URL }).success).toBe(true)
  })

  it('rejects an empty body (mandatory)', () => {
    expect(attachReceiptSchema.safeParse({}).success).toBe(false)
  })

  it('rejects both doc and url (XOR)', () => {
    expect(
      attachReceiptSchema.safeParse({ receiptDocumentId: UUID, receiptExternalUrl: EXPLORER_URL })
        .success,
    ).toBe(false)
  })
})
