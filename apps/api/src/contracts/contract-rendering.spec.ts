/**
 * Unit tests for `renderContractTemplate` — the shared rendering helper used
 * both at sign-time and preview-time.
 *
 * Note: `SignedContractsService.interpolateVariables` is a thin static wrapper
 * around this function; its integration tests live in
 * `signed-contracts.service.spec.ts`. These tests target the pure function
 * directly to guarantee standalone coverage and to document the public contract
 * of the extracted helper.
 */
import { describe, expect, it } from 'vitest'
import { renderContractTemplate, type ContractRenderUserContext } from './contract-rendering'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<ContractRenderUserContext> = {}): ContractRenderUserContext {
  return {
    displayName: 'Test User',
    legalFullName: null,
    email: 'test@cc.com',
    role: 'SENIOR',
    walletUsdtErc20: '0x1234567890123456789012345678901234567890',
    walletUsdtLabel: 'Main',
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    paymentMethod: 'USDT_ERC20',
    monthlySalary: null,
    salaryCurrency: 'USD',
    ...overrides,
  }
}

const ALL_PLACEHOLDERS =
  '{{employeeName}}\n' +
  '{{employeeEmail}}\n' +
  '{{role}}\n' +
  '{{onboardingDate}}\n' +
  '{{companyName}}\n' +
  '{{walletUsdt}}\n' +
  '{{bankUahFop}}\n' +
  '{{preferredMethod}}\n' +
  '{{salary}}'

const FIXED_DATE = new Date('2026-06-04T00:00:00Z')

// ---------------------------------------------------------------------------
// Core substitution
// ---------------------------------------------------------------------------

describe('renderContractTemplate', () => {
  describe('all 8 interpolatable variables', () => {
    it('substitutes {{employeeName}} from displayName', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ displayName: 'Alice' }),
        FIXED_DATE,
      )
      expect(body).toBe('Alice')
    })

    it('substitutes {{employeeEmail}} from email', () => {
      const { body } = renderContractTemplate(
        '{{employeeEmail}}',
        makeUser({ email: 'alice@cc.com' }),
        FIXED_DATE,
      )
      expect(body).toBe('alice@cc.com')
    })

    it('substitutes {{role}} with human-readable label for each enum value', () => {
      const cases: Array<[ContractRenderUserContext['role'], string]> = [
        ['HR', 'HR'],
        ['SENIOR', 'Senior'],
        ['JUNIOR', 'Junior'],
        ['DROP', 'Drop'],
        ['ACCOUNTANT', 'Accountant'],
      ]
      for (const [role, label] of cases) {
        const { body } = renderContractTemplate('{{role}}', makeUser({ role }), FIXED_DATE)
        expect(body, `role=${role}`).toBe(label)
      }
    })

    it('substitutes {{onboardingDate}} as YYYY-MM-DD (UTC)', () => {
      const { body } = renderContractTemplate('{{onboardingDate}}', makeUser(), FIXED_DATE)
      expect(body).toBe('2026-06-04')
    })

    it('substitutes {{companyName}} as literal "Cheeky Cheese IT"', () => {
      const { body } = renderContractTemplate('{{companyName}}', makeUser(), FIXED_DATE)
      expect(body).toBe('Cheeky Cheese IT')
    })

    it('substitutes {{walletUsdt}} from walletUsdtErc20', () => {
      const wallet = '0xabcdef1234567890abcdef1234567890abcdef12'
      const { body } = renderContractTemplate(
        '{{walletUsdt}}',
        makeUser({ walletUsdtErc20: wallet }),
        FIXED_DATE,
      )
      expect(body).toBe(wallet)
    })

    it('substitutes {{bankUahFop}} by joining all 4 bank fields with ", "', () => {
      const user = makeUser({
        bankUahRecipient: 'Ivan Shevchenko',
        bankUahIban: 'UA111111111111111111111111111',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'PrivatBank',
      })
      const { body } = renderContractTemplate('{{bankUahFop}}', user, FIXED_DATE)
      expect(body).toBe('Ivan Shevchenko, UA111111111111111111111111111, 1234567890, PrivatBank')
    })

    it('substitutes {{bankUahFop}} with only the non-null bank fields', () => {
      const user = makeUser({
        bankUahRecipient: 'Ivan Shevchenko',
        bankUahIban: null,
        bankUahRnokpp: '1234567890',
        bankUahBankName: null,
      })
      const { body } = renderContractTemplate('{{bankUahFop}}', user, FIXED_DATE)
      expect(body).toBe('Ivan Shevchenko, 1234567890')
    })

    it('substitutes {{preferredMethod}} with USDT (ERC-20) for USDT_ERC20', () => {
      const { body } = renderContractTemplate(
        '{{preferredMethod}}',
        makeUser({ paymentMethod: 'USDT_ERC20' }),
        FIXED_DATE,
      )
      expect(body).toBe('USDT (ERC-20)')
    })

    it('substitutes {{preferredMethod}} with ФОП (UAH) for BANK_UAH_FOP', () => {
      const { body } = renderContractTemplate(
        '{{preferredMethod}}',
        makeUser({ paymentMethod: 'BANK_UAH_FOP' }),
        FIXED_DATE,
      )
      expect(body).toBe('ФОП (UAH)')
    })
  })

  // ---------------------------------------------------------------------------
  // Null / missing values → "не указано"
  // ---------------------------------------------------------------------------

  describe('"не указано" fallbacks', () => {
    it('uses "не указано" for null walletUsdtErc20', () => {
      const { body } = renderContractTemplate(
        '{{walletUsdt}}',
        makeUser({ walletUsdtErc20: null }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('uses "не указано" for whitespace-only walletUsdtErc20', () => {
      const { body } = renderContractTemplate(
        '{{walletUsdt}}',
        makeUser({ walletUsdtErc20: '   ' }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('uses "не указано" for all-null bank fields', () => {
      const { body } = renderContractTemplate(
        '{{bankUahFop}}',
        makeUser({
          bankUahRecipient: null,
          bankUahIban: null,
          bankUahRnokpp: null,
          bankUahBankName: null,
        }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('uses "не указано" for null paymentMethod', () => {
      const { body } = renderContractTemplate(
        '{{preferredMethod}}',
        makeUser({ paymentMethod: null }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('uses "не указано" for null displayName', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ displayName: null }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })
  })

  // ---------------------------------------------------------------------------
  // AC1: legalFullName fallback chain (spec §4.3 Option A)
  // Priority: legalFullName?.trim() → displayName → 'не указано'
  // ---------------------------------------------------------------------------

  describe('AC1: legalFullName priority chain for {{employeeName}}', () => {
    it('uses legalFullName when both legalFullName and displayName are present', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: 'Шевченко Іван Миколайович', displayName: 'Ivan Shevchenko' }),
        FIXED_DATE,
      )
      // legalFullName takes priority over displayName (AC1)
      expect(body).toBe('Шевченко Іван Миколайович')
    })

    it('falls back to displayName when legalFullName is null', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: null, displayName: 'Ivan Shevchenko' }),
        FIXED_DATE,
      )
      expect(body).toBe('Ivan Shevchenko')
    })

    it('falls back to displayName when legalFullName is empty string', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: '', displayName: 'Ivan Shevchenko' }),
        FIXED_DATE,
      )
      expect(body).toBe('Ivan Shevchenko')
    })

    it('falls back to displayName when legalFullName is whitespace-only', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: '   ', displayName: 'Ivan Shevchenko' }),
        FIXED_DATE,
      )
      expect(body).toBe('Ivan Shevchenko')
    })

    it('uses "не указано" when both legalFullName and displayName are null', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: null, displayName: null }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('trims leading/trailing whitespace from legalFullName before using it', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: '  Коваленко Олена  ', displayName: 'Olena' }),
        FIXED_DATE,
      )
      expect(body).toBe('Коваленко Олена')
    })

    it('variables snapshot uses legalFullName value for employeeName key', () => {
      const { variables } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ legalFullName: 'Бойко Петро Іванович', displayName: 'Petro Boiko' }),
        FIXED_DATE,
      )
      expect(variables.employeeName).toBe('Бойко Петро Іванович')
    })
  })

  // ---------------------------------------------------------------------------
  // {{salary}} placeholder (monthlySalary + salaryCurrency)
  // ---------------------------------------------------------------------------

  describe('{{salary}} placeholder', () => {
    it('renders "<amount> <currency>" from monthlySalary + salaryCurrency', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: '800.00', salaryCurrency: 'USD' }),
        FIXED_DATE,
      )
      expect(body).toBe('800 USD')
    })

    it('strips trailing .00 from integer amounts', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: '1200.00', salaryCurrency: 'EUR' }),
        FIXED_DATE,
      )
      expect(body).toBe('1200 EUR')
    })

    it('keeps decimal part when it is non-zero (e.g. 1234.50)', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: '1234.50', salaryCurrency: 'USD' }),
        FIXED_DATE,
      )
      expect(body).toBe('1234.50 USD')
    })

    it('uses fallback "не указано" when monthlySalary is null', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: null, salaryCurrency: 'USD' }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('uses fallback "не указано" when monthlySalary is empty string', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        // Drizzle numeric can return empty string for null in some paths
        makeUser({ monthlySalary: '' as unknown as null, salaryCurrency: 'USD' }),
        FIXED_DATE,
      )
      expect(body).toBe('не указано')
    })

    it('defaults to USD currency when salaryCurrency is null', () => {
      const { body } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: '500.00', salaryCurrency: null }),
        FIXED_DATE,
      )
      expect(body).toBe('500 USD')
    })

    it('salary key is present in variables snapshot', () => {
      const { variables } = renderContractTemplate(
        '{{salary}}',
        makeUser({ monthlySalary: '800.00', salaryCurrency: 'USD' }),
        FIXED_DATE,
      )
      expect(variables.salary).toBe('800 USD')
    })
  })

  // ---------------------------------------------------------------------------
  // Variables snapshot returned
  // ---------------------------------------------------------------------------

  describe('variables snapshot', () => {
    it('returns all interpolatable keys in the variables map (including salary)', () => {
      const { variables } = renderContractTemplate(ALL_PLACEHOLDERS, makeUser(), FIXED_DATE)
      const keys = Object.keys(variables)
      expect(keys).toContain('employeeName')
      expect(keys).toContain('employeeEmail')
      expect(keys).toContain('role')
      expect(keys).toContain('onboardingDate')
      expect(keys).toContain('companyName')
      expect(keys).toContain('walletUsdt')
      expect(keys).toContain('bankUahFop')
      expect(keys).toContain('preferredMethod')
      expect(keys).toContain('salary')
      // contractNumber is generated server-side, NOT part of interpolatable variables
      expect(keys).not.toContain('contractNumber')
    })

    it('variables snapshot matches rendered values', () => {
      const user = makeUser({ displayName: 'Olena Kovalenko', email: 'olena@cc.com' })
      const { body, variables } = renderContractTemplate(
        '{{employeeName}} / {{employeeEmail}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe(`${variables.employeeName} / ${variables.employeeEmail}`)
    })
  })

  // ---------------------------------------------------------------------------
  // Unknown tokens
  // ---------------------------------------------------------------------------

  describe('unknown tokens', () => {
    it('leaves unrecognised {{token}} intact (visible to admin for debugging)', () => {
      const { body } = renderContractTemplate(
        'Hello {{unknownToken}} world',
        makeUser(),
        FIXED_DATE,
      )
      expect(body).toBe('Hello {{unknownToken}} world')
    })

    it('substitutes known tokens even when unknown tokens are present in the same body', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}} / {{unknownToken}}',
        makeUser({ displayName: 'Alice' }),
        FIXED_DATE,
      )
      expect(body).toBe('Alice / {{unknownToken}}')
    })
  })

  // ---------------------------------------------------------------------------
  // SECURITY: single-pass substitution prevents second-round injection
  // ---------------------------------------------------------------------------

  describe('SECURITY: single-pass substitution (template injection prevention)', () => {
    it('user-controlled value "{{walletUsdt}}" in displayName is NOT re-substituted', () => {
      // Malicious user sets displayName = '{{walletUsdt}}' hoping to inject
      // another field's value. Single-pass regex prevents this.
      const user = makeUser({
        displayName: '{{walletUsdt}}',
        walletUsdtErc20: '0xSECRET',
      })
      const { body } = renderContractTemplate(
        'Name: {{employeeName}}\nWallet: {{walletUsdt}}',
        user,
        FIXED_DATE,
      )
      // employeeName slot = literal string '{{walletUsdt}}' (NOT re-resolved)
      // walletUsdt slot = real wallet
      expect(body).toBe('Name: {{walletUsdt}}\nWallet: 0xSECRET')
    })

    it('user-controlled value "{{companyName}}" in email is NOT re-substituted', () => {
      const user = makeUser({ email: '{{companyName}}' })
      const { body } = renderContractTemplate(
        'Email: {{employeeEmail}}\nCompany: {{companyName}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe('Email: {{companyName}}\nCompany: Cheeky Cheese IT')
    })
  })
})
