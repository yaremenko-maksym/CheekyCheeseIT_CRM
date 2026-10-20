import { describe, expect, it } from 'vitest'
import { buildSourceObservation, type RawObservationFields } from './observation'

/**
 * Companion to observation.spec.ts: forwarding of every optional field, the `truncated` /
 * `displayTruncated` pair in both directions, evidence shape, tags bounds, the injected clock, and
 * the inputs the content hash must react to.
 */

const NOW = new Date('2026-10-20T12:00:00Z')

const base: RawObservationFields = {
  provider: 'REED_API',
  namespace: 'reed-uk',
  nativeId: '555',
  url: 'https://www.reed.co.uk/jobs/dev/555',
  title: 'Backend Developer',
  companyName: 'Acme Ltd',
  location: 'London',
  description: '<p>Build APIs</p>',
  tags: ['node', 'postgres'],
  applicationUrl: 'https://www.reed.co.uk/jobs/dev/555/apply',
  dates: [{ raw: '03/10/2026', contract: 'REED_DMY', semantics: 'PUBLISHED' }],
  adapterVersion: 'reed@1',
}
const ok = (over: Partial<RawObservationFields> = {}) => {
  const r = buildSourceObservation({ ...base, ...over }, { now: NOW })
  if (!r.ok) throw new Error(`expected an observation, got quarantine ${r.reason}`)
  return r.observation
}

describe('buildSourceObservation: version literal and clock', () => {
  it('stamps the normalizer version n1', () => {
    expect(ok().normalizerVersion).toBe('n1')
  })

  it('uses the injected clock: the same date is OK for a later now and FUTURE for an earlier one', () => {
    const dates = [{ raw: '2026-12-01T00:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' }]
    const later = buildSourceObservation(
      { ...base, dates },
      { now: new Date('2027-01-01T00:00:00Z') },
    )
    const earlier = buildSourceObservation({ ...base, dates }, { now: NOW })
    if (!later.ok || !earlier.ok) throw new Error('expected observations')
    expect(later.observation.normalized.dates[0]?.status).toBe('OK')
    expect(earlier.observation.normalized.dates[0]?.status).toBe('FUTURE')
  })

  it('defaults to the real clock when none is injected', () => {
    const r = buildSourceObservation({
      ...base,
      dates: [
        { raw: '2099-01-01T00:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
        { raw: '2026-01-01T00:00:00Z', contract: 'ISO_ZONED', semantics: 'UPDATED' },
      ],
    })
    if (!r.ok) throw new Error('expected an observation')
    expect(r.observation.normalized.dates.map((d) => d.status)).toEqual(['FUTURE', 'OK'])
  })
})

describe('buildSourceObservation: every optional field reaches the normalizer', () => {
  it('forwards descriptionKind, remote, employmentType and seniorityHint', () => {
    const o = ok({
      description: 'plain [text]',
      descriptionKind: 'text',
      remote: true,
      employmentType: 'Full-time',
      seniorityHint: 'Senior',
    })
    expect(o.normalized.descriptionMd).toBe('plain \\[text\\]')
    expect(o.normalized.remote).toBe(true)
    expect(o.normalized.employmentType).toBe('Full-time')
    expect(o.normalized.seniorityHint).toBe('Senior')
    expect(o.originalFields.description.kind).toBe('text')
  })

  it('description kind is html unless declared text', () => {
    expect(ok().originalFields.description.kind).toBe('html')
    expect(ok({ descriptionKind: 'html' }).originalFields.description.kind).toBe('html')
  })

  it('absent optional fields stay unknown rather than defaulting', () => {
    const o = ok({ remote: undefined, employmentType: undefined, seniorityHint: undefined })
    expect(o.normalized.remote).toBeNull()
    expect(o.normalized.employmentType).toBeNull()
    expect(o.normalized.seniorityHint).toBeNull()
  })
})

describe('buildSourceObservation: dates', () => {
  it('without a dates field there are no dates, no evidence and no publishedAt', () => {
    const o = ok({ dates: undefined })
    expect(o.normalized.dates).toEqual([])
    expect(o.normalized.publishedAt).toBeNull()
    expect(o.evidence).toEqual([])
  })

  it('an absent date input is skipped, not recorded', () => {
    const o = ok({
      dates: [
        { raw: null, contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
        { raw: '03/10/2026', contract: 'REED_DMY', semantics: 'PUBLISHED' },
      ],
    })
    expect(o.normalized.dates).toHaveLength(1)
    expect(o.normalized.publishedAt?.toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  it('publishedAt is the first PUBLISHED date that is OK, skipping an earlier unusable one', () => {
    const o = ok({
      dates: [
        { raw: '2026-12-01T00:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
        { raw: '03/10/2026', contract: 'REED_DMY', semantics: 'PUBLISHED' },
      ],
    })
    expect(o.normalized.publishedAt?.toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  it('evidence for an uncertain date names its semantics and status exactly', () => {
    const o = ok({
      dates: [{ raw: 'garbage', contract: 'ISO_ZONED', semantics: 'UPDATED' }],
    })
    expect(o.evidence).toEqual([
      { field: 'date.UPDATED', kind: 'DATE_UNCERTAIN', detail: 'INVALID' },
    ])
  })
})

describe('buildSourceObservation: application link', () => {
  it('an absent application link is null and produces no evidence', () => {
    for (const applicationUrl of [null, undefined]) {
      const o = ok({ applicationUrl })
      expect(o.applicationUrl).toBeNull()
      expect(o.evidence).toEqual([])
    }
  })

  it('a clean record has exactly no evidence', () => {
    expect(ok().evidence).toEqual([])
  })
})

describe('buildSourceObservation: location original', () => {
  it('is null when absent, blank or not a string', () => {
    expect(ok({ location: undefined }).originalFields.location).toBeNull()
    expect(ok({ location: null }).originalFields.location).toBeNull()
    expect(ok({ location: '   ' }).originalFields.location).toBeNull()
    expect(ok({ location: 5 as unknown as string }).originalFields.location).toBeNull()
  })

  it('keeps a real location with both flags false', () => {
    expect(ok().originalFields.location).toEqual({
      value: 'London',
      originalLength: 6,
      truncated: false,
      displayTruncated: false,
    })
  })

  it('location display cut at 500: 500 fits, 501 is flagged and recorded as evidence', () => {
    const fit = ok({ location: 'L'.repeat(500) })
    expect(fit.originalFields.location?.displayTruncated).toBe(false)
    expect(fit.evidence).toEqual([])
    const cut = ok({ location: 'L'.repeat(501) })
    expect(cut.originalFields.location).toMatchObject({ truncated: false, displayTruncated: true })
    expect(cut.evidence).toEqual([
      { field: 'location', kind: 'DISPLAY_TRUNCATED', detail: 'exceeds display limit' },
    ])
  })

  it('location retention cap 2000: 2000 whole, 2001 truncated', () => {
    expect(ok({ location: 'L'.repeat(2000) }).originalFields.location?.truncated).toBe(false)
    const cut = ok({ location: 'L'.repeat(2001) }).originalFields.location
    expect(cut?.truncated).toBe(true)
    expect(cut?.value).toHaveLength(2000)
  })

  it('a location made only of bidi marks is retained without crashing; its display is null', () => {
    const o = ok({ location: '‎‏' })
    expect(o.normalized.location).toBeNull()
    expect(o.originalFields.location?.value).toBe('‎‏')
  })
})

describe('buildSourceObservation: originals, NUL and whitespace', () => {
  it('strips every NUL, counts the original with them, and flags nothing for a short field', () => {
    const t = ok({ title: 'a\u0000b\u0000c' }).originalFields.title
    expect(t).toEqual({
      value: 'abc',
      originalLength: 5,
      truncated: false,
      displayTruncated: false,
    })
  })

  it('surrounding whitespace is not display truncation', () => {
    const t = ok({ title: `  ${'T'.repeat(500)}  ` }).originalFields.title
    expect(t.displayTruncated).toBe(false)
    expect(t.truncated).toBe(false)
  })

  it('title retention cap 2000: 2000 whole, 2001 truncated', () => {
    expect(ok({ title: 'T'.repeat(2000) }).originalFields.title.truncated).toBe(false)
    expect(ok({ title: 'T'.repeat(2001) }).originalFields.title.truncated).toBe(true)
  })

  it('company retention cap 1000: 1000 whole, 1001 truncated; display flag is independent', () => {
    const whole = ok({ companyName: 'C'.repeat(1000) }).originalFields.companyName
    expect(whole).toMatchObject({ truncated: false, displayTruncated: true })
    const cut = ok({ companyName: 'C'.repeat(1001) }).originalFields.companyName
    expect(cut.truncated).toBe(true)
    expect(cut.value).toHaveLength(1000)
  })

  it('a missing description is an empty original with both flags false', () => {
    for (const description of [undefined, null]) {
      expect(ok({ description }).originalFields.description).toEqual({
        value: '',
        originalLength: 0,
        truncated: false,
        displayTruncated: false,
        kind: 'html',
      })
    }
    expect(
      ok({ description: undefined, descriptionKind: 'text' }).originalFields.description,
    ).toMatchObject({ displayTruncated: false, kind: 'text' })
  })
})
