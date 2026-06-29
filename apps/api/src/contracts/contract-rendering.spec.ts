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
import {
  appendCompanyRequisitesSection,
  COMPANY_REQUISITES_HEADING,
  renderContractTemplate,
  type ContractRenderUserContext,
} from './contract-rendering'

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
    seniorSharePercent: 26,
    dropSharePercent: null,
    phone: null,
    registrationAddress: null,
    usrRecord: null,
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

    it('customValues containing "{{employeeName}}" are NOT re-substituted (single-pass)', () => {
      const user = makeUser({ displayName: 'Alice' })
      const customValues = { contractSubject: '{{employeeName}} contract' }
      const { body } = renderContractTemplate(
        'Name: {{employeeName}}\nSubject: {{contractSubject}}',
        user,
        FIXED_DATE,
        customValues,
      )
      // contractSubject is substituted as literal string — NOT re-interpolated
      expect(body).toBe('Name: Alice\nSubject: {{employeeName}} contract')
    })
  })

  // ---------------------------------------------------------------------------
  // {{sharePercent}} and {{companySharePercent}} — role-dependent split
  // ---------------------------------------------------------------------------

  describe('{{sharePercent}} and {{companySharePercent}}', () => {
    it('SENIOR: sharePercent = seniorSharePercent, companySharePercent = 100 − seniorSharePercent', () => {
      const user = makeUser({ role: 'SENIOR', seniorSharePercent: 26 })
      const { body } = renderContractTemplate(
        '{{sharePercent}} / {{companySharePercent}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe('26 / 74')
    })

    it('SENIOR with custom seniorSharePercent=30: sharePercent=30, companySharePercent=70', () => {
      const user = makeUser({ role: 'SENIOR', seniorSharePercent: 30 })
      const { body } = renderContractTemplate(
        '{{sharePercent}} / {{companySharePercent}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe('30 / 70')
    })

    it('DROP: sharePercent = dropSharePercent, companySharePercent = 100 − dropSharePercent', () => {
      const user = makeUser({ role: 'DROP', dropSharePercent: 5, seniorSharePercent: 26 })
      const { body } = renderContractTemplate(
        '{{sharePercent}} / {{companySharePercent}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe('5 / 95')
    })

    it('DROP with custom dropSharePercent=10: sharePercent=10, companySharePercent=90', () => {
      const user = makeUser({ role: 'DROP', dropSharePercent: 10, seniorSharePercent: 26 })
      const { body } = renderContractTemplate(
        '{{sharePercent}} / {{companySharePercent}}',
        user,
        FIXED_DATE,
      )
      expect(body).toBe('10 / 90')
    })

    it('DROP with null dropSharePercent: sharePercent="" and companySharePercent="" (empty fallback)', () => {
      const user = makeUser({ role: 'DROP', dropSharePercent: null, seniorSharePercent: 26 })
      const { body } = renderContractTemplate(
        '{{sharePercent}} / {{companySharePercent}}',
        user,
        FIXED_DATE,
      )
      // null dropSharePercent → treated as not applicable → '' empty string
      expect(body).toBe(' / ')
    })

    it('HR: sharePercent="" (empty string — not applicable)', () => {
      const user = makeUser({ role: 'HR', seniorSharePercent: 26, dropSharePercent: null })
      const { body } = renderContractTemplate('{{sharePercent}}', user, FIXED_DATE)
      expect(body).toBe('')
    })

    it('JUNIOR: sharePercent="" (empty string)', () => {
      const user = makeUser({ role: 'JUNIOR', seniorSharePercent: 26, dropSharePercent: null })
      const { body } = renderContractTemplate('{{sharePercent}}', user, FIXED_DATE)
      expect(body).toBe('')
    })

    it('ACCOUNTANT: companySharePercent="" (empty string)', () => {
      const user = makeUser({ role: 'ACCOUNTANT', seniorSharePercent: 26, dropSharePercent: null })
      const { body } = renderContractTemplate('{{companySharePercent}}', user, FIXED_DATE)
      expect(body).toBe('')
    })

    it('sharePercent and companySharePercent sum to 100 for SENIOR', () => {
      const user = makeUser({ role: 'SENIOR', seniorSharePercent: 26 })
      const { variables } = renderContractTemplate('', user, FIXED_DATE)
      const share = Number(variables.sharePercent)
      const company = Number(variables.companySharePercent)
      expect(share + company).toBe(100)
    })

    it('sharePercent and companySharePercent sum to 100 for DROP', () => {
      const user = makeUser({ role: 'DROP', dropSharePercent: 7, seniorSharePercent: 26 })
      const { variables } = renderContractTemplate('', user, FIXED_DATE)
      const share = Number(variables.sharePercent)
      const company = Number(variables.companySharePercent)
      expect(share + company).toBe(100)
    })
  })

  // ---------------------------------------------------------------------------
  // New simple field variables: rnokpp, phone, salaryCurrency,
  // registrationAddress, usrRecord
  // ---------------------------------------------------------------------------

  describe('new simple field variables', () => {
    it('{{rnokpp}} resolves from bankUahRnokpp', () => {
      const { body } = renderContractTemplate(
        '{{rnokpp}}',
        makeUser({ bankUahRnokpp: '1234567890' }),
        FIXED_DATE,
      )
      expect(body).toBe('1234567890')
    })

    it('{{rnokpp}} resolves to "" when bankUahRnokpp is null', () => {
      const { body } = renderContractTemplate(
        '{{rnokpp}}',
        makeUser({ bankUahRnokpp: null }),
        FIXED_DATE,
      )
      expect(body).toBe('')
    })

    it('{{phone}} resolves from phone', () => {
      const { body } = renderContractTemplate(
        '{{phone}}',
        makeUser({ phone: '+380501234567' }),
        FIXED_DATE,
      )
      expect(body).toBe('+380501234567')
    })

    it('{{phone}} resolves to "" when phone is null', () => {
      const { body } = renderContractTemplate('{{phone}}', makeUser({ phone: null }), FIXED_DATE)
      expect(body).toBe('')
    })

    it('{{salaryCurrency}} resolves from salaryCurrency', () => {
      const { body } = renderContractTemplate(
        '{{salaryCurrency}}',
        makeUser({ salaryCurrency: 'EUR' }),
        FIXED_DATE,
      )
      expect(body).toBe('EUR')
    })

    it('{{salaryCurrency}} resolves to "" when salaryCurrency is null', () => {
      const { body } = renderContractTemplate(
        '{{salaryCurrency}}',
        makeUser({ salaryCurrency: null }),
        FIXED_DATE,
      )
      expect(body).toBe('')
    })

    it('{{registrationAddress}} resolves from registrationAddress', () => {
      const { body } = renderContractTemplate(
        '{{registrationAddress}}',
        makeUser({ registrationAddress: 'м. Київ, вул. Хрещатик, 1' }),
        FIXED_DATE,
      )
      expect(body).toBe('м. Київ, вул. Хрещатик, 1')
    })

    it('{{registrationAddress}} resolves to "" when null', () => {
      const { body } = renderContractTemplate(
        '{{registrationAddress}}',
        makeUser({ registrationAddress: null }),
        FIXED_DATE,
      )
      expect(body).toBe('')
    })

    it('{{usrRecord}} resolves from usrRecord', () => {
      const { body } = renderContractTemplate(
        '{{usrRecord}}',
        makeUser({ usrRecord: '12.05.2024 №2070020000000123456' }),
        FIXED_DATE,
      )
      expect(body).toBe('12.05.2024 №2070020000000123456')
    })

    it('{{usrRecord}} resolves to "" when null', () => {
      const { body } = renderContractTemplate(
        '{{usrRecord}}',
        makeUser({ usrRecord: null }),
        FIXED_DATE,
      )
      expect(body).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Company constants: companyRegNumber, companyVat, companyBank,
  // companyAuthorityBasis — resolved from CONTRACT_COMPANY
  // ---------------------------------------------------------------------------

  describe('company constant variables', () => {
    it('{{companyRegNumber}} resolves (empty string from CONTRACT_COMPANY.regNumber)', () => {
      const { variables } = renderContractTemplate('{{companyRegNumber}}', makeUser(), FIXED_DATE)
      // Currently '' — placeholder until owner provides real value.
      expect(typeof variables.companyRegNumber).toBe('string')
    })

    it('{{companyVat}} resolves as string', () => {
      const { variables } = renderContractTemplate('{{companyVat}}', makeUser(), FIXED_DATE)
      expect(typeof variables.companyVat).toBe('string')
    })

    it('{{companyBank}} resolves as string', () => {
      const { variables } = renderContractTemplate('{{companyBank}}', makeUser(), FIXED_DATE)
      expect(typeof variables.companyBank).toBe('string')
    })

    it('{{companyAuthorityBasis}} resolves as string', () => {
      const { variables } = renderContractTemplate(
        '{{companyAuthorityBasis}}',
        makeUser(),
        FIXED_DATE,
      )
      expect(typeof variables.companyAuthorityBasis).toBe('string')
    })
  })

  // ---------------------------------------------------------------------------
  // customValues — 4th parameter substitution
  // ---------------------------------------------------------------------------

  describe('customValues parameter', () => {
    it('substitutes a custom variable from customValues', () => {
      const { body } = renderContractTemplate('Project: {{projectName}}', makeUser(), FIXED_DATE, {
        projectName: 'ACME Corp',
      })
      expect(body).toBe('Project: ACME Corp')
    })

    it('standard variables take priority over customValues with the same key', () => {
      // If someone passes a customValue with a key that matches a standard variable,
      // the standard variable always wins (order: standard → custom).
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ displayName: 'Alice' }),
        FIXED_DATE,
        { employeeName: 'INJECTED' },
      )
      // Standard variable takes priority
      expect(body).toBe('Alice')
    })

    it('unknown token remains as-is when not in standard vars and not in customValues', () => {
      const { body } = renderContractTemplate('{{unknownVar}}', makeUser(), FIXED_DATE, {
        someOtherKey: 'value',
      })
      expect(body).toBe('{{unknownVar}}')
    })

    it('unknown token is replaced when provided in customValues', () => {
      const { body } = renderContractTemplate('{{projectDuration}}', makeUser(), FIXED_DATE, {
        projectDuration: '6 месяцев',
      })
      expect(body).toBe('6 месяцев')
    })

    it('omitting customValues (undefined) works like before — backward compat', () => {
      const { body } = renderContractTemplate(
        '{{employeeName}}',
        makeUser({ displayName: 'Bob' }),
        FIXED_DATE,
      )
      expect(body).toBe('Bob')
    })

    it('multiple custom variables substituted in single pass', () => {
      const { body } = renderContractTemplate(
        '{{a}} / {{b}} / {{employeeName}}',
        makeUser({ displayName: 'Charlie' }),
        FIXED_DATE,
        { a: 'first', b: 'second' },
      )
      expect(body).toBe('first / second / Charlie')
    })
  })
})

// ---------------------------------------------------------------------------
// appendCompanyRequisitesSection — Part 2 auto-section helper
// ---------------------------------------------------------------------------
describe('appendCompanyRequisitesSection', () => {
  const BODY = '# Contract\n\nSome clauses.'

  it('appends a «Реквизиты компании» section at the END for non-empty requisites', () => {
    const requisites = 'ООО «Тест»\n\n- IBAN: UA00\n- РНОКПП: 1234567890'
    const out = appendCompanyRequisitesSection(BODY, requisites)
    expect(out).toBe(`${BODY}\n\n${COMPANY_REQUISITES_HEADING}\n\n${requisites}`)
    // The original body is a strict prefix → nothing in the contract is mutated,
    // requisites are strictly appended after it.
    expect(out.startsWith(BODY)).toBe(true)
    expect(out.endsWith(requisites)).toBe(true)
  })

  it('returns the body UNCHANGED for null requisites (no heading-only section)', () => {
    expect(appendCompanyRequisitesSection(BODY, null)).toBe(BODY)
  })

  it('returns the body UNCHANGED for undefined requisites', () => {
    expect(appendCompanyRequisitesSection(BODY, undefined)).toBe(BODY)
  })

  it('returns the body UNCHANGED for empty-string requisites', () => {
    expect(appendCompanyRequisitesSection(BODY, '')).toBe(BODY)
  })

  it('returns the body UNCHANGED for whitespace-only requisites', () => {
    expect(appendCompanyRequisitesSection(BODY, '   \n\t  ')).toBe(BODY)
    expect(appendCompanyRequisitesSection(BODY, '   \n\t  ')).not.toContain(
      COMPANY_REQUISITES_HEADING,
    )
  })

  it('preserves requisites markdown verbatim (tables / headings / lists not interpolated)', () => {
    const requisites = '| UA | EN |\n| --- | --- |\n| Назва | Name |\n\n### Підрозділ\n\n- a\n- b'
    const out = appendCompanyRequisitesSection(BODY, requisites)
    expect(out).toContain(requisites)
    // No {{token}} substitution happens here — a token in requisites stays literal.
    const withToken = appendCompanyRequisitesSection(BODY, 'IBAN {{companyBank}}')
    expect(withToken).toContain('IBAN {{companyBank}}')
  })
})
