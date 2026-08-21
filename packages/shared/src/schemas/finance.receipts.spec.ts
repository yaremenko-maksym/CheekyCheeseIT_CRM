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
import { kyivToday } from '../utils/kyiv-day'

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
  // task-senior-drop-income-idempotency (backlog 73/A-3): idempotencyKey is
  // now a required field — present in `base` so every case below isolates
  // the receipt-refine behaviour under test.
  const base = { projectId: UUID, amount: 100, idempotencyKey: UUID }

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

  // task-remove-settle-currency / code-review PR #381 (MED — no schema-level
  // test for the `d.currency ?? 'USDT'` defaulting ternary): the settle dialog
  // no longer sends a `currency` field at all, so this ternary (inside the
  // mandatoryReceiptRefine call above) is what decides the EFFECTIVE currency
  // for receipt validation on every real omitted-currency settle. All prior
  // "no currency" coverage exercised the SERVICE (pending-settlement.spec.ts /
  // finance-bugs.unit.spec.ts AC2-e), never `.safeParse()` directly.
  it('ADMIN_PERSONAL with NO currency field defaults the effective currency to USDT (explorer-only) — rejects a file receipt', () => {
    expect(
      settleSeniorPayoutSchema.safeParse({
        fundingSource: 'ADMIN_PERSONAL',
        receiptDocumentId: UUID,
      }).success,
    ).toBe(false)
  })

  it('ADMIN_PERSONAL with NO currency field defaults the effective currency to USDT (explorer-only) — accepts an explorer url', () => {
    const result = settleSeniorPayoutSchema.safeParse({
      fundingSource: 'ADMIN_PERSONAL',
      receiptExternalUrl: EXPLORER_URL,
    })
    expect(result.success).toBe(true)
    // NOTE: the schema itself does NOT stamp a default onto the parsed output
    // — `currency` stays `undefined` here. The ternary above only drives the
    // receipt-validation refine; the ACTUAL currency default (→
    // obligation.currency, USDT in practice) is applied by the SERVICE at
    // settle time (pending-settlement.service.ts), which now also re-asserts
    // the BIZ-03 whitelist against that resolved value (security-review
    // PR #381, MED fix).
    expect(result.data?.currency).toBeUndefined()
  })
})

// task-drop-payout-currency (owner addendum, 2026-08): `txDate` — the
// operator-selected settle date. The schema enforces the ONE bound it can
// (no future dates, against server "today"); the LOWER bound (not before
// the obligation existed) needs the obligation row and is enforced in
// pending-settlement.service.ts (covered there).
describe('settleSeniorPayoutSchema — txDate (owner addendum, 2026-08)', () => {
  const base = { fundingSource: 'ADMIN_PERSONAL' as const, receiptExternalUrl: EXPLORER_URL }

  it('accepts a past date', () => {
    expect(settleSeniorPayoutSchema.safeParse({ ...base, txDate: '2026-01-01' }).success).toBe(true)
  })

  it('accepts today', () => {
    // security-review PR #578 review (MED-2): `kyivToday()`, the SAME
    // function the schema itself compares against — NOT
    // `new Date().toISOString()` (plain UTC), which disagrees with it for up
    // to 3 hours a day (backlog 148) and would make this test genuinely flaky
    // when actually run in that window, not merely wrong in theory.
    expect(settleSeniorPayoutSchema.safeParse({ ...base, txDate: kyivToday() }).success).toBe(true)
  })

  it('rejects a future date, on the txDate field, with a russian "future" message', () => {
    // "Tomorrow" relative to the KYIV calendar day the schema itself uses —
    // plain calendar-day arithmetic (no timezone involved once we already
    // have a YYYY-MM-DD string), so this stays correct regardless of when
    // the suite actually runs.
    const tomorrow = new Date(Date.parse(`${kyivToday()}T00:00:00Z`) + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    const result = settleSeniorPayoutSchema.safeParse({ ...base, txDate: tomorrow })
    expect(result.success).toBe(false)
    if (result.success) return
    // Precise issue shape — not just success:false — so a mutant that
    // still adds SOME issue (e.g. via a malformed addIssue call) but with
    // the WRONG path/message is caught too.
    const issue = result.error.issues.find((i) => i.path.join('.') === 'txDate')
    expect(issue).toBeTruthy()
    expect(issue?.message).toMatch(/будущем/)
    expect(issue?.code).toBe('custom')
  })

  it('rejects a malformed (non-digit) date string, with the regex-format message', () => {
    const result = settleSeniorPayoutSchema.safeParse({ ...base, txDate: '01/01/2026' })
    expect(result.success).toBe(false)
    if (result.success) return
    const issue = result.error.issues.find((i) => i.path.join('.') === 'txDate')
    expect(issue?.message).toBe('Дата должна быть в формате YYYY-MM-DD')
  })

  // Regex anchor coverage — a bare `\d{4}-\d{2}-\d{2}` (no `^`/`$`) would
  // accept these via a substring match; the schema must not.
  it('rejects a date string with trailing junk (missing $ anchor)', () => {
    expect(
      settleSeniorPayoutSchema.safeParse({ ...base, txDate: '2026-01-01-extra' }).success,
    ).toBe(false)
  })

  it('rejects a date string with leading junk (missing ^ anchor)', () => {
    // NOT an 'x' (or any char with a HIGHER code point than a digit) prefix
    // — that would make the whole string sort ABOVE any real date and get
    // rejected by the SEPARATE future-date check regardless of what the
    // regex itself does, masking the anchor. '!' (0x21) sorts BELOW every
    // digit, so the malformed string is provably "not in the future" and
    // only the regex can be the reason this is rejected.
    expect(settleSeniorPayoutSchema.safeParse({ ...base, txDate: '!2026-01-01' }).success).toBe(
      false,
    )
  })

  it('omitted txDate is valid — every pre-existing caller keeps working', () => {
    expect(settleSeniorPayoutSchema.safeParse(base).success).toBe(true)
  })

  it('null txDate is valid (nullable, mirrors the other txDate fields in this module)', () => {
    expect(settleSeniorPayoutSchema.safeParse({ ...base, txDate: null }).success).toBe(true)
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

// ── receiptFields scheme validation (fix/external-receipt-rendering) ────────
// NEW receipt input is tightened to https:// only — an http:// url already
// silently failed to render for the viewer (mixed content: the site is
// https, `img-src`/CSP only allow `https:`), so accepting it here just
// deferred a guaranteed-broken value to render time. This tightens the
// WRITE-side schema only; already-saved http:// rows keep parsing on the
// READ-side `transactionSchema` (see finance.spec.ts "accepts valid http://
// URL") — legacy data is not touched, only new input is rejected.

describe('attachReceiptSchema — https-only scheme for new input (fix/external-receipt-rendering)', () => {
  it('accepts a new https:// receipt url (boundary: passes)', () => {
    expect(
      attachReceiptSchema.safeParse({ receiptExternalUrl: 'https://example.com/receipt.pdf' })
        .success,
    ).toBe(true)
  })

  it('rejects a new http:// receipt url (boundary: fails)', () => {
    const result = attachReceiptSchema.safeParse({
      receiptExternalUrl: 'http://example.com/receipt.pdf',
    })
    expect(result.success).toBe(false)
  })
})
