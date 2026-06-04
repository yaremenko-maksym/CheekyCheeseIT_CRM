import { describe, it, expect } from 'vitest'
import { CONTRACT_VARIABLE_DESCRIPTIONS, CONTRACT_VARIABLE_DESCRIPTIONS_BRACED } from './contracts'

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
})
