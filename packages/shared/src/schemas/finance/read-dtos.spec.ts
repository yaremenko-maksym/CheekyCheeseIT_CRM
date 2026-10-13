/**
 * read-dtos.spec.ts — round-trip + bounds pins for the finance wire DTOs.
 *
 * `parse(valid)` must hand back EVERY key it was given: a `z.object` that lost
 * its shape would silently strip the payload to `{}` and still "validate". The
 * payloads are hand-written literals (the contract), not derived from a schema.
 */
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { companyAccountSchema, companyDepositSchema, depositStatusSchema } from './company-account'
import {
  balanceSchema,
  confirmCryptoPaymentSchema,
  cryptoRecipientSchema,
  initiateCryptoPaymentResponseSchema,
  initiateCryptoPaymentSchema,
  pendingObligationSchema,
  pendingSettlementItemSchema,
  settleBySourceTransactionParamSchema,
  settleObligationResponseSchema,
  totalEarnedSchema,
} from './payout'
import {
  accountantSummarySchema,
  financeSummarySchema,
  incomeComplianceOverviewSchema,
  incomeComplianceQuerySchema,
  seniorActiveProjectSchema,
  seniorEarningsStatsSchema,
  seniorMonthlyEarningSchema,
  seniorSummarySchema,
} from './reports'
import { payoutRequestSchema, projectFinanceSettingsSchema, transactionSchema } from './transaction'

const UUID = 'a0000000-0000-4000-8000-000000000001'
const UUID2 = 'a0000000-0000-4000-8000-000000000002'
const ISO = '2026-06-01T10:00:00.000Z'
const CURRENCIES = ['USDT', 'USD', 'EUR', 'UAH'] as const

/** [] when `value` parses and comes back deep-equal; otherwise what went wrong. */
function roundTrips(schema: z.ZodType, value: unknown): unknown[] {
  const r = schema.safeParse(value)
  if (!r.success) return [r.error.issues]
  return isDeepStrictEqual(r.data, value) ? [] : [{ lost: value, got: r.data }]
}

/** [] when exactly USDT/USD/EUR/UAH are accepted; otherwise the offending inputs. */
function acceptsEveryCurrency(field: z.ZodType): string[] {
  const bad: string[] = []
  for (const c of CURRENCIES) if (!field.safeParse(c).success) bad.push(`rejects ${c}`)
  for (const c of ['GBP', '']) if (field.safeParse(c).success) bad.push(`accepts "${c}"`)
  return bad
}

describe('company-account DTOs', () => {
  it('companyAccountSchema keeps every field', () => {
    expect(
      roundTrips(companyAccountSchema, {
        walletAddress: '0xabc',
        confirmationThreshold: 12,
        balance: 10.5,
        requisitesMarkdown: 'IBAN ...',
        updatedAt: ISO,
      }),
    ).toEqual([])
  })

  it('companyDepositSchema keeps every field', () => {
    expect(
      roundTrips(companyDepositSchema, {
        id: UUID,
        txHash: '0xabc',
        amountUsdt: 5,
        status: 'PAID',
        confirmations: 3,
        threshold: 12,
        toMatches: true,
        createdAt: ISO,
      }),
    ).toEqual([])
  })

  it('depositStatusSchema keeps every field', () => {
    expect(
      roundTrips(depositStatusSchema, {
        status: 'REJECTED',
        confirmations: 0,
        threshold: 12,
        amountUsdt: null,
      }),
    ).toEqual([])
  })
})

describe('payout-side read DTOs', () => {
  const recipient = {
    userId: UUID,
    displayName: 'Admin',
    address: '0xabc',
    amount: '12.5',
    currency: 'USDT',
    role: 'ADMIN',
  }
  const obligation = {
    id: UUID,
    creditorUserId: UUID2,
    debtorType: 'COMPANY',
    debtorUserId: null,
    sourceTransactionId: UUID,
    closingTransactionId: null,
    amount: '100.00',
    currency: 'EUR',
    status: 'PENDING',
    payoutRequestId: null,
    createdAt: ISO,
    updatedAt: ISO,
  }

  it('balanceSchema / totalEarnedSchema keep every field; totalEarned accepts all six roles', () => {
    expect(
      roundTrips(balanceSchema, { balance: 1.5, currency: 'USD', breakdown: { income: 2 } }),
    ).toEqual([])
    for (const role of ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']) {
      expect(
        roundTrips(totalEarnedSchema, {
          userId: UUID,
          role,
          totalEarned: 7,
          currency: 'USD',
          breakdown: { salary: 7 },
        }),
      ).toEqual([])
    }
    expect(
      totalEarnedSchema.safeParse({
        userId: UUID,
        role: 'OWNER',
        totalEarned: 7,
        currency: 'USD',
        breakdown: {},
      }).success,
    ).toBe(false)
  })

  it('pendingObligationSchema keeps every field and accepts every currency', () => {
    expect(roundTrips(pendingObligationSchema, obligation)).toEqual([])
    expect(acceptsEveryCurrency(pendingObligationSchema.shape.currency)).toEqual([])
  })

  it('cryptoRecipientSchema keeps every field; roles SENIOR/ADMIN only; every currency', () => {
    expect(roundTrips(cryptoRecipientSchema, recipient)).toEqual([])
    expect(roundTrips(cryptoRecipientSchema, { ...recipient, role: 'SENIOR' })).toEqual([])
    expect(cryptoRecipientSchema.safeParse({ ...recipient, role: 'DROP' }).success).toBe(false)
    expect(acceptsEveryCurrency(cryptoRecipientSchema.shape.currency)).toEqual([])
  })

  it('initiateCryptoPaymentResponseSchema keeps every field and accepts every currency', () => {
    expect(
      roundTrips(initiateCryptoPaymentResponseSchema, {
        contractAddress: null,
        recipients: [recipient],
        currency: 'USDT',
      }),
    ).toEqual([])
    expect(acceptsEveryCurrency(initiateCryptoPaymentResponseSchema.shape.currency)).toEqual([])
  })

  it('pendingSettlementItemSchema keeps every field and accepts every currency', () => {
    expect(
      roundTrips(pendingSettlementItemSchema, {
        obligationId: 'o-1',
        sourceTransactionId: 't-1',
        debtorType: 'COMPANY',
        debtorUserId: null,
        debtorName: null,
        seniorId: 's-1',
        seniorName: 'Senior',
        projectId: null,
        projectName: null,
        amount: '10',
        currency: 'UAH',
        createdAt: ISO,
      }),
    ).toEqual([])
    expect(acceptsEveryCurrency(pendingSettlementItemSchema.shape.currency)).toEqual([])
  })

  it('settleObligationResponseSchema keeps obligation and created rows', () => {
    const r = settleObligationResponseSchema.parse({ obligation, created: [] })
    expect(r).toEqual({ obligation, created: [] })
  })

  describe('UUID-like id fields', () => {
    const lax = '00000000-0000-0000-0000-000000000001'
    const bad = [
      'x00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001x',
      '00000000-0000-0000-0000-00000000000g',
      '00000000-0000-0000-0000-00000000001',
      'not-a-uuid',
    ]

    it('confirmCryptoPaymentSchema.incomeId', () => {
      for (const id of [lax, 'ABCDEF00-0000-0000-0000-000000000001'])
        expect(
          roundTrips(confirmCryptoPaymentSchema, { incomeId: id, txHashes: ['abcd'] }),
        ).toEqual([])
      for (const id of bad) {
        const r = confirmCryptoPaymentSchema.safeParse({ incomeId: id, txHashes: ['abcd'] })
        expect(r.success).toBe(false)
        expect(r.error?.issues[0]?.message).toBe('Invalid UUID')
      }
    })

    it('initiateCryptoPaymentSchema.incomeId', () => {
      expect(roundTrips(initiateCryptoPaymentSchema, { incomeId: lax })).toEqual([])
      for (const id of bad) {
        const r = initiateCryptoPaymentSchema.safeParse({ incomeId: id })
        expect(r.success).toBe(false)
        expect(r.error?.issues[0]?.message).toBe('Invalid UUID')
      }
    })

    it('settleBySourceTransactionParamSchema.sourceTransactionId', () => {
      expect(
        roundTrips(settleBySourceTransactionParamSchema, { sourceTransactionId: lax }),
      ).toEqual([])
      for (const id of bad) {
        const r = settleBySourceTransactionParamSchema.safeParse({ sourceTransactionId: id })
        expect(r.success).toBe(false)
        expect(r.error?.issues[0]?.message).toBe('Invalid UUID')
      }
    })
  })

  describe('confirmCryptoPaymentSchema.txHashes bounds', () => {
    const parse = (txHashes: string[]) =>
      confirmCryptoPaymentSchema.safeParse({ incomeId: UUID, txHashes }).success

    it('needs at least one hash, allows several', () => {
      expect(parse([])).toBe(false)
      expect(parse(['abcd'])).toBe(true)
      expect(parse(['abcd', 'efgh', 'ijkl'])).toBe(true)
    })

    it('each hash is 4..255 characters', () => {
      expect(parse(['abc'])).toBe(false)
      expect(parse(['abcd'])).toBe(true)
      expect(parse(['x'.repeat(255)])).toBe(true)
      expect(parse(['x'.repeat(256)])).toBe(false)
    })
  })
})

describe('transaction.ts DTOs', () => {
  const baseTx = {
    id: UUID,
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
    createdBy: UUID2,
    createdAt: ISO,
    updatedAt: ISO,
  }

  it('transactionSchema keeps the nested payoutRequest snapshot', () => {
    const payoutRequest = {
      seniorId: UUID2,
      incomeAmount: '1000.00',
      payableAmount: '840.00',
      seniorSharePercent: 16,
      seniorSharePercentSource: 'TEAM',
    }
    const r = transactionSchema.parse({ ...baseTx, payoutRequest })
    expect(r.payoutRequest).toEqual(payoutRequest)
  })

  it('transactionSchema accepts every currency for currency and originalCurrency', () => {
    expect(acceptsEveryCurrency(transactionSchema.shape.currency)).toEqual([])
    for (const c of CURRENCIES) {
      expect(transactionSchema.safeParse({ ...baseTx, originalCurrency: c }).success).toBe(true)
    }
    for (const bad of ['GBP', '']) {
      expect(transactionSchema.safeParse({ ...baseTx, originalCurrency: bad }).success).toBe(false)
    }
    expect(transactionSchema.safeParse({ ...baseTx, originalCurrency: null }).success).toBe(true)
  })

  it('transactionSchema.receiptExternalUrl is the READ-side http(s) rule, anchored at the start', () => {
    const parse = (receiptExternalUrl: string) =>
      transactionSchema.safeParse({ ...baseTx, receiptExternalUrl })
    expect(parse('http://example.com/r').success).toBe(true)
    expect(parse('https://example.com/r').success).toBe(true)
    expect(parse('HTTPS://example.com/r').success).toBe(true)
    const ftp = parse('ftp://example.com/?u=https://evil.example/')
    expect(ftp.success).toBe(false)
    expect(ftp.error?.issues[0]?.message).toBe('Receipt URL must use http or https scheme')
  })

  it('payoutRequestSchema keeps every field', () => {
    expect(
      roundTrips(payoutRequestSchema, {
        id: UUID,
        seniorId: UUID2,
        seniorName: 'Senior',
        incomeAmount: '1000.00',
        payableAmount: '840.00',
        contractAddress: '0xabc',
        txHash: null,
        txFromAddress: null,
        status: 'PENDING',
        createdAt: ISO,
        updatedAt: ISO,
      }),
    ).toEqual([])
  })

  it('projectFinanceSettingsSchema keeps every field; the override is an int 0..100', () => {
    const settings = {
      id: UUID,
      projectId: UUID2,
      seniorSharePercentOverride: 50,
      juniorSalaryOverride: '300.00',
      updatedBy: null,
      updatedAt: ISO,
    }
    expect(roundTrips(projectFinanceSettingsSchema, settings)).toEqual([])
    for (const ok of [0, 1, 99, 100, null]) {
      expect(
        projectFinanceSettingsSchema.safeParse({ ...settings, seniorSharePercentOverride: ok })
          .success,
      ).toBe(true)
    }
    for (const bad of [-1, 101, 1.5]) {
      expect(
        projectFinanceSettingsSchema.safeParse({ ...settings, seniorSharePercentOverride: bad })
          .success,
      ).toBe(false)
    }
  })
})

describe('reports.ts DTOs', () => {
  it('financeSummarySchema keeps nested admin balances, drop balances and monthly rows', () => {
    const summary = {
      totalIncome: 1,
      totalExpenses: 2,
      totalSalaries: 3,
      netBalance: 4,
      adminBalances: [{ userId: UUID, displayName: 'A', balance: 5 }],
      dropBalances: [
        { userId: UUID2, displayName: 'D', balance: 6, dropSharePercent: 10, pendingCount: 1 },
      ],
      monthly: [{ month: '2026-06', income: 1, expenses: 2, salaries: 3, profit: 4 }],
    }
    expect(roundTrips(financeSummarySchema, summary)).toEqual([])
    expect(
      financeSummarySchema.parse({ ...summary, dropBalances: undefined }).dropBalances,
    ).toEqual([])
  })

  it('accountantSummarySchema keeps every nested block', () => {
    expect(
      roundTrips(accountantSummarySchema, {
        pendingValidation: { count: 1, amount: 2 },
        validatedThisMonth: { count: 3, amount: 4 },
        paidThisMonth: { amount: 5 },
        recipientCount: 6,
      }),
    ).toEqual([])
  })

  it('seniorActiveProjectSchema: sharePercent is an int 0..100', () => {
    const p = { id: UUID, name: 'P', companyName: 'C', sharePercent: 50 }
    expect(roundTrips(seniorActiveProjectSchema, p)).toEqual([])
    for (const ok of [0, 100]) {
      expect(seniorActiveProjectSchema.safeParse({ ...p, sharePercent: ok }).success).toBe(true)
    }
    for (const bad of [-1, 101, 0.5]) {
      expect(seniorActiveProjectSchema.safeParse({ ...p, sharePercent: bad }).success).toBe(false)
    }
  })

  it('seniorMonthlyEarningSchema / seniorEarningsStatsSchema keep every field', () => {
    expect(roundTrips(seniorMonthlyEarningSchema, { month: '2026-06', amount: 9 })).toEqual([])
    expect(
      roundTrips(seniorEarningsStatsSchema, {
        lastMonthIncome: 1,
        monthlyHistory: [{ month: '2026-06', amount: 9 }],
        companyIncomeProgress: { received: 2, total: 3 },
      }),
    ).toEqual([])
  })

  it('seniorSummarySchema keeps every nested block and pins the USD currency literal', () => {
    const summary = {
      activeProjects: {
        count: 1,
        items: [{ id: UUID, name: 'P', companyName: 'C', sharePercent: 10 }],
      },
      seniorShareIncome: { total: 1, thisMonth: 2, currency: 'USD' },
      pendingPayouts: { count: 3, amount: 4 },
      mySalaryStatus: null,
      mySalaryState: { state: 'NOT_CONFIGURED' },
      earningsStats: {
        lastMonthIncome: 1,
        monthlyHistory: [],
        companyIncomeProgress: { received: 0, total: 0 },
      },
    }
    expect(roundTrips(seniorSummarySchema, summary)).toEqual([])
    expect(
      seniorSummarySchema.safeParse({
        ...summary,
        seniorShareIncome: { total: 1, thisMonth: 2, currency: 'EUR' },
      }).success,
    ).toBe(false)
  })

  it('incomeComplianceOverviewSchema.month is exactly YYYY-MM', () => {
    const base = {
      totals: {
        expectedProjects: 1,
        submittedProjects: 1,
        laggingReceivers: 0,
        completeReceivers: 1,
        pendingProjects: 0,
      },
      receivers: [],
    }
    const parse = (month: string) => incomeComplianceOverviewSchema.safeParse({ ...base, month })
    expect(parse('2026-08').success).toBe(true)
    for (const bad of ['x2026-08', '2026-08x', '2026-8', '202-08', '20266-08', ' 2026-08']) {
      expect(parse(bad).success).toBe(false)
    }
    expect(parse('nope').error?.issues[0]?.message).toBe("Expected 'YYYY-MM' format")
  })

  it('incomeComplianceQuerySchema keeps month and validates it as a real month', () => {
    expect(roundTrips(incomeComplianceQuerySchema, { month: '2026-08' })).toEqual([])
    expect(incomeComplianceQuerySchema.safeParse({}).success).toBe(true)
    for (const ok of ['2026-01', '2026-09', '2026-10', '2026-12']) {
      expect(incomeComplianceQuerySchema.safeParse({ month: ok }).success).toBe(true)
    }
    for (const bad of [
      '2026-00',
      '2026-13',
      '2026-20',
      '2026-1',
      '2026-011',
      'x2026-05',
      '2026-05x',
      '26-05',
    ]) {
      expect(incomeComplianceQuerySchema.safeParse({ month: bad }).success).toBe(false)
    }
    expect(incomeComplianceQuerySchema.safeParse({ month: 'bad' }).error?.issues[0]?.message).toBe(
      'month must be YYYY-MM',
    )
  })
})
