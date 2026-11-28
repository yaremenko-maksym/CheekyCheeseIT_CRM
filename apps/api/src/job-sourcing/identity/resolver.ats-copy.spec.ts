import { describe, expect, it } from 'vitest'
import {
  ATS_COPY_WINDOW_MS,
  IDENTITY_RULES_VERSION,
  type ResolverRecord,
  atsCopyAttach,
} from './resolver'

/** sources-18 step 4: an aggregator copy and its ATS posting are one vacancy (the pure rule). */

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-11-01T00:00:00Z')
const at = (days: number, extraMs = 0) => new Date(T0.getTime() + days * DAY + extraMs)
const LEVER = (job: string) => `https://jobs.lever.co/acme/${job}`
const JOB_A = '0b5f8e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
const JOB_B = '1c6f9f3b-2d4e-4f6a-9bac-1d2e3f4a5b6c'

function rec(over: Partial<ResolverRecord> = {}): ResolverRecord {
  return {
    id: 'copy',
    provider: 'THEHUB_HTML',
    namespace: 'thehub',
    nativeId: 'c1',
    company: 'Acme',
    title: 'Senior Go Engineer',
    location: 'Remote',
    department: null,
    postingUrl: 'https://thehub.example/jobs/c1',
    applicationUrl: null,
    applicationUrlVerified: false,
    seen: { first: at(0), last: at(3) },
    ...over,
  }
}

const atsRec = (id: string, job: string, over: Partial<ResolverRecord> = {}) =>
  rec({
    id,
    provider: 'LEVER_ATS',
    namespace: 'lever:global:acme',
    nativeId: job,
    postingUrl: LEVER(job),
    ...over,
  })

const copy = rec()
const ats = atsRec('ats', JOB_A)

describe('atsCopyAttach', () => {
  it('rules version is v2', () => {
    expect(IDENTITY_RULES_VERSION).toBe('identity-rules-v2')
    expect(ATS_COPY_WINDOW_MS).toBe(14 * DAY)
  })

  it('(a) ATS first, copy later: the copy attaches with an ATS_COPY association', () => {
    const r = atsCopyAttach([ats], copy)
    expect(r).toEqual({
      attach: true,
      associations: [
        {
          aId: 'ats',
          bId: 'copy',
          rule: 'ATS_COPY',
          evidence: ['COMPANY_TITLE', 'SEEN_GAP_MS:0'],
          revision: 'identity-rules-v2',
          actor: 'RULES',
        },
      ],
    })
  })

  it('(b) copy first, ATS later: the ATS record attaches to the copy-only opportunity', () => {
    expect(atsCopyAttach([copy], ats).attach).toBe(true)
  })

  it('(c) a copy carrying the same ATS key first: ATS_JOB_KEY association, not ATS_COPY', () => {
    const nlj = rec({ id: 'nlj', provider: 'NEXTLEVELJOBS_HTML', postingUrl: LEVER(JOB_A) })
    const r = atsCopyAttach([nlj], ats)
    expect(r.attach).toBe(true)
    expect(r.attach && r.associations[0]).toMatchObject({
      aId: 'ats',
      bId: 'nlj',
      rule: 'ATS_JOB_KEY',
      revision: 'identity-rules-v2',
      actor: 'RULES',
    })
  })

  it('a record naming its job by posting and verified apply URL is still one job', () => {
    const both = atsRec('ats2', JOB_A, {
      applicationUrl: `${LEVER(JOB_A)}/apply`,
      applicationUrlVerified: true,
    })
    expect(atsCopyAttach([ats, both], copy).attach).toBe(true)
    expect(atsCopyAttach([both], ats).attach).toBe(true)
  })

  it('(c) a copy carrying ANOTHER ATS job: the keys are not a subset, no attach', () => {
    const nlj = rec({ id: 'nlj', provider: 'NEXTLEVELJOBS_HTML', postingUrl: LEVER(JOB_B) })
    expect(atsCopyAttach([nlj], ats)).toEqual({
      attach: false,
      reason: 'ATS_KEY_MISMATCH',
      blockedBy: ['nlj'],
    })
  })

  it('a copy never attaches to a copy-only opportunity (copy-copy is out of scope)', () => {
    expect(atsCopyAttach([rec({ id: 'other' })], copy)).toEqual({
      attach: false,
      reason: 'NO_ATS_MEMBER',
      blockedBy: [],
    })
  })

  it('an opportunity holding two different ATS jobs takes nothing', () => {
    const r = atsCopyAttach([ats, atsRec('ats2', JOB_B)], copy)
    expect(r).toEqual({ attach: false, reason: 'MULTIPLE_ATS_JOBS', blockedBy: ['ats', 'ats2'] })
    // Two members of ONE job are one job.
    expect(atsCopyAttach([ats, rec({ id: 'nlj', postingUrl: LEVER(JOB_A) })], copy).attach).toBe(
      true,
    )
  })

  it('an ATS record never joins an opportunity whose ATS member is another job', () => {
    expect(atsCopyAttach([copy, atsRec('ats2', JOB_B)], ats)).toEqual({
      attach: false,
      reason: 'ATS_KEY_MISMATCH',
      blockedBy: ['ats2'],
    })
  })

  describe('F7: an ATS-hosted URL naming another job refuses, verified or not', () => {
    it('a copy whose unverified apply URL names another job does not join', () => {
      const c = rec({ applicationUrl: LEVER(JOB_B) })
      expect(atsCopyAttach([ats], c)).toEqual({
        attach: false,
        reason: 'ATS_KEY_MISMATCH',
        blockedBy: ['ats'],
      })
    })

    it('a copy whose posting and apply URLs name two jobs (no trusted key) does not join', () => {
      const c = rec({
        postingUrl: LEVER(JOB_A),
        applicationUrl: LEVER(JOB_B),
        applicationUrlVerified: true,
      })
      expect(atsCopyAttach([ats], c)).toMatchObject({ attach: false, reason: 'ATS_KEY_MISMATCH' })
    })

    it('an unverified apply URL naming the same job still joins', () => {
      expect(atsCopyAttach([ats], rec({ applicationUrl: LEVER(JOB_A) })).attach).toBe(true)
    })

    it('an employer-hosted key is not ATS-hosted and contradicts nothing', () => {
      const c = rec({ applicationUrl: 'https://acme.example/careers?gh_jid=999' })
      expect(atsCopyAttach([ats], c).attach).toBe(true)
    })

    it('a keyless cluster member whose apply URL names another job refuses an incoming ATS record', () => {
      const copyK = rec({ id: 'copy', applicationUrl: LEVER(JOB_B) })
      expect(atsCopyAttach([copyK], ats)).toEqual({
        attach: false,
        reason: 'ATS_KEY_MISMATCH',
        blockedBy: ['copy'],
      })
      expect(atsCopyAttach([rec({ id: 'copy', applicationUrl: LEVER(JOB_A) })], ats).attach).toBe(
        true,
      )
      expect(atsCopyAttach([rec({ id: 'copy', applicationUrl: null })], ats).attach).toBe(true)
    })
  })

  it('every member must agree: company, title, location, department', () => {
    const blocked = (over: Partial<ResolverRecord>) => atsCopyAttach([ats], rec(over))
    expect(blocked({ company: 'Acme Inc' })).toMatchObject({
      attach: false,
      reason: 'NOT_ASSOCIATED_WITH_ALL',
      blockedBy: ['ats'],
    })
    expect(blocked({ company: null }).attach).toBe(false)
    expect(
      atsCopyAttach([atsRec('ats', JOB_A, { company: null })], rec({ company: null })).attach,
    ).toBe(false)
    expect(blocked({ title: 'Junior Go Engineer' }).attach).toBe(false)
    expect(blocked({ title: '' }).attach).toBe(false)
    expect(blocked({ location: 'Berlin' }).attach).toBe(false)
    expect(blocked({ location: null }).attach).toBe(true)
    expect(blocked({ department: 'Platform' }).attach).toBe(true)
    expect(
      atsCopyAttach([atsRec('ats', JOB_A, { department: 'Data' })], rec({ department: 'Platform' }))
        .attach,
    ).toBe(false)
    // Squashed title: spacing and punctuation do not matter.
    expect(blocked({ title: 'Senior Go-Engineer' }).attach).toBe(true)
    // One disagreeing member blocks, even when another agrees.
    const r = atsCopyAttach([ats, rec({ id: 'c0', location: 'Berlin' })], copy)
    expect(r).toMatchObject({ attach: false, blockedBy: ['c0'] })
  })

  it('a member over the field cap is unknown, never a match', () => {
    const long = 'x'.repeat(257)
    expect(
      atsCopyAttach([atsRec('ats', JOB_A, { title: long })], rec({ title: long })).attach,
    ).toBe(false)
  })

  it('a pair an ADMIN split is never re-associated', () => {
    expect(atsCopyAttach([ats], copy, { revokedPairs: [['copy', 'ats']] })).toMatchObject({
      attach: false,
      blockedBy: ['ats'],
    })
  })

  describe('window: 14 days between the observation intervals', () => {
    const atsSeen = (first: Date, last: Date) => atsRec('ats', JOB_A, { seen: { first, last } })
    it('overlapping or touching intervals match', () => {
      expect(atsCopyAttach([atsSeen(at(-60), at(60))], copy).attach).toBe(true)
    })
    it('exactly 14 days apart matches, 14 days + 1 ms does not (both directions)', () => {
      // The ATS was last seen 14 days before the copy was first seen.
      expect(atsCopyAttach([atsSeen(at(-30), at(-14))], copy).attach).toBe(true)
      expect(atsCopyAttach([atsSeen(at(-30), at(-14, -1))], copy).attach).toBe(false)
      // The copy was last seen (day 3) 14 days before the ATS was first seen.
      expect(atsCopyAttach([atsSeen(at(17), at(40))], copy).attach).toBe(true)
      expect(atsCopyAttach([atsSeen(at(17, 1), at(40))], copy).attach).toBe(false)
      const r = atsCopyAttach([atsSeen(at(-30), at(-14))], copy)
      expect(r.attach && r.associations[0]?.evidence).toEqual([
        'COMPANY_TITLE',
        `SEEN_GAP_MS:${14 * DAY}`,
      ])
    })
    it('a record without an observation interval never matches', () => {
      const unseen = rec()
      delete unseen.seen
      const unseenAts = atsRec('ats', JOB_A)
      delete unseenAts.seen
      expect(atsCopyAttach([ats], unseen).attach).toBe(false)
      expect(atsCopyAttach([unseenAts], copy).attach).toBe(false)
    })
  })

  it('the cluster guards: empty, already a member', () => {
    expect(atsCopyAttach([], copy)).toEqual({
      attach: false,
      reason: 'EMPTY_CLUSTER',
      blockedBy: [],
    })
    expect(atsCopyAttach([ats, copy], copy)).toEqual({
      attach: false,
      reason: 'ALREADY_MEMBER',
      blockedBy: ['copy'],
    })
  })

  it('associations are listed by member id, each pair sorted', () => {
    const r = atsCopyAttach([atsRec('z-ats', JOB_A), rec({ id: 'a-copy' })], rec({ id: 'm' }))
    expect(r.attach && r.associations.map((a) => [a.aId, a.bId])).toEqual([
      ['a-copy', 'm'],
      ['m', 'z-ats'],
    ])
  })
})
