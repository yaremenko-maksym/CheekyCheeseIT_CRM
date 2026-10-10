import { describe, expect, it } from 'vitest'
import { buildCreateUserInsertValues, buildDropInsertValues } from './user-insert.util'

const baseUser = { email: 'a@x.io', displayName: 'Ann', role: 'JUNIOR' as const }

describe('buildCreateUserInsertValues', () => {
  it('minimal input: nulls for optionals, locale passed through, no optional keys', () => {
    expect(buildCreateUserInsertValues(baseUser, 'en')).toStrictEqual({
      email: 'a@x.io',
      displayName: 'Ann',
      role: 'JUNIOR',
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
      locale: 'en',
    })
  })

  it('passes through contact fields and tech stack', () => {
    const v = buildCreateUserInsertValues(
      { ...baseUser, telegram: '@a', phone: '+1', avatarUrl: 'u', techStack: ['ts'] },
      'uk',
    )
    expect(v).toMatchObject({ telegram: '@a', phone: '+1', avatarUrl: 'u', techStack: ['ts'] })
  })

  it('seniorSharePercent: 0 is kept (only undefined skipped)', () => {
    expect(
      buildCreateUserInsertValues({ ...baseUser, seniorSharePercent: 0 }, 'uk'),
    ).toHaveProperty('seniorSharePercent', 0)
    expect(
      buildCreateUserInsertValues({ ...baseUser, seniorSharePercent: 40 }, 'uk'),
    ).toHaveProperty('seniorSharePercent', 40)
  })

  it('monthlySalary: stringified, 0 kept, null/undefined skipped', () => {
    expect(buildCreateUserInsertValues({ ...baseUser, monthlySalary: 1500 }, 'uk')).toHaveProperty(
      'monthlySalary',
      '1500',
    )
    expect(buildCreateUserInsertValues({ ...baseUser, monthlySalary: 0 }, 'uk')).toHaveProperty(
      'monthlySalary',
      '0',
    )
    expect(
      buildCreateUserInsertValues({ ...baseUser, monthlySalary: null }, 'uk'),
    ).not.toHaveProperty('monthlySalary')
    expect(buildCreateUserInsertValues(baseUser, 'uk')).not.toHaveProperty('monthlySalary')
  })

  it('salaryCurrency set only when provided', () => {
    expect(
      buildCreateUserInsertValues({ ...baseUser, salaryCurrency: 'EUR' }, 'uk'),
    ).toHaveProperty('salaryCurrency', 'EUR')
    expect(buildCreateUserInsertValues(baseUser, 'uk')).not.toHaveProperty('salaryCurrency')
  })

  it('legalFullName trimmed; blank skipped', () => {
    expect(
      buildCreateUserInsertValues({ ...baseUser, legalFullName: '  Ivan I  ' }, 'uk'),
    ).toHaveProperty('legalFullName', 'Ivan I')
    expect(
      buildCreateUserInsertValues({ ...baseUser, legalFullName: '   ' }, 'uk'),
    ).not.toHaveProperty('legalFullName')
  })

  it('no paymentMethod: requisite fields ignored entirely', () => {
    const v = buildCreateUserInsertValues(
      { ...baseUser, walletUsdtErc20: '0xabc', bankUahIban: 'UA1' },
      'uk',
    )
    expect(v).not.toHaveProperty('paymentMethod')
    expect(v).not.toHaveProperty('walletUsdtErc20')
    expect(v).not.toHaveProperty('bankUahIban')
  })

  it('USDT_ERC20: persists wallet fields only, null-defaults missing', () => {
    const full = buildCreateUserInsertValues(
      {
        ...baseUser,
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
        walletUsdtLabel: 'main',
        bankUahIban: 'UA1',
      },
      'uk',
    )
    expect(full).toMatchObject({
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
    })
    expect(full).not.toHaveProperty('bankUahIban')
    expect(full).not.toHaveProperty('bankUahRecipient')

    const empty = buildCreateUserInsertValues({ ...baseUser, paymentMethod: 'USDT_ERC20' }, 'uk')
    expect(empty).toMatchObject({ walletUsdtErc20: null, walletUsdtLabel: null })
  })

  it('BANK_UAH_FOP: persists all four bank fields, ignores wallet, null-defaults', () => {
    const full = buildCreateUserInsertValues(
      {
        ...baseUser,
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'FOP Ivan',
        bankUahIban: 'UA21',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'Mono',
        walletUsdtErc20: '0xabc',
      },
      'uk',
    )
    expect(full).toMatchObject({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'FOP Ivan',
      bankUahIban: 'UA21',
      bankUahRnokpp: '1234567890',
      bankUahBankName: 'Mono',
    })
    expect(full).not.toHaveProperty('walletUsdtErc20')
    expect(full).not.toHaveProperty('walletUsdtLabel')

    const empty = buildCreateUserInsertValues({ ...baseUser, paymentMethod: 'BANK_UAH_FOP' }, 'uk')
    expect(empty).toMatchObject({
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
    })
  })
})

describe('buildDropInsertValues', () => {
  const baseDrop = { email: 'd@x.io', displayName: 'Dan' }

  it('minimal input: role DROP, default share 5, nulls', () => {
    expect(buildDropInsertValues(baseDrop)).toStrictEqual({
      email: 'd@x.io',
      displayName: 'Dan',
      role: 'DROP',
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
      dropSharePercent: 5,
    })
  })

  it('passes through contact fields; dropSharePercent 0 kept', () => {
    const v = buildDropInsertValues({
      ...baseDrop,
      telegram: '@d',
      phone: '+2',
      avatarUrl: 'u',
      techStack: ['go'],
      dropSharePercent: 0,
    })
    expect(v).toMatchObject({
      telegram: '@d',
      phone: '+2',
      avatarUrl: 'u',
      techStack: ['go'],
      dropSharePercent: 0,
    })
  })

  it('legalFullName and registrationAddress trimmed; blank/null skipped', () => {
    const v = buildDropInsertValues({
      ...baseDrop,
      legalFullName: ' Ivan ',
      registrationAddress: ' Kyiv ',
    })
    expect(v).toMatchObject({ legalFullName: 'Ivan', registrationAddress: 'Kyiv' })
    const blank = buildDropInsertValues({
      ...baseDrop,
      legalFullName: ' ',
      registrationAddress: null,
    })
    expect(blank).not.toHaveProperty('legalFullName')
    expect(blank).not.toHaveProperty('registrationAddress')
    expect(buildDropInsertValues({ ...baseDrop, registrationAddress: '  ' })).not.toHaveProperty(
      'registrationAddress',
    )
  })

  it('USDT_ERC20 and BANK_UAH_FOP requisites mirror the method', () => {
    const usdt = buildDropInsertValues({
      ...baseDrop,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xdef',
      walletUsdtLabel: 'l',
      bankUahIban: 'UA9',
    })
    expect(usdt).toMatchObject({
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xdef',
      walletUsdtLabel: 'l',
    })
    expect(usdt).not.toHaveProperty('bankUahIban')

    const bank = buildDropInsertValues({
      ...baseDrop,
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'R',
      bankUahIban: 'UA9',
      bankUahRnokpp: '1',
      bankUahBankName: 'B',
      walletUsdtErc20: '0xdef',
    })
    expect(bank).toMatchObject({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'R',
      bankUahIban: 'UA9',
      bankUahRnokpp: '1',
      bankUahBankName: 'B',
    })
    expect(bank).not.toHaveProperty('walletUsdtErc20')

    expect(buildDropInsertValues({ ...baseDrop, paymentMethod: 'BANK_UAH_FOP' })).toMatchObject({
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
    })
    expect(buildDropInsertValues(baseDrop)).not.toHaveProperty('paymentMethod')
  })
})
