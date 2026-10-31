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
})
