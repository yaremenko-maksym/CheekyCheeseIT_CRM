import { describe, expect, it } from 'vitest'
import {
  IDENTITY_RULES_VERSION,
  assess,
  assessWithRevocations,
  revocationSet,
  canAttach,
  canonicalAuthorityPolicyVersion,
  chooseCanonical,
  clusterRecords,
  MAX_CLUSTER_RECORDS,
  MAX_FIELD_CHARS,
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

/** Clusters of a call that must succeed. */
function cl(records: ResolverRecord[], options?: Parameters<typeof clusterRecords>[1]) {
  const r = clusterRecords(records, options)
  if (!r.ok) throw new Error(`clusterRecords refused: ${r.reason}`)
  return r.clusters
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
    expect(r.evidence).toContain('ATS_KEY:["ats1","greenhouse","ATS_HOSTED","us:acme","100"]')
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

  it('a missing company or title on one side is not a contradiction while the other field agrees', () => {
    const a = rec('a', { postingUrl: GH(100) })
    expect(
      assess(a, rec('b', { nativeId: 'x', postingUrl: GH(100), company: null })).decision,
    ).toBe('ASSOCIATE')
    expect(assess(a, rec('c', { nativeId: 'y', postingUrl: GH(100), title: '' })).decision).toBe(
      'ASSOCIATE',
    )
  })

  it('employer-host gh_jid is never strong identity, verified or not (SR-M-2)', () => {
    const url = 'https://careers.acme.example/roles?gh_jid=77'
    const a = rec('a', { applicationUrl: url, applicationUrlVerified: false })
    const b = rec('b', { nativeId: 'x', applicationUrl: url, applicationUrlVerified: false })
    expect(assess(a, b).decision).toBe('CANDIDATE') // same company/title/city only
    const av = { ...a, applicationUrlVerified: true }
    const bv = { ...b, applicationUrlVerified: true }
    expect(assess(av, bv)).toMatchObject({ decision: 'CANDIDATE', rule: 'COMPANY_TITLE' })
    // and with contradicting companies it is not even a candidate
    expect(assess(av, { ...bv, company: 'Globex' }).decision).toBe('DISTINCT')
  })

  it('a board URL and an employer gh_jid URL for the same number do not associate (precision over recall)', () => {
    const board = rec('a', { postingUrl: GH(77) })
    const employer = rec('b', {
      nativeId: 'x',
      applicationUrl: 'https://careers.acme.example/r?gh_jid=77',
      applicationUrlVerified: true,
    })
    expect(assess(board, employer).rule).toBe('COMPANY_TITLE')
  })

  it('an employer gh_jid verified apply URL beside an ATS posting URL is not an APPLY_URL_CONFLICT', () => {
    const r = rec('a', {
      postingUrl: GH(1),
      applicationUrl: 'https://careers.acme.example/r?gh_jid=2',
      applicationUrlVerified: true,
    })
    const other = rec('b', { nativeId: 'x', postingUrl: GH(1) })
    const res = assess(r, other)
    expect(res.rule).toBe('ATS_JOB_KEY')
    expect(res.evidence.some((e) => e.startsWith('APPLY_URL_CONFLICT'))).toBe(false)
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

describe('assess: exact evidence and strong-key policy', () => {
  it('an unverified apply URL is recorded as evidence and decides nothing', () => {
    const a = rec('a', { postingUrl: GH(100) })
    const b = rec('b', { nativeId: 'x', applicationUrl: GH(100), applicationUrlVerified: false })
    expect(assess(a, b)).toEqual({
      decision: 'CANDIDATE',
      rule: 'COMPANY_TITLE',
      evidence: ['APPLY_URL_UNVERIFIED:b'],
      revision: IDENTITY_RULES_VERSION,
    })
  })

  it('evidence from both sides is sorted', () => {
    const a = rec('a', { applicationUrl: GH(1), applicationUrlVerified: false })
    const b = rec('b', { nativeId: 'x', applicationUrl: GH(2), applicationUrlVerified: false })
    expect(assess(b, a).evidence).toEqual(['APPLY_URL_UNVERIFIED:a', 'APPLY_URL_UNVERIFIED:b'])
  })

  it('a non-ATS application URL leaves no evidence', () => {
    const a = rec('a', {
      applicationUrl: 'https://example.com/apply',
      applicationUrlVerified: false,
    })
    expect(assess(a, rec('b', { nativeId: 'x' })).evidence).toEqual([])
  })

  it('a self-contradicting record yields exactly APPLY_URL_CONFLICT and no keys', () => {
    const self = rec('a', {
      postingUrl: GH(1),
      applicationUrl: GH(2),
      applicationUrlVerified: true,
    })
    const other = rec('b', { nativeId: 'x', postingUrl: GH(1) })
    expect(assess(self, other)).toEqual({
      decision: 'CANDIDATE',
      rule: 'COMPANY_TITLE',
      evidence: ['APPLY_URL_CONFLICT:a'],
      revision: IDENTITY_RULES_VERSION,
    })
  })

  it('a verified apply URL equal to the posting key is consistent, not a conflict', () => {
    const a = rec('a', { postingUrl: GH(1), applicationUrl: GH(1), applicationUrlVerified: true })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(1) })
    expect(assess(a, b).rule).toBe('ATS_JOB_KEY')
  })

  it('a verified apply URL to a different board of the same id is a conflict too', () => {
    const a = rec('a', {
      postingUrl: GH(1, 'acme'),
      applicationUrl: GH(1, 'other'),
      applicationUrlVerified: true,
    })
    expect(assess(a, rec('b', { nativeId: 'x' })).evidence).toEqual(['APPLY_URL_CONFLICT:a'])
  })

  it('a posting URL on an employer host (gh_jid) is not a strong key', () => {
    const url = 'https://careers.acme.example/roles?gh_jid=5'
    const a = rec('a', { postingUrl: url, company: 'Acme' })
    const b = rec('b', { nativeId: 'x', postingUrl: url, company: 'Globex' })
    expect(assess(a, b)).toMatchObject({ decision: 'DISTINCT', rule: 'NO_SHARED_IDENTITY' })
  })

  it('a verified apply URL is strong even when only the apply side carries it', () => {
    const a = rec('a', { postingUrl: 'https://remoteok.com/a' })
    const b = rec('b', { nativeId: 'x', applicationUrl: GH(5), applicationUrlVerified: true })
    const c = rec('c', { nativeId: 'y', postingUrl: GH(5) })
    expect(assess(b, c).rule).toBe('ATS_JOB_KEY')
    expect(assess(a, b).rule).toBe('COMPANY_TITLE')
  })

  it('ASSOCIATE evidence is exactly the shared key', () => {
    const a = rec('a', { postingUrl: GH(7) })
    const b = rec('b', { nativeId: 'x', postingUrl: GH(7) })
    expect(assess(a, b)).toEqual({
      decision: 'ASSOCIATE',
      rule: 'ATS_JOB_KEY',
      evidence: ['ATS_KEY:["ats1","greenhouse","ATS_HOSTED","us:acme","7"]'],
      revision: IDENTITY_RULES_VERSION,
    })
  })

  it('both contradictions are listed in a fixed order', () => {
    const a = rec('a', { postingUrl: GH(7) })
    const b = rec('b', {
      nativeId: 'x',
      postingUrl: GH(7),
      company: 'Globex',
      title: 'Data Analyst',
    })
    expect(assess(a, b).evidence).toEqual([
      'ATS_KEY:["ats1","greenhouse","ATS_HOSTED","us:acme","7"]',
      'COMPANY_MISMATCH',
      'TITLE_MISMATCH',
    ])
  })

  it('company contradiction alone, and title contradiction alone, each demote to CANDIDATE', () => {
    const a = rec('a', { postingUrl: GH(7) })
    expect(
      assess(a, rec('b', { nativeId: 'x', postingUrl: GH(7), company: 'Globex' })).evidence,
    ).toEqual(['ATS_KEY:["ats1","greenhouse","ATS_HOSTED","us:acme","7"]', 'COMPANY_MISMATCH'])
    expect(
      assess(a, rec('c', { nativeId: 'y', postingUrl: GH(7), title: 'Data Analyst' })).evidence,
    ).toEqual(['ATS_KEY:["ats1","greenhouse","ATS_HOSTED","us:acme","7"]', 'TITLE_MISMATCH'])
  })

  it('an unknown side is not an agreement: blank company AND title never associate onto an ATS key (SR-H-1)', () => {
    const victim = rec('victim', {
      postingUrl: GH(100),
      company: 'Victim Corp',
      title: 'Staff Engineer',
    })
    for (const probe of [
      { company: null, title: '---' },
      { company: null, title: '' },
      { company: '   ', title: '!!!' },
    ]) {
      const viaPosting = rec('p', { nativeId: 'x', postingUrl: GH(100), ...probe })
      const viaApply = rec('q', {
        nativeId: 'y',
        applicationUrl: GH(100),
        applicationUrlVerified: true,
        ...probe,
      })
      for (const r of [
        assess(victim, viaPosting),
        assess(viaPosting, victim),
        assess(victim, viaApply),
      ]) {
        expect(r).toMatchObject({ decision: 'CANDIDATE', rule: 'ATS_JOB_KEY_UNCORROBORATED' })
        expect(r.evidence).toContain('NO_POSITIVE_MATCH')
      }
    }
  })

  it('one positively equal field is enough; the other may be unknown, in either direction', () => {
    const a = rec('a', { postingUrl: GH(7) })
    const companyOnly = { title: '' }
    const titleOnly = { company: null }
    for (const gap of [companyOnly, titleOnly, { title: '---' }]) {
      const b = rec('b', { nativeId: 'x', postingUrl: GH(7), ...gap })
      expect(assess(a, b).decision).toBe('ASSOCIATE')
      expect(assess(b, a).decision).toBe('ASSOCIATE')
    }
  })

  it('a contradiction still wins over a positive match on the other field', () => {
    const a = rec('a', { postingUrl: GH(7) })
    expect(
      assess(a, rec('b', { nativeId: 'x', postingUrl: GH(7), company: 'Globex' })).decision,
    ).toBe('CANDIDATE')
    expect(
      assess(a, rec('c', { nativeId: 'y', postingUrl: GH(7), title: 'Data Analyst' })).decision,
    ).toBe('CANDIDATE')
  })

  it('distinct ATS ids are flagged only when BOTH sides carry a key', () => {
    const a = rec('a', { postingUrl: GH(1) })
    expect(assess(a, rec('b', { nativeId: 'x', postingUrl: GH(2) })).evidence).toEqual([
      'DISTINCT_ATS_IDS',
    ])
    expect(assess(a, rec('c', { nativeId: 'y' })).evidence).toEqual([])
    expect(assess(rec('c', { nativeId: 'y' }), a).evidence).toEqual([])
  })

  it('NATIVE_ID evidence names provider, namespace and id; any one differing breaks it', () => {
    const a = rec('a', { nativeId: 'n1', company: 'A', title: 'T1' })
    expect(assess(a, rec('b', { nativeId: 'n1', company: 'B', title: 'T2' })).evidence).toEqual([
      'NATIVE:REMOTEOK:remoteok.com:n1',
    ])
    expect(assess(a, rec('c', { nativeId: 'n2', company: 'B', title: 'T2' })).decision).toBe(
      'DISTINCT',
    )
  })

  it('unknown (null, empty or punctuation-only) location/department is compatible; known values compare case-insensitively', () => {
    for (const unknown of [null, '', ' - ']) {
      expect(assess(rec('a', { location: unknown }), rec('b')).decision).toBe('CANDIDATE')
      expect(assess(rec('a'), rec('b', { location: unknown })).decision).toBe('CANDIDATE')
      expect(
        assess(rec('a', { department: unknown }), rec('b', { department: 'Growth' })).decision,
      ).toBe('CANDIDATE')
      expect(
        assess(rec('a', { department: 'Growth' }), rec('b', { department: unknown })).decision,
      ).toBe('CANDIDATE')
    }
    expect(
      assess(rec('a', { location: 'BERLIN' }), rec('b', { location: 'berlin' })).decision,
    ).toBe('CANDIDATE')
    expect(
      assess(rec('a', { department: 'Growth' }), rec('b', { department: 'GROWTH' })).decision,
    ).toBe('CANDIDATE')
  })

  it('a missing title on either side never makes a COMPANY_TITLE candidate', () => {
    expect(assess(rec('a', { title: '' }), rec('b', { title: '' })).decision).toBe('DISTINCT')
  })

  it('company mismatch with equal titles is DISTINCT, and title mismatch with equal company is DISTINCT', () => {
    expect(assess(rec('a'), rec('b', { company: 'Globex' })).decision).toBe('DISTINCT')
    expect(assess(rec('a'), rec('b', { title: 'Data Analyst' })).decision).toBe('DISTINCT')
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
    const clusters = cl([c, b, a])
    expect(clusters.map((x) => x.memberIds)).toEqual([['a', 'b'], ['c']])
    expect(clusters.flatMap((x) => x.memberIds).sort()).toEqual(['a', 'b', 'c'])
  })

  it('clusterRecords is independent of input order', () => {
    const forward = cl([a, b, c])
    const backward = cl([c, b, a])
    expect(backward).toEqual(forward)
  })

  it('candidates and distinct records never cluster; each is its own cluster', () => {
    const x = rec('x')
    const y = rec('y') // same company/title/city => CANDIDATE only
    const z = rec('z', { company: 'Other' })
    expect(cl([x, y, z]).map((cl) => cl.memberIds)).toEqual([['x'], ['y'], ['z']])
  })

  it('cluster associations form a clique: n members => n(n-1)/2 associations', () => {
    const d = rec('d', { nativeId: 'zz', postingUrl: GH(1) })
    const [first] = cl([a, b, d])
    expect(first?.memberIds).toEqual(['a', 'b', 'd'])
    expect(first?.associations).toHaveLength(3)
  })
})

describe('ordering and bookkeeping', () => {
  it('exports the rules version literal', () => {
    expect(IDENTITY_RULES_VERSION).toBe('identity-rules-v1')
  })

  it('association ids are sorted whichever side the candidate is on', () => {
    const lo = rec('a', { nativeId: 'same' })
    const hi = rec('b', { nativeId: 'same' })
    const up = canAttach([lo], hi)
    const down = canAttach([hi], lo)
    expect(
      [up, down].map((r) => (r.attach ? [r.associations[0]?.aId, r.associations[0]?.bId] : null)),
    ).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ])
  })

  it('canAttach lists blockers and associations in id order whatever the cluster order', () => {
    const c = rec('z', { nativeId: 'nz', company: 'Globex', title: 'Other' })
    const m1 = rec('m1', { nativeId: 'n1' })
    const m2 = rec('m2', { nativeId: 'n2' })
    const m3 = rec('m3', { nativeId: 'n3' })
    expect(canAttach([m3, m1, m2], c)).toEqual({
      attach: false,
      reason: 'NOT_ASSOCIATED_WITH_ALL',
      blockedBy: ['m1', 'm2', 'm3'],
    })
    const joiner = rec('j', { nativeId: 'shared' })
    const x3 = rec('x3', { nativeId: 'shared' })
    const x1 = rec('x1', { nativeId: 'shared' })
    const x2 = rec('x2', { nativeId: 'shared' })
    const res = canAttach([x3, x1, x2], joiner)
    expect(res.attach ? res.associations.map((a) => `${a.aId}-${a.bId}`) : []).toEqual([
      'j-x1',
      'j-x2',
      'j-x3',
    ])
  })

  it('a candidate already in a larger cluster is refused as ALREADY_MEMBER', () => {
    const a = rec('a')
    const b = rec('b', { nativeId: 'nb' })
    expect(canAttach([a, b], b)).toEqual({
      attach: false,
      reason: 'ALREADY_MEMBER',
      blockedBy: ['b'],
    })
    expect(canAttach([b, a], b)).toEqual({
      attach: false,
      reason: 'ALREADY_MEMBER',
      blockedBy: ['b'],
    })
  })

  it('a partial blocker is named and only that one', () => {
    const ok = rec('ok', { nativeId: 'shared' })
    const no = rec('no', { nativeId: 'other', company: 'Globex', title: 'Other' })
    const c = rec('c', { nativeId: 'shared' })
    expect(canAttach([ok, no], c)).toEqual({
      attach: false,
      reason: 'NOT_ASSOCIATED_WITH_ALL',
      blockedBy: ['no'],
    })
  })

  it('clusterRecords orders clusters and members by id for a shuffled input', () => {
    const r = (id: string, nativeId: string) => rec(id, { nativeId })
    const out = cl([r('d', 'x'), r('b', 'y'), r('c', 'x'), r('a', 'y'), r('e', 'z')])
    expect(out.map((c) => c.memberIds)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('works without options and with ids that look like the old default (S, t)', () => {
    const s1 = rec('S', { nativeId: 'same' })
    const t1 = rec('t', { nativeId: 'same' })
    expect(cl([s1, t1]).map((c) => c.memberIds)).toEqual([['S', 't']])
  })

  it('revoked pairs are compared as pairs, not as concatenated text', () => {
    const ab = rec('ab', { nativeId: 'same' })
    const c = rec('c', { nativeId: 'same' })
    // ['a','bc'] and ['ab','c'] would both read "abc" if the pair were joined without a separator.
    expect(cl([ab, c], { revokedPairs: [['a', 'bc']] }).map((x) => x.memberIds)).toEqual([
      ['ab', 'c'],
    ])
  })

  it('assessWithRevocations: order-insensitive, exact evidence, others unaffected', () => {
    const a = rec('a', { nativeId: 'same' })
    const b = rec('b', { nativeId: 'same' })
    const c = rec('c', { nativeId: 'same' })
    const revoked = revocationSet([['b', 'a']])
    expect(assessWithRevocations(a, b, revoked)).toEqual({
      decision: 'DISTINCT',
      rule: 'REVOKED',
      evidence: ['REVOKED:a,b'],
      revision: IDENTITY_RULES_VERSION,
    })
    expect(assessWithRevocations(b, a, revoked).evidence).toEqual(['REVOKED:a,b'])
    expect(assessWithRevocations(a, c, revoked).decision).toBe('ASSOCIATE')
    expect(revocationSet(undefined).size).toBe(0)
  })
})

describe('split recovery', () => {
  const a = rec('a', { postingUrl: GH(1) })
  const b = rec('b', { nativeId: 'b', postingUrl: GH(1) })
  const c = rec('c', { nativeId: 'c', postingUrl: GH(1) })

  it('a revoked pair is never re-associated; every record and payload id survives', () => {
    const before = cl([a, b, c])
    expect(before.map((x) => x.memberIds)).toEqual([['a', 'b', 'c']])
    const after = cl([a, b, c], { revokedPairs: [['b', 'a']] })
    expect(after.map((x) => x.memberIds)).toEqual([['a', 'c'], ['b']])
    expect(after.flatMap((x) => x.memberIds).sort()).toEqual(['a', 'b', 'c'])
  })

  it('revocation overrides even a NATIVE_ID association', () => {
    const p = rec('p', { nativeId: 'same' })
    const q = rec('q', { nativeId: 'same' })
    expect(cl([p, q]).map((x) => x.memberIds)).toEqual([['p', 'q']])
    expect(cl([p, q], { revokedPairs: [['p', 'q']] }).map((x) => x.memberIds)).toEqual([
      ['p'],
      ['q'],
    ])
  })

  it('an unrelated revocation changes nothing', () => {
    expect(cl([a, b, c], { revokedPairs: [['x', 'y']] })).toEqual(cl([a, b, c]))
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

  it('array values compare by content, order-insensitively', () => {
    const r = chooseCanonical([
      claim({ sourceRecordId: 'a', value: ['ts', 'go'] }),
      claim({ sourceRecordId: 'b', value: ['go', 'ts'] }),
    ])
    expect(r).toMatchObject({ status: 'CHOSEN', winnerId: 'a' })
    const conflict = chooseCanonical([
      claim({ sourceRecordId: 'a', value: ['ts', 'go'] }),
      claim({ sourceRecordId: 'b', value: ['ts', 'rust'] }),
    ])
    expect(conflict.status).toBe('UNKNOWN')
    expect(
      chooseCanonical([
        claim({ sourceRecordId: 'a', value: ['x'] }),
        claim({ sourceRecordId: 'b', value: 'x' }),
      ]).status,
    ).toBe('UNKNOWN')
  })

  it('a neutral claim carries no information: a restrictive aggregator claim still stands (CR-M-4)', () => {
    const r = chooseCanonical([
      claim({ sourceRecordId: 'e', authority: 'EMPLOYER_ATS', value: 'anywhere' }),
      claim({
        sourceRecordId: 'g',
        authority: 'AGGREGATOR',
        value: 'EU only',
        stance: 'RESTRICTIVE',
      }),
    ])
    expect(r).toMatchObject({ value: 'EU only', winnerId: 'g', rule: 'RESTRICTION' })
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
