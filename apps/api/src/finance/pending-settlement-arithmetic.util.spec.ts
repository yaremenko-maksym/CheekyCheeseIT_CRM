/**
 * Direct unit tests for the pure L2 arithmetic extracted from
 * `PendingSettlementService.settleByCompany`. Expected values are hand-counted
 * literals, never recomputed with the formula under test.
 */
import { describe, expect, it } from 'vitest'
import { HttpException } from '@nestjs/common'
import { MAX_TRANSACTION_AMOUNT } from '@crm/shared'
import {
  assertDropCurrencyInvariants,
  convertDropPayoutAmount,
  finalizeDropPayout,
  isFundingSourceMismatch,
  remainingOwed,
  resolveCompanyDebit,
  resolveSettleCurrency,
} from './pending-settlement-arithmetic.util'

function body(fn: () => unknown): { code: string; params?: unknown } {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException)
    const ex = e as HttpException
    expect(ex.getStatus()).toBe(400)
    return ex.getResponse() as { code: string; params?: unknown }
  }
  throw new Error('expected a throw')
}

const RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260812' }

describe('remainingOwed', () => {
  it('subtracts the accumulator', () => {
    expect(remainingOwed('1000', 0)).toBe(1000)
    expect(remainingOwed('130.3', 100.1)).toBe(30.2)
  })
  it('strips the float tail (0.3 - 0.1) at 6dp', () => {
    expect(remainingOwed('0.3', 0.1)).toBe(0.2)
  })
  it('rounds to exactly 6 decimals', () => {
    expect(remainingOwed('1.0000004', 0)).toBe(1)
    expect(remainingOwed('1.0000006', 0)).toBe(1.000001)
  })
  it('returns a negative remainder when overpaid', () => {
    expect(remainingOwed('50', 80)).toBe(-30)
  })
})

describe('resolveCompanyDebit', () => {
  const base = { isDropObligation: false, sourceDropCascadeOrigin: null }

  it('no funding: COMPANY debt defaults to company account, DROP debt does not', () => {
    expect(resolveCompanyDebit({ ...base, debtorType: 'COMPANY', funding: undefined })).toEqual({
      useCompanyAccount: true,
      debitsCompanyAccount: true,
    })
    expect(resolveCompanyDebit({ ...base, debtorType: 'DROP', funding: undefined })).toEqual({
      useCompanyAccount: false,
      debitsCompanyAccount: false,
    })
  })

  it('explicit funding overrides the default; debit needs a COMPANY debt too', () => {
    expect(
      resolveCompanyDebit({
        ...base,
        debtorType: 'COMPANY',
        funding: { fundingSource: 'ADMIN_PERSONAL' },
      }),
    ).toEqual({ useCompanyAccount: false, debitsCompanyAccount: false })
    expect(
      resolveCompanyDebit({
        ...base,
        debtorType: 'DROP',
        funding: { fundingSource: 'COMPANY_ACCOUNT' },
      }),
    ).toEqual({ useCompanyAccount: true, debitsCompanyAccount: false })
    expect(
      resolveCompanyDebit({
        ...base,
        debtorType: 'COMPANY',
        funding: { fundingSource: 'COMPANY_ACCOUNT' },
      }),
    ).toEqual({ useCompanyAccount: true, debitsCompanyAccount: true })
  })

  it.each([null, true])(
    'HIGH-1: drop obligation with cascade origin %s refuses a company debit (both branches)',
    (origin) => {
      const fund = { fundingSource: 'COMPANY_ACCOUNT' as const }
      for (const funding of [fund, undefined]) {
        expect(
          body(() =>
            resolveCompanyDebit({
              debtorType: 'COMPANY',
              funding,
              isDropObligation: true,
              sourceDropCascadeOrigin: origin,
            }),
          ).code,
        ).toBe('FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT')
      }
    },
  )

  it('HIGH-1: only an explicit false origin, a non-drop, or a non-company-debit passes', () => {
    expect(
      resolveCompanyDebit({
        debtorType: 'COMPANY',
        funding: undefined,
        isDropObligation: true,
        sourceDropCascadeOrigin: false,
      }).debitsCompanyAccount,
    ).toBe(true)
    expect(
      resolveCompanyDebit({
        debtorType: 'COMPANY',
        funding: undefined,
        isDropObligation: false,
        sourceDropCascadeOrigin: true,
      }).debitsCompanyAccount,
    ).toBe(true)
    expect(
      resolveCompanyDebit({
        debtorType: 'COMPANY',
        funding: { fundingSource: 'ADMIN_PERSONAL' },
        isDropObligation: true,
        sourceDropCascadeOrigin: true,
      }).debitsCompanyAccount,
    ).toBe(false)
    expect(
      resolveCompanyDebit({
        debtorType: 'DROP',
        funding: undefined,
        isDropObligation: true,
        sourceDropCascadeOrigin: true,
      }).debitsCompanyAccount,
    ).toBe(false)
  })
})

describe('resolveSettleCurrency', () => {
  it('no funding, no company debit: keeps the obligation currency', () => {
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USD',
        funding: undefined,
        isDropObligation: false,
        debitsCompanyAccount: false,
      }),
    ).toBe('USD')
  })

  it('a company-account debit forces USDT', () => {
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USD',
        funding: { fundingSource: 'COMPANY_ACCOUNT' },
        isDropObligation: false,
        debitsCompanyAccount: true,
      }),
    ).toBe('USDT')
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USD',
        funding: undefined,
        isDropObligation: false,
        debitsCompanyAccount: true,
      }),
    ).toBe('USDT')
  })

  it('ADMIN_PERSONAL without currency keeps the obligation currency', () => {
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USDT',
        funding: { fundingSource: 'ADMIN_PERSONAL' },
        isDropObligation: false,
        debitsCompanyAccount: false,
      }),
    ).toBe('USDT')
  })

  it('ADMIN_PERSONAL explicit currency: whitelisted for SENIOR, BIZ-03 rejects UAH', () => {
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USDT',
        funding: { fundingSource: 'ADMIN_PERSONAL', currency: 'USD' },
        isDropObligation: false,
        debitsCompanyAccount: false,
      }),
    ).toBe('USD')
    const err = body(() =>
      resolveSettleCurrency({
        obligationCurrency: 'USDT',
        funding: { fundingSource: 'ADMIN_PERSONAL', currency: 'UAH' },
        isDropObligation: false,
        debitsCompanyAccount: false,
      }),
    )
    expect(err.code).toBe('FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED')
    expect(err.params).toEqual({ currency: 'UAH' })
  })

  it('a DROP settle is exempt from the whitelist', () => {
    expect(
      resolveSettleCurrency({
        obligationCurrency: 'USDT',
        funding: { fundingSource: 'ADMIN_PERSONAL', currency: 'UAH' },
        isDropObligation: true,
        debitsCompanyAccount: false,
      }),
    ).toBe('UAH')
  })
})

describe('assertDropCurrencyInvariants', () => {
  it('refuses a non-USDT drop obligation (MED-1)', () => {
    expect(body(() => assertDropCurrencyInvariants('EUR', 'EUR', 0)).code).toBe(
      'FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY',
    )
    expect(body(() => assertDropCurrencyInvariants('USD', 'USD', 0)).code).toBe(
      'FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY',
    )
  })

  it('top-up in another currency is refused with the obligation currency in params', () => {
    const err = body(() => assertDropCurrencyInvariants('USDT', 'UAH', 0.000001))
    expect(err.code).toBe('FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY')
    expect(err.params).toEqual({ obligationCurrency: 'USDT' })
    // strict compare: USD is a different currency for this guard
    expect(body(() => assertDropCurrencyInvariants('USDT', 'USD', 5)).code).toBe(
      'FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY',
    )
  })

  it('allows same-currency top-ups and first settles in any currency', () => {
    expect(() => assertDropCurrencyInvariants('USDT', 'USDT', 100)).not.toThrow()
    expect(() => assertDropCurrencyInvariants('USDT', 'UAH', 0)).not.toThrow()
  })
})

describe('convertDropPayoutAmount', () => {
  it('converts through the NBU rates and rounds to 2dp', () => {
    expect(convertDropPayoutAmount(100, 'USDT', 'UAH', RATES)).toBe(4150)
    expect(convertDropPayoutAmount(100, 'USDT', 'EUR', RATES)).toBe(92.63)
    expect(convertDropPayoutAmount(100.123456, 'USDT', 'UAH', RATES)).toBe(4155.12)
  })

  it('rounds half up at the second decimal (5.1875 -> 5.19)', () => {
    expect(convertDropPayoutAmount(0.125, 'USDT', 'UAH', RATES)).toBe(5.19)
  })

  it('refuses an unknown-date stale rate (MED-2) but accepts a dated fallback', () => {
    expect(
      body(() => convertDropPayoutAmount(100, 'USDT', 'UAH', { ...RATES, stale: true })).code,
    ).toBe('FINANCE_NBU_RATE_UNAVAILABLE')
    expect(
      convertDropPayoutAmount(100, 'USDT', 'UAH', { ...RATES, stale: true, rateDate: '20260810' }),
    ).toBe(4150)
    expect(convertDropPayoutAmount(100, 'USDT', 'UAH', { ...RATES, stale: false })).toBe(4150)
  })

  it('a broken rate surfaces from convertToBase instead of a silent relabel', () => {
    expect(() =>
      convertDropPayoutAmount(100, 'USDT', 'UAH', { ...RATES, usdUah: '0', usdtUah: '0' }),
    ).toThrow(/NBU rate unavailable/)
  })
})

describe('finalizeDropPayout', () => {
  const args = (o: Partial<Parameters<typeof finalizeDropPayout>[0]> = {}) => ({
    obligationAmount: 100,
    owedNow: 100,
    paidAmount: 100,
    priorSettledAmount: 0,
    ...o,
  })

  it('same-currency first settle stamps rate 1', () => {
    expect(finalizeDropPayout(args())).toBe('1.00000000')
  })

  it('converted payment stamps paid/obligation', () => {
    expect(finalizeDropPayout(args({ paidAmount: 4150 }))).toBe('41.50000000')
  })

  it('cumulativePaid is rounded to 6dp before the ratio', () => {
    expect(
      finalizeDropPayout(
        args({ obligationAmount: 1, owedNow: 1, paidAmount: 100.1234567, priorSettledAmount: 0 }),
      ),
    ).toBe('100.12345700')
  })

  it('top-up: numerator is prior + this payment, float tail stripped', () => {
    expect(
      finalizeDropPayout(
        args({
          obligationAmount: 130.3,
          owedNow: 30.2,
          paidAmount: 30.2,
          priorSettledAmount: 100.1,
        }),
      ),
    ).toBe('1.00000000')
    expect(
      finalizeDropPayout(
        args({ obligationAmount: 200, owedNow: 100, paidAmount: 100, priorSettledAmount: 50 }),
      ),
    ).toBe('0.75000000')
  })

  it('zero-share obligation: legal, rate NULL', () => {
    expect(finalizeDropPayout(args({ obligationAmount: 0, owedNow: 0, paidAmount: 0 }))).toBeNull()
  })

  it('idempotent close (owedNow 0, paid 0) is allowed', () => {
    expect(finalizeDropPayout(args({ owedNow: 0, paidAmount: 0, priorSettledAmount: 100 }))).toBe(
      '1.00000000',
    )
  })

  it('dust: paid rounds to 0 while something is still owed is refused', () => {
    expect(body(() => finalizeDropPayout(args({ owedNow: 0.004, paidAmount: 0 }))).code).toBe(
      'FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO',
    )
  })

  it('validates the paid figure: NaN, negative, over ceiling; ceiling itself passes', () => {
    expect(body(() => finalizeDropPayout(args({ paidAmount: NaN }))).code).toBe(
      'FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
    )
    expect(body(() => finalizeDropPayout(args({ paidAmount: -1 }))).code).toBe(
      'FINANCE_SETTLED_AMOUNT_NEGATIVE',
    )
    const over = body(() => finalizeDropPayout(args({ paidAmount: MAX_TRANSACTION_AMOUNT + 1 })))
    expect(over.code).toBe('FINANCE_SETTLED_AMOUNT_OVER_LIMIT')
    expect(over.params).toEqual({ maxAmount: MAX_TRANSACTION_AMOUNT })
    expect(
      finalizeDropPayout(
        args({
          obligationAmount: MAX_TRANSACTION_AMOUNT,
          owedNow: MAX_TRANSACTION_AMOUNT,
          paidAmount: MAX_TRANSACTION_AMOUNT,
        }),
      ),
    ).toBe('1.00000000')
  })

  it('an unstorable ratio is NULL, not a thrown error', () => {
    // 500000 / 0.00001 -> 5e10 >= 1e10
    expect(
      finalizeDropPayout(
        args({ obligationAmount: 0.00001, owedNow: 0.00001, paidAmount: MAX_TRANSACTION_AMOUNT }),
      ),
    ).toBeNull()
    // 0.001 / 500000 = 2e-9 < 1e-8
    expect(
      finalizeDropPayout(
        args({
          obligationAmount: MAX_TRANSACTION_AMOUNT,
          owedNow: MAX_TRANSACTION_AMOUNT,
          paidAmount: 0.001,
        }),
      ),
    ).toBeNull()
  })

  it('a non-finite obligation amount yields NULL rate', () => {
    expect(finalizeDropPayout(args({ obligationAmount: NaN }))).toBeNull()
  })
})

describe('isFundingSourceMismatch', () => {
  const same = {
    settleFundingSource: 'COMPANY_ACCOUNT',
    sourceFundingSource: 'COMPANY_ACCOUNT',
    senderId: null,
    sourceSenderId: null,
  }

  it('first settle never mismatches', () => {
    expect(
      isFundingSourceMismatch({
        priorSettledAmount: 0,
        settleFundingSource: null,
        sourceFundingSource: 'COMPANY_ACCOUNT',
        senderId: 'a',
        sourceSenderId: 'b',
      }),
    ).toBe(false)
  })

  it('top-up from the same pot and payer is fine', () => {
    expect(isFundingSourceMismatch({ priorSettledAmount: 260, ...same })).toBe(false)
  })

  it('top-up from a different pot or a different payer is a mismatch (tiny prior counts)', () => {
    expect(
      isFundingSourceMismatch({
        priorSettledAmount: 0.000001,
        ...same,
        settleFundingSource: null,
      }),
    ).toBe(true)
    expect(isFundingSourceMismatch({ priorSettledAmount: 260, ...same, senderId: 'admin-b' })).toBe(
      true,
    )
    expect(
      isFundingSourceMismatch({
        priorSettledAmount: 260,
        settleFundingSource: null,
        sourceFundingSource: null,
        senderId: 'admin-a',
        sourceSenderId: 'admin-b',
      }),
    ).toBe(true)
  })
})
