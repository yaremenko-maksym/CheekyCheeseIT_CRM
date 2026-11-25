import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import type { RelevanceCandidate } from './relevance-pass'
import { createRelevanceStore, loadRelevanceFits, relevanceReason } from './relevance.store'

const KEY = { titleKey: 'java lead', descriptionSha256: 'abc', roles: ['BACKEND_ENGINEER'] }
const A = { seniorId: '5e000000-0000-4000-8000-000000000001', profileVersion: 'pv-a', fit: 0.5 }
const T = '2026-11-24T10:00:00.000001Z'
const B = { seniorId: '5e000000-0000-4000-8000-000000000002', profileVersion: 'pv-b', fit: 0.75 }

describe('relevanceReason', () => {
  it('is order-insensitive', () => {
    expect(relevanceReason(KEY, [A, B], T)).toBe(relevanceReason(KEY, [B, A], T))
  })

  it('same set gives the same reason', () => {
    expect(relevanceReason(KEY, [A, B], T)).toBe(
      relevanceReason({ ...KEY }, [{ ...A }, { ...B }], T),
    )
  })

  it('two different fit sets give different reasons', () => {
    expect(relevanceReason(KEY, [A, B], T)).not.toBe(
      relevanceReason(KEY, [A, { ...B, fit: 0.5 }], T),
    )
    expect(relevanceReason(KEY, [A], T)).not.toBe(relevanceReason(KEY, [A, B], T))
  })

  it('a re-grade after a profile change gives a new reason even at the same fit', () => {
    expect(relevanceReason(KEY, [A], T)).not.toBe(
      relevanceReason(KEY, [{ ...A, profileVersion: 'pv-a2' }], T),
    )
  })

  it('a re-grade after the vacancy key moved gives a new reason even at the same fits', () => {
    const base = relevanceReason(KEY, [A], T)
    expect(relevanceReason({ ...KEY, roles: ['FULLSTACK_ENGINEER'] }, [A], T)).not.toBe(base)
    expect(relevanceReason({ ...KEY, descriptionSha256: null }, [A], T)).not.toBe(base)
    expect(relevanceReason({ ...KEY, titleKey: 'java dev' }, [A], T)).not.toBe(base)
  })

  it('starts with RELEVANCE:rel.1: then 16 hex, and is ≤ 100 chars', () => {
    const r = relevanceReason(KEY, [A, B], T)
    expect(r).toMatch(/^RELEVANCE:rel\.1:[0-9a-f]{16}$/)
    expect(r.length).toBeLessThanOrEqual(100)
  })

  it('an A -> B -> A re-grade gives a new reason: the graded-at time is in the digest (SO-6)', () => {
    const first = relevanceReason(KEY, [A], T)
    expect(relevanceReason(KEY, [{ ...A }], '2026-11-24T10:05:00.000000Z')).not.toBe(first)
  })

  it('never starts with AVAILABILITY:', () => {
    expect(relevanceReason(KEY, [], T).startsWith('AVAILABILITY:')).toBe(false)
  })
})

type Query = { text: string; params: unknown[] }

/** A db double: every statement rendered to SQL text + params; `answer` picks the rows by text. */
function fakeDb(answer: (text: string) => Record<string, unknown>[] = () => []) {
  const queries: Query[] = []
  const exec = {
    execute(q: SQL) {
      const { sql, params } = new PgDialect().sqlToQuery(q)
      queries.push({ text: sql, params })
      return Promise.resolve({ rows: answer(sql) })
    },
  }
  const db = { ...exec, transaction: (work: (tx: typeof exec) => Promise<unknown>) => work(exec) }
  return { db: db as unknown as MeterDb, queries }
}

const NOW = new Date('2026-11-24T10:00:00.000Z')
const OPP = '0f000000-0000-4000-8000-000000000001'
const C: RelevanceCandidate = {
  id: OPP,
  title: 'Java lead',
  titleKey: 'java lead',
  descriptionSha256: 'abc',
  description: 'Spring.',
  categories: ['java'],
  roles: ['BACKEND_ENGINEER'],
  pairs: [],
}
const isLock = (t: string) => t.includes('FOR NO KEY UPDATE')
const inserts = (q: Query[]) =>
  q.filter((x) => x.text.includes('INSERT INTO job_opportunity_relevance'))
const dirty = (q: Query[]) => q.filter((x) => x.text.includes('job_dirty_work'))

describe('createRelevanceStore (unit double; the SQL itself is the integration spec)', () => {
  it('candidates: maps each row and binds the rule version, now, attempts cap and limit', async () => {
    const { db, queries } = fakeDb(() => [
      {
        id: OPP,
        title: 'Java lead',
        title_key: 'java lead',
        description_sha256: null,
        description: '',
        stack_keywords: ['java'],
        technical_roles: ['BACKEND_ENGINEER'],
        pairs: [{ seniorId: A.seniorId, profileVersion: 'pv-a' }],
      },
    ])
    const rows = await createRelevanceStore(db).candidates(NOW, 7)
    expect(rows).toEqual([
      {
        id: OPP,
        title: 'Java lead',
        titleKey: 'java lead',
        descriptionSha256: null,
        description: '',
        categories: ['java'],
        roles: ['BACKEND_ENGINEER'],
        pairs: [{ seniorId: A.seniorId, profileVersion: 'pv-a' }],
      },
    ])
    expect(queries).toHaveLength(1)
    expect(queries[0]?.params).toEqual(
      expect.arrayContaining([MATCH_RULE_VERSION, 'rel.1', NOW.toISOString(), 10, 7]),
    )
  })

  it('applyGrades: the opportunity moved -> false, nothing written, no dirty row', async () => {
    const { db, queries } = fakeDb(() => [])
    await expect(createRelevanceStore(db).applyGrades(C, [{ ...A }])).resolves.toBe(false)
    expect(queries.some((q) => isLock(q.text))).toBe(true)
    expect(inserts(queries)).toEqual([])
    expect(dirty(queries)).toEqual([])
  })

  it('applyGrades: one multi-row GRADED upsert, one dirty row at the locked revision', async () => {
    const at = '2026-11-24T10:00:01.123456Z'
    const graded = [
      { senior_id: A.seniorId, senior_profile_version: 'pv-a', fit: '0.5', graded_at: at },
      { senior_id: B.seniorId, senior_profile_version: 'pv-b', fit: 0.75, graded_at: at },
    ]
    const { db, queries } = fakeDb((t) =>
      isLock(t) ? [{ revision: '7' }] : t.includes('AS senior_id') ? graded : [],
    )
    await expect(createRelevanceStore(db).applyGrades(C, [A, B])).resolves.toBe(true)
    const ups = inserts(queries)
    expect(ups).toHaveLength(1)
    expect(ups[0]?.params).toEqual(
      expect.arrayContaining([OPP, A.seniorId, 'pv-a', 0.5, B.seniorId, 'pv-b', 0.75]),
    )
    // Two VALUES tuples, comma-separated.
    expect(ups[0]?.text).toMatch(/clock_timestamp\(\)\),\s*\(/)
    // The key columns: grader version, title key and description sha of the locked candidate.
    expect(ups[0]?.params).toEqual(expect.arrayContaining(['rel.1', 'java lead', 'abc']))
    expect(queries.findIndex((q) => isLock(q.text))).toBeLessThan(queries.indexOf(ups[0] as Query))
    const [d] = dirty(queries)
    expect(dirty(queries)).toHaveLength(1)
    const reason = relevanceReason({ ...KEY, titleKey: 'java lead' }, [A, B], at)
    expect(d?.params).toEqual(expect.arrayContaining(['OPPORTUNITY', OPP, 7, reason]))
  })

  it('recordFailures: the opportunity moved -> no row written', async () => {
    const { db, queries } = fakeDb(() => [])
    await createRelevanceStore(db).recordFailures(C, [A], NOW)
    expect(inserts(queries)).toEqual([])
  })

  it('recordFailures: one multi-row upsert, the written count back, backoff in the same statement', async () => {
    const { db, queries } = fakeDb((t) => {
      if (isLock(t)) return [{ revision: 3 }]
      // The first pair holds a current GRADED row (the upsert's WHERE kept it): one row back.
      return t.includes('RETURNING 1') ? [{ '?column?': 1 }] : []
    })
    await expect(createRelevanceStore(db).recordFailures(C, [A, B], NOW)).resolves.toBe(1)
    const ups = inserts(queries)
    expect(ups).toHaveLength(1)
    expect(queries.filter((q) => q.text.startsWith('UPDATE'))).toEqual([])
    // A fresh row: attempts 1, RELEVANCE_BACKOFF(0) = 15 minutes after now.
    expect(ups[0]?.params).toEqual(
      expect.arrayContaining([A.seniorId, B.seniorId, '2026-11-24T10:15:00.000Z']),
    )
    // A conflicting row: from now, base and cap bound for the SQL backoff.
    expect(ups[0]?.params).toEqual(
      expect.arrayContaining([NOW.toISOString(), 15 * 60_000, 86_400_000]),
    )
    expect(ups[0]?.text).toMatch(/next_attempt_at = .*power\(2, CASE WHEN/s)
    expect(ups[0]?.text).toMatch(/clock_timestamp\(\)\),\s*\(/)
  })

  it('recordFailures: no pairs -> no statement, 0', async () => {
    const { db, queries } = fakeDb(() => [{ revision: 3 }])
    await expect(createRelevanceStore(db).recordFailures(C, [], NOW)).resolves.toBe(0)
    expect(queries).toEqual([])
  })
})

describe('createRelevanceStore candidates: a description sha is kept', () => {
  it('maps a non-null description_sha256 through unchanged', async () => {
    const { db } = fakeDb(() => [
      {
        id: OPP,
        title: 'T',
        title_key: 't',
        description_sha256: 'abc',
        description: 'D',
        stack_keywords: [],
        technical_roles: [],
        pairs: [],
      },
    ])
    const [row] = await createRelevanceStore(db).candidates(NOW, 1)
    expect(row?.descriptionSha256).toBe('abc')
  })
})

describe('loadRelevanceFits (queue relevance PR2: current-key fits only)', () => {
  const versions = new Map(
    ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => [
      id,
      { profile: `p-${id}`, exclusion: 'x' },
    ]),
  )
  const KEY = {
    titleKey: 'java lead',
    descriptionSha256: 'abc',
    roles: ['BACKEND_ENGINEER'] as const,
  }
  const row = (senior_id: string, fit: unknown, senior_profile_version = `p-${senior_id}`) => ({
    senior_id,
    senior_profile_version,
    fit,
  })

  it('keeps a fit in [0,1] whose senior profile is current; drops stale, absent, null and out-of-range', async () => {
    const { db, queries } = fakeDb(() => [
      row('s1', 0),
      row('s2', 1),
      row('s3', '0.42'),
      row('s4', 0.9, 'p-old'),
      row('ghost', 0.9, 'p-ghost'),
      row('s5', null),
      row('s6', 1.01),
      row('s7', -0.01),
    ])
    expect(await loadRelevanceFits(db, OPP, KEY, versions)).toEqual({ s1: 0, s2: 1, s3: 0.42 })
    expect(queries).toHaveLength(1)
    const [q] = queries
    expect(q?.text).toContain('FROM job_opportunity_relevance')
    expect(q?.text).toContain("status = 'GRADED'")
    expect(q?.params).toEqual(expect.arrayContaining([OPP, 'java lead', 'abc']))
  })

  it('no rows: an empty map', async () => {
    const { db } = fakeDb()
    expect(await loadRelevanceFits(db, OPP, KEY, versions)).toEqual({})
  })
})
