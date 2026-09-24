import { describe, expect, it } from 'vitest'

import { settledAmountError, throwSettledAmountError } from './exchange-rate.util'

// Mutation gate (i18n stage 4 Task 2): throwSettledAmountError had zero
// direct unit coverage — the only caller (pending-settlement.service.ts) is
// exercised solely through integration specs, which the mutation gate
// cannot see (mutation-gate-integration-specs.md). This file is the unit
// double that rule requires.
describe('settledAmountError', () => {
  it('NaN / Infinity → FINANCE_SETTLED_AMOUNT_NOT_NUMBER', () => {
    expect(settledAmountError(Number.NaN, 1000)).toEqual({
      code: 'FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
    })
    expect(settledAmountError(Infinity, 1000)).toEqual({
      code: 'FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
    })
  })

  it('negative value → FINANCE_SETTLED_AMOUNT_NEGATIVE', () => {
    expect(settledAmountError(-1, 1000)).toEqual({ code: 'FINANCE_SETTLED_AMOUNT_NEGATIVE' })
  })

  it('value over the ceiling → FINANCE_SETTLED_AMOUNT_OVER_LIMIT with the ceiling in params', () => {
    expect(settledAmountError(1500, 1000)).toEqual({
      code: 'FINANCE_SETTLED_AMOUNT_OVER_LIMIT',
      maxAmount: 1000,
    })
  })

  it('value within bounds → null (no error)', () => {
    expect(settledAmountError(500, 1000)).toBeNull()
    expect(settledAmountError(1000, 1000)).toBeNull() // exactly at the ceiling, not over it
    expect(settledAmountError(0, 1000)).toBeNull()
  })
})

describe('throwSettledAmountError', () => {
  it('FINANCE_SETTLED_AMOUNT_OVER_LIMIT — throws with maxAmount in params (not {})', () => {
    expect(() =>
      throwSettledAmountError({ code: 'FINANCE_SETTLED_AMOUNT_OVER_LIMIT', maxAmount: 42 }),
    ).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'FINANCE_SETTLED_AMOUNT_OVER_LIMIT',
          statusCode: 400,
          params: { maxAmount: 42 },
        }),
      }),
    )
  })

  it('FINANCE_SETTLED_AMOUNT_NOT_NUMBER — throws with that code, 400', () => {
    expect(() =>
      throwSettledAmountError({ code: 'FINANCE_SETTLED_AMOUNT_NOT_NUMBER' }),
    ).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
          statusCode: 400,
        }),
      }),
    )
  })

  it('FINANCE_SETTLED_AMOUNT_NEGATIVE — throws with that code, 400', () => {
    expect(() => throwSettledAmountError({ code: 'FINANCE_SETTLED_AMOUNT_NEGATIVE' })).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'FINANCE_SETTLED_AMOUNT_NEGATIVE',
          statusCode: 400,
        }),
      }),
    )
  })
})
