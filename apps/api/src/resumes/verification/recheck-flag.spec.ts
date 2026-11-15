import { describe, expect, it } from 'vitest'
import { redactionInputChanged } from './recheck-flag'

const existing = { displayName: 'Olena K', legalFullName: 'Коваль Олена', telegram: '@olena' }

describe('redactionInputChanged (backlog 442)', () => {
  it('a new display name, legal name or Telegram handle is a change', () => {
    expect(redactionInputChanged(existing, { displayName: 'Olena M' })).toBe(true)
    expect(redactionInputChanged(existing, { legalFullName: 'Мороз Олена' })).toBe(true)
    expect(redactionInputChanged(existing, { telegram: '@olena_m' })).toBe(true)
  })

  it('the same values resubmitted are not a change', () => {
    expect(redactionInputChanged(existing, { ...existing, updatedAt: new Date() })).toBe(false)
  })

  it('a write that names no redaction input is not a change', () => {
    expect(redactionInputChanged(existing, { phone: '+380', techStack: ['go'] })).toBe(false)
  })

  it('null to a value and a value to null are changes; null to null is not', () => {
    expect(redactionInputChanged({ telegram: null }, { telegram: '@new' })).toBe(true)
    expect(redactionInputChanged(existing, { telegram: null })).toBe(true)
    expect(redactionInputChanged({ legalFullName: null }, { legalFullName: null })).toBe(false)
  })

  it('an absent existing value counts as null', () => {
    expect(redactionInputChanged({}, { legalFullName: null })).toBe(false)
    expect(redactionInputChanged({}, { legalFullName: 'Коваль Олена' })).toBe(true)
  })
})
