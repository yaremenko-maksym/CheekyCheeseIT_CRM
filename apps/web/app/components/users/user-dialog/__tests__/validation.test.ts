import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Currency } from '@/components/ui/amount-currency-input'
import type { Role } from '../../constants'

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/axios', () => ({ api: { get: apiGet } }))

import {
  defaultPaymentMethod,
  fetchUsersForDialog,
  ibanPattern,
  phoneFieldSchema,
  rnokppPattern,
  telegramFieldSchema,
  toUsd,
  usdtWalletPattern,
  type ExchangeRates,
} from '../validation'

beforeEach(() => apiGet.mockReset())

describe('defaultPaymentMethod', () => {
  it.each<[Role, string]>([
    ['SENIOR', 'USDT_ERC20'],
    ['ADMIN', 'USDT_ERC20'],
    ['JUNIOR', 'BANK_UAH_FOP'],
    ['HR', 'BANK_UAH_FOP'],
    ['ACCOUNTANT', 'BANK_UAH_FOP'],
  ])('%s -> %s', (role, expected) => {
    expect(defaultPaymentMethod(role)).toBe(expected)
  })
})

describe('toUsd', () => {
  const rates: ExchangeRates = { usdUah: '40', usdtUah: '39', eurUah: '44', date: '2026-01-01' }

  it('passes USD and USDT through unchanged', () => {
    expect(toUsd(123.45, 'USD', rates)).toBe(123.45)
    expect(toUsd(123.45, 'USDT', rates)).toBe(123.45)
  })
  it('converts EUR via eurUah / usdUah', () => {
    expect(toUsd(100, 'EUR', rates)).toBeCloseTo(110, 10)
  })
  it('converts UAH by dividing by usdUah', () => {
    expect(toUsd(400, 'UAH', rates)).toBe(10)
  })
  it('returns the amount for an unknown currency', () => {
    expect(toUsd(7, 'XXX' as Currency, rates)).toBe(7)
  })
})

describe('fetchUsersForDialog', () => {
  it('GETs /users and unwraps the response data', async () => {
    const users = [{ id: 'u1' }]
    apiGet.mockResolvedValue({ data: users })
    await expect(fetchUsersForDialog()).resolves.toBe(users)
    expect(apiGet).toHaveBeenCalledWith('/users')
  })
})

describe('field patterns', () => {
  it('usdtWalletPattern accepts a 0x + 40 hex address and rejects malformed ones', () => {
    const ok = '0x' + 'aB09'.repeat(10)
    expect(usdtWalletPattern.test(ok)).toBe(true)
    expect(usdtWalletPattern.test(ok.slice(2))).toBe(false) // no 0x
    expect(usdtWalletPattern.test(ok.slice(0, -1))).toBe(false) // 39 hex
    expect(usdtWalletPattern.test(ok + '0')).toBe(false) // 41 hex
    expect(usdtWalletPattern.test('x' + ok)).toBe(false) // leading junk
    expect(usdtWalletPattern.test('0x' + 'g'.repeat(40))).toBe(false) // non-hex
  })
  it('ibanPattern accepts UA + 27 digits and rejects malformed ones', () => {
    const ok = 'UA' + '1'.repeat(27)
    expect(ibanPattern.test(ok)).toBe(true)
    expect(ibanPattern.test('1'.repeat(29))).toBe(false)
    expect(ibanPattern.test('UA' + '1'.repeat(26))).toBe(false)
    expect(ibanPattern.test(ok + '1')).toBe(false)
    expect(ibanPattern.test(' ' + ok)).toBe(false)
    expect(ibanPattern.test('UA' + 'a'.repeat(27))).toBe(false)
  })
  it('rnokppPattern accepts exactly 10 digits', () => {
    expect(rnokppPattern.test('1234567890')).toBe(true)
    expect(rnokppPattern.test('123456789')).toBe(false)
    expect(rnokppPattern.test('12345678901')).toBe(false)
    expect(rnokppPattern.test(' 1234567890')).toBe(false)
    expect(rnokppPattern.test('12345a7890')).toBe(false)
  })
})

describe('field schemas', () => {
  it('telegramFieldSchema accepts a valid handle and rejects a bad format with the code', () => {
    expect(telegramFieldSchema.safeParse('@valid_name').success).toBe(true)
    const bad = telegramFieldSchema.safeParse('ab')
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toBe('zod.TELEGRAM_FORMAT')
  })
  it('phoneFieldSchema caps at 30 characters', () => {
    expect(phoneFieldSchema.safeParse('1'.repeat(30)).success).toBe(true)
    expect(phoneFieldSchema.safeParse('1'.repeat(31)).success).toBe(false)
  })
})
