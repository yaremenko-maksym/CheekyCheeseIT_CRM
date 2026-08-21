/**
 * interviews.spec.ts — unit tests for mySalaryStatusSchema.
 *
 * task-salary-month-gap-and-status (E-6): the schema used to be a bare
 * `.nullable()` object — this task replaced it with a 3-state discriminated
 * union so "not configured" and "not created yet" are distinguishable BY
 * SHAPE (see the module comment on `mySalaryStatusSchema` in interviews.ts
 * for the full rationale). These tests pin the wire contract at the schema
 * boundary itself — the API-level behaviour (which state a given DB row
 * resolves to) is covered separately in apps/api's salary-status.helper.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { mySalaryStatusSchema } from './interviews'

describe('mySalaryStatusSchema', () => {
  it('parses NOT_CONFIGURED (no other fields)', () => {
    const result = mySalaryStatusSchema.parse({ state: 'NOT_CONFIGURED' })
    expect(result).toEqual({ state: 'NOT_CONFIGURED' })
  })

  it('parses AWAITING_CREATION (no other fields)', () => {
    const result = mySalaryStatusSchema.parse({ state: 'AWAITING_CREATION' })
    expect(result).toEqual({ state: 'AWAITING_CREATION' })
  })

  it('parses EXISTS with amount/currency/status', () => {
    const result = mySalaryStatusSchema.parse({
      state: 'EXISTS',
      amount: 1500,
      currency: 'USD',
      status: 'PENDING',
    })
    expect(result).toEqual({ state: 'EXISTS', amount: 1500, currency: 'USD', status: 'PENDING' })
  })

  it('EXISTS accepts every valid salary status (PENDING / PAID / LOCKED)', () => {
    for (const status of ['PENDING', 'PAID', 'LOCKED'] as const) {
      expect(() =>
        mySalaryStatusSchema.parse({ state: 'EXISTS', amount: 100, currency: 'USD', status }),
      ).not.toThrow()
    }
  })

  it('EXISTS accepts every valid currency', () => {
    for (const currency of ['USDT', 'USD', 'EUR', 'UAH'] as const) {
      expect(() =>
        mySalaryStatusSchema.parse({ state: 'EXISTS', amount: 100, currency, status: 'PAID' }),
      ).not.toThrow()
    }
  })

  it('rejects EXISTS missing amount/currency/status — the discriminant alone is not enough', () => {
    expect(() => mySalaryStatusSchema.parse({ state: 'EXISTS' })).toThrow()
  })

  it('rejects an unknown state value', () => {
    expect(() => mySalaryStatusSchema.parse({ state: 'BOGUS' })).toThrow()
  })

  it('rejects a bare null (the pre-fix shape) — the field is no longer nullable', () => {
    expect(() => mySalaryStatusSchema.parse(null)).toThrow()
  })

  it('rejects an invalid status inside EXISTS (e.g. REJECTED — not a valid SALARY status)', () => {
    expect(() =>
      mySalaryStatusSchema.parse({
        state: 'EXISTS',
        amount: 100,
        currency: 'USD',
        status: 'REJECTED',
      }),
    ).toThrow()
  })
})
