import { describe, expect, it } from 'vitest'
import {
  buildCreateUserPayload,
  computeMonthlySalaryUsd,
  type CreateUserFormValue,
} from '../payloads'
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
