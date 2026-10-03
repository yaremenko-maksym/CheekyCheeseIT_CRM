import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { CONTRACT_NAME_MESSAGES } from './document-name-registry'
import { contractNameKindSchema } from './documents'
import { renderMessage } from './notification-registry'

const UK = createI18n('uk')
const EN = createI18n('en')

const params = { contractNumber: 'CHK-11-2025' }

describe('CONTRACT_NAME_MESSAGES', () => {
  it('has exactly one descriptor per ContractNameKind, each with a non-empty message and a namespaced id', () => {
    expect(Object.keys(CONTRACT_NAME_MESSAGES).sort()).toEqual(
      [...contractNameKindSchema.options].sort(),
    )
    for (const kind of contractNameKindSchema.options) {
      const d = CONTRACT_NAME_MESSAGES[kind]
      expect(d.id).toBe(`document.contractName.${kind}`)
      expect((d.message ?? '').length).toBeGreaterThan(0)
    }
  })

  it('renders every kind in uk (contract number substituted untouched)', () => {
    expect(renderMessage(UK, CONTRACT_NAME_MESSAGES.CONTRACT_SIGNED, params)).toBe(
      'Трудовий договір CHK-11-2025',
    )
    expect(renderMessage(UK, CONTRACT_NAME_MESSAGES.CONTRACT)).toBe('Трудовий договір')
    expect(renderMessage(UK, CONTRACT_NAME_MESSAGES.CONTRACT_TO_SIGN)).toBe(
      'Трудовий договір (очікує підпису)',
    )
    expect(renderMessage(UK, CONTRACT_NAME_MESSAGES.CONTRACT_DRAFT)).toBe(
      'Трудовий договір (чернетка)',
    )
  })

  it('renders every kind in en as a second original (not the uk text)', () => {
    expect(renderMessage(EN, CONTRACT_NAME_MESSAGES.CONTRACT_SIGNED, params)).toBe(
      'Employment contract CHK-11-2025',
    )
    expect(renderMessage(EN, CONTRACT_NAME_MESSAGES.CONTRACT)).toBe('Employment contract')
    expect(renderMessage(EN, CONTRACT_NAME_MESSAGES.CONTRACT_TO_SIGN)).toBe(
      'Employment contract (awaiting signature)',
    )
    expect(renderMessage(EN, CONTRACT_NAME_MESSAGES.CONTRACT_DRAFT)).toBe(
      'Employment contract (draft)',
    )
  })
})
