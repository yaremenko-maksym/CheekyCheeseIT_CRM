/**
 * employee-contracts.spec.ts — unit tests for schema hardening (audit LOW fixes).
 *
 * Covers:
 *   - boundedCustomValuesSchema: max 50 keys, key regex, value max 2000
 *   - updateCustomValuesSchema: same bounds applied to PATCH payload
 */
import { describe, expect, it } from 'vitest'
import { boundedCustomValuesSchema, updateCustomValuesSchema } from './employee-contracts'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeKeys(n: number): Record<string, string> {
  const rec: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    rec[`key${i}`] = 'value'
  }
  return rec
}

// ── boundedCustomValuesSchema ─────────────────────────────────────────────────

describe('boundedCustomValuesSchema', () => {
  it('accepts an empty record', () => {
    expect(() => boundedCustomValuesSchema.parse({})).not.toThrow()
  })

  it('accepts a record with 50 valid keys', () => {
    expect(() => boundedCustomValuesSchema.parse(makeKeys(50))).not.toThrow()
  })

  it('rejects a record with 51 keys (exceeds max)', () => {
    expect(() => boundedCustomValuesSchema.parse(makeKeys(51))).toThrow()
  })

  it('accepts valid key: starts with letter, alphanumeric+underscore, max 50 chars', () => {
    expect(() =>
      boundedCustomValuesSchema.parse({ validKey: 'hello', anotherKey_1: 'world' }),
    ).not.toThrow()
  })

  it('rejects key starting with digit', () => {
    expect(() => boundedCustomValuesSchema.parse({ '1badKey': 'value' })).toThrow()
  })

  it('rejects key starting with underscore', () => {
    expect(() => boundedCustomValuesSchema.parse({ _badKey: 'value' })).toThrow()
  })

  it('rejects key with spaces', () => {
    expect(() => boundedCustomValuesSchema.parse({ 'bad key': 'value' })).toThrow()
  })

  it('rejects key with Cyrillic characters', () => {
    expect(() => boundedCustomValuesSchema.parse({ ключ: 'value' })).toThrow()
  })

  it('rejects key longer than 50 characters', () => {
    const longKey = 'a' + 'b'.repeat(50) // 51 chars
    expect(() => boundedCustomValuesSchema.parse({ [longKey]: 'value' })).toThrow()
  })

  it('accepts value up to 2000 chars', () => {
    expect(() => boundedCustomValuesSchema.parse({ myKey: 'x'.repeat(2000) })).not.toThrow()
  })

  it('rejects value longer than 2000 chars', () => {
    expect(() => boundedCustomValuesSchema.parse({ myKey: 'x'.repeat(2001) })).toThrow()
  })

  it('accepts empty string value', () => {
    expect(() => boundedCustomValuesSchema.parse({ myKey: '' })).not.toThrow()
  })
})

// ── updateCustomValuesSchema (PATCH body) ─────────────────────────────────────

describe('updateCustomValuesSchema', () => {
  it('accepts a valid customValues payload', () => {
    expect(() =>
      updateCustomValuesSchema.parse({ customValues: { firstName: 'Ivan', city: 'Kyiv' } }),
    ).not.toThrow()
  })

  it('rejects unknown key format (digit-start) in customValues', () => {
    expect(() => updateCustomValuesSchema.parse({ customValues: { '9badKey': 'value' } })).toThrow()
  })

  it('rejects customValues with 51 keys', () => {
    expect(() => updateCustomValuesSchema.parse({ customValues: makeKeys(51) })).toThrow()
  })

  it('rejects value > 2000 chars', () => {
    expect(() =>
      updateCustomValuesSchema.parse({ customValues: { myKey: 'x'.repeat(2001) } }),
    ).toThrow()
  })
})
