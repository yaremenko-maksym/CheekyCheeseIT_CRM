import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { AttachResult } from '../identity/resolver'
import type { MeterDb } from '../metering/account-meter.store'
import { atsCopyMatch, pickCopyTarget } from './ats-copy.store'
import type { MemberSnapshot } from './canonical-plan'
import { resolveRecordsTx } from './canonical.store'

/**
 * sources-18: the ATS_COPY step of `resolveRecords` on a fake `db` that routes each statement by
 * its text. The real round-trip is `./ats-copy.integration.spec.ts`; this spec is what the
 * mutation gate can execute (it never loads an integration spec).
 */
const COPY = '11111111-1111-4111-8111-111111111111'
const ATS = '44444444-4444-4444-8444-444444444444'
const OPP = '22222222-2222-4222-8222-222222222222'
const OPP2 = '55555555-5555-4555-8555-555555555555'
const NEW_OPP = '66666666-6666-4666-8666-666666666666'
const LEVER = 'https://jobs.lever.co/acme/0b5f8e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'

const row = (over: Record<string, unknown>) => ({
  revision_id: '33333333-3333-4333-8333-333333333333',
  received_seq: 1,
  received_at: '2026-11-21T00:00:00.000Z',
  first_seen_at: '2026-11-18T00:00:00.000Z',
  last_observed_at: '2026-11-21T00:00:00.000Z',
  application_url: null,
  description_sha256: null,
  normalized: { title: 'Senior Go Engineer', companyName: 'Acme', location: 'Remote' },
  ...over,
})
const copyRow = row({
  record_id: COPY,
  source_type: 'THEHUB_HTML',
  namespace: 'thehub',
  source_url: 'https://thehub.example/jobs/c1',
  original_identity: { nativeId: 'c1' },
})
const atsRow = row({
  record_id: ATS,
  source_type: 'LEVER_ATS',
  namespace: 'lever:global:acme',
  source_url: LEVER,
  original_identity: { nativeId: '0b5f8e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' },
})

const dialect = new PgDialect()

function routedDb(candidates: string[], memberRows: Record<string, unknown>[] = [atsRow]) {
  const queries: { sql: string; params: unknown[] }[] = []
  const rowsFor = (text: string): Record<string, unknown>[] => {
    if (/FROM job_source_records r JOIN/.test(text)) return [copyRow]
    if (/FROM job_opportunities o\s+WHERE o\.employer_key/.test(text))
      return candidates.map((id) => ({ id }))
    if (/^SELECT id FROM job_opportunities WHERE id IN/.test(text))
      return candidates.map((id) => ({ id }))
    if (/FROM job_opportunity_sources s\s+JOIN/.test(text)) return memberRows
    if (/^INSERT INTO job_opportunities\s/.test(text)) return [{ id: NEW_OPP, revision: 1 }]
    return []
  }
  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({
        async execute(query: SQL) {
          const q = dialect.sqlToQuery(query)
          queries.push(q)
          return { rows: rowsFor(q.sql.trim()) }
        },
      })
    },
  }
  return { db: db as unknown as MeterDb, queries }
}

const linkInsert = (queries: { sql: string; params: unknown[] }[]) => {
  const q = queries.find((x) => /^INSERT INTO job_opportunity_sources/.test(x.sql.trim()))
  expect(q).toBeDefined()
  return { opportunityId: q!.params[1], evidence: JSON.parse(String(q!.params[3])) }
}

describe('resolveRecords: ATS_COPY (sources-18)', () => {
  it('an unmatched copy joins the one candidate whose ATS member agrees', async () => {
    const { db, queries } = routedDb([OPP])
    expect(await resolveRecordsTx(db, [COPY])).toEqual([
      { recordId: COPY, kind: 'ATTACH', opportunityId: OPP },
    ])
    const link = linkInsert(queries)
    expect(link.opportunityId).toBe(OPP)
    expect(link.evidence).toMatchObject({ actor: 'SYSTEM', rule: 'ATS_COPY' })
    expect(link.evidence.associations).toHaveLength(1)
    expect(link.evidence.associations[0]).toMatchObject({ rule: 'ATS_COPY' })
    expect(queries.some((q) => /^INSERT INTO job_opportunities\s/.test(q.sql.trim()))).toBe(false)
    // The lock taken out of order, then the re-read restricted to it.
    const lock = queries.findIndex((q) =>
      /^SELECT id FROM job_opportunities WHERE id IN/.test(q.sql.trim()),
    )
    expect(lock).toBeGreaterThan(-1)
    expect(queries[lock]!.params).toEqual([OPP])
    expect(queries.slice(lock).some((q) => /AND o\.id IN/.test(q.sql))).toBe(true)
  })

  it('no candidate: NEW, as before, with the reason NO_TRUSTED_MATCH', async () => {
    const { db, queries } = routedDb([])
    expect(await resolveRecordsTx(db, [COPY])).toEqual([
      { recordId: COPY, kind: 'NEW', opportunityId: NEW_OPP },
    ])
    expect(linkInsert(queries)).toEqual({
      opportunityId: NEW_OPP,
      evidence: { actor: 'SYSTEM', reason: 'NO_TRUSTED_MATCH' },
    })
  })

  it('two passing candidates: NEW with ATS_COPY_AMBIGUOUS', async () => {
    const { db, queries } = routedDb([OPP, OPP2])
    expect((await resolveRecordsTx(db, [COPY]))[0]).toMatchObject({ kind: 'NEW' })
    expect(linkInsert(queries).evidence).toEqual({ actor: 'SYSTEM', reason: 'ATS_COPY_AMBIGUOUS' })
  })
})

const snap = (over: Partial<MemberSnapshot> = {}): MemberSnapshot => ({
  recordId: COPY,
  revisionId: 'v1',
  receivedSeq: 1,
  receivedAt: new Date('2026-11-21T00:00:00Z'),
  provider: 'THEHUB_HTML',
  namespace: 'thehub',
  nativeId: 'c1',
  title: 'Senior Go Engineer',
  companyName: 'Acme',
  location: 'Remote',
  sourceUrl: null,
  applicationUrl: null,
  descriptionSha256: null,
  publishedAt: null,
  tags: [],
  salary: null,
  firstSeenAt: new Date('2026-11-18T00:00:00Z'),
  lastObservedAt: new Date('2026-11-21T00:00:00Z'),
  ...over,
})
const atsSnap = snap({
  recordId: ATS,
  provider: 'LEVER_ATS',
  namespace: 'lever:global:acme',
  nativeId: '0b5f8e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  sourceUrl: LEVER,
})

/** A tx whose every statement returns the next scripted rows. */
function scriptedTx(steps: Record<string, unknown>[][]) {
  const queries: string[] = []
  return {
    queries,
    tx: {
      async execute(query: SQL) {
        queries.push(dialect.sqlToQuery(query).sql)
        return { rows: steps[queries.length - 1] ?? [] }
      },
    },
  }
}

describe('atsCopyMatch', () => {
  const port = (memberSnaps: MemberSnapshot[] = [atsSnap]) => ({
    lockLate: vi.fn(async () => {}),
    members: vi.fn(async () => memberSnaps),
  })

  it('more candidates than the cap is ambiguous without reading any member', async () => {
    const { tx } = scriptedTx([Array.from({ length: 21 }, (_, i) => ({ id: `o${i}` }))])
    const p = port()
    expect(await atsCopyMatch(tx, snap(), p)).toEqual({ kind: 'NEW', reason: 'ATS_COPY_AMBIGUOUS' })
    expect(p.lockLate).not.toHaveBeenCalled()
    // Exactly the cap is still read.
    const at = scriptedTx([Array.from({ length: 20 }, (_, i) => ({ id: `o${i}` })), []])
    expect(await atsCopyMatch(at.tx, snap(), p)).toEqual({
      kind: 'NEW',
      reason: 'NO_TRUSTED_MATCH',
    })
    expect(p.lockLate).toHaveBeenCalledTimes(1)
  })

  it('an ATS-backed record whose board runs the title twice is refused (sibling guard)', async () => {
    const { tx, queries } = scriptedTx([[{ id: OPP }], [{ title: 'Senior Go Engineer' }]])
    const p = port([snap()])
    expect(await atsCopyMatch(tx, atsSnap, p)).toEqual({ kind: 'NEW', reason: 'ATS_COPY_SIBLING' })
    expect(queries[1]).toContain('r.namespace = $2')
    expect(p.lockLate).not.toHaveBeenCalled()
  })

  it('an ATS-backed record with no sibling joins a copy-only opportunity', async () => {
    const { tx, queries } = scriptedTx([[{ id: OPP }], [], [{ id: OPP }]])
    const p = port([snap()])
    expect(await atsCopyMatch(tx, atsSnap, p)).toMatchObject({ kind: 'ATTACH', opportunityId: OPP })
    expect(queries).toHaveLength(3)
    expect(p.lockLate).toHaveBeenCalledWith([OPP])
    expect(p.members).toHaveBeenCalledWith(OPP)
  })

  it('a copy never runs the sibling read; a candidate gone under the lock is not read', async () => {
    const { tx, queries } = scriptedTx([[{ id: OPP }], []])
    const p = port()
    expect(await atsCopyMatch(tx, snap(), p)).toEqual({ kind: 'NEW', reason: 'NO_TRUSTED_MATCH' })
    expect(queries).toHaveLength(2)
    expect(queries[1]).toContain('AND o.id IN')
    expect(p.members).not.toHaveBeenCalled()
  })
})

describe('pickCopyTarget', () => {
  const pass: AttachResult = { attach: true, associations: [] }
  const fail: AttachResult = { attach: false, reason: 'NOT_ASSOCIATED_WITH_ALL', blockedBy: [] }
  it('exactly one passing joins it, more is ambiguous, none is unmatched', () => {
    expect(
      pickCopyTarget([
        { opportunityId: 'a', result: fail },
        { opportunityId: 'b', result: pass },
      ]),
    ).toEqual({ kind: 'ATTACH', opportunityId: 'b', associations: [] })
    expect(
      pickCopyTarget([
        { opportunityId: 'a', result: pass },
        { opportunityId: 'b', result: pass },
      ]),
    ).toEqual({ kind: 'NEW', reason: 'ATS_COPY_AMBIGUOUS' })
    expect(pickCopyTarget([{ opportunityId: 'a', result: fail }])).toEqual({
      kind: 'NEW',
      reason: 'NO_TRUSTED_MATCH',
    })
    expect(pickCopyTarget([])).toEqual({ kind: 'NEW', reason: 'NO_TRUSTED_MATCH' })
  })
})
