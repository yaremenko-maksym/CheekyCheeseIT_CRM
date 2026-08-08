import { describe, it, expect } from 'vitest'
import {
  CONTRACT_VARIABLE_DESCRIPTIONS,
  CONTRACT_VARIABLE_DESCRIPTIONS_BRACED,
  customVariableSchema,
  createContractTemplateSchema,
} from './contracts'

describe('CONTRACT_VARIABLE_DESCRIPTIONS', () => {
  it('bare-key form is camelCase only (no braces)', () => {
    for (const key of Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS)) {
      expect(key, `key "${key}" should not contain braces`).not.toMatch(/^\{\{|}}$/)
      expect(key, `key "${key}" should be camelCase`).toMatch(/^[a-z][a-zA-Z0-9]*$/)
    }
  })

  it('braced form mirrors bare-key form with {{...}} wrapping', () => {
    const bareKeys = Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS).sort()
    const bracedKeys = Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED)
      .map((k) => k.slice(2, -2))
      .sort()
    expect(bracedKeys).toEqual(bareKeys)
  })

  it('braced form keys follow {{camelCase}} pattern', () => {
    for (const key of Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED)) {
      expect(key, `braced key "${key}" must match {{camelCase}}`).toMatch(
        /^\{\{[a-z][a-zA-Z0-9]*\}\}$/,
      )
    }
  })

  it('descriptions are non-empty Russian strings', () => {
    for (const [key, desc] of Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS)) {
      expect(desc, `description for "${key}" should be non-empty`).toBeTruthy()
      expect(typeof desc).toBe('string')
    }
    for (const [key, desc] of Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED)) {
      expect(desc, `braced description for "${key}" should be non-empty`).toBeTruthy()
    }
  })

  it('contractNumber is present in bare form but absent from InterpolatableVariableKey set', () => {
    // contractNumber must exist in bare descriptions (for admin docs)
    expect(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS)).toContain('contractNumber')
    // braced form also contains it (derived from bare)
    expect(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED)).toContain('{{contractNumber}}')
  })

  it('new variables (sharePercent, rnokpp, phone, salaryCurrency, etc.) are present', () => {
    const keys = Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS)
    expect(keys).toContain('sharePercent')
    expect(keys).toContain('companySharePercent')
    expect(keys).toContain('rnokpp')
    expect(keys).toContain('phone')
    expect(keys).toContain('salaryCurrency')
    expect(keys).toContain('registrationAddress')
    expect(keys).toContain('companyRegNumber')
    expect(keys).toContain('companyVat')
    expect(keys).toContain('companyBank')
    expect(keys).toContain('companyAuthorityBasis')
  })
})

describe('customVariableSchema', () => {
  describe('valid inputs', () => {
    it('accepts key starting with letter + alphanumerics', () => {
      const result = customVariableSchema.safeParse({
        key: 'projectName',
        label: 'Название проекта',
      })
      expect(result.success).toBe(true)
    })

    it('accepts key with underscores', () => {
      const result = customVariableSchema.safeParse({
        key: 'project_name_2024',
        label: 'Проект 2024',
      })
      expect(result.success).toBe(true)
    })

    it('accepts key of exactly 50 chars (boundary)', () => {
      // 1 letter + 49 alphanum/underscore = 50 total (max allowed)
      const key = 'a' + 'b'.repeat(49)
      expect(key.length).toBe(50)
      const result = customVariableSchema.safeParse({ key, label: 'Test' })
      expect(result.success).toBe(true)
    })

    it('accepts single-char key (just the leading letter)', () => {
      const result = customVariableSchema.safeParse({ key: 'a', label: 'Short' })
      expect(result.success).toBe(true)
    })

    it('includes optional defaultValue when provided', () => {
      const result = customVariableSchema.safeParse({
        key: 'endDate',
        label: 'Дата окончания',
        defaultValue: '31.12.2026',
      })
      expect(result.success).toBe(true)
      expect(result.data?.defaultValue).toBe('31.12.2026')
    })

    it('defaultValue is absent when not provided', () => {
      const result = customVariableSchema.safeParse({
        key: 'endDate',
        label: 'Дата',
      })
      expect(result.success).toBe(true)
      expect(result.data?.defaultValue).toBeUndefined()
    })
  })

  describe('invalid inputs', () => {
    it('rejects key starting with a digit', () => {
      const result = customVariableSchema.safeParse({ key: '1project', label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects key starting with underscore', () => {
      const result = customVariableSchema.safeParse({ key: '_project', label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects key with spaces', () => {
      const result = customVariableSchema.safeParse({ key: 'my project', label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects key with hyphens', () => {
      const result = customVariableSchema.safeParse({ key: 'my-project', label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects key of 51 chars (over max)', () => {
      // regex is {0,49} for tail, so total max = 1 + 49 = 50
      const key = 'a' + 'b'.repeat(50) // 51 chars
      const result = customVariableSchema.safeParse({ key, label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects empty key', () => {
      const result = customVariableSchema.safeParse({ key: '', label: 'Test' })
      expect(result.success).toBe(false)
    })

    it('rejects empty label', () => {
      const result = customVariableSchema.safeParse({ key: 'myVar', label: '' })
      expect(result.success).toBe(false)
    })
  })
})

describe('createContractTemplateSchema', () => {
  it('defaults customVariables to [] when omitted', () => {
    const result = createContractTemplateSchema.safeParse({
      targetRole: 'SENIOR',
      bodyMarkdown: '# Contract\n\n{{employeeName}}',
    })
    expect(result.success).toBe(true)
    expect(result.data?.customVariables).toEqual([])
  })

  it('accepts customVariables array with valid entries', () => {
    const result = createContractTemplateSchema.safeParse({
      targetRole: 'HR',
      bodyMarkdown: '# HR Contract',
      customVariables: [
        { key: 'projectName', label: 'Название проекта' },
        { key: 'startDate', label: 'Дата начала', defaultValue: '01.01.2026' },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data?.customVariables).toHaveLength(2)
    expect(result.data?.customVariables[0]?.key).toBe('projectName')
    expect(result.data?.customVariables[1]?.defaultValue).toBe('01.01.2026')
  })

  it('rejects customVariables array containing invalid key', () => {
    const result = createContractTemplateSchema.safeParse({
      targetRole: 'JUNIOR',
      bodyMarkdown: '# Junior',
      customVariables: [{ key: '1badKey', label: 'Bad' }],
    })
    expect(result.success).toBe(false)
  })

  it('accepts empty customVariables array explicitly', () => {
    const result = createContractTemplateSchema.safeParse({
      targetRole: 'ACCOUNTANT',
      bodyMarkdown: '# Accountant',
      customVariables: [],
    })
    expect(result.success).toBe(true)
    expect(result.data?.customVariables).toEqual([])
  })
})
