import { HttpException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  assertSettleCurrencyAllowed,
  isUsdPegPair,
  SETTLE_ALLOWED_CURRENCIES,
} from './settle-currency.util'

function catchHttp(fn: () => void): HttpException {
  try {
    fn()
  } catch (e) {
    return e as HttpException
  }
  throw new Error('expected function to throw')
}

describe('SETTLE_ALLOWED_CURRENCIES (BIZ-03 whitelist)', () => {
  it('is exactly USDT and USD — nothing else (hand-written literal)', () => {
    expect([...SETTLE_ALLOWED_CURRENCIES].sort()).toEqual(['USD', 'USDT'])
  })
})

describe('assertSettleCurrencyAllowed', () => {
  it.each(['USDT', 'USD'])('allows %s (returns undefined, does not throw)', (c) => {
    expect(assertSettleCurrencyAllowed(c)).toBeUndefined()
  })

  it.each(['UAH', 'EUR', 'usdt', 'usd', 'USDT ', '', 'BTC'])(
    'rejects %j with 400 FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED and the offending currency in params',
    (c) => {
      const ex = catchHttp(() => assertSettleCurrencyAllowed(c))
      expect(ex).toBeInstanceOf(HttpException)
      expect(ex.getStatus()).toBe(400)
      const body = ex.getResponse() as {
        statusCode: number
        code: string
        params: unknown
      }
      expect(body.statusCode).toBe(400)
      expect(body.code).toBe('FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED')
      expect(body.params).toEqual({ currency: c })
    },
  )
})

describe('isUsdPegPair', () => {
  it.each([
    ['USD', 'USD', true],
    ['USD', 'USDT', true],
    ['USDT', 'USD', true],
    ['USDT', 'USDT', true],
    ['UAH', 'USDT', false],
    ['USDT', 'UAH', false],
    ['EUR', 'USD', false],
    ['USD', 'EUR', false],
    ['UAH', 'EUR', false],
    ['UAH', 'UAH', false],
  ] as const)('isUsdPegPair(%s, %s) === %s', (a, b, expected) => {
    expect(isUsdPegPair(a, b)).toBe(expected)
  })
})
