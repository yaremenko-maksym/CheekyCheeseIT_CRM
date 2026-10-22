import { describe, expect, it } from 'vitest'
import type { Transaction, users } from '../database/schema'
import { buildCounterpartyInfo, getCounterpartyId } from './invoice-counterparty.util'

function tx(over: Partial<Transaction>): Transaction {
  return {
    type: 'SENIOR_INCOME',
    senderId: 'sender-1',
    receiverId: 'receiver-1',
    ...over,
  } as Transaction
}

function user(over: Partial<typeof users.$inferSelect>): typeof users.$inferSelect {
  return {
    displayName: 'Olena Koval',
    locale: 'en',
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    ...over,
  } as typeof users.$inferSelect
}

describe('getCounterpartyId', () => {
  it('SENIOR_INCOME resolves to the receiver', () => {
    expect(getCounterpartyId(tx({ type: 'SENIOR_INCOME' }))).toBe('receiver-1')
  })

  it('SALARY resolves to the receiver', () => {
    expect(getCounterpartyId(tx({ type: 'SALARY' }))).toBe('receiver-1')
  })

  it('PAYOUT resolves to the sender', () => {
    expect(getCounterpartyId(tx({ type: 'PAYOUT' }))).toBe('sender-1')
  })

  it('returns null for any other transaction type', () => {
    expect(getCounterpartyId(tx({ type: 'EXPENSE' }))).toBeNull()
  })

  it('passes a NULL column through as null', () => {
    expect(getCounterpartyId(tx({ type: 'SALARY', receiverId: null }))).toBeNull()
    expect(getCounterpartyId(tx({ type: 'PAYOUT', senderId: null }))).toBeNull()
  })
})

describe('buildCounterpartyInfo', () => {
  it('USDT_ERC20 lists wallet then label', () => {
    const info = buildCounterpartyInfo(
      user({ paymentMethod: 'USDT_ERC20', walletUsdtErc20: '0xabc', walletUsdtLabel: 'Main' }),
    )
    expect(info).toEqual({
      displayName: 'Olena Koval',
      locale: 'en',
      paymentMethod: 'USDT_ERC20',
      paymentDetails: ['USDT (ERC-20): 0xabc', 'Main'],
    })
  })

  it('USDT_ERC20 omits absent wallet and label', () => {
    expect(buildCounterpartyInfo(user({ paymentMethod: 'USDT_ERC20' })).paymentDetails).toEqual([])
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'USDT_ERC20', walletUsdtLabel: 'Only' }))
        .paymentDetails,
    ).toEqual(['Only'])
  })

  it('ignores bank fields for USDT and wallet fields for bank', () => {
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'USDT_ERC20', bankUahIban: 'UA00' }))
        .paymentDetails,
    ).toEqual([])
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'BANK_UAH_FOP', walletUsdtErc20: '0xabc' }))
        .paymentDetails,
    ).toEqual([])
  })

  it('BANK_UAH_FOP renders en labels', () => {
    const info = buildCounterpartyInfo(
      user({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Olena Koval',
        bankUahIban: 'UA00',
        bankUahRnokpp: '123',
        bankUahBankName: 'Mono',
      }),
    )
    expect(info.paymentDetails).toEqual([
      'Recipient: Olena Koval',
      'IBAN: UA00',
      'Tax ID (RNOKPP): 123',
      'Bank: Mono',
    ])
  })

  it('BANK_UAH_FOP renders uk labels for a uk recipient', () => {
    const info = buildCounterpartyInfo(
      user({
        locale: 'uk',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Olena Koval',
        bankUahIban: 'UA00',
        bankUahRnokpp: '123',
        bankUahBankName: 'Mono',
      }),
    )
    expect(info.locale).toBe('uk')
    expect(info.paymentDetails).toEqual([
      'Отримувач: Olena Koval',
      'IBAN: UA00',
      'РНОКПП: 123',
      'Банк: Mono',
    ])
  })

  it('BANK_UAH_FOP skips each absent field independently', () => {
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'BANK_UAH_FOP', bankUahIban: 'UA00' }))
        .paymentDetails,
    ).toEqual(['IBAN: UA00'])
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'BANK_UAH_FOP', bankUahBankName: 'Mono' }))
        .paymentDetails,
    ).toEqual(['Bank: Mono'])
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'BANK_UAH_FOP', bankUahRnokpp: '123' }))
        .paymentDetails,
    ).toEqual(['Tax ID (RNOKPP): 123'])
    expect(
      buildCounterpartyInfo(user({ paymentMethod: 'BANK_UAH_FOP', bankUahRecipient: 'Olena' }))
        .paymentDetails,
    ).toEqual(['Recipient: Olena'])
  })

  it('lists no details for a payment method that is neither USDT nor bank, even with data present', () => {
    expect(
      buildCounterpartyInfo(
        user({
          paymentMethod: null,
          bankUahRecipient: 'Olena',
          bankUahIban: 'UA00',
          bankUahRnokpp: '123',
          bankUahBankName: 'Mono',
          walletUsdtErc20: '0xabc',
        }),
      ).paymentDetails,
    ).toEqual([])
  })

  it('no payment method yields null and no details', () => {
    expect(buildCounterpartyInfo(user({ paymentMethod: null }))).toEqual({
      displayName: 'Olena Koval',
      locale: 'en',
      paymentMethod: null,
      paymentDetails: [],
    })
  })
})
