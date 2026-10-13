/**
 * enums.spec.ts — pins the wire vocabulary of every finance enum.
 *
 * These literals ARE the contract (they mirror the Postgres enums and the web
 * switch statements), so each list is written out by hand, in declaration
 * order, rather than derived from the schema under test.
 */
import { describe, expect, it } from 'vitest'
import { companyDepositStatusSchema } from './company-account'
import {
  dropSharePercentSourceSchema,
  payoutRequestStatusSchema,
  seniorSharePercentSourceSchema,
  transactionStatusSchema,
  transactionTypeSchema,
} from './enums'
import {
  payoutMethodSchema,
  pendingObligationDebtorTypeSchema,
  pendingObligationStatusSchema,
} from './payout'
import { incomeComplianceRoleSchema } from './reports'

describe('finance enums — exact members, in declaration order', () => {
  it('transactionTypeSchema', () => {
    expect(transactionTypeSchema.options).toEqual([
      'ADMIN_INCOME',
      'SENIOR_INCOME',
      'EXPENSE',
      'SALARY',
      'ADMIN_TRANSFER',
      'PAYOUT',
      'PAYOUT_ADMIN',
      'DROP_INCOME',
      'PAYOUT_DROP',
      'PAYOUT_CONFIRMED',
      'TOV_INCOME',
      'SENIOR_PENDING_PAYOUT',
      'SENIOR_PAID',
      'ADMIN_INCOME_CASH',
      'ADMIN_INCOME_CRYPTO',
      'SENIOR_INCOME_CRYPTO',
      'DIVIDEND_TO_ADMIN',
      'DIVIDEND_TAX',
      'COMPANY_DEPOSIT',
      'DROP_PENDING_PAYOUT',
    ])
  })

  it('transactionStatusSchema', () => {
    expect(transactionStatusSchema.options).toEqual([
      'PENDING',
      'VALIDATED',
      'PENDING_PAYMENT',
      'REJECTED',
      'PAID',
      'LOCKED',
      'PENDING_CASH_CONFIRM',
    ])
  })

  it('payoutRequestStatusSchema', () => {
    expect(payoutRequestStatusSchema.options).toEqual(['PENDING', 'PAID'])
  })

  it('seniorSharePercentSourceSchema', () => {
    expect(seniorSharePercentSourceSchema.options).toEqual(['PROJECT', 'TEAM', 'USER_DEFAULT'])
  })

  it('dropSharePercentSourceSchema', () => {
    expect(dropSharePercentSourceSchema.options).toEqual(['PROJECT', 'USER_DEFAULT'])
  })

  it('companyDepositStatusSchema', () => {
    expect(companyDepositStatusSchema.options).toEqual(['PENDING', 'PAID', 'REJECTED'])
  })

  it('pendingObligationDebtorTypeSchema', () => {
    expect(pendingObligationDebtorTypeSchema.options).toEqual(['DROP', 'TOV', 'ADMIN', 'COMPANY'])
  })

  it('pendingObligationStatusSchema', () => {
    expect(pendingObligationStatusSchema.options).toEqual(['PENDING', 'PAID', 'CANCELLED'])
  })

  it('payoutMethodSchema', () => {
    expect(payoutMethodSchema.options).toEqual(['CRYPTO', 'CASH'])
  })

  it('incomeComplianceRoleSchema', () => {
    expect(incomeComplianceRoleSchema.options).toEqual(['SENIOR', 'ADMIN_SENIOR', 'DROP'])
  })
})
