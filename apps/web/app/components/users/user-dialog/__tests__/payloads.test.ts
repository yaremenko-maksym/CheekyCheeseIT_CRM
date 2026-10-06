import { describe, expect, it } from 'vitest'
import {
  buildCreateDropPayload,
  buildCreateUserPayload,
  buildEditUpdatePayload,
  buildWizardUpdatePayload,
  computeMonthlySalaryUsd,
  type CreateDropFormValue,
  type CreateUserFormValue,
  type EditUserFormValue,
  type WizardUpdateFormValue,
} from '../payloads'
import type { UserProfileDto } from '@crm/shared'
import type { Currency } from '@/components/ui/amount-currency-input'
import type { ExchangeRates } from '../validation'

// Fixed rate sample: 1 USD = 41 UAH, 1 EUR = 44.5 UAH.
const RATES: ExchangeRates = {
  usdUah: '41',
  usdtUah: '41',
  eurUah: '44.5',
  date: '2026-10-06',
}

// ── computeMonthlySalaryUsd ────────────────────────────────────────────────
describe('computeMonthlySalaryUsd', () => {
  const run = (monthlySalary: unknown, salaryCurrency: Currency = 'USD', rates?: ExchangeRates) =>
    computeMonthlySalaryUsd({ monthlySalary, salaryCurrency, exchangeRates: rates })

  it('returns null for an empty or blank value', () => {
    expect(run('', 'USD', RATES)).toBeNull()
    expect(run('   ', 'USD', RATES)).toBeNull()
  })

  it('returns null for a non-numeric or malformed value', () => {
    expect(run('abc', 'USD', RATES)).toBeNull()
    expect(run('1,5', 'USD', RATES)).toBeNull()
  })

  it('returns null for a negative value', () => {
    expect(run('-5', 'USD', RATES)).toBeNull()
  })

  it('keeps zero (not negative, finite)', () => {
    expect(run('0', 'USD', RATES)).toBe(0)
  })

  it('returns null for a non-finite value', () => {
    expect(run('9'.repeat(400), 'USD', RATES)).toBeNull()
  })

  it('passes the number through unrounded when no exchange rates are loaded', () => {
    expect(run('1500.555', 'UAH')).toBe(1500.555)
  })

  it('stringifies non-string input (number) before parsing', () => {
    expect(run(1500, 'USD', RATES)).toBe(1500)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(run('  200  ', 'USD', RATES)).toBe(200)
  })

  it('rounds to 2 decimals for USD / USDT passthrough', () => {
    expect(run('123.456', 'USD', RATES)).toBe(123.46)
    expect(run('123.454', 'USDT', RATES)).toBe(123.45)
  })

  it('converts UAH to USD with 2-dp rounding', () => {
    // 100 / 41 = 2.4390...
    expect(run('100', 'UAH', RATES)).toBe(2.44)
    expect(run('4100', 'UAH', RATES)).toBe(100)
  })

  it('converts EUR to USD with 2-dp rounding', () => {
    // 100 * (44.5 / 41) = 108.5365...
    expect(run('100', 'EUR', RATES)).toBe(108.54)
  })
})

// ── buildCreateUserPayload ─────────────────────────────────────────────────
function makeValue(overrides: Partial<CreateUserFormValue> = {}): CreateUserFormValue {
  return {
    email: 'user@example.com',
    personalEmail: '',
    displayName: 'Test User',
    role: 'JUNIOR',
    locale: 'uk',
    telegram: '',
    phone: '',
    techStack: [],
    seniorSharePercent: 26,
    monthlySalary: '',
    salaryCurrency: 'USD',
    projectId: '',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '',
    walletUsdtLabel: '',
    bankUahRecipient: '',
    bankUahIban: '',
    bankUahRnokpp: '',
    bankUahBankName: '',
    teamMode: 'CREATE_NEW',
    dropTeamId: '',
    legalFullName: '',
    registrationAddress: '',
    ...overrides,
  }
}

const NO_TEAM = { hrIds: [] as string[], accountantId: '', exchangeRates: RATES }

describe('buildCreateUserPayload', () => {
  it('builds the minimal JUNIOR payload (every optional key explicitly undefined)', () => {
    const payload = buildCreateUserPayload(makeValue(), NO_TEAM)
    expect(payload).toStrictEqual({
      email: 'user@example.com',
      displayName: 'Test User',
      role: 'JUNIOR',
      telegram: undefined,
      phone: undefined,
      techStack: undefined,
      locale: 'uk',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '',
    })
  })

  it('trims email / displayName and normalizes the telegram handle', () => {
    const payload = buildCreateUserPayload(
      makeValue({ email: '  a@b.co  ', displayName: '  Name  ', telegram: '  handle ' }),
      NO_TEAM,
    )
    expect(payload).toStrictEqual({
      email: 'a@b.co',
      displayName: 'Name',
      role: 'JUNIOR',
      telegram: '@handle',
      phone: undefined,
      techStack: undefined,
      locale: 'uk',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '',
    })
  })

  it('keeps an already @-prefixed telegram handle and passes phone / techStack / locale', () => {
    const payload = buildCreateUserPayload(
      makeValue({
        telegram: '@already',
        phone: '+380501234567',
        techStack: ['react', 'node'],
        locale: 'en',
      }),
      NO_TEAM,
    )
    expect(payload).toStrictEqual({
      email: 'user@example.com',
      displayName: 'Test User',
      role: 'JUNIOR',
      telegram: '@already',
      phone: '+380501234567',
      techStack: ['react', 'node'],
      locale: 'en',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '',
    })
  })

  it('treats a whitespace-only telegram as absent', () => {
    const payload = buildCreateUserPayload(makeValue({ telegram: '   ' }), NO_TEAM)
    expect(payload.telegram).toBeUndefined()
  })

  describe('personalEmail', () => {
    it('is included trimmed when present', () => {
      const payload = buildCreateUserPayload(makeValue({ personalEmail: ' me@x.io ' }), NO_TEAM)
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        personalEmail: 'me@x.io',
        displayName: 'Test User',
        role: 'JUNIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '',
      })
    })

    it('is omitted when blank / whitespace-only', () => {
      expect(
        'personalEmail' in buildCreateUserPayload(makeValue({ personalEmail: '  ' }), NO_TEAM),
      ).toBe(false)
    })
  })

  describe('payment requisites', () => {
    it('USDT: includes the trimmed wallet and omits an empty label', () => {
      const payload = buildCreateUserPayload(
        makeValue({ walletUsdtErc20: ' 0xabc ', walletUsdtLabel: '   ' }),
        NO_TEAM,
      )
      expect(payload.paymentMethod).toBe('USDT_ERC20')
      expect(payload.walletUsdtErc20).toBe('0xabc')
      expect('walletUsdtLabel' in payload).toBe(false)
    })

    it('USDT: includes the trimmed label when present', () => {
      const payload = buildCreateUserPayload(
        makeValue({ walletUsdtErc20: '0xabc', walletUsdtLabel: ' main ' }),
        NO_TEAM,
      )
      expect(payload.walletUsdtLabel).toBe('main')
    })

    it('USDT: never carries bank fields even when they are filled', () => {
      const payload = buildCreateUserPayload(
        makeValue({
          walletUsdtErc20: '0xabc',
          bankUahRecipient: 'R',
          bankUahIban: 'UA1',
          bankUahRnokpp: '1',
          bankUahBankName: 'B',
        }),
        NO_TEAM,
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'JUNIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
      })
    })

    it('BANK_UAH_FOP: full bank slice with trimmed values and bank name', () => {
      const payload = buildCreateUserPayload(
        makeValue({
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: ' Recipient ',
          bankUahIban: ' UA123 ',
          bankUahRnokpp: ' 1234567890 ',
          bankUahBankName: ' Mono ',
          walletUsdtErc20: '0xshouldnotappear',
          walletUsdtLabel: 'nope',
        }),
        NO_TEAM,
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'JUNIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Recipient',
        bankUahIban: 'UA123',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'Mono',
      })
    })

    it('BANK_UAH_FOP: omits an empty bank name', () => {
      const payload = buildCreateUserPayload(
        makeValue({
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: 'R',
          bankUahIban: 'UA1',
          bankUahRnokpp: '1',
          bankUahBankName: '  ',
        }),
        NO_TEAM,
      )
      expect('bankUahBankName' in payload).toBe(false)
      expect(payload.bankUahIban).toBe('UA1')
    })

    it.each(['SENIOR', 'ADMIN'] as const)(
      '%s is forced to USDT_ERC20 regardless of the form',
      (role) => {
        const payload = buildCreateUserPayload(
          makeValue({
            role,
            paymentMethod: 'BANK_UAH_FOP',
            bankUahIban: 'UA1',
            walletUsdtErc20: '0xw',
          }),
          NO_TEAM,
        )
        expect(payload.paymentMethod).toBe('USDT_ERC20')
        expect(payload.walletUsdtErc20).toBe('0xw')
        expect('bankUahIban' in payload).toBe(false)
      },
    )

    it.each(['HR', 'ACCOUNTANT', 'JUNIOR'] as const)('%s uses the form payment method', (role) => {
      const payload = buildCreateUserPayload(
        makeValue({ role, paymentMethod: 'BANK_UAH_FOP' }),
        NO_TEAM,
      )
      expect(payload.paymentMethod).toBe('BANK_UAH_FOP')
    })
  })

  describe('SENIOR', () => {
    it('CREATE_NEW: includes share, hrIds and accountantId; no salary / project / teamMode', () => {
      const payload = buildCreateUserPayload(
        makeValue({
          role: 'SENIOR',
          seniorSharePercent: 30,
          monthlySalary: '1000',
          projectId: 'proj-1',
          dropTeamId: 'drop-1',
        }),
        { hrIds: ['hr-1', 'hr-2'], accountantId: 'acc-1', exchangeRates: RATES },
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'SENIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '',
        seniorSharePercent: 30,
        hrIds: ['hr-1', 'hr-2'],
        accountantId: 'acc-1',
      })
    })

    it('CREATE_NEW: an empty accountantId becomes null', () => {
      const payload = buildCreateUserPayload(makeValue({ role: 'SENIOR' }), {
        hrIds: ['hr-1'],
        accountantId: '',
        exchangeRates: RATES,
      })
      expect(payload.accountantId).toBeNull()
      expect(payload.hrIds).toEqual(['hr-1'])
    })

    it('JOIN_DROP_TEAM: omits hrIds / accountantId and carries teamMode + dropTeamId', () => {
      const payload = buildCreateUserPayload(
        makeValue({ role: 'SENIOR', teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-9' }),
        { hrIds: ['hr-1'], accountantId: 'acc-1', exchangeRates: RATES },
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'SENIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '',
        seniorSharePercent: 26,
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: 'drop-9',
      })
    })

    it('non-SENIOR with JOIN_DROP_TEAM leftovers never carries team fields', () => {
      const payload = buildCreateUserPayload(
        makeValue({
          role: 'HR',
          teamMode: 'JOIN_DROP_TEAM',
          dropTeamId: 'drop-9',
          seniorSharePercent: 40,
        }),
        { hrIds: ['hr-1'], accountantId: 'acc-1', exchangeRates: RATES },
      )
      expect('hrIds' in payload).toBe(false)
      expect('accountantId' in payload).toBe(false)
      expect('teamMode' in payload).toBe(false)
      expect('dropTeamId' in payload).toBe(false)
      expect('seniorSharePercent' in payload).toBe(false)
    })
  })

  describe('monthly salary (non-SENIOR)', () => {
    it('is omitted when blank', () => {
      const payload = buildCreateUserPayload(makeValue({ monthlySalary: '   ' }), NO_TEAM)
      expect('monthlySalary' in payload).toBe(false)
      expect('salaryCurrency' in payload).toBe(false)
    })

    it('is converted to USD and salaryCurrency is pinned to USD', () => {
      const payload = buildCreateUserPayload(
        makeValue({ role: 'HR', monthlySalary: '4100', salaryCurrency: 'UAH' }),
        NO_TEAM,
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'HR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '',
        monthlySalary: 100,
        salaryCurrency: 'USD',
      })
    })

    it('uses the raw number when no rates are loaded', () => {
      const payload = buildCreateUserPayload(
        makeValue({ role: 'ACCOUNTANT', monthlySalary: '1500', salaryCurrency: 'EUR' }),
        { hrIds: [], accountantId: '', exchangeRates: undefined },
      )
      expect(payload.monthlySalary).toBe(1500)
      expect(payload.salaryCurrency).toBe('USD')
    })

    it('an unparseable non-blank salary yields monthlySalary undefined but keeps salaryCurrency', () => {
      const payload = buildCreateUserPayload(makeValue({ monthlySalary: '-5' }), NO_TEAM)
      expect('monthlySalary' in payload).toBe(true)
      expect(payload.monthlySalary).toBeUndefined()
      expect(payload.salaryCurrency).toBe('USD')
    })

    it('ADMIN gets the salary slice too (only SENIOR is excluded)', () => {
      const payload = buildCreateUserPayload(
        makeValue({ role: 'ADMIN', monthlySalary: '10' }),
        NO_TEAM,
      )
      expect(payload.monthlySalary).toBe(10)
      expect(payload.salaryCurrency).toBe('USD')
    })
  })

  describe('projectId', () => {
    it('is attached for JUNIOR when chosen', () => {
      const payload = buildCreateUserPayload(makeValue({ projectId: 'proj-1' }), NO_TEAM)
      expect(payload.projectId).toBe('proj-1')
    })

    it('is omitted for JUNIOR when not chosen', () => {
      expect('projectId' in buildCreateUserPayload(makeValue(), NO_TEAM)).toBe(false)
    })

    it.each(['HR', 'ACCOUNTANT', 'ADMIN', 'SENIOR'] as const)(
      'is omitted for %s even when a stale projectId is set',
      (role) => {
        const payload = buildCreateUserPayload(makeValue({ role, projectId: 'proj-1' }), {
          hrIds: ['hr-1'],
          accountantId: '',
          exchangeRates: RATES,
        })
        expect('projectId' in payload).toBe(false)
      },
    )
  })

  describe('contract data', () => {
    it('includes trimmed legalFullName and registrationAddress when present', () => {
      const payload = buildCreateUserPayload(
        makeValue({ legalFullName: ' Ivan Petrenko ', registrationAddress: ' Kyiv, 1 ' }),
        NO_TEAM,
      )
      expect(payload).toStrictEqual({
        email: 'user@example.com',
        displayName: 'Test User',
        role: 'JUNIOR',
        telegram: undefined,
        phone: undefined,
        techStack: undefined,
        locale: 'uk',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '',
        legalFullName: 'Ivan Petrenko',
        registrationAddress: 'Kyiv, 1',
      })
    })

    it('omits each independently when blank', () => {
      const onlyName = buildCreateUserPayload(
        makeValue({ legalFullName: 'N', registrationAddress: '  ' }),
        NO_TEAM,
      )
      expect(onlyName.legalFullName).toBe('N')
      expect('registrationAddress' in onlyName).toBe(false)

      const onlyAddr = buildCreateUserPayload(
        makeValue({ legalFullName: '  ', registrationAddress: 'A' }),
        NO_TEAM,
      )
      expect('legalFullName' in onlyAddr).toBe(false)
      expect(onlyAddr.registrationAddress).toBe('A')
    })
  })

  it('full-house JUNIOR payload (every conditional spread active)', () => {
    const payload = buildCreateUserPayload(
      makeValue({
        email: ' full@x.io ',
        personalEmail: ' p@x.io ',
        displayName: ' Full ',
        telegram: 'full_tg',
        phone: '+380671112233',
        techStack: ['go'],
        locale: 'en',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Rec',
        bankUahIban: 'UA9',
        bankUahRnokpp: '0123456789',
        bankUahBankName: 'Privat',
        monthlySalary: '8200',
        salaryCurrency: 'UAH',
        projectId: 'proj-7',
        legalFullName: 'Full Legal',
        registrationAddress: 'Addr',
      }),
      NO_TEAM,
    )
    expect(payload).toStrictEqual({
      email: 'full@x.io',
      personalEmail: 'p@x.io',
      displayName: 'Full',
      role: 'JUNIOR',
      telegram: '@full_tg',
      phone: '+380671112233',
      techStack: ['go'],
      locale: 'en',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Rec',
      bankUahIban: 'UA9',
      bankUahRnokpp: '0123456789',
      bankUahBankName: 'Privat',
      monthlySalary: 200,
      salaryCurrency: 'USD',
      projectId: 'proj-7',
      legalFullName: 'Full Legal',
      registrationAddress: 'Addr',
    })
  })
})

// ── buildCreateDropPayload ─────────────────────────────────────────────────
function makeDropValue(overrides: Partial<CreateDropFormValue> = {}): CreateDropFormValue {
  return {
    email: 'drop@example.com',
    displayName: 'Drop User',
    telegram: '',
    phone: '',
    techStack: [],
    dropSharePercent: 5,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xwallet',
    walletUsdtLabel: '',
    bankUahRecipient: '',
    bankUahIban: '',
    bankUahRnokpp: '',
    bankUahBankName: '',
    teamTelegramChannelDrop: '',
    legalFullName: '',
    registrationAddress: '',
    ...overrides,
  }
}

const DROP_DEPS = { hrIds: ['hr-1', 'hr-2'], accountantId: 'acc-1' }

describe('buildCreateDropPayload', () => {
  it('builds the minimal USDT payload (optional keys explicitly undefined / null)', () => {
    expect(buildCreateDropPayload(makeDropValue(), DROP_DEPS)).toStrictEqual({
      email: 'drop@example.com',
      displayName: 'Drop User',
      telegram: undefined,
      phone: undefined,
      dropSharePercent: 5,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xwallet',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
      telegramChannel: null,
    })
  })

  it('trims email / displayName / wallet and normalizes telegram; passes phone, share, label', () => {
    expect(
      buildCreateDropPayload(
        makeDropValue({
          email: '  a@b.co ',
          displayName: ' Name  ',
          telegram: ' handle ',
          phone: '+380501234567',
          dropSharePercent: 12,
          walletUsdtErc20: ' 0xabc ',
          walletUsdtLabel: ' main ',
        }),
        DROP_DEPS,
      ),
    ).toStrictEqual({
      email: 'a@b.co',
      displayName: 'Name',
      telegram: '@handle',
      phone: '+380501234567',
      dropSharePercent: 12,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
      telegramChannel: null,
    })
  })

  it('keeps an already @-prefixed telegram and treats a blank one as absent', () => {
    expect(buildCreateDropPayload(makeDropValue({ telegram: '@kept' }), DROP_DEPS).telegram).toBe(
      '@kept',
    )
    expect(
      buildCreateDropPayload(makeDropValue({ telegram: '   ' }), DROP_DEPS).telegram,
    ).toBeUndefined()
  })

  it('USDT: omits a blank label and never carries bank fields', () => {
    const payload = buildCreateDropPayload(
      makeDropValue({
        walletUsdtLabel: '   ',
        bankUahRecipient: 'R',
        bankUahIban: 'UA1',
        bankUahRnokpp: '1',
        bankUahBankName: 'B',
      }),
      DROP_DEPS,
    )
    expect(payload).toStrictEqual({
      email: 'drop@example.com',
      displayName: 'Drop User',
      telegram: undefined,
      phone: undefined,
      dropSharePercent: 5,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xwallet',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
      telegramChannel: null,
    })
  })

  it('BANK_UAH_FOP: full bank slice trimmed, no wallet fields', () => {
    expect(
      buildCreateDropPayload(
        makeDropValue({
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: ' Recipient ',
          bankUahIban: ' UA123 ',
          bankUahRnokpp: ' 1234567890 ',
          bankUahBankName: ' Mono ',
          walletUsdtErc20: '0xshouldnotappear',
          walletUsdtLabel: 'nope',
        }),
        DROP_DEPS,
      ),
    ).toStrictEqual({
      email: 'drop@example.com',
      displayName: 'Drop User',
      telegram: undefined,
      phone: undefined,
      dropSharePercent: 5,
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient',
      bankUahIban: 'UA123',
      bankUahRnokpp: '1234567890',
      bankUahBankName: 'Mono',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
      telegramChannel: null,
    })
  })

  it('BANK_UAH_FOP: omits a blank bank name', () => {
    const payload = buildCreateDropPayload(
      makeDropValue({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'R',
        bankUahIban: 'UA1',
        bankUahRnokpp: '1',
        bankUahBankName: '  ',
      }),
      DROP_DEPS,
    )
    expect('bankUahBankName' in payload).toBe(false)
    expect(payload.bankUahIban).toBe('UA1')
  })

  it('includes techStack only when non-empty', () => {
    expect(
      buildCreateDropPayload(makeDropValue({ techStack: ['react', 'node'] }), DROP_DEPS).techStack,
    ).toStrictEqual(['react', 'node'])
    expect('techStack' in buildCreateDropPayload(makeDropValue(), DROP_DEPS)).toBe(false)
  })

  it('accountantId: empty becomes null; hrIds passed through by reference', () => {
    const hrIds = ['hr-9']
    const payload = buildCreateDropPayload(makeDropValue(), { hrIds, accountantId: '' })
    expect(payload.accountantId).toBeNull()
    expect(payload.hrIds).toBe(hrIds)
  })

  it('telegramChannel: empty / whitespace -> null, @-prefixed -> stripped, bare -> trimmed', () => {
    const ch = (v: string) =>
      buildCreateDropPayload(makeDropValue({ teamTelegramChannelDrop: v }), DROP_DEPS)
        .telegramChannel
    expect(ch('')).toBeNull()
    expect(ch('   ')).toBeNull()
    expect(ch('@team_chan')).toBe('team_chan')
    expect(ch('  @team_chan  ')).toBe('team_chan')
    expect(ch('team_chan')).toBe('team_chan')
    expect(ch(' team_chan ')).toBe('team_chan')
    expect(ch('@')).toBe('')
  })

  it('legalFullName / registrationAddress: trimmed when present, omitted when blank', () => {
    expect(
      buildCreateDropPayload(
        makeDropValue({ legalFullName: ' Full Legal ', registrationAddress: ' Addr ' }),
        DROP_DEPS,
      ),
    ).toStrictEqual({
      email: 'drop@example.com',
      displayName: 'Drop User',
      telegram: undefined,
      phone: undefined,
      dropSharePercent: 5,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xwallet',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
      telegramChannel: null,
      legalFullName: 'Full Legal',
      registrationAddress: 'Addr',
    })
    const blank = buildCreateDropPayload(
      makeDropValue({ legalFullName: '  ', registrationAddress: '  ' }),
      DROP_DEPS,
    )
    expect('legalFullName' in blank).toBe(false)
    expect('registrationAddress' in blank).toBe(false)
  })

  it('legalFullName without registrationAddress carries only the former', () => {
    const payload = buildCreateDropPayload(makeDropValue({ legalFullName: 'Only Name' }), DROP_DEPS)
    expect(payload.legalFullName).toBe('Only Name')
    expect('registrationAddress' in payload).toBe(false)
  })
})

// ── buildWizardUpdatePayload ───────────────────────────────────────────────
function makeWizardValue(overrides: Partial<WizardUpdateFormValue> = {}): WizardUpdateFormValue {
  return {
    role: 'JUNIOR',
    displayName: 'Test User',
    telegram: '',
    phone: '',
    techStack: [],
    seniorSharePercent: 26,
    monthlySalary: '',
    salaryCurrency: 'USD',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '',
    walletUsdtLabel: '',
    bankUahRecipient: '',
    bankUahIban: '',
    bankUahRnokpp: '',
    bankUahBankName: '',
    legalFullName: '',
    registrationAddress: '',
    ...overrides,
  }
}

describe('buildWizardUpdatePayload', () => {
  it('builds the minimal non-SENIOR payload: empty fields become null, salary block present', () => {
    expect(buildWizardUpdatePayload(makeWizardValue(), NO_TEAM)).toStrictEqual({
      displayName: 'Test User',
      telegram: null,
      phone: null,
      techStack: null,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      monthlySalary: null,
      salaryCurrency: 'USD',
    })
  })

  it('SENIOR: forced USDT even if BANK selected, senior block with team, NO salary keys', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({
        role: 'SENIOR',
        paymentMethod: 'BANK_UAH_FOP',
        walletUsdtErc20: ' 0xabc ',
        walletUsdtLabel: ' main ',
        bankUahIban: 'UA123',
        seniorSharePercent: 30,
        monthlySalary: '1000',
      }),
      { hrIds: ['hr-1', 'hr-2'], accountantId: 'acc-1', exchangeRates: RATES },
    )
    expect(payload).toStrictEqual({
      displayName: 'Test User',
      telegram: null,
      phone: null,
      techStack: null,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
      seniorSharePercent: 30,
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
    })
  })

  it('SENIOR with no accountant picked sends accountantId null and keeps empty hrIds', () => {
    const payload = buildWizardUpdatePayload(makeWizardValue({ role: 'SENIOR' }), NO_TEAM)
    expect(payload.accountantId).toBeNull()
    expect(payload.hrIds).toStrictEqual([])
    expect(payload.seniorSharePercent).toBe(26)
  })

  it('ADMIN: forced USDT even if BANK selected, salary block (non-SENIOR), no senior block', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ role: 'ADMIN', paymentMethod: 'BANK_UAH_FOP', bankUahIban: 'UA1' }),
      { hrIds: ['hr-1'], accountantId: 'acc-1', exchangeRates: RATES },
    )
    expect(payload).toStrictEqual({
      displayName: 'Test User',
      telegram: null,
      phone: null,
      techStack: null,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      monthlySalary: null,
      salaryCurrency: 'USD',
    })
  })

  it('non-SENIOR keeps the chosen BANK method and trims/nulls the bank block (no USDT keys)', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({
        role: 'HR',
        paymentMethod: 'BANK_UAH_FOP',
        walletUsdtErc20: '0xignored',
        bankUahRecipient: ' FOP Ivanov ',
        bankUahIban: ' UA213223130000026007233566001 ',
        bankUahRnokpp: ' 1234567890 ',
        bankUahBankName: '   ',
      }),
      NO_TEAM,
    )
    expect(payload).toStrictEqual({
      displayName: 'Test User',
      telegram: null,
      phone: null,
      techStack: null,
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'FOP Ivanov',
      bankUahIban: 'UA213223130000026007233566001',
      bankUahRnokpp: '1234567890',
      bankUahBankName: null,
      monthlySalary: null,
      salaryCurrency: 'USD',
    })
  })

  it('bank name, when filled, is trimmed and kept', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({
        role: 'HR',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahBankName: ' Mono ',
      }),
      NO_TEAM,
    )
    expect(payload.bankUahBankName).toBe('Mono')
    expect(payload.bankUahRecipient).toBeNull()
    expect(payload.bankUahIban).toBeNull()
    expect(payload.bankUahRnokpp).toBeNull()
  })

  it('non-SENIOR salary is converted to USD via the shared helper (UAH → USD, 2 dp)', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ monthlySalary: '4100', salaryCurrency: 'UAH' }),
      NO_TEAM,
    )
    expect(payload.monthlySalary).toBe(100)
    expect(payload.salaryCurrency).toBe('USD')
  })

  it('non-SENIOR salary in EUR converts through the passed exchange rates', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ monthlySalary: '100', salaryCurrency: 'EUR' }),
      NO_TEAM,
    )
    expect(payload.monthlySalary).toBe(108.54)
  })

  it('non-SENIOR salary passes through unconverted when exchange rates are not loaded', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ monthlySalary: '1500.555', salaryCurrency: 'UAH' }),
      { hrIds: [], accountantId: '', exchangeRates: undefined },
    )
    expect(payload.monthlySalary).toBe(1500.555)
  })

  it('non-SENIOR salary that is truthy but invalid resolves to null', () => {
    const payload = buildWizardUpdatePayload(makeWizardValue({ monthlySalary: 'abc' }), NO_TEAM)
    expect(payload.monthlySalary).toBeNull()
    expect(payload.salaryCurrency).toBe('USD')
  })

  it('contact fields: displayName trimmed, telegram normalised, phone and techStack kept', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({
        displayName: '  Ann  ',
        telegram: '  ann_tg ',
        phone: '+380501234567',
        techStack: ['react', 'node'],
      }),
      NO_TEAM,
    )
    expect(payload.displayName).toBe('Ann')
    expect(payload.telegram).toBe('@ann_tg')
    expect(payload.phone).toBe('+380501234567')
    expect(payload.techStack).toStrictEqual(['react', 'node'])
  })

  it('telegram already prefixed with @ is kept as-is; whitespace-only telegram becomes null', () => {
    expect(
      buildWizardUpdatePayload(makeWizardValue({ telegram: '@ann_tg' }), NO_TEAM).telegram,
    ).toBe('@ann_tg')
    expect(buildWizardUpdatePayload(makeWizardValue({ telegram: '   ' }), NO_TEAM).telegram).toBe(
      null,
    )
  })

  it('legal data: both filled are trimmed and included', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ legalFullName: '  Ivan Ivanov ', registrationAddress: ' Kyiv, 1 ' }),
      NO_TEAM,
    )
    expect(payload.legalFullName).toBe('Ivan Ivanov')
    expect(payload.registrationAddress).toBe('Kyiv, 1')
  })

  it('legal data: blank values are omitted entirely (keys absent, not null)', () => {
    const payload = buildWizardUpdatePayload(
      makeWizardValue({ legalFullName: '   ', registrationAddress: '   ' }),
      NO_TEAM,
    )
    expect('legalFullName' in payload).toBe(false)
    expect('registrationAddress' in payload).toBe(false)
  })

  it('legalFullName without registrationAddress carries only the former, and vice versa', () => {
    const onlyName = buildWizardUpdatePayload(makeWizardValue({ legalFullName: 'N' }), NO_TEAM)
    expect(onlyName.legalFullName).toBe('N')
    expect('registrationAddress' in onlyName).toBe(false)
    const onlyAddr = buildWizardUpdatePayload(
      makeWizardValue({ registrationAddress: 'A' }),
      NO_TEAM,
    )
    expect(onlyAddr.registrationAddress).toBe('A')
    expect('legalFullName' in onlyAddr).toBe(false)
  })
})

// ── buildEditUpdatePayload ─────────────────────────────────────────────────
// Server snapshot the change-detection compares against.
const SNAPSHOT = {
  id: 'u1',
  email: 'a@x.com',
  role: 'SENIOR',
  paymentMethod: 'USDT_ERC20',
  walletUsdtErc20: '0xW',
  walletUsdtLabel: 'main',
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  seniorSharePercent: 26,
} as unknown as UserProfileDto

// Form value that mirrors SNAPSHOT exactly (nothing touched).
function makeEditValue(overrides: Partial<EditUserFormValue> = {}): EditUserFormValue {
  return {
    email: 'a@x.com',
    role: 'SENIOR',
    displayName: ' Ann ',
    telegram: '',
    phone: '',
    techStack: [],
    seniorSharePercent: 26,
    dropSharePercent: 30,
    teamTelegramChannel: '',
    monthlySalary: '',
    salaryCurrency: 'USD',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xW',
    walletUsdtLabel: 'main',
    bankUahRecipient: '',
    bankUahIban: '',
    bankUahRnokpp: '',
    bankUahBankName: '',
    legalFullName: '',
    registrationAddress: '',
    ...overrides,
  }
}

const EDIT_DEPS = {
  editingUser: SNAPSHOT,
  hrIds: ['hr1'],
  accountantId: 'acc1',
  exchangeRates: RATES,
}

describe('buildEditUpdatePayload', () => {
  it('untouched SENIOR: no email, no share, no payment slice; exact shape', () => {
    expect(buildEditUpdatePayload(makeEditValue(), EDIT_DEPS)).toStrictEqual({
      displayName: 'Ann',
      telegram: null,
      phone: null,
      techStack: null,
      hrIds: ['hr1'],
      accountantId: 'acc1',
      teamTelegramChannel: null,
      registrationAddress: null,
    })
  })

  it('email: key present (trimmed) only when it differs from the server email', () => {
    const changed = buildEditUpdatePayload(makeEditValue({ email: '  b@x.com ' }), EDIT_DEPS)
    expect(changed.email).toBe('b@x.com')
    const same = buildEditUpdatePayload(makeEditValue({ email: ' a@x.com ' }), EDIT_DEPS)
    expect('email' in same).toBe(false)
  })

  it('email: omitted when there is no server snapshot', () => {
    const p = buildEditUpdatePayload(makeEditValue({ email: 'z@x.com' }), {
      ...EDIT_DEPS,
      editingUser: null,
    })
    expect('email' in p).toBe(false)
  })

  it('shareChanged: seniorSharePercent present only when it differs from the SERVER value', () => {
    const moved = buildEditUpdatePayload(makeEditValue({ seniorSharePercent: 40 }), EDIT_DEPS)
    expect(moved.seniorSharePercent).toBe(40)
    const same = buildEditUpdatePayload(makeEditValue({ seniorSharePercent: 26 }), EDIT_DEPS)
    expect('seniorSharePercent' in same).toBe(false)
  })

  it('shareChanged: absent without a server snapshot even for a non-default value', () => {
    const p = buildEditUpdatePayload(makeEditValue({ seniorSharePercent: 40 }), {
      ...EDIT_DEPS,
      editingUser: null,
    })
    expect('seniorSharePercent' in p).toBe(false)
  })

  it('share % is never sent for a non-SENIOR role', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ role: 'JUNIOR', seniorSharePercent: 40 }),
      EDIT_DEPS,
    )
    expect('seniorSharePercent' in p).toBe(false)
    expect('hrIds' in p).toBe(false)
    expect('accountantId' in p).toBe(false)
    expect('teamTelegramChannel' in p).toBe(false)
  })

  it('SENIOR with empty accountant sends accountantId null', () => {
    const p = buildEditUpdatePayload(makeEditValue(), { ...EDIT_DEPS, accountantId: '' })
    expect(p.accountantId).toBeNull()
  })

  it('normalizedTeamChannel: blank -> null, @-prefixed stripped, bare kept, trimmed', () => {
    expect(
      buildEditUpdatePayload(makeEditValue({ teamTelegramChannel: '   ' }), EDIT_DEPS)
        .teamTelegramChannel,
    ).toBeNull()
    expect(
      buildEditUpdatePayload(makeEditValue({ teamTelegramChannel: ' @team ' }), EDIT_DEPS)
        .teamTelegramChannel,
    ).toBe('team')
    expect(
      buildEditUpdatePayload(makeEditValue({ teamTelegramChannel: 'team' }), EDIT_DEPS)
        .teamTelegramChannel,
    ).toBe('team')
  })

  it('paymentChanged: method change (USDT -> BANK) sends the BANK slice only', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: ' R ',
        bankUahIban: 'UA1',
        bankUahRnokpp: '',
        bankUahBankName: 'B',
      }),
      EDIT_DEPS,
    )
    expect(p).toMatchObject({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'R',
      bankUahIban: 'UA1',
      bankUahRnokpp: null,
      bankUahBankName: 'B',
    })
    expect('walletUsdtErc20' in p).toBe(false)
    expect('walletUsdtLabel' in p).toBe(false)
  })

  it('paymentChanged: a wallet edit sends the USDT slice only (label blank -> null)', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ walletUsdtErc20: ' 0xNEW ', walletUsdtLabel: ' ' }),
      EDIT_DEPS,
    )
    expect(p).toMatchObject({
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xNEW',
      walletUsdtLabel: null,
    })
    expect('bankUahIban' in p).toBe(false)
  })

  it('telegram: whitespace-only is treated as empty -> null', () => {
    expect(
      buildEditUpdatePayload(makeEditValue({ telegram: '   ' }), EDIT_DEPS).telegram,
    ).toBeNull()
  })

  describe('BANK_UAH_FOP server snapshot', () => {
    const BANK_SNAPSHOT = {
      ...SNAPSHOT,
      role: 'JUNIOR',
      paymentMethod: 'BANK_UAH_FOP',
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      bankUahRecipient: 'R',
      bankUahIban: 'UA1',
      bankUahRnokpp: '123',
      bankUahBankName: 'B',
    } as unknown as UserProfileDto
    const bankDeps = { ...EDIT_DEPS, editingUser: BANK_SNAPSHOT }
    const bankValue = (over: Partial<EditUserFormValue> = {}) =>
      makeEditValue({
        role: 'JUNIOR',
        paymentMethod: 'BANK_UAH_FOP',
        walletUsdtErc20: '',
        walletUsdtLabel: '',
        bankUahRecipient: 'R',
        bankUahIban: 'UA1',
        bankUahRnokpp: '123',
        bankUahBankName: 'B',
        ...over,
      })

    it('null server wallet fields vs empty form fields -> NO payment slice', () => {
      const p = buildEditUpdatePayload(bankValue(), bankDeps)
      expect('paymentMethod' in p).toBe(false)
      expect('bankUahIban' in p).toBe(false)
    })

    it('whitespace-padded copies of the server bank values -> NO payment slice', () => {
      const p = buildEditUpdatePayload(
        bankValue({
          bankUahRecipient: ' R ',
          bankUahIban: ' UA1 ',
          bankUahRnokpp: ' 123 ',
          bankUahBankName: ' B ',
        }),
        bankDeps,
      )
      expect('paymentMethod' in p).toBe(false)
    })

    it.each([
      ['bankUahRecipient', { bankUahRecipient: 'R2' }],
      ['bankUahIban', { bankUahIban: 'UA2' }],
      ['bankUahRnokpp', { bankUahRnokpp: '999' }],
      ['bankUahBankName', { bankUahBankName: 'B2' }],
    ] as const)('a lone %s change sends the full trimmed BANK slice', (_n, over) => {
      const p = buildEditUpdatePayload(
        bankValue({
          bankUahRecipient: ' R ',
          bankUahIban: ' UA1 ',
          bankUahRnokpp: ' 123 ',
          bankUahBankName: ' B ',
          ...over,
        }),
        bankDeps,
      )
      expect(p.paymentMethod).toBe('BANK_UAH_FOP')
      const expected = {
        bankUahRecipient: 'R',
        bankUahIban: 'UA1',
        bankUahRnokpp: '123',
        bankUahBankName: 'B',
        ...over,
      }
      expect(p).toMatchObject(expected)
    })

    it('blank bank values in the slice become null', () => {
      const p = buildEditUpdatePayload(
        bankValue({ bankUahIban: '  ', bankUahRnokpp: '', bankUahBankName: ' ' }),
        bankDeps,
      )
      expect(p).toMatchObject({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      })
    })
  })

  it.each([
    ['walletUsdtErc20', { walletUsdtErc20: '0xZ' }],
    ['walletUsdtLabel', { walletUsdtLabel: 'other' }],
    ['bankUahRecipient', { bankUahRecipient: 'x' }],
    ['bankUahIban', { bankUahIban: 'x' }],
    ['bankUahRnokpp', { bankUahRnokpp: 'x' }],
    ['bankUahBankName', { bankUahBankName: 'x' }],
  ] as const)('paymentChanged: a lone %s change triggers the payment slice', (_n, over) => {
    const p = buildEditUpdatePayload(makeEditValue(over), EDIT_DEPS)
    expect(p.paymentMethod).toBe('USDT_ERC20')
  })

  it('paymentChanged false: whitespace-only differences send NO payment slice', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ walletUsdtErc20: ' 0xW ', walletUsdtLabel: ' main ' }),
      EDIT_DEPS,
    )
    expect('paymentMethod' in p).toBe(false)
    expect('walletUsdtErc20' in p).toBe(false)
  })

  it('paymentChanged: null server method falls back to the role default', () => {
    const snap = { ...SNAPSHOT, paymentMethod: null } as unknown as UserProfileDto
    // SENIOR default is USDT_ERC20 -> unchanged
    const same = buildEditUpdatePayload(makeEditValue(), { ...EDIT_DEPS, editingUser: snap })
    expect('paymentMethod' in same).toBe(false)
    // JUNIOR default is BANK_UAH_FOP -> USDT form value counts as changed
    const diff = buildEditUpdatePayload(makeEditValue({ role: 'JUNIOR' }), {
      ...EDIT_DEPS,
      editingUser: snap,
    })
    expect(diff.paymentMethod).toBe('USDT_ERC20')
  })

  it('paymentChanged: no server snapshot never sends the payment slice', () => {
    const p = buildEditUpdatePayload(makeEditValue({ walletUsdtErc20: '0xOTHER' }), {
      ...EDIT_DEPS,
      editingUser: null,
    })
    expect('paymentMethod' in p).toBe(false)
  })

  it('DROP: dropSharePercent present, NO salary, NO senior fields', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ role: 'DROP', dropSharePercent: 35, monthlySalary: '100' }),
      EDIT_DEPS,
    )
    expect(p.dropSharePercent).toBe(35)
    expect('monthlySalary' in p).toBe(false)
    expect('salaryCurrency' in p).toBe(false)
    expect('hrIds' in p).toBe(false)
  })

  it('non-SENIOR non-DROP: salary converted to USD via rates, currency USD', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ role: 'JUNIOR', monthlySalary: '4100', salaryCurrency: 'UAH' }),
      EDIT_DEPS,
    )
    expect(p.monthlySalary).toBe(100)
    expect(p.salaryCurrency).toBe('USD')
    expect('dropSharePercent' in p).toBe(false)
  })

  it('non-SENIOR: blank salary sends null (clear), still with salaryCurrency USD', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ role: 'JUNIOR', monthlySalary: '' }),
      EDIT_DEPS,
    )
    expect(p.monthlySalary).toBeNull()
    expect(p.salaryCurrency).toBe('USD')
  })

  it('SENIOR never carries salary fields', () => {
    const p = buildEditUpdatePayload(makeEditValue({ monthlySalary: '100' }), EDIT_DEPS)
    expect('monthlySalary' in p).toBe(false)
    expect('salaryCurrency' in p).toBe(false)
  })

  it('telegram is normalised with @ and phone/techStack pass through', () => {
    const p = buildEditUpdatePayload(
      makeEditValue({ telegram: ' ann ', phone: '+380501112233', techStack: ['ts'] }),
      EDIT_DEPS,
    )
    expect(p.telegram).toBe('@ann')
    expect(p.phone).toBe('+380501112233')
    expect(p.techStack).toStrictEqual(['ts'])
  })

  it('legalFullName: trimmed when present, key absent when blank', () => {
    expect(
      buildEditUpdatePayload(makeEditValue({ legalFullName: ' Ivan ' }), EDIT_DEPS).legalFullName,
    ).toBe('Ivan')
    expect(
      'legalFullName' in buildEditUpdatePayload(makeEditValue({ legalFullName: '  ' }), EDIT_DEPS),
    ).toBe(false)
  })

  it('registrationAddress: ALWAYS present — trimmed value, or null when blank', () => {
    const filled = buildEditUpdatePayload(
      makeEditValue({ registrationAddress: ' Kyiv, 1 ' }),
      EDIT_DEPS,
    )
    expect(filled.registrationAddress).toBe('Kyiv, 1')
    const blank = buildEditUpdatePayload(makeEditValue({ registrationAddress: '  ' }), EDIT_DEPS)
    expect('registrationAddress' in blank).toBe(true)
    expect(blank.registrationAddress).toBeNull()
  })
})
