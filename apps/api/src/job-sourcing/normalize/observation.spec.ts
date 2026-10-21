import { describe, expect, it } from 'vitest'
import { buildNormalizedPosting } from './build-posting'
import {
  buildSourceObservation,
  NORMALIZER_VERSION,
  type RawObservationFields,
} from './observation'

const NOW = new Date('2026-10-20T12:00:00Z')

const base: RawObservationFields = {
  provider: 'REED_API',
  namespace: 'reed-uk',
  nativeId: '555',
  url: 'https://www.reed.co.uk/jobs/dev/555?utm_source=x',
  title: 'Backend Developer',
  companyName: 'Acme Ltd',
  location: 'London',
  description: '<p>Build <b>APIs</b></p>',
  tags: ['node', 'postgres'],
  applicationUrl: 'https://www.reed.co.uk/jobs/dev/555/apply?utm_campaign=y',
  dates: [{ raw: '03/10/2026', contract: 'REED_DMY', semantics: 'PUBLISHED' }],
  adapterVersion: 'reed@1',
}
const build = (over: Partial<RawObservationFields> = {}) =>
  buildSourceObservation({ ...base, ...over }, { now: NOW })

const ok = (over: Partial<RawObservationFields> = {}) => {
  const r = build(over)
  if (!r.ok) throw new Error(`expected an observation, got quarantine ${r.reason}`)
  return r.observation
}

describe('buildSourceObservation: shape', () => {
  it('builds a NATIVE observation carrying versions, canonical link and parsed date', () => {
    const o = ok()
    expect(o.identity).toMatchObject({
      provider: 'REED_API',
      namespace: 'reed-uk',
      nativeId: '555',
      identityKind: 'NATIVE_ID',
    })
    expect(o.sourcePostingUrl).toBe('https://www.reed.co.uk/jobs/dev/555')
    expect(o.applicationUrl).toBe('https://www.reed.co.uk/jobs/dev/555/apply?utm_campaign=y')
    expect(o.adapterVersion).toBe('reed@1')
    expect(o.normalizerVersion).toBe(NORMALIZER_VERSION)
    expect(o.normalized.publishedAt?.toISOString()).toBe('2026-10-03T00:00:00.000Z')
    expect(o.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('falls back to a URL identity, preserving declared identity params', () => {
    const o = ok({
      nativeId: null,
      url: 'https://news.example/item?id=42&utm=x',
      identityParams: ['id'],
    })
    expect(o.identity.identityKind).toBe('URL_FALLBACK')
    expect(o.sourcePostingUrl).toBe('https://news.example/item?id=42')
    expect(o.identity.identityKey).not.toBe(
      ok({ nativeId: null, url: 'https://news.example/item?id=43', identityParams: ['id'] })
        .identity.identityKey,
    )
  })

  it('display fields equal what the shipped normalizer produces (compatibility, not recomputation)', () => {
    const legacy = buildNormalizedPosting('REED_API', {
      url: base.url,
      title: base.title,
      companyName: base.companyName,
      location: base.location,
      description: base.description,
      tags: base.tags,
    })!
    const n = ok().normalized
    expect({
      title: n.title,
      companyName: n.companyName,
      companyNameNormalized: n.companyNameNormalized,
      location: n.location,
      descriptionMd: n.descriptionMd,
      tags: n.tags,
    }).toEqual({
      title: legacy.title,
      companyName: legacy.companyName,
      companyNameNormalized: legacy.companyNameNormalized,
      location: legacy.location,
      descriptionMd: legacy.descriptionMd,
      tags: legacy.tags,
    })
  })
})

describe('buildSourceObservation: quarantine', () => {
  it.each([
    ['an empty namespace', { namespace: ' ' }, 'INVALID_NAMESPACE'],
    ['neither a native id nor a link', { nativeId: null, url: null }, 'NO_IDENTITY'],
    [
      'no native id and an unsafe link',
      { nativeId: null, url: 'https://u:p@a.example/j' },
      'NO_IDENTITY',
    ],
    ['a native id but an unsafe posting link', { url: 'https://10.0.0.1/j' }, 'UNSAFE_URL'],
    ['a missing title', { title: ' ‎ ' }, 'MISSING_TITLE'],
    ['a missing employer', { companyName: null }, 'MISSING_COMPANY'],
  ] as const)('quarantines %s as %s', (_n, over, reason) => {
    expect(build(over as Partial<RawObservationFields>)).toEqual({ ok: false, reason })
  })

  it('accepts the same record once the defect is removed (the quarantine is not unconditional)', () => {
    expect(build().ok).toBe(true)
  })
})

describe('buildSourceObservation: originals and truncation flags', () => {
  const flags = (over: Partial<RawObservationFields>) => {
    const o = ok(over)
    return {
      title: o.originalFields.title,
      company: o.originalFields.companyName,
      description: o.originalFields.description,
      tags: o.originalFields.tags,
      evidence: o.evidence.map((e) => `${e.field}:${e.kind}`),
      normalized: o.normalized,
    }
  }

  it('title: display cut at 500 keeps the full original and sets displayTruncated only then', () => {
    const cut = flags({ title: 'T'.repeat(600) })
    expect(cut.normalized.title).toHaveLength(500)
    expect(cut.title).toMatchObject({
      originalLength: 600,
      truncated: false,
      displayTruncated: true,
    })
    expect(cut.title.value).toHaveLength(600)
    expect(cut.evidence).toContain('title:DISPLAY_TRUNCATED')

    const edge = flags({ title: 'T'.repeat(500) })
    expect(edge.title).toMatchObject({ truncated: false, displayTruncated: false })
    expect(edge.evidence).not.toContain('title:DISPLAY_TRUNCATED')
  })

  it('title: an original beyond the retention cap is itself truncated', () => {
    const huge = flags({ title: 'T'.repeat(3000) })
    expect(huge.title).toMatchObject({
      originalLength: 3000,
      truncated: true,
      displayTruncated: true,
    })
    expect(huge.title.value.length).toBeLessThan(3000)
  })

  it('company: 255 fits, 256 is cut', () => {
    expect(flags({ companyName: 'C'.repeat(255) }).company.displayTruncated).toBe(false)
    expect(flags({ companyName: 'C'.repeat(256) }).company.displayTruncated).toBe(true)
  })

  it('description: plain text at the 20 000 ceiling is whole, one over is flagged', () => {
    const at = flags({ description: 'd'.repeat(20_000), descriptionKind: 'text' })
    expect(at.description.displayTruncated).toBe(false)
    const over = flags({ description: 'd'.repeat(20_001), descriptionKind: 'text' })
    expect(over.description.displayTruncated).toBe(true)
    expect(over.description.value).toHaveLength(20_001)
  })

  it('description: short HTML is not flagged', () => {
    expect(flags({}).description).toMatchObject({ truncated: false, displayTruncated: false })
  })

  it('tags: 50 fit, 51 flag; one over-long tag flags', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(flags({ tags: tags(50) }).tags).toMatchObject({
      originalCount: 50,
      displayTruncated: false,
    })
    expect(flags({ tags: tags(51) }).tags).toMatchObject({
      originalCount: 51,
      displayTruncated: true,
    })
    expect(flags({ tags: ['x'.repeat(61)] }).tags.displayTruncated).toBe(true)
    expect(flags({ tags: ['x'.repeat(60)] }).tags.displayTruncated).toBe(false)
  })

  it('NUL is stripped from retained originals (Postgres text cannot hold it)', () => {
    expect(flags({ title: 'a\u0000b' }).title.value).toBe('ab')
  })
})

describe('buildSourceObservation: dates and evidence', () => {
  it('a future PUBLISHED date leaves publishedAt null, keeps the raw string, and records evidence', () => {
    const o = ok({
      dates: [{ raw: '2026-12-01T00:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
    })
    expect(o.normalized.publishedAt).toBeNull()
    expect(o.normalized.dates[0]).toMatchObject({
      raw: '2026-12-01T00:00:00Z',
      status: 'FUTURE',
      value: null,
    })
    expect(o.evidence).toContainEqual(
      expect.objectContaining({
        field: 'date.PUBLISHED',
        kind: 'DATE_UNCERTAIN',
        detail: 'FUTURE',
      }),
    )
  })

  it('a clean date produces no date evidence', () => {
    expect(ok().evidence.filter((e) => e.kind === 'DATE_UNCERTAIN')).toEqual([])
  })

  it('publishedAt comes from the PUBLISHED date only, not from UPDATED', () => {
    const o = ok({
      dates: [{ raw: '2026-10-10T00:00:00Z', contract: 'ISO_ZONED', semantics: 'UPDATED' }],
    })
    expect(o.normalized.publishedAt).toBeNull()
    expect(o.normalized.dates).toHaveLength(1)
  })

  it('an unsafe application link is dropped to null with evidence; the record survives', () => {
    const o = ok({ applicationUrl: 'https://u:p@apply.example/x' })
    expect(o.applicationUrl).toBeNull()
    expect(o.evidence).toContainEqual(
      expect.objectContaining({
        field: 'applicationUrl',
        kind: 'REJECTED_LINK',
        detail: 'USERINFO',
      }),
    )
  })
})

describe('buildSourceObservation: content hash through the real builder', () => {
  const h = (over: Partial<RawObservationFields> = {}) => ok(over).contentHash

  it('re-fetching an unchanged posting hashes the same despite volatile inputs', () => {
    const refetched = h({
      fetch: { fetchedAt: new Date('2026-10-20T12:05:00Z'), requestId: 'req-2' },
      url: 'https://www.reed.co.uk/jobs/dev/555?utm_source=other&_=17860',
      applicationUrl: 'https://www.reed.co.uk/jobs/dev/555/apply?utm_campaign=z&gclid=q',
      description: '<p>Build <b>APIs</b></p><p>Posted 4 days ago</p>',
    })
    expect(refetched).toBe(
      h({
        fetch: { fetchedAt: new Date('2026-10-19T08:00:00Z'), requestId: 'req-1' },
        description: '<p>Build <b>APIs</b></p><p>Posted 3 days ago</p>',
      }),
    )
  })

  it('a real content change hashes differently', () => {
    const ref = h()
    expect(h({ title: 'Staff Backend Developer' })).not.toBe(ref)
    expect(h({ description: '<p>Build APIs and own on-call</p>' })).not.toBe(ref)
    expect(h({ applicationUrl: 'https://www.reed.co.uk/jobs/dev/556/apply' })).not.toBe(ref)
    expect(
      h({ dates: [{ raw: '04/10/2026', contract: 'REED_DMY', semantics: 'PUBLISHED' }] }),
    ).not.toBe(ref)
  })

  it('the identity does not feed the content hash (same content, different id = same hash)', () => {
    expect(h({ nativeId: '999' })).toBe(h())
  })
})
