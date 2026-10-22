import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAdminUserUpdateSet } from './user-update.util'

const NOW = new Date('2026-01-02T03:04:05.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('buildAdminUserUpdateSet', () => {
  it('empty input: only updatedAt, no requested share', () => {
    expect(buildAdminUserUpdateSet({}, 'JUNIOR')).toStrictEqual({
      set: { updatedAt: NOW },
      requestedSeniorSharePercent: undefined,
    })
  })

  it('copies defined scalar fields; ignores undefined email/displayName/role', () => {
    expect(
      buildAdminUserUpdateSet(
        { email: 'a@x.io', displayName: 'Ann', role: 'SENIOR', salaryCurrency: 'EUR' },
        'SENIOR',
      ).set,
    ).toStrictEqual({
      updatedAt: NOW,
      email: 'a@x.io',
      displayName: 'Ann',
      role: 'SENIOR',
      salaryCurrency: 'EUR',
    })
    expect(
      buildAdminUserUpdateSet(
        { email: undefined, displayName: undefined, role: undefined, salaryCurrency: undefined },
        'JUNIOR',
      ).set,
    ).toStrictEqual({ updatedAt: NOW })
  })

  it("'in' keys: present-but-null/undefined becomes null; values pass through", () => {
    expect(
      buildAdminUserUpdateSet(
        { telegram: undefined, phone: null, avatarUrl: undefined, techStack: undefined },
        'JUNIOR',
      ).set,
    ).toStrictEqual({
      updatedAt: NOW,
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
    })
    expect(
      buildAdminUserUpdateSet(
        { telegram: '@a', phone: '+1', avatarUrl: 'u', techStack: ['ts'] },
        'JUNIOR',
      ).set,
    ).toStrictEqual({
      updatedAt: NOW,
      telegram: '@a',
      phone: '+1',
      avatarUrl: 'u',
      techStack: ['ts'],
    })
  })

  it('never writes avatarDocumentId or seniorSharePercent into set', () => {
    const { set } = buildAdminUserUpdateSet(
      { seniorSharePercent: 40, avatarDocumentId: 'doc' } as never,
      'SENIOR',
    )
    expect(set).toStrictEqual({ updatedAt: NOW })
  })

  it('requestedSeniorSharePercent only for effective SENIOR', () => {
    expect(buildAdminUserUpdateSet({ seniorSharePercent: 40 }, 'SENIOR')).toMatchObject({
      requestedSeniorSharePercent: 40,
    })
    expect(
      buildAdminUserUpdateSet({ seniorSharePercent: 40 }, 'JUNIOR').requestedSeniorSharePercent,
    ).toBeUndefined()
    expect(buildAdminUserUpdateSet({}, 'SENIOR').requestedSeniorSharePercent).toBeUndefined()
  })

  it('dropSharePercent only for effective DROP and only when defined', () => {
    expect(buildAdminUserUpdateSet({ dropSharePercent: 10 }, 'DROP').set).toStrictEqual({
      updatedAt: NOW,
      dropSharePercent: 10,
    })
    expect(buildAdminUserUpdateSet({ dropSharePercent: 0 }, 'DROP').set).toStrictEqual({
      updatedAt: NOW,
      dropSharePercent: 0,
    })
    expect(buildAdminUserUpdateSet({ dropSharePercent: 10 }, 'SENIOR').set).toStrictEqual({
      updatedAt: NOW,
    })
    expect(buildAdminUserUpdateSet({}, 'DROP').set).toStrictEqual({ updatedAt: NOW })
  })

  it('monthlySalary: number -> string, 0 -> "0", null/undefined -> null', () => {
    expect(buildAdminUserUpdateSet({ monthlySalary: 1500.5 }, 'JUNIOR').set.monthlySalary).toBe(
      '1500.5',
    )
    expect(buildAdminUserUpdateSet({ monthlySalary: 0 }, 'JUNIOR').set.monthlySalary).toBe('0')
    expect(buildAdminUserUpdateSet({ monthlySalary: null }, 'JUNIOR').set.monthlySalary).toBeNull()
    expect(
      buildAdminUserUpdateSet({ monthlySalary: undefined }, 'JUNIOR').set.monthlySalary,
    ).toBeNull()
  })

  it('legalFullName and registrationAddress are trimmed; blank -> null', () => {
    expect(
      buildAdminUserUpdateSet({ legalFullName: '  Іваненко І. І.  ' }, 'JUNIOR').set.legalFullName,
    ).toBe('Іваненко І. І.')
    expect(buildAdminUserUpdateSet({ legalFullName: '   ' }, 'JUNIOR').set.legalFullName).toBeNull()
    expect(buildAdminUserUpdateSet({ legalFullName: '' }, 'JUNIOR').set.legalFullName).toBeNull()
    expect(buildAdminUserUpdateSet({}, 'JUNIOR').set).not.toHaveProperty('legalFullName')
    expect(
      buildAdminUserUpdateSet({ registrationAddress: ' Kyiv ' }, 'JUNIOR').set.registrationAddress,
    ).toBe('Kyiv')
    expect(
      buildAdminUserUpdateSet({ registrationAddress: '  ' }, 'JUNIOR').set.registrationAddress,
    ).toBeNull()
    expect(
      buildAdminUserUpdateSet({ registrationAddress: null }, 'JUNIOR').set.registrationAddress,
    ).toBeNull()
    expect(
      buildAdminUserUpdateSet({ registrationAddress: undefined }, 'JUNIOR').set.registrationAddress,
    ).toBeNull()
  })

  describe('payment requisites', () => {
    it('USDT_ERC20 switch: writes wallet fields present, nulls bank branch', () => {
      expect(
        buildAdminUserUpdateSet(
          { paymentMethod: 'USDT_ERC20', walletUsdtErc20: '0xabc', walletUsdtLabel: 'L' },
          'JUNIOR',
        ).set,
      ).toStrictEqual({
        updatedAt: NOW,
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
        walletUsdtLabel: 'L',
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      })
    })

    it('USDT_ERC20 switch: wallet fields absent are not written; present-undefined -> null', () => {
      const absent = buildAdminUserUpdateSet({ paymentMethod: 'USDT_ERC20' }, 'JUNIOR').set
      expect(absent).not.toHaveProperty('walletUsdtErc20')
      expect(absent).not.toHaveProperty('walletUsdtLabel')
      const undef = buildAdminUserUpdateSet(
        { paymentMethod: 'USDT_ERC20', walletUsdtErc20: undefined, walletUsdtLabel: undefined },
        'JUNIOR',
      ).set
      expect(undef.walletUsdtErc20).toBeNull()
      expect(undef.walletUsdtLabel).toBeNull()
    })

    it('BANK_UAH_FOP switch: writes bank fields present, nulls wallet branch', () => {
      expect(
        buildAdminUserUpdateSet(
          {
            paymentMethod: 'BANK_UAH_FOP',
            bankUahRecipient: 'R',
            bankUahIban: 'UA1',
            bankUahRnokpp: '123',
            bankUahBankName: 'B',
          },
          'JUNIOR',
        ).set,
      ).toStrictEqual({
        updatedAt: NOW,
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'R',
        bankUahIban: 'UA1',
        bankUahRnokpp: '123',
        bankUahBankName: 'B',
        walletUsdtErc20: null,
        walletUsdtLabel: null,
      })
    })

    it('BANK_UAH_FOP switch: bank fields absent not written; present-undefined -> null', () => {
      const absent = buildAdminUserUpdateSet({ paymentMethod: 'BANK_UAH_FOP' }, 'JUNIOR').set
      for (const k of [
        'bankUahRecipient',
        'bankUahIban',
        'bankUahRnokpp',
        'bankUahBankName',
      ] as const) {
        expect(absent).not.toHaveProperty(k)
      }
      const undef = buildAdminUserUpdateSet(
        {
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: undefined,
          bankUahIban: undefined,
          bankUahRnokpp: undefined,
          bankUahBankName: undefined,
        },
        'JUNIOR',
      ).set
      expect(undef).toMatchObject({
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      })
    })

    it('no method switch: patches individual fields without clearing others', () => {
      expect(
        buildAdminUserUpdateSet(
          {
            walletUsdtErc20: '0x1',
            walletUsdtLabel: 'L',
            bankUahRecipient: 'R',
            bankUahIban: 'UA',
            bankUahRnokpp: '9',
            bankUahBankName: 'B',
          },
          'JUNIOR',
        ).set,
      ).toStrictEqual({
        updatedAt: NOW,
        walletUsdtErc20: '0x1',
        walletUsdtLabel: 'L',
        bankUahRecipient: 'R',
        bankUahIban: 'UA',
        bankUahRnokpp: '9',
        bankUahBankName: 'B',
      })
      expect(buildAdminUserUpdateSet({}, 'JUNIOR').set).toStrictEqual({ updatedAt: NOW })
      expect(
        buildAdminUserUpdateSet(
          {
            walletUsdtErc20: undefined,
            walletUsdtLabel: undefined,
            bankUahRecipient: undefined,
            bankUahIban: undefined,
            bankUahRnokpp: undefined,
            bankUahBankName: undefined,
          },
          'JUNIOR',
        ).set,
      ).toStrictEqual({
        updatedAt: NOW,
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      })
    })
  })
})
