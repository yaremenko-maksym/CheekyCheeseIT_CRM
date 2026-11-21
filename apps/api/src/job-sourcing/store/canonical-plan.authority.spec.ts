import { jobSourceTypeSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { ATS_SOURCE_TYPES, type MemberSnapshot, canonicalFields } from './canonical-plan'

/** sources-18 AC 6: an employer's own ATS record outranks an aggregator copy, field by field. */

function member(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    recordId: 'r1',
    revisionId: 'v1',
    receivedSeq: 1,
    receivedAt: new Date('2026-10-20T00:00:00Z'),
    provider: 'THEHUB_HTML',
    namespace: 'thehub',
    nativeId: '1',
    title: 'Go Engineer',
    companyName: 'Acme',
    location: 'Remote',
    sourceUrl: 'https://fixture.test/jobs/1',
    applicationUrl: null,
    descriptionSha256: null,
    publishedAt: null,
    tags: [],
    salary: null,
    ...over,
  }
}

const copy = member()
const ats = member({
  recordId: 'r2',
  revisionId: 'v2',
  // Older than the copy: authority, not recency, decides.
  receivedAt: new Date('2026-10-01T00:00:00Z'),
  provider: 'LEVER_ATS',
  namespace: 'lever:global:acme',
  title: 'Senior Go Engineer',
  location: 'Berlin',
  applicationUrl: 'https://jobs.lever.co/acme/x/apply',
})

describe('ATS_SOURCE_TYPES', () => {
  it('is exactly the shared source types ending _ATS', () => {
    expect([...ATS_SOURCE_TYPES].sort()).toEqual(
      [
        'ASHBY_ATS',
        'GREENHOUSE_ATS',
        'LEVER_ATS',
        'PERSONIO_ATS',
        'RECRUITEE_ATS',
        'SMARTRECRUITERS_ATS',
        'WORKABLE_ATS',
      ].sort(),
    )
    expect(ATS_SOURCE_TYPES.every((t) => jobSourceTypeSchema.options.includes(t))).toBe(true)
  })
})

describe('canonicalFields: EMPLOYER_ATS authority (sources-18)', () => {
  it('the ATS member wins title, location and apply URL over a differing aggregator copy', () => {
    const c = canonicalFields([copy, ats], null)
    expect(c.title).toBe('Senior Go Engineer')
    expect(c.titleKey).toBe('senior go engineer')
    expect(c.location).toBe('Berlin')
    expect(c.applicationUrl).toBe('https://jobs.lever.co/acme/x/apply')
    expect(c.fieldRevisions['title']).toBe('v2')
    expect(c.fieldRevisions['location']).toBe('v2')
  })

  it('two ATS members that differ are still UNKNOWN', () => {
    const other = member({
      recordId: 'r3',
      revisionId: 'v3',
      provider: 'GREENHOUSE_ATS',
      title: 'Staff Go Engineer',
    })
    const c = canonicalFields([ats, other], 'kept')
    expect(c.title).toBe('kept')
    expect(c.fieldRevisions['title']).toEqual({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
      candidates: ['r2', 'r3'],
    })
  })

  it('a field only the copy states is still taken from the copy', () => {
    const c = canonicalFields([member({ publishedAt: '2026-10-19T00:00:00.000Z' }), ats], null)
    expect(c.publishedAt).toBe('2026-10-19T00:00:00.000Z')
    expect(c.fieldRevisions['publishedAt']).toBe('v1')
  })

  it('the ATS salary wins over a differing aggregator salary (after sources-17)', () => {
    const c = canonicalFields(
      [
        member({ salary: { min: 5000, max: 6000, currency: 'EUR', period: 'MONTH' } }),
        { ...ats, salary: { min: 70000, max: 90000, currency: 'EUR', period: 'YEAR' } },
      ],
      null,
    )
    expect(c.salary).toEqual({ min: 70000, max: 90000, currency: 'EUR', period: 'YEAR' })
    expect(c.fieldRevisions['salary']).toBe('v2')
  })

  it('a copy carrying an ATS button is still an aggregator: only the provider decides', () => {
    const nlj = member({
      recordId: 'r3',
      revisionId: 'v3',
      provider: 'NEXTLEVELJOBS_HTML',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      title: 'Other Title',
    })
    expect(canonicalFields([copy, nlj], 'kept').title).toBe('kept')
  })
})
