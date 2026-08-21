/**
 * interviews.spec.ts — unit tests for mySalaryStateSchema + mySalaryStatusSchema.
 *
 * task-salary-month-gap-and-status (E-6): the NEW `mySalaryState` field is a
 * 4-state discriminated union so "not configured", "configured but this role
 * is never cron-processed", and "configured, cron-eligible, row not created
 * yet" are distinguishable BY SHAPE (see the module comment on
 * `mySalaryStateSchema` in interviews.ts for the full rationale). The OLD
 * `mySalaryStatus` field is DEPRECATED but kept byte-identical to its
 * pre-task shape (security-review MED-3 — an already-loaded old frontend
 * bundle does a STRICT Zod .parse() and must not crash on it). These tests
 * pin BOTH wire contracts at the schema boundary — the API-level behaviour
 * (which state a given DB row resolves to) is covered separately in
 * apps/api's salary-status.helper.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { mySalaryStateSchema, mySalaryStatusSchema } from './interviews'

describe('mySalaryStateSchema (E-6 fix — the new 4-state field)', () => {
  it('parses NOT_CONFIGURED (no other fields)', () => {
    const result = mySalaryStateSchema.parse({ state: 'NOT_CONFIGURED' })
    expect(result).toEqual({ state: 'NOT_CONFIGURED' })
  })

  it('parses NOT_CRON_ELIGIBLE (no other fields) — configured but this role is never cron-processed', () => {
    const result = mySalaryStateSchema.parse({ state: 'NOT_CRON_ELIGIBLE' })
    expect(result).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
  })

  it('parses AWAITING_CREATION (no other fields)', () => {
    const result = mySalaryStateSchema.parse({ state: 'AWAITING_CREATION' })
    expect(result).toEqual({ state: 'AWAITING_CREATION' })
  })

  it('parses EXISTS with amount/currency/status', () => {
    const result = mySalaryStateSchema.parse({
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
        mySalaryStateSchema.parse({ state: 'EXISTS', amount: 100, currency: 'USD', status }),
      ).not.toThrow()
    }
  })

  it('EXISTS accepts every valid currency', () => {
    for (const currency of ['USDT', 'USD', 'EUR', 'UAH'] as const) {
      expect(() =>
        mySalaryStateSchema.parse({ state: 'EXISTS', amount: 100, currency, status: 'PAID' }),
      ).not.toThrow()
    }
  })

  it('rejects EXISTS missing amount/currency/status — the discriminant alone is not enough', () => {
    expect(() => mySalaryStateSchema.parse({ state: 'EXISTS' })).toThrow()
  })

  it('rejects an unknown state value', () => {
    expect(() => mySalaryStateSchema.parse({ state: 'BOGUS' })).toThrow()
  })

  it('rejects a bare null — this field is never nullable (unlike the deprecated mySalaryStatus)', () => {
    expect(() => mySalaryStateSchema.parse(null)).toThrow()
  })

  it('rejects an invalid status inside EXISTS (e.g. REJECTED — not a valid SALARY status)', () => {
    expect(() =>
      mySalaryStateSchema.parse({
        state: 'EXISTS',
        amount: 100,
        currency: 'USD',
        status: 'REJECTED',
      }),
    ).toThrow()
  })
})

describe('mySalaryStatusSchema (DEPRECATED — pins backward compatibility, security-review MED-3)', () => {
  it('parses null (the "nothing to show" case — no `state` discriminant, unlike mySalaryState)', () => {
    expect(mySalaryStatusSchema.parse(null)).toBeNull()
  })

  it('parses the object shape with amount/currency/status — no `state` key', () => {
    const result = mySalaryStatusSchema.parse({ amount: 1500, currency: 'USD', status: 'PENDING' })
    expect(result).toEqual({ amount: 1500, currency: 'USD', status: 'PENDING' })
  })

  it('rejects a `state`-shaped payload — required amount/currency/status are missing on it', () => {
    // Not because `state` itself is rejected (Zod objects here are non-strict
    // — unknown keys are silently dropped, not rejected, exactly what lets an
    // OLD client tolerate the NEW `mySalaryState` field being added
    // alongside it) — this throws because a bare `{ state: ... }` payload
    // has none of the three keys THIS schema actually requires. Pinned as a
    // negative case so this schema can never silently drift toward
    // `mySalaryStateSchema`'s discriminated-union shape.
    expect(() => mySalaryStatusSchema.parse({ state: 'AWAITING_CREATION' })).toThrow()
  })

  it('rejects an invalid status (e.g. REJECTED — not a valid SALARY status)', () => {
    expect(() =>
      mySalaryStatusSchema.parse({ amount: 100, currency: 'USD', status: 'REJECTED' }),
    ).toThrow()
  })

  it('rejects missing amount/currency/status on a non-null object', () => {
    expect(() => mySalaryStatusSchema.parse({})).toThrow()
  })
})
