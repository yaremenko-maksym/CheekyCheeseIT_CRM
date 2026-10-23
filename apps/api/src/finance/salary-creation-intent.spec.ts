import { describe, expect, it } from 'vitest'
import { HttpStatus } from '@nestjs/common'
import {
  assertSalaryCreationIntent,
  buildSalaryCreationIntent,
  type SalaryCreationIntent,
} from './salary-creation-intent'

/**
 * PR #868 (SR-795-M-2) — the replay comparison itself, at the seam the service
 * calls. The createSalary specs cover the two replay PATHS; these cover the
 * meaning of one intent and what makes two of them differ.
 *
 * Expected values below are written out by hand, never computed the way the
 * code computes them, so a test cannot agree with a wrong implementation.
 */
describe('buildSalaryCreationIntent', () => {
  const base = {
    receiverId: 'E7B1C2D3-4455-4667-8899-AABBCCDDEEFF',
    amount: 1500,
    currency: 'USD',
    salaryMonth: '2026-09',
    notes: 'part 1',
    txDate: '2026-10-01',
  }

  it('builds the exact persisted shape', () => {
    expect(buildSalaryCreationIntent(base)).toEqual({
      version: 1,
      operation: 'MANUAL_SALARY_CREATE',
      receiverId: 'e7b1c2d3-4455-4667-8899-aabbccddeeff',
      amount: '1500.000000',
      currency: 'USD',
      salaryMonth: '2026-09',
      notes: 'part 1',
      txDate: '2026-10-01',
    })
  })

  it('lower-cases the receiver id so one receiver cannot own two intents', () => {
    const upper = buildSalaryCreationIntent(base)
    const lower = buildSalaryCreationIntent({
      ...base,
      receiverId: 'e7b1c2d3-4455-4667-8899-aabbccddeeff',
    })
    expect(upper.receiverId).toBe(lower.receiverId)
  })

  it('fixes the amount to six decimals, so 1500 and 1500.0 are one intent', () => {
    expect(buildSalaryCreationIntent({ ...base, amount: 1500 }).amount).toBe('1500.000000')
    expect(buildSalaryCreationIntent({ ...base, amount: 1500.5 }).amount).toBe('1500.500000')
  })

  it('distinguishes amounts that differ below the sixth decimal boundary', () => {
    expect(buildSalaryCreationIntent({ ...base, amount: 1500.000001 }).amount).toBe('1500.000001')
  })

  it('defaults an absent currency to USD and an absent note to null', () => {
    const intent = buildSalaryCreationIntent({
      receiverId: base.receiverId,
      amount: 1,
      salaryMonth: '2026-09',
    })
    expect(intent.currency).toBe('USD')
    expect(intent.notes).toBeNull()
  })

  it("records an omitted date as the literal 'AUTO', not as null", () => {
    expect(buildSalaryCreationIntent({ ...base, txDate: undefined }).txDate).toBe('AUTO')
    expect(buildSalaryCreationIntent({ ...base, txDate: null }).txDate).toBe('AUTO')
  })
})

describe('assertSalaryCreationIntent', () => {
  const expected: SalaryCreationIntent = {
    version: 1,
    operation: 'MANUAL_SALARY_CREATE',
    receiverId: 'e7b1c2d3-4455-4667-8899-aabbccddeeff',
    amount: '1500.000000',
    currency: 'USD',
    salaryMonth: '2026-09',
    notes: null,
    txDate: 'AUTO',
  }

  it('accepts a replay whose stored intent means the same request', () => {
    expect(() =>
      assertSalaryCreationIntent({ id: 'tx-1', salaryCreationIntent: { ...expected } }, expected),
    ).not.toThrow()
  })

  it.each([
    ['amount', { amount: '1499.000000' }],
    ['currency', { currency: 'EUR' as const }],
    ['receiver', { receiverId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
    ['month', { salaryMonth: '2026-08' }],
    ['notes', { notes: 'different' }],
    ['date', { txDate: '2026-10-01' }],
  ])('refuses a replay whose stored intent differs by %s', (_field, override) => {
    let thrown: unknown
    try {
      assertSalaryCreationIntent(
        { id: 'tx-1', salaryCreationIntent: { ...expected, ...override } },
        expected,
      )
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'FINANCE_SALARY_IDEMPOTENCY_CONFLICT',
        reason: 'INTENT_MISMATCH',
        existingTransactionId: 'tx-1',
      },
    })
  })

  it('fails closed on a legacy row whose intent was never stored, with its own reason', () => {
    let thrown: unknown
    try {
      assertSalaryCreationIntent({ id: 'tx-legacy', salaryCreationIntent: null }, expected)
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'FINANCE_SALARY_IDEMPOTENCY_CONFLICT',
        reason: 'LEGACY_INTENT_UNKNOWN',
        existingTransactionId: 'tx-legacy',
        message:
          'This salary was not saved: an earlier salary with this key is on record, but its details cannot be verified. The existing record is unchanged.',
      },
    })
  })

  it('names the conflicting row, so the operator can be shown what already exists', () => {
    let thrown: unknown
    try {
      assertSalaryCreationIntent(
        { id: 'tx-other', salaryCreationIntent: { ...expected, amount: '1.000000' } },
        expected,
      )
    } catch (err: unknown) {
      thrown = err
    }
    expect(
      (thrown as { response: { existingTransactionId: string } }).response.existingTransactionId,
    ).toBe('tx-other')
  })
})
