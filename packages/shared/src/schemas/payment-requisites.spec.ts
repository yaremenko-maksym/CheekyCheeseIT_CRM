import { describe, expect, it } from 'vitest'
import { paymentRequisitesSchema } from './payment-requisites'

describe('paymentRequisitesSchema', () => {
  it('accepts valid USDT requisites', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0x1234567890abcdef1234567890abcdef12345678',
      }).success,
    ).toBe(true)
  })

  it('rejects USDT with invalid wallet', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: 'not-a-wallet',
      }).success,
    ).toBe(false)
  })

  it('accepts valid Bank UAH requisites', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван Петренко',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '1234567890',
      }).success,
    ).toBe(true)
  })

  it('rejects Bank UAH with invalid IBAN', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван',
        bankUahIban: 'NOT-AN-IBAN',
        bankUahRnokpp: '1234567890',
      }).success,
    ).toBe(false)
  })

  it('rejects Bank UAH with invalid RNOKPP (not 10 digits)', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '12345',
      }).success,
    ).toBe(false)
  })
})
