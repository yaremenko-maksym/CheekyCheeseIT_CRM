import { describe, expect, it } from 'vitest'
import { buildSourceObservation } from '../normalize/observation'
import type { NormalizedPosting } from '../job-source.provider'
import { contentVersion } from './content-version'
import { DOU_NAMESPACE, douPostingToRawObservation } from './dou-observation'

/** A DOU posting as the provider returns it (already normalized). */
function douPosting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    sourceType: 'DOU_RSS',
    externalId: 'https://jobs.dou.ua/companies/acme/vacancies/42/',
    url: 'https://jobs.dou.ua/companies/acme/vacancies/42/',
    title: 'Senior TypeScript Engineer',
    companyName: 'Acme',
    companyNameNormalized: 'acme',
    location: 'Kyiv',
    descriptionMd: 'We need a senior.',
    publishedAt: new Date('2026-10-30T08:00:00.000Z'),
    fingerprint: 'fp-acme-42',
    remote: true,
    employmentType: 'FULL_TIME',
    seniorityHint: 'SENIOR',
    tags: ['typescript', 'node'],
    ...overrides,
  }
}

describe('contentVersion', () => {
  it('is a 64-char lowercase hex sha256, stable for the same content', () => {
    const v = contentVersion(douPosting())
    expect(v).toMatch(/^[0-9a-f]{64}$/)
    expect(contentVersion(douPosting())).toBe(v)
  })

  it('is independent of tag order (canonical content)', () => {
    expect(contentVersion(douPosting({ tags: ['node', 'typescript'] }))).toBe(
      contentVersion(douPosting({ tags: ['typescript', 'node'] })),
    )
  })

  it('changes when the description changes (a changed item is a new version)', () => {
    expect(contentVersion(douPosting({ descriptionMd: 'changed' }))).not.toBe(
      contentVersion(douPosting()),
    )
  })

  it('changes when the title changes', () => {
    expect(contentVersion(douPosting({ title: 'Lead Engineer' }))).not.toBe(
      contentVersion(douPosting()),
    )
  })

  it('changes when any other hashed content field changes', () => {
    const base = contentVersion(douPosting())
    for (const over of [
      { companyName: 'Globex' },
      { companyNameNormalized: 'globex' },
      { url: 'https://jobs.dou.ua/companies/acme/vacancies/99/' },
      { externalId: 'other' },
      { location: 'Lviv' },
      { remote: false },
      { employmentType: 'PART_TIME' },
      { seniorityHint: 'JUNIOR' },
      { publishedAt: new Date('2026-10-29T08:00:00.000Z') },
      { tags: ['rust'] },
    ] satisfies Partial<NormalizedPosting>[]) {
      expect(contentVersion(douPosting(over)), JSON.stringify(over)).not.toBe(base)
    }
  })

  it('normalizes an absent optional field to the same version as an explicit null (the ?? null fallbacks)', () => {
    expect(contentVersion(douPosting({ remote: undefined }))).toBe(
      contentVersion(douPosting({ remote: null })),
    )
    expect(contentVersion(douPosting({ employmentType: undefined }))).toBe(
      contentVersion(douPosting({ employmentType: null })),
    )
    expect(contentVersion(douPosting({ seniorityHint: undefined }))).toBe(
      contentVersion(douPosting({ seniorityHint: null })),
    )
  })

  it('a null publishedAt hashes without throwing (the optional-chaining guard)', () => {
    expect(contentVersion(douPosting({ publishedAt: null }))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('de-duplicates tags before hashing (the Set)', () => {
    expect(contentVersion(douPosting({ tags: ['node', 'node', 'typescript'] }))).toBe(
      contentVersion(douPosting({ tags: ['node', 'typescript'] })),
    )
  })
})

describe('douPostingToRawObservation', () => {
  it('maps a DOU posting into a RawObservationFields the store accepts', () => {
    const result = buildSourceObservation(douPostingToRawObservation(douPosting()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.identity.provider).toBe('DOU_RSS')
    expect(result.observation.identity.namespace).toBe(DOU_NAMESPACE)
    expect(result.observation.normalized.title).toBe('Senior TypeScript Engineer')
    expect(result.observation.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-30T08:00:00.000Z',
    )
  })

  it('carries the DOU provider version as adapterVersion', () => {
    const raw = douPostingToRawObservation(douPosting())
    expect(raw.provider).toBe('DOU_RSS')
    expect(raw.adapterVersion.length).toBeGreaterThan(0)
  })

  it('maps each field through verbatim, with absent optionals as null and absent tags as []', () => {
    const raw = douPostingToRawObservation(
      douPosting({
        url: 'https://jobs.dou.ua/u/',
        title: 'T',
        companyName: 'Co',
        location: 'Kyiv',
        descriptionMd: 'D',
        remote: undefined,
        employmentType: undefined,
        seniorityHint: undefined,
        tags: undefined,
      }),
    )
    expect(raw.namespace).toBe(DOU_NAMESPACE)
    expect(raw.url).toBe('https://jobs.dou.ua/u/')
    expect(raw.title).toBe('T')
    expect(raw.companyName).toBe('Co')
    expect(raw.location).toBe('Kyiv')
    expect(raw.description).toBe('D')
    expect(raw.descriptionKind).toBe('text')
    expect(raw.remote).toBeNull()
    expect(raw.employmentType).toBeNull()
    expect(raw.seniorityHint).toBeNull()
    expect(raw.tags).toEqual([])
  })

  it('passes a concrete optional field through unchanged (not the null fallback)', () => {
    const raw = douPostingToRawObservation(
      douPosting({
        remote: true,
        employmentType: 'FULL_TIME',
        seniorityHint: 'SENIOR',
        tags: ['go'],
      }),
    )
    expect(raw.remote).toBe(true)
    expect(raw.employmentType).toBe('FULL_TIME')
    expect(raw.seniorityHint).toBe('SENIOR')
    expect(raw.tags).toEqual(['go'])
  })

  it('emits a PUBLISHED date only when the posting carries one', () => {
    expect(douPostingToRawObservation(douPosting()).dates).toEqual([
      { semantics: 'PUBLISHED', contract: 'ISO_ZONED', raw: '2026-10-30T08:00:00.000Z' },
    ])
    expect(douPostingToRawObservation(douPosting({ publishedAt: null })).dates).toEqual([])
  })
})
