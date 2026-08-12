/**
 * finance.spec.ts — unit tests for financeSummarySchema.dropBalances
 * covering the new dropSharePercent + pendingCount fields added in
 * feat/drop-balances-panel.
 *
 * MED-3 note: dropSharePercent is now z.number() (non-nullable). The backend
 * applies DEFAULT_DROP_SHARE_PERCENT before responding, so null never reaches
 * the client. The «accepts null» test has been replaced with a rejection test.
 */
import { describe, expect, it } from 'vitest'
import {
  extractOnChainTxHash,
  financeSummarySchema,
  manualConfirmPayoutSchema,
  transactionSchema,
} from './finance'

const baseSummary = {
  totalIncome: 50000,
  totalExpenses: 12000,
  totalSalaries: 5000,
  netBalance: 33000,
  adminBalances: [],
  monthly: [],
}

describe('financeSummarySchema.dropBalances — new fields', () => {
  it('parses a drop balance entry with dropSharePercent and pendingCount', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 1250.5,
          dropSharePercent: 7,
          pendingCount: 2,
        },
      ],
    })
    const entry = result.dropBalances[0]!
    expect(entry.dropSharePercent).toBe(7)
    expect(entry.pendingCount).toBe(2)
    expect(entry.balance).toBe(1250.5)
  })

  it('rejects null dropSharePercent (MED-3: backend always sends a number)', () => {
    // Backend applies DEFAULT_DROP_SHARE_PERCENT fallback before responding,
    // so the client schema should reject null to keep the contract honest.
    expect(() =>
      financeSummarySchema.parse({
        ...baseSummary,
        dropBalances: [
          {
            userId: 'a0000000-0000-4000-8000-000000000007',
            displayName: 'Drop User',
            balance: 0,
            dropSharePercent: null,
            pendingCount: 0,
          },
        ],
      }),
    ).toThrow()
  })

  it('accepts zero balance with pendingCount=0', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 0,
          dropSharePercent: 5,
          pendingCount: 0,
        },
      ],
    })
    expect(result.dropBalances[0]!.balance).toBe(0)
    expect(result.dropBalances[0]!.pendingCount).toBe(0)
  })

  it('rejects dropSharePercent > 100', () => {
    expect(() =>
      financeSummarySchema.parse({
        ...baseSummary,
        dropBalances: [
          {
            userId: 'a0000000-0000-4000-8000-000000000007',
            displayName: 'Drop User',
            balance: 0,
            dropSharePercent: 101,
            pendingCount: 0,
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects negative pendingCount', () => {
    expect(() =>
      financeSummarySchema.parse({
        ...baseSummary,
        dropBalances: [
          {
            userId: 'a0000000-0000-4000-8000-000000000007',
            displayName: 'Drop User',
            balance: 0,
            dropSharePercent: 5,
            pendingCount: -1,
          },
        ],
      }),
    ).toThrow()
  })

  it('defaults to empty array when dropBalances is omitted', () => {
    const result = financeSummarySchema.parse(baseSummary)
    expect(result.dropBalances).toEqual([])
  })

  it('accepts multiple drop balance entries', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 300,
          dropSharePercent: 5,
          pendingCount: 1,
        },
        {
          userId: 'a0000000-0000-4000-8000-000000000008',
          displayName: 'Drop User 2',
          balance: -100,
          dropSharePercent: 10,
          pendingCount: 3,
        },
      ],
    })
    expect(result.dropBalances).toHaveLength(2)
    expect(result.dropBalances[1]!.dropSharePercent).toBe(10)
    expect(result.dropBalances[1]!.pendingCount).toBe(3)
  })
})

// ── transactionSchema.receiptExternalUrl — read-DTO hardening ────────────────

describe('transactionSchema.receiptExternalUrl', () => {
  const baseTx = {
    id: 'a0000000-0000-4000-8000-000000000001',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '1000.00',
    currency: 'USDT',
    senderId: null,
    senderLabel: null,
    senderName: null,
    receiverId: null,
    receiverLabel: null,
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
    salaryMonth: null,
    txDate: null,
    createdBy: 'a0000000-0000-4000-8000-000000000002',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  }

  it('accepts null receiptExternalUrl', () => {
    expect(() => transactionSchema.parse({ ...baseTx, receiptExternalUrl: null })).not.toThrow()
  })

  it('accepts a valid HTTPS URL', () => {
    expect(() =>
      transactionSchema.parse({
        ...baseTx,
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
      }),
    ).not.toThrow()
  })

  it('rejects a plain string that is not a URL (prevents unsafe href)', () => {
    expect(() => transactionSchema.parse({ ...baseTx, receiptExternalUrl: 'not-a-url' })).toThrow()
  })

  it('rejects an empty string (not a URL)', () => {
    expect(() => transactionSchema.parse({ ...baseTx, receiptExternalUrl: '' })).toThrow()
  })

  // MED-2: scheme allow-list — javascript:/data: must be rejected even if .url() passes
  it('MED-2: rejects javascript: scheme (XSS via href)', () => {
    expect(() =>
      transactionSchema.parse({ ...baseTx, receiptExternalUrl: 'javascript:alert(1)' }),
    ).toThrow()
  })

  it('MED-2: rejects data: URI', () => {
    expect(() =>
      transactionSchema.parse({
        ...baseTx,
        receiptExternalUrl: 'data:text/html,<script>alert(1)</script>',
      }),
    ).toThrow()
  })

  it('MED-2: accepts valid http:// URL', () => {
    expect(() =>
      transactionSchema.parse({ ...baseTx, receiptExternalUrl: 'http://etherscan.io/tx/0xabc' }),
    ).not.toThrow()
  })

  it('MED-2: accepts valid https:// URL', () => {
    expect(() =>
      transactionSchema.parse({
        ...baseTx,
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123def456',
      }),
    ).not.toThrow()
  })
})

// ── Drop self-view DTOs (task-drop-2-backend) ───────────────────────────────
import {
  dropIncomeDtoSchema,
  dropIncomesQuerySchema,
  dropPaymentDtoSchema,
  dropProjectDtoSchema,
  paginatedDropIncomesSchema,
} from './finance'

describe('dropIncomeDtoSchema', () => {
  const base = {
    id: 'a0000000-0000-4000-8000-000000000010',
    companyName: 'TechCorp',
    amount: 1500,
    currency: 'USDT',
    createdAt: '2026-06-12T10:00:00.000Z',
    status: 'validated',
    model: 'declared',
  }

  it('parses a valid income row', () => {
    const r = dropIncomeDtoSchema.parse(base)
    expect(r.companyName).toBe('TechCorp')
    expect(r.status).toBe('validated')
    expect(r.model).toBe('declared')
  })

  it.each(['pending', 'validated', 'paid', 'rejected'])('accepts status %s', (status) => {
    expect(dropIncomeDtoSchema.parse({ ...base, status }).status).toBe(status)
  })

  // task-drop-sees-own-obligations: the feed now covers the company-booked
  // obligation model (DROP_PENDING_PAYOUT/PAYOUT_DROP) alongside the old
  // self-declared DROP_INCOME model — discriminated by `model`.
  it.each(['declared', 'obligation'])('accepts model %s', (model) => {
    expect(dropIncomeDtoSchema.parse({ ...base, model }).model).toBe(model)
  })

  it('rejects an unknown model', () => {
    expect(() => dropIncomeDtoSchema.parse({ ...base, model: 'DROP_PENDING_PAYOUT' })).toThrow()
  })

  it('rejects a DB-internal status that must never reach the FE', () => {
    expect(() => dropIncomeDtoSchema.parse({ ...base, status: 'PENDING_PAYMENT' })).toThrow()
  })

  it('rejects a non-uuid id', () => {
    expect(() => dropIncomeDtoSchema.parse({ ...base, id: 'not-a-uuid' })).toThrow()
  })
})

describe('paginatedDropIncomesSchema', () => {
  it('parses an envelope with items + pagination meta', () => {
    const r = paginatedDropIncomesSchema.parse({
      items: [
        {
          id: 'a0000000-0000-4000-8000-000000000011',
          companyName: 'StartupA',
          amount: 800,
          currency: 'USDT',
          createdAt: '2026-06-10T10:00:00.000Z',
          status: 'pending',
          model: 'obligation',
        },
      ],
      total: 42,
      page: 2,
      limit: 20,
    })
    expect(r.items).toHaveLength(1)
    expect(r.total).toBe(42)
    expect(r.page).toBe(2)
    expect(r.items[0]?.model).toBe('obligation')
  })

  it('rejects a non-positive page', () => {
    expect(() =>
      paginatedDropIncomesSchema.parse({ items: [], total: 0, page: 0, limit: 20 }),
    ).toThrow()
  })
})

describe('dropIncomesQuerySchema', () => {
  it('applies default page=1 limit=20 when omitted', () => {
    const r = dropIncomesQuerySchema.parse({})
    expect(r.page).toBe(1)
    expect(r.limit).toBe(20)
  })

  it('coerces string page/limit (query params arrive as strings)', () => {
    const r = dropIncomesQuerySchema.parse({ page: '3', limit: '50' })
    expect(r.page).toBe(3)
    expect(r.limit).toBe(50)
  })

  it('caps limit at 100', () => {
    expect(() => dropIncomesQuerySchema.parse({ limit: '500' })).toThrow()
  })

  it('only accepts DROP_INCOME for type', () => {
    expect(dropIncomesQuerySchema.parse({ type: 'DROP_INCOME' }).type).toBe('DROP_INCOME')
    expect(() => dropIncomesQuerySchema.parse({ type: 'SENIOR_INCOME' })).toThrow()
  })
})

describe('dropProjectDtoSchema', () => {
  const base = {
    id: 'a0000000-0000-4000-8000-000000000012',
    companyName: 'TechCorp',
    seniorDisplayName: 'Oleksiy Kovalenko',
    incomesCount: 12,
    status: 'active',
  }

  it('parses a valid drop-project row with real senior display name', () => {
    const r = dropProjectDtoSchema.parse(base)
    expect(r.seniorDisplayName).toBe('Oleksiy Kovalenko')
    expect(r.incomesCount).toBe(12)
    expect(r.status).toBe('active')
  })

  it('accepts status closed', () => {
    expect(dropProjectDtoSchema.parse({ ...base, status: 'closed' }).status).toBe('closed')
  })

  it('rejects an unknown status', () => {
    expect(() => dropProjectDtoSchema.parse({ ...base, status: 'archived' })).toThrow()
  })

  it('rejects a negative incomesCount', () => {
    expect(() => dropProjectDtoSchema.parse({ ...base, incomesCount: -1 })).toThrow()
  })
})

describe('dropPaymentDtoSchema', () => {
  const base = {
    id: 'a0000000-0000-4000-8000-000000000013',
    amount: 950,
    currency: 'USDT',
    status: 'pending',
    createdAt: '2026-06-12T10:00:00.000Z',
  }

  it('parses a payment without txHash (txHash optional)', () => {
    const r = dropPaymentDtoSchema.parse(base)
    expect(r.txHash).toBeUndefined()
    expect(r.status).toBe('pending')
  })

  it('parses a payment with txHash', () => {
    const r = dropPaymentDtoSchema.parse({ ...base, txHash: '0xabc123', status: 'confirmed' })
    expect(r.txHash).toBe('0xabc123')
    expect(r.status).toBe('confirmed')
  })

  it.each(['pending', 'confirmed', 'failed'])('accepts payment status %s', (status) => {
    expect(dropPaymentDtoSchema.parse({ ...base, status }).status).toBe(status)
  })

  it('rejects an income-style status on a payment', () => {
    expect(() => dropPaymentDtoSchema.parse({ ...base, status: 'validated' })).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-1 (security-review PR #438) — the manual-confirm write boundary.
//
// `txHash` used to be `z.string().max(255)`: ANY string passed, went straight
// into `payout_requests.tx_hash`, credited the company account, and — because
// the consumed-hash registry could not recognise a non-bare-hash value —
// escaped the "one transfer settles one thing" invariant. Validating the format
// here means a bad value never reaches the money path at all.
// ─────────────────────────────────────────────────────────────────────────────
describe('manualConfirmPayoutSchema.txHash — format is validated', () => {
  const HASH = '0x' + 'a'.repeat(64)

  it('accepts a bare hash', () => {
    expect(
      manualConfirmPayoutSchema.parse({ method: 'COMPANY_ACCOUNT', txHash: HASH }).txHash,
    ).toBe(HASH)
  })

  it('accepts an explorer link (the format the deposit endpoint advertises)', () => {
    const link = `https://etherscan.io/tx/${HASH}`
    expect(
      manualConfirmPayoutSchema.parse({ method: 'COMPANY_ACCOUNT', txHash: link }).txHash,
    ).toBe(link)
  })

  it('accepts omitted / null / empty (manual settlement without a hash)', () => {
    expect(() => manualConfirmPayoutSchema.parse({ method: 'CASH' })).not.toThrow()
    expect(() => manualConfirmPayoutSchema.parse({ method: 'CASH', txHash: null })).not.toThrow()
    expect(() => manualConfirmPayoutSchema.parse({ method: 'CASH', txHash: '' })).not.toThrow()
  })

  it('REJECTS a truncated hash (was accepted by the old `length >= 10` rule)', () => {
    expect(() =>
      manualConfirmPayoutSchema.parse({ method: 'COMPANY_ACCOUNT', txHash: '0xabcdef0123456789' }),
    ).toThrow()
  })

  it('REJECTS free text that merely looks long enough', () => {
    expect(() =>
      manualConfirmPayoutSchema.parse({
        method: 'COMPANY_ACCOUNT',
        txHash: 'paid by bank transfer on friday',
      }),
    ).toThrow()
  })
})

describe('extractOnChainTxHash — ONE rule for every money path', () => {
  const HASH = '0x' + 'ab'.repeat(32)

  it('extracts from a bare hash and from a link, always lowercase', () => {
    expect(extractOnChainTxHash(HASH)).toBe(HASH)
    const mixedCaseLink = `https://etherscan.io/tx/${HASH.toUpperCase().replace('0X', '0x')}`
    expect(extractOnChainTxHash(mixedCaseLink)).toBe(HASH)
  })

  it('returns null for synthetic markers and junk', () => {
    expect(extractOnChainTxHash('0xSIM' + 'b'.repeat(56))).toBeNull()
    expect(extractOnChainTxHash('0xMANUAL' + 'c'.repeat(52))).toBeNull()
    expect(extractOnChainTxHash('0x123')).toBeNull()
    expect(extractOnChainTxHash(null)).toBeNull()
  })
})
