import { describe, expect, it } from 'vitest'
import type { I18n } from '@lingui/core'
import type { Document } from '@crm/shared'
import { i18n as appI18n } from '@/lib/i18n'
import { loadCatalog } from '@/test/i18n'
import { getDocumentDisplayName } from '../document-display-name'

// The app singleton is re-activated per locale: the REAL compiled catalogs,
// the same runtime production code uses. `en` is a second original.
async function localized(locale: 'uk' | 'en'): Promise<I18n> {
  await loadCatalog(locale)
  return appI18n
}

type NameFields = Pick<Document, 'name' | 'originalName' | 'nameKind' | 'contractNumber'>

const virtual = (over: Partial<NameFields> = {}): NameFields => ({
  name: 'employee-contract',
  originalName: null,
  nameKind: 'CONTRACT_SIGNED',
  contractNumber: 'CHK-11-2025',
  ...over,
})

describe('getDocumentDisplayName', () => {
  it('renders a virtual contract in the viewer locale (uk and en are separate originals)', async () => {
    expect(getDocumentDisplayName(await localized('uk'), virtual())).toBe(
      'Трудовий договір CHK-11-2025',
    )
    expect(getDocumentDisplayName(await localized('en'), virtual())).toBe(
      'Employment contract CHK-11-2025',
    )
  })

  it('renders every number-less kind in uk', async () => {
    const uk = await localized('uk')
    const noNumber = { contractNumber: null }
    expect(getDocumentDisplayName(uk, virtual({ ...noNumber, nameKind: 'CONTRACT' }))).toBe(
      'Трудовий договір',
    )
    expect(getDocumentDisplayName(uk, virtual({ ...noNumber, nameKind: 'CONTRACT_TO_SIGN' }))).toBe(
      'Трудовий договір (до підписання)',
    )
    expect(getDocumentDisplayName(uk, virtual({ ...noNumber, nameKind: 'CONTRACT_DRAFT' }))).toBe(
      'Трудовий договір (чернетка)',
    )
  })

  it('renders every number-less kind in en', async () => {
    const en = await localized('en')
    const noNumber = { contractNumber: null }
    expect(getDocumentDisplayName(en, virtual({ ...noNumber, nameKind: 'CONTRACT' }))).toBe(
      'Employment contract',
    )
    expect(getDocumentDisplayName(en, virtual({ ...noNumber, nameKind: 'CONTRACT_TO_SIGN' }))).toBe(
      'Employment contract (awaiting signature)',
    )
    expect(getDocumentDisplayName(en, virtual({ ...noNumber, nameKind: 'CONTRACT_DRAFT' }))).toBe(
      'Employment contract (draft)',
    )
  })

  it('a real upload (nameKind null) keeps originalName, then name', async () => {
    const uk = await localized('uk')
    const real = {
      name: 'cv.pdf',
      originalName: 'Резюме.pdf',
      nameKind: null,
      contractNumber: null,
    }
    expect(getDocumentDisplayName(uk, real)).toBe('Резюме.pdf')
    expect(getDocumentDisplayName(uk, { ...real, originalName: null })).toBe('cv.pdf')
  })

  it('an older API response without the new fields still falls back to originalName ?? name', async () => {
    const uk = await localized('uk')
    expect(getDocumentDisplayName(uk, { name: 'cv.pdf', originalName: 'CV.pdf' })).toBe('CV.pdf')
    expect(getDocumentDisplayName(uk, { name: 'cv.pdf', originalName: null })).toBe('cv.pdf')
  })
})
