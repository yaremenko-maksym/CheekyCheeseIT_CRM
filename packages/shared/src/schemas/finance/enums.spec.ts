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
  accountsForSalaryMonth,
  AUTOMATIC_SALARY_ORIGINS,
  dropSharePercentSourceSchema,
  isAutomaticSalaryOrigin,
  payoutRequestStatusSchema,
  salaryOriginSchema,
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

// CR-795-L-2 / SR-795-L-3 — `salary_origin` used to be a bare varchar compared
// against string literals in five services; a typo like 'Manual' type-checked
// and silently flipped a row out of the automatic-component predicate. The
// expected values below are written out by hand from the business meaning of
// each origin (not derived from the schema object under test), so adding or
// dropping a value has to be acknowledged here.
describe('salaryOriginSchema (CR-795-L-2)', () => {
  it('carries exactly the three non-NULL origins', () => {
    expect(salaryOriginSchema.options).toEqual(['MANUAL', 'CRON', 'ADJUSTED'])
  })

  it('rejects a mis-cased literal', () => {
    expect(salaryOriginSchema.safeParse('Manual').success).toBe(false)
    expect(salaryOriginSchema.safeParse('manual').success).toBe(false)
  })

  it('every value fits the varchar(8) column', () => {
    for (const option of salaryOriginSchema.options) {
      expect(option.length).toBeLessThanOrEqual(8)
    }
  })

  it('AUTOMATIC_SALARY_ORIGINS names only the cron-owned origin', () => {
    expect(AUTOMATIC_SALARY_ORIGINS).toEqual(['CRON'])
  })

  it('isAutomaticSalaryOrigin — NULL (legacy) and CRON are automatic, the rest are not', () => {
    expect(isAutomaticSalaryOrigin(null)).toBe(true)
    expect(isAutomaticSalaryOrigin('CRON')).toBe(true)
    expect(isAutomaticSalaryOrigin('MANUAL')).toBe(false)
    expect(isAutomaticSalaryOrigin('ADJUSTED')).toBe(false)
  })

  // `undefined` is a separate arm of the guard from `null`, and it is not
  // decoration: a Drizzle row selected without the column, or a partial read,
  // hands this `undefined` rather than `null`, and the two must answer alike —
  // treating an absent origin as non-automatic would drop a legacy row out of
  // the cron-idempotency predicate. The mutation gate found the arm unpinned.
  it('isAutomaticSalaryOrigin — an ABSENT origin answers like a legacy NULL', () => {
    expect(isAutomaticSalaryOrigin(undefined)).toBe(true)
    expect(isAutomaticSalaryOrigin(undefined)).toBe(isAutomaticSalaryOrigin(null))
  })

  it('accountsForSalaryMonth — everything except an ADJUSTED correction', () => {
    expect(accountsForSalaryMonth(null)).toBe(true)
    expect(accountsForSalaryMonth('CRON')).toBe(true)
    expect(accountsForSalaryMonth('MANUAL')).toBe(true)
    expect(accountsForSalaryMonth('ADJUSTED')).toBe(false)
  })

  it('accountsForSalaryMonth — an ABSENT origin accounts for its month', () => {
    expect(accountsForSalaryMonth(undefined)).toBe(true)
  })
})
