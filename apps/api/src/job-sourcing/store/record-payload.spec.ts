import { describe, expect, it } from 'vitest'
import type { SourceObservation } from '../normalize/observation'
import { MAX_EVIDENCE_ENTRIES, revisionPayload, validateObservation } from './record-payload'

const HASH = 'a'.repeat(64)
/** `printf 'Build things.' | shasum -a 256` */
const DESCRIPTION_SHA = 'c0c56823c9971e29c57fdbd0f6a4a78497fb24f5ae138bd98a1c3afe7a17d63b'

const DATES: SourceObservation['normalized']['dates'] = [
  { semantics: 'UPDATED', contract: 'ISO_ZONED', raw: 'u-raw', status: 'INVALID', value: null },
  {
    semantics: 'PUBLISHED',
    contract: 'ISO_ZONED',
    raw: '2026-10-20T10:00:00Z',
    status: 'OK',
    value: new Date('2026-10-20T10:00:00Z'),
  },
]

function observation(over: Partial<SourceObservation['normalized']> = {}): SourceObservation {
  return {
    identity: {
      provider: 'REMOTIVE_API',
      namespace: 'ns',
      nativeId: '42',
      identityKey: '["42"]',
      identityKind: 'NATIVE_ID',
    },
    sourcePostingUrl: 'https://fixture.test/jobs/42',
    applicationUrl: 'https://fixture.test/apply/42',
    originalFields: {} as SourceObservation['originalFields'],
    normalized: {
      title: 'Senior Go Engineer',
      companyName: 'Acme',
      companyNameNormalized: 'acme',
      location: 'Remote',
      descriptionMd: 'Build things.',
      publishedAt: new Date('2026-10-20T10:00:00Z'),
      dates: DATES,
      ...over,
    },
    evidence: [{ field: 'title', kind: 'DISPLAY_TRUNCATED', detail: 'cut' }],
    adapterVersion: 'remotive-1',
    normalizerVersion: 'n1',
    contentHash: HASH,
  }
}

describe('revisionPayload', () => {
  it('maps an observation onto the revision columns, the description content-addressed', () => {
    expect(
      revisionPayload(
        observation({
          tags: ['go'],
          remote: true,
          employmentType: 'full_time',
          seniorityHint: 'Senior',
        }),
      ),
    ).toEqual({
      adapterVersion: 'remotive-1',
      normalizerVersion: 'n1',
      contentHash: HASH,
      normalized: {
        title: 'Senior Go Engineer',
        companyName: 'Acme',
        companyNameNormalized: 'acme',
        location: 'Remote',
        publishedAt: '2026-10-20T10:00:00.000Z',
        remote: true,
        employmentType: 'full_time',
        seniorityHint: 'Senior',
        tags: ['go'],
        dates: DATES,
      },
      originalIdentity: {
        provider: 'REMOTIVE_API',
        namespace: 'ns',
        nativeId: '42',
        identityKind: 'NATIVE_ID',
        identityKey: '["42"]',
        sourcePostingUrl: 'https://fixture.test/jobs/42',
        applicationUrl: 'https://fixture.test/apply/42',
      },
      evidence: { fields: [{ field: 'title', kind: 'DISPLAY_TRUNCATED', detail: 'cut' }] },
      description: { sha256: DESCRIPTION_SHA, text: 'Build things.' },
      publishedAtRaw: '2026-10-20T10:00:00Z',
      publishedAt: '2026-10-20T10:00:00.000Z',
      sourceUrl: 'https://fixture.test/jobs/42',
      applicationUrl: 'https://fixture.test/apply/42',
    })
  })

  it('stores no blob for an empty description, and nulls for absent dates and extras', () => {
    const p = revisionPayload(observation({ descriptionMd: '', publishedAt: null, dates: [] }))
    expect(p.description).toBeNull()
    expect(p.publishedAt).toBeNull()
    expect(p.publishedAtRaw).toBeNull()
    expect(p.normalized).toMatchObject({
      publishedAt: null,
      remote: null,
      employmentType: null,
      seniorityHint: null,
      tags: [],
    })
  })
})

describe('validateObservation (SR-M-4: the store re-parses what it is handed)', () => {
  it('accepts a well-formed observation', () => {
    expect(() => validateObservation(observation())).not.toThrow()
  })

  it('refuses an identity or a revision field the store schemas reject', () => {
    const o = observation()
    expect(() =>
      validateObservation({ ...o, identity: { ...o.identity, identityKey: '' } }),
    ).toThrow()
    expect(() => validateObservation({ ...o, contentHash: 'not-hex' })).toThrow()
    expect(() => validateObservation({ ...o, adapterVersion: '' })).toThrow()
    expect(() => validateObservation({ ...o, normalizerVersion: 'v'.repeat(101) })).toThrow()
    const n = o.normalized
    expect(() =>
      validateObservation({ ...o, normalized: { ...n, title: 't'.repeat(501) } }),
    ).toThrow()
    expect(() =>
      validateObservation({ ...o, normalized: { ...n, companyName: 'c'.repeat(256) } }),
    ).toThrow()
    expect(() =>
      validateObservation({ ...o, normalized: { ...n, location: 'l'.repeat(501) } }),
    ).toThrow()
    expect(() => validateObservation({ ...o, applicationUrl: 'http://plain.test/x' })).toThrow()
    expect(() => validateObservation({ ...o, sourcePostingUrl: 'javascript:alert(1)' })).toThrow()
  })

  it('refuses more dates or evidence entries than the observation boundary produces', () => {
    const o = observation()
    const date = DATES[0] as SourceObservation['normalized']['dates'][number]
    expect(() =>
      validateObservation({ ...o, normalized: { ...o.normalized, dates: Array(9).fill(date) } }),
    ).toThrow(new RangeError('validateObservation: 9 dates, at most 8'))
    expect(() =>
      validateObservation({ ...o, normalized: { ...o.normalized, dates: Array(8).fill(date) } }),
    ).not.toThrow()
    const entry = { field: 'x', kind: 'DATE_UNCERTAIN' as const, detail: 'INVALID' }
    expect(MAX_EVIDENCE_ENTRIES).toBe(32)
    expect(() => validateObservation({ ...o, evidence: Array(33).fill(entry) })).toThrow(
      new RangeError('validateObservation: 33 evidence entries, at most 32'),
    )
    expect(() => validateObservation({ ...o, evidence: Array(32).fill(entry) })).not.toThrow()
  })

  it('refuses a description or tags beyond the display limits (20 000 chars; 50 tags of 60)', () => {
    const o = observation()
    const n = o.normalized
    const at = (over: Partial<SourceObservation['normalized']>) => () =>
      validateObservation({ ...o, normalized: { ...n, ...over } })
    expect(at({ descriptionMd: 'd'.repeat(20_000) })).not.toThrow()
    expect(at({ descriptionMd: 'd'.repeat(20_001) })).toThrow(
      new RangeError('validateObservation: description over the display limit'),
    )
    expect(at({ tags: Array(50).fill('t'.repeat(60)) })).not.toThrow()
    expect(at({ tags: Array(51).fill('t') })).toThrow(
      new RangeError('validateObservation: tags over the display limit'),
    )
    // One long tag among short ones is enough.
    expect(at({ tags: ['go', 't'.repeat(61)] })).toThrow(
      new RangeError('validateObservation: tags over the display limit'),
    )
  })
})
