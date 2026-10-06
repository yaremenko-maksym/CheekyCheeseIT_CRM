import { describe, expect, it } from 'vitest'
import type { UserProfileDto } from '@crm/shared'
import { buildUserDialogDefaults } from '../form-defaults'

// Blank create defaults, role/paymentMethod aside. Literal expectations — written
// out by hand (NOT derived from the builder) so a changed default fails loudly.
const BLANK_COMMON = {
  email: '',
  personalEmail: '',
  displayName: '',
  locale: 'uk',
  telegram: '',
  phone: '',
  techStack: [],
  seniorSharePercent: 26,
  monthlySalary: '',
  salaryCurrency: 'USD',
  projectId: '',
  walletUsdtErc20: '',
  walletUsdtLabel: '',
  bankUahRecipient: '',
  bankUahIban: '',
  bankUahRnokpp: '',
  bankUahBankName: '',
  teamTelegramChannel: '',
  teamMode: 'CREATE_NEW',
  dropTeamId: '',
  dropSharePercent: 5,
  teamTelegramChannelDrop: '',
  legalFullName: '',
  registrationAddress: '',
}

const FULL_USER = {
  id: 'u1',
  email: 'ann@x.com',
  displayName: 'Ann',
  role: 'SENIOR',
  telegram: '@ann',
  phone: '+380501234567',
  techStack: ['ts', 'go'],
  seniorSharePercent: 31,
  monthlySalary: '1500.50',
  salaryCurrency: 'EUR',
  paymentMethod: 'BANK_UAH_FOP',
  walletUsdtErc20: '0xW',
  walletUsdtLabel: 'main',
  bankUahRecipient: 'Ann FOP',
  bankUahIban: 'UA123',
  bankUahRnokpp: '1234567890',
  bankUahBankName: 'Mono',
  dropSharePercent: 12,
  legalFullName: 'Ann Legal',
  registrationAddress: 'Kyiv',
} as unknown as UserProfileDto

describe('buildUserDialogDefaults', () => {
  it('null user, not hrOnly -> blank create defaults with JUNIOR role + bank payment method', () => {
    expect(buildUserDialogDefaults(null, { hrOnly: false })).toStrictEqual({
      ...BLANK_COMMON,
      role: 'JUNIOR',
      paymentMethod: 'BANK_UAH_FOP',
    })
  })

  it('null user, hrOnly -> SENIOR role + USDT payment method', () => {
    expect(buildUserDialogDefaults(null, { hrOnly: true })).toStrictEqual({
      ...BLANK_COMMON,
      role: 'SENIOR',
      paymentMethod: 'USDT_ERC20',
    })
  })

  it('full user -> every field prefilled from the user; create-only fields stay blank/default', () => {
    expect(buildUserDialogDefaults(FULL_USER, { hrOnly: false })).toStrictEqual({
      email: 'ann@x.com',
      personalEmail: '',
      displayName: 'Ann',
      role: 'SENIOR',
      locale: 'uk',
      telegram: '@ann',
      phone: '+380501234567',
      techStack: ['ts', 'go'],
      seniorSharePercent: 31,
      monthlySalary: '1500.50',
      salaryCurrency: 'EUR',
      projectId: '',
      paymentMethod: 'BANK_UAH_FOP',
      walletUsdtErc20: '0xW',
      walletUsdtLabel: 'main',
      bankUahRecipient: 'Ann FOP',
      bankUahIban: 'UA123',
      bankUahRnokpp: '1234567890',
      bankUahBankName: 'Mono',
      teamTelegramChannel: '',
      teamMode: 'CREATE_NEW',
      dropTeamId: '',
      dropSharePercent: 12,
      teamTelegramChannelDrop: '',
      legalFullName: 'Ann Legal',
      registrationAddress: 'Kyiv',
    })
  })

  it('hrOnly is ignored when a user is present (role comes from the user)', () => {
    const jr = { ...FULL_USER, role: 'JUNIOR', paymentMethod: null } as unknown as UserProfileDto
    const out = buildUserDialogDefaults(jr, { hrOnly: true })
    expect(out.role).toBe('JUNIOR')
    expect(out.paymentMethod).toBe('BANK_UAH_FOP')
  })

  it('user with null/missing optionals -> falls back to the documented defaults', () => {
    const sparse = {
      id: 'u2',
      email: 'bob@x.com',
      displayName: 'Bob',
      role: 'JUNIOR',
      telegram: null,
      phone: null,
      techStack: null,
      seniorSharePercent: null,
      monthlySalary: null,
      salaryCurrency: null,
      paymentMethod: null,
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
      dropSharePercent: null,
      legalFullName: null,
      registrationAddress: null,
    } as unknown as UserProfileDto
    expect(buildUserDialogDefaults(sparse, { hrOnly: false })).toStrictEqual({
      ...BLANK_COMMON,
      email: 'bob@x.com',
      displayName: 'Bob',
      role: 'JUNIOR',
      paymentMethod: 'BANK_UAH_FOP',
    })
  })

  it.each([
    ['SENIOR', 'USDT_ERC20'],
    ['ADMIN', 'USDT_ERC20'],
    ['JUNIOR', 'BANK_UAH_FOP'],
    ['HR', 'BANK_UAH_FOP'],
    ['ACCOUNTANT', 'BANK_UAH_FOP'],
    ['DROP', 'BANK_UAH_FOP'],
  ])('role %s with null paymentMethod -> %s', (role, expected) => {
    const u = { ...FULL_USER, role, paymentMethod: null } as unknown as UserProfileDto
    expect(buildUserDialogDefaults(u, { hrOnly: false }).paymentMethod).toBe(expected)
  })

  it('an explicit paymentMethod wins over the role default', () => {
    const u = { ...FULL_USER, role: 'SENIOR', paymentMethod: 'BANK_UAH_FOP' } as UserProfileDto
    expect(buildUserDialogDefaults(u, { hrOnly: false }).paymentMethod).toBe('BANK_UAH_FOP')
    const j = { ...FULL_USER, role: 'JUNIOR', paymentMethod: 'USDT_ERC20' } as UserProfileDto
    expect(buildUserDialogDefaults(j, { hrOnly: false }).paymentMethod).toBe('USDT_ERC20')
  })
})
