import { describe, expect, it } from 'vitest'
import {
  type MemberSnapshot,
  canonicalFields,
  decideAuto,
  toResolverRecord,
  trustedTokens,
} from './canonical-plan'

const GH = 'https://boards.greenhouse.io/acme/jobs/123'

function member(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    recordId: 'r1',
    revisionId: 'v1',
    receivedSeq: 1,
    receivedAt: new Date('2026-10-20T00:00:00Z'),
    provider: 'REMOTIVE_API',
    namespace: 'ns',
    nativeId: '1',
    title: 'Go Engineer',
    companyName: 'Acme',
    location: 'Remote',
    sourceUrl: 'https://fixture.test/jobs/1',
    applicationUrl: null,
    descriptionSha256: null,
    publishedAt: null,
    tags: [],
    ...over,
  }
}

describe('toResolverRecord', () => {
  it('maps a member onto the resolver’s record, apply URL never treated as verified', () => {
    expect(toResolverRecord(member({ applicationUrl: 'https://x.test/a' }))).toEqual({
      id: 'r1',
      provider: 'REMOTIVE_API',
      namespace: 'ns',
      nativeId: '1',
      company: 'Acme',
      title: 'Go Engineer',
      location: 'Remote',
      department: null,
      postingUrl: 'https://fixture.test/jobs/1',
      applicationUrl: 'https://x.test/a',
      applicationUrlVerified: false,
    })
  })

  it('treats an empty company as unknown', () => {
    expect(toResolverRecord(member({ companyName: '' })).company).toBeNull()
  })
})

describe('trustedTokens', () => {
  it('turns a vendor-hosted ATS posting URL into one ATS_JOB_KEY token', () => {
    const [token, ...rest] = trustedTokens(member({ sourceUrl: GH }))
    expect(rest).toEqual([])
    expect(token?.kind).toBe('ATS_JOB_KEY')
    expect(token?.key).toContain('123')
  })

  it('never trusts an apply URL, a homepage or a plain posting page', () => {
    expect(trustedTokens(member({ applicationUrl: GH }))).toEqual([])
    expect(trustedTokens(member({ sourceUrl: 'https://acme.test/' }))).toEqual([])
  })
})

describe('decideAuto', () => {
  const attachOk = { attach: true as const, associations: [] }
  const attachNo = {
    attach: false as const,
    reason: 'NOT_ASSOCIATED_WITH_ALL' as const,
    blockedBy: ['m'],
  }

  it('keeps a linked record whose tokens agree with its link, AUTO or CONFIRMED', () => {
    expect(
      decideAuto({ link: { opportunityId: 'o1', decision: 'AUTO' }, owners: [], attach: null }),
    ).toEqual({
      kind: 'KEEP',
      opportunityId: 'o1',
    })
    expect(
      decideAuto({
        link: { opportunityId: 'o1', decision: 'CONFIRMED' },
        owners: ['o1'],
        attach: null,
      }),
    ).toEqual({ kind: 'KEEP', opportunityId: 'o1' })
  })

  it('refuses to move a linked record onto another owner’s token: an ADMIN must decide', () => {
    expect(
      decideAuto({
        link: { opportunityId: 'o1', decision: 'CONFIRMED' },
        owners: ['o1', 'o2'],
        attach: null,
      }),
    ).toEqual({ kind: 'CONFLICT', opportunityId: 'o1', owners: ['o1', 'o2'] })
    expect(
      decideAuto({ link: { opportunityId: 'o1', decision: 'AUTO' }, owners: ['o2'], attach: null }),
    ).toEqual({ kind: 'CONFLICT', opportunityId: 'o1', owners: ['o2'] })
  })

  it('defaults an unlinked record with no trusted match to its own opportunity', () => {
    expect(decideAuto({ link: null, owners: [], attach: null })).toEqual({
      kind: 'NEW',
      reason: 'NO_TRUSTED_MATCH',
    })
  })

  it('attaches to the single owner only when associated with every member', () => {
    expect(decideAuto({ link: null, owners: ['o1'], attach: attachOk })).toEqual({
      kind: 'ATTACH',
      opportunityId: 'o1',
      associations: [],
    })
    expect(decideAuto({ link: null, owners: ['o1'], attach: attachNo })).toEqual({
      kind: 'NEW',
      reason: 'NOT_ASSOCIATED',
    })
    expect(decideAuto({ link: null, owners: ['o1'], attach: null })).toEqual({
      kind: 'NEW',
      reason: 'NOT_ASSOCIATED',
    })
  })

  it('never merges two opportunities: tokens owned by two give a distinct one', () => {
    expect(decideAuto({ link: null, owners: ['o1', 'o2'], attach: attachOk })).toEqual({
      kind: 'NEW',
      reason: 'TOKEN_CONFLICT',
    })
  })
})

describe('canonicalFields', () => {
  it('takes agreeing values and records the winning revision per field', () => {
    const a = member({
      applicationUrl: 'https://acme.test/apply',
      publishedAt: '2026-10-19T00:00:00.000Z',
      descriptionSha256: 'd'.repeat(64),
      tags: ['go', 'k8s'],
    })
    const b = member({
      recordId: 'r2',
      revisionId: 'v2',
      receivedSeq: 2,
      receivedAt: new Date('2026-10-21T00:00:00Z'),
      tags: ['k8s', 'go'],
    })
    const c = canonicalFields([a, b], null)
    expect(c).toEqual({
      title: 'Go Engineer',
      titleKey: 'go engineer',
      employerName: 'Acme',
      employerKey: 'acme',
      location: 'Remote',
      applicationUrl: 'https://acme.test/apply',
      publishedAt: '2026-10-19T00:00:00.000Z',
      descriptionSha256: 'd'.repeat(64),
      stackKeywords: ['go', 'k8s'],
      fieldRevisions: {
        title: 'v2',
        employerName: 'v2',
        location: 'v2',
        applicationUrl: 'v1',
        publishedAt: 'v1',
        descriptionSha256: 'v1',
        stackKeywords: 'v2',
      },
    })
  })

  it('leaves an equal-authority conflict UNKNOWN: null fields, previous title kept', () => {
    const a = member({ title: 'Go Engineer', location: 'Berlin' })
    const b = member({
      recordId: 'r2',
      revisionId: 'v2',
      title: 'Rust Engineer',
      location: 'Paris',
    })
    const c = canonicalFields([a, b], 'Kept Title')
    expect(c.title).toBe('Kept Title')
    expect(c.titleKey).toBe('kept title')
    expect(c.location).toBeNull()
    expect(c.fieldRevisions['title']).toEqual({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
      candidates: ['r1', 'r2'],
    })
  })

  it('falls back to the lowest record id’s title when nothing was kept, and empties absent fields', () => {
    const a = member({ recordId: 'r9', title: 'Zeta', companyName: '', location: null })
    const b = member({
      recordId: 'r3',
      revisionId: 'v3',
      title: 'Alpha',
      companyName: '',
      location: null,
    })
    const c = canonicalFields([a, b], null)
    expect(c.title).toBe('Alpha')
    expect(c.employerName).toBeNull()
    expect(c.employerKey).toBeNull()
    expect(c.stackKeywords).toEqual([])
    expect(c.fieldRevisions['employerName']).toEqual({
      status: 'UNKNOWN',
      reason: 'NO_CLAIMS',
      candidates: [],
    })
  })

  it('refuses an empty member set', () => {
    expect(() => canonicalFields([], null)).toThrow(
      new RangeError('canonicalFields: an opportunity needs a member'),
    )
  })

  it('treats a member with no tags as no claim, so the tagged member’s keywords win', () => {
    const tagged = member({ tags: ['rust'] })
    const untagged = member({ recordId: 'r2', revisionId: 'v2', tags: [] })
    const c = canonicalFields([tagged, untagged], null)
    expect(c.stackKeywords).toEqual(['rust'])
    expect(c.fieldRevisions['stackKeywords']).toBe('v1')
  })
})
