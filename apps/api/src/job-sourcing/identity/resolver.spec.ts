import { describe, expect, it } from 'vitest'
import {
  IDENTITY_RULES_VERSION,
  assess,
  canAttach,
  canonicalAuthorityPolicyVersion,
  chooseCanonical,
  clusterRecords,
  normalizeCompanyName,
  normalizeTitle,
  type FieldClaim,
  type ResolverRecord,
} from './resolver'

const GH = (id: number | string, board = 'acme') =>
  `https://boards.greenhouse.io/${board}/jobs/${id}`

function rec(id: string, over: Partial<ResolverRecord> = {}): ResolverRecord {
  return {
    id,
    provider: 'REMOTEOK',
    namespace: 'remoteok.com',
    nativeId: `native-${id}`,
    company: 'Acme',
    title: 'Senior Backend Engineer',
    location: 'Berlin',
    department: null,
    postingUrl: `https://remoteok.com/jobs/${id}`,
    applicationUrl: null,
    applicationUrlVerified: false,
    ...over,
  }
}

describe('normalizers', () => {
  it('company: case, punctuation and whitespace only; legal-form suffixes are KEPT', () => {
    expect(normalizeCompanyName('  Acme,  Inc. ')).toBe('acme inc')
    expect(normalizeCompanyName('ACME Inc')).toBe('acme inc')
    expect(normalizeCompanyName('Acme')).toBe('acme')
    expect(normalizeCompanyName('Acme')).not.toBe(normalizeCompanyName('Acme Inc'))
    expect(normalizeCompanyName('   ')).toBeNull()
    expect(normalizeCompanyName(null)).toBeNull()
  })

  it('title: hyphens/punctuation fold to spaces, case folded, and compared squashed', () => {
    expect(normalizeTitle('Full-Stack  Engineer')).toBe('full stack engineer')
    expect(normalizeTitle('Back-end Engineer (Remote)')).toBe('back end engineer remote')
    expect(normalizeTitle('')).toBe('')
  })
})

describe('assess: native identity and ATS keys', () => {
  it('same provider + namespace + native id = ASSOCIATE (rule NATIVE_ID), even when the URL changed', () => {
    const a = rec('a', { nativeId: 'n1', postingUrl: 'https://remoteok.com/jobs/old' })
    const b = rec('b', { nativeId: 'n1', postingUrl: 'https://remoteok.com/jobs/new' })
    const r = assess(a, b)
    expect(r.decision).toBe('ASSOCIATE')
    expect(r.rule).toBe('NATIVE_ID')
    expect(r.revision).toBe(IDENTITY_RULES_VERSION)
  })

  it('the same native id under a different namespace or provider is NOT one record', () => {
    const a = rec('a', { nativeId: 'n1', company: 'Acme', title: 'X' })
    expect(
      assess(a, rec('b', { nativeId: 'n1', namespace: 'other.com', company: 'Zed', title: 'Y' }))
        .decision,
    ).toBe('DISTINCT')
    expect(
      assess(a, rec('c', { nativeId: 'n1', provider: 'REMOTIVE', company: 'Zed', title: 'Y' }))
        .decision,
    ).toBe('DISTINCT')
  })

  it('null native ids never match each other', () => {
    const a = rec('a', { nativeId: null, company: 'A', title: 'T1' })
    const b = rec('b', { nativeId: null, company: 'B', title: 'T2' })
    expect(assess(a, b).decision).toBe('DISTINCT')
  })

  it('cross-source copies sharing a verified ATS job key associate (rule ATS_JOB_KEY)', () => {
    const a = rec('a', { postingUrl: GH(100) })
    const b = rec('b', {
      provider: 'REMOTIVE',
      namespace: 'remotive.com',
      postingUrl: 'https://remotive.com/j/9',
      applicationUrl: GH(100),
      applicationUrlVerified: true,
    })
    const r = assess(a, b)
    expect(r).toMatchObject({ decision: 'ASSOCIATE', rule: 'ATS_JOB_KEY' })
    expect(r.evidence).toContain('ATS_KEY:["ats1","greenhouse","acme","100"]')
  })

  it('an UNVERIFIED application URL is not identity (poisoned / tracking / unverified)', () => {
    const real = rec('a', { postingUrl: GH(100) })
    const poisoned = rec('b', {
      provider: 'REMOTIVE',
      namespace: 'remotive.com',
      company: 'Acme',
      applicationUrl: GH(100),
      applicationUrlVerified: false,
    })
    const r = assess(real, poisoned)
    expect(r.decision).not.toBe('ASSOCIATE')
  })

  it("an unverified apply URL to ANOTHER company's job cannot pull a copy into that job", () => {
    const victim = rec('victim', {
      company: 'Victim Corp',
      title: 'Dev',
      postingUrl: GH(555, 'victim'),
    })
    const spam = rec('spam', {
      provider: 'REMOTIVE',
      namespace: 'remotive.com',
      company: 'Spam LLC',
      title: 'Dev',
      applicationUrl: GH(555, 'victim'),
      applicationUrlVerified: false,
    })
    expect(assess(victim, spam).decision).toBe('DISTINCT')
  })

  it('a record whose verified apply key contradicts its own ATS posting key has no strong identity', () => {
    const self = rec('a', {
      postingUrl: GH(1),
      applicationUrl: GH(2),
      applicationUrlVerified: true,
    })
    const other1 = rec('b', { postingUrl: GH(1), nativeId: 'zz1' })
    const other2 = rec('c', { postingUrl: GH(2), nativeId: 'zz2' })
    expect(assess(self, other1).decision).not.toBe('ASSOCIATE')
    expect(assess(self, other2).decision).not.toBe('ASSOCIATE')
    expect(assess(self, other1).evidence).toContain('APPLY_URL_CONFLICT:a')
  })

  it('a shared ATS key with a contradicting company is only a CANDIDATE', () => {
    const a = rec('a', { postingUrl: GH(100), company: 'Acme' })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(100), company: 'Globex' })
    const r = assess(a, b)
    expect(r.decision).toBe('CANDIDATE')
    expect(r.rule).toBe('ATS_JOB_KEY_CONTRADICTED')
    expect(r.evidence).toContain('COMPANY_MISMATCH')
  })

  it('a shared ATS key with a contradicting title is only a CANDIDATE; hyphenation is not a contradiction', () => {
    const a = rec('a', { postingUrl: GH(100), title: 'Full-Stack Engineer' })
    const same = rec('b', { nativeId: 'x', postingUrl: GH(100), title: 'full stack engineer' })
    const squashed = rec('c', { nativeId: 'y', postingUrl: GH(100), title: 'Fullstack Engineer' })
    const other = rec('d', { nativeId: 'z', postingUrl: GH(100), title: 'Data Analyst' })
    expect(assess(a, same).decision).toBe('ASSOCIATE')
    expect(assess(a, squashed).decision).toBe('ASSOCIATE')
    const r = assess(a, other)
    expect(r.decision).toBe('CANDIDATE')
    expect(r.evidence).toContain('TITLE_MISMATCH')
  })

  it('a missing company or title on one side is not a contradiction', () => {
    const a = rec('a', { postingUrl: GH(100) })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(100), company: null, title: '' })
    expect(assess(a, b).decision).toBe('ASSOCIATE')
  })

  it('employer-host gh_jid is weak unless the application URL is verified', () => {
    const url = 'https://careers.acme.example/roles?gh_jid=77'
    const a = rec('a', { applicationUrl: url, applicationUrlVerified: false })
    const b = rec('b', { nativeId: 'x', applicationUrl: url, applicationUrlVerified: false })
    expect(assess(a, b).decision).toBe('CANDIDATE') // same company/title/city only
    const av = { ...a, applicationUrlVerified: true }
    const bv = { ...b, applicationUrlVerified: true }
    expect(assess(av, bv).decision).toBe('ASSOCIATE')
  })
})

describe('assess: same company/title is a candidate only', () => {
  it('same company + title + city, no shared id = CANDIDATE (rule COMPANY_TITLE)', () => {
    const r = assess(rec('a'), rec('b'))
    expect(r).toMatchObject({ decision: 'CANDIDATE', rule: 'COMPANY_TITLE' })
  })

  it('identical titles across different cities are DISTINCT', () => {
    expect(
      assess(rec('a', { location: 'Berlin' }), rec('b', { location: 'Lisbon' })).decision,
    ).toBe('DISTINCT')
  })

  it('identical titles across different departments are DISTINCT', () => {
    const a = rec('a', { department: 'Payments' })
    const b = rec('b', { department: 'Growth' })
    expect(assess(a, b).decision).toBe('DISTINCT')
  })

  it('an unknown city or department on one side stays a candidate', () => {
    expect(assess(rec('a', { location: null }), rec('b')).decision).toBe('CANDIDATE')
    expect(
      assess(rec('a', { department: 'Payments' }), rec('b', { department: null })).decision,
    ).toBe('CANDIDATE')
  })

  it('hyphenated roles that differ are distinct; the same role spelled with a hyphen is a candidate', () => {
    expect(
      assess(rec('a', { title: 'Front-end Engineer' }), rec('b', { title: 'Back-end Engineer' }))
        .decision,
    ).toBe('DISTINCT')
    expect(
      assess(rec('a', { title: 'Back-end Engineer' }), rec('b', { title: 'Back end engineer' }))
        .decision,
    ).toBe('CANDIDATE')
  })

  it('reposts (different ATS ids, same company/title) stay distinct records: candidate at most, never ASSOCIATE', () => {
    const a = rec('a', { postingUrl: GH(1) })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(2) })
    const r = assess(a, b)
    expect(r.decision).toBe('CANDIDATE')
    expect(r.evidence).toContain('DISTINCT_ATS_IDS')
  })

  it('subsidiaries and agencies are not collapsed on stripped suffixes', () => {
    for (const other of ['Acme Inc', 'Acme Staffing', 'Acme Robotics GmbH', 'Acme Recruitment']) {
      expect(
        assess(rec('a', { company: 'Acme' }), rec('b', { company: other })).decision,
        other,
      ).toBe('DISTINCT')
    }
  })

  it('a missing company never produces a candidate', () => {
    expect(assess(rec('a', { company: null }), rec('b', { company: null })).decision).toBe(
      'DISTINCT',
    )
  })

  it('is symmetric', () => {
    const a = rec('a', { postingUrl: GH(1) })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(1), company: 'Globex' })
    const ab = assess(a, b)
    const ba = assess(b, a)
    expect(ba).toEqual(ab)
  })
})

describe('canAttach and clusterRecords: every-member check', () => {
  const a = rec('a', { postingUrl: GH(1), company: 'Acme' })
  // b shares the ATS key with a AND a native id with c.
  const b = rec('b', {
    nativeId: 'shared',
    postingUrl: GH(1),
    company: 'Acme',
    title: 'Senior Backend Engineer',
  })
  const c = rec('c', {
    nativeId: 'shared',
    postingUrl: 'https://remoteok.com/jobs/c',
    company: 'Globex',
    title: 'Senior Backend Engineer',
  })

  it('attaches when associated with every member, with one association per member', () => {
    const d = rec('d', { nativeId: 'zz', postingUrl: GH(1) })
    const res = canAttach([a, b], d)
    const associations = res.attach ? res.associations : []
    expect(res.attach).toBe(true)
    expect(associations.map((x) => [x.aId, x.bId, x.rule])).toEqual([
      ['a', 'd', 'ATS_JOB_KEY'],
      ['b', 'd', 'ATS_JOB_KEY'],
    ])
    expect(associations.map((x) => x.revision)).toEqual([
      IDENTITY_RULES_VERSION,
      IDENTITY_RULES_VERSION,
    ])
    expect(associations.map((x) => x.actor)).toEqual(['RULES', 'RULES'])
    expect(associations.every((x) => x.evidence.length > 0)).toBe(true)
  })

  it('refuses when ONE member is only a candidate (transitive contradictory cluster) and names the blocker', () => {
    // a~b by ATS key, b~c by native id, but a and c contradict (company) => c cannot join {a,b}.
    expect(assess(a, b).decision).toBe('ASSOCIATE')
    expect(assess(b, c).decision).toBe('ASSOCIATE')
    expect(assess(a, c).decision).not.toBe('ASSOCIATE')
    const res = canAttach([a, b], c)
    expect(res).toEqual({ attach: false, reason: 'NOT_ASSOCIATED_WITH_ALL', blockedBy: ['a'] })
  })

  it('refuses an empty cluster and an existing member', () => {
    expect(canAttach([], a)).toEqual({ attach: false, reason: 'EMPTY_CLUSTER', blockedBy: [] })
    expect(canAttach([a], a)).toEqual({ attach: false, reason: 'ALREADY_MEMBER', blockedBy: ['a'] })
  })

  it('clusterRecords splits the contradictory chain and loses no record', () => {
    const clusters = clusterRecords([c, b, a])
    expect(clusters.map((x) => x.memberIds)).toEqual([['a', 'b'], ['c']])
    expect(clusters.flatMap((x) => x.memberIds).sort()).toEqual(['a', 'b', 'c'])
  })

  it('clusterRecords is independent of input order', () => {
    const forward = clusterRecords([a, b, c])
    const backward = clusterRecords([c, b, a])
    expect(backward).toEqual(forward)
  })

  it('candidates and distinct records never cluster; each is its own cluster', () => {
    const x = rec('x')
    const y = rec('y') // same company/title/city => CANDIDATE only
    const z = rec('z', { company: 'Other' })
    expect(clusterRecords([x, y, z]).map((cl) => cl.memberIds)).toEqual([['x'], ['y'], ['z']])
  })

  it('cluster associations form a clique: n members => n(n-1)/2 associations', () => {
    const d = rec('d', { nativeId: 'zz', postingUrl: GH(1) })
    const [cl] = clusterRecords([a, b, d])
    expect(cl.memberIds).toEqual(['a', 'b', 'd'])
    expect(cl.associations).toHaveLength(3)
  })
})

describe('split recovery', () => {
  const a = rec('a', { postingUrl: GH(1) })
  const b = rec('b', { nativeId: 'b', postingUrl: GH(1) })
  const c = rec('c', { nativeId: 'c', postingUrl: GH(1) })

  it('a revoked pair is never re-associated; every record and payload id survives', () => {
    const before = clusterRecords([a, b, c])
    expect(before.map((x) => x.memberIds)).toEqual([['a', 'b', 'c']])
    const after = clusterRecords([a, b, c], { revokedPairs: [['b', 'a']] })
    expect(after.map((x) => x.memberIds)).toEqual([['a', 'c'], ['b']])
    expect(after.flatMap((x) => x.memberIds).sort()).toEqual(['a', 'b', 'c'])
  })

  it('revocation overrides even a NATIVE_ID association', () => {
    const p = rec('p', { nativeId: 'same' })
    const q = rec('q', { nativeId: 'same' })
    expect(clusterRecords([p, q]).map((x) => x.memberIds)).toEqual([['p', 'q']])
    expect(clusterRecords([p, q], { revokedPairs: [['p', 'q']] }).map((x) => x.memberIds)).toEqual([
      ['p'],
      ['q'],
    ])
  })

  it('an unrelated revocation changes nothing', () => {
    expect(clusterRecords([a, b, c], { revokedPairs: [['x', 'y']] })).toEqual(
      clusterRecords([a, b, c]),
    )
  })
})

describe('chooseCanonical: authority policy', () => {
  const t = new Date('2026-10-01T00:00:00Z')
  const claim = (over: Partial<FieldClaim> & { sourceRecordId: string }): FieldClaim => ({
    authority: 'AGGREGATOR',
    value: 'v',
    observedAt: t,
    revision: 1,
    ...over,
  })

  it('exports the policy version and stamps every outcome with it', () => {
    expect(canonicalAuthorityPolicyVersion).toBe('authority-v1')
    expect(chooseCanonical([]).policyVersion).toBe('authority-v1')
    expect(chooseCanonical([claim({ sourceRecordId: 'a' })]).policyVersion).toBe('authority-v1')
  })

  it('no claims = UNKNOWN', () => {
    expect(chooseCanonical([])).toMatchObject({
      status: 'UNKNOWN',
      reason: 'NO_CLAIMS',
      candidates: [],
    })
  })

  it('employer/ATS > publisher structured > aggregator > inference', () => {
    const claims = [
      claim({ sourceRecordId: 'i', authority: 'INFERENCE', value: 'inf' }),
      claim({ sourceRecordId: 'g', authority: 'AGGREGATOR', value: 'agg' }),
      claim({ sourceRecordId: 'p', authority: 'PUBLISHER_STRUCTURED', value: 'pub' }),
      claim({ sourceRecordId: 'e', authority: 'EMPLOYER_ATS', value: 'emp' }),
    ]
    expect(chooseCanonical(claims)).toMatchObject({
      status: 'CHOSEN',
      value: 'emp',
      winnerId: 'e',
      authority: 'EMPLOYER_ATS',
      rule: 'AUTHORITY',
    })
    expect(chooseCanonical(claims.slice(0, 3))).toMatchObject({ value: 'pub' })
    expect(chooseCanonical(claims.slice(0, 2))).toMatchObject({ value: 'agg' })
    expect(chooseCanonical(claims.slice(0, 1))).toMatchObject({ value: 'inf' })
  })

  it('equal-authority conflict = UNKNOWN naming every candidate, sorted', () => {
    const r = chooseCanonical([
      claim({ sourceRecordId: 'b', value: 'x' }),
      claim({ sourceRecordId: 'a', value: 'y' }),
      claim({ sourceRecordId: 'c', authority: 'INFERENCE', value: 'z' }),
    ])
    expect(r).toMatchObject({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
      candidates: ['a', 'b'],
    })
  })

  it('equal values at the top tier agree; tie-break = newest observation, then highest revision, then lowest id', () => {
    const older = new Date('2026-09-01T00:00:00Z')
    expect(
      chooseCanonical([
        claim({ sourceRecordId: 'a', observedAt: older }),
        claim({ sourceRecordId: 'b', observedAt: t }),
      ]),
    ).toMatchObject({ winnerId: 'b' })
    expect(
      chooseCanonical([
        claim({ sourceRecordId: 'a', revision: 1 }),
        claim({ sourceRecordId: 'b', revision: 2 }),
      ]),
    ).toMatchObject({ winnerId: 'b' })
    expect(
      chooseCanonical([claim({ sourceRecordId: 'b' }), claim({ sourceRecordId: 'a' })]),
    ).toMatchObject({ winnerId: 'a' })
  })

  it('is independent of claim order', () => {
    const claims = [
      claim({ sourceRecordId: 'a', value: 'x' }),
      claim({ sourceRecordId: 'b', value: 'x' }),
      claim({ sourceRecordId: 'c', authority: 'INFERENCE', value: 'y' }),
    ]
    expect(chooseCanonical([...claims].reverse())).toEqual(chooseCanonical(claims))
  })

  it('array values compare by content', () => {
    const r = chooseCanonical([
      claim({ sourceRecordId: 'a', value: ['ts', 'go'] }),
      claim({ sourceRecordId: 'b', value: ['ts', 'go'] }),
    ])
    expect(r).toMatchObject({ status: 'CHOSEN', value: ['ts', 'go'] })
    const conflict = chooseCanonical([
      claim({ sourceRecordId: 'a', value: ['ts', 'go'] }),
      claim({ sourceRecordId: 'b', value: ['go', 'ts'] }),
    ])
    expect(conflict.status).toBe('UNKNOWN')
  })

  it('an explicit restriction dominates a permissive claim, even from a higher authority', () => {
    const r = chooseCanonical([
      claim({
        sourceRecordId: 'e',
        authority: 'EMPLOYER_ATS',
        value: 'anywhere',
        stance: 'PERMISSIVE',
      }),
      claim({
        sourceRecordId: 'g',
        authority: 'AGGREGATOR',
        value: 'EU only',
        stance: 'RESTRICTIVE',
      }),
    ])
    expect(r).toMatchObject({
      status: 'CHOSEN',
      value: 'EU only',
      winnerId: 'g',
      rule: 'RESTRICTION',
    })
  })

  it('among restrictions, authority still decides; equal-authority restrictions that differ are UNKNOWN', () => {
    expect(
      chooseCanonical([
        claim({
          sourceRecordId: 'e',
          authority: 'EMPLOYER_ATS',
          value: 'EU only',
          stance: 'RESTRICTIVE',
        }),
        claim({
          sourceRecordId: 'g',
          authority: 'AGGREGATOR',
          value: 'US only',
          stance: 'RESTRICTIVE',
        }),
      ]),
    ).toMatchObject({ value: 'EU only', rule: 'RESTRICTION' })
    expect(
      chooseCanonical([
        claim({ sourceRecordId: 'a', value: 'EU only', stance: 'RESTRICTIVE' }),
        claim({ sourceRecordId: 'b', value: 'US only', stance: 'RESTRICTIVE' }),
      ]),
    ).toMatchObject({ status: 'UNKNOWN', reason: 'EQUAL_AUTHORITY_CONFLICT' })
  })

  it('an inferred "restriction" is not explicit and does not dominate', () => {
    const r = chooseCanonical([
      claim({
        sourceRecordId: 'g',
        authority: 'AGGREGATOR',
        value: 'anywhere',
        stance: 'PERMISSIVE',
      }),
      claim({
        sourceRecordId: 'i',
        authority: 'INFERENCE',
        value: 'EU only',
        stance: 'RESTRICTIVE',
      }),
    ])
    expect(r).toMatchObject({ value: 'anywhere', rule: 'AUTHORITY' })
  })
})
