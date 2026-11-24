import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import type { RelevanceCandidate } from './relevance-pass'
import { createRelevanceStore, relevanceReason } from './relevance.store'

const KEY = { titleKey: 'java lead', descriptionSha256: 'abc', roles: ['BACKEND_ENGINEER'] }
const A = { seniorId: '5e000000-0000-4000-8000-000000000001', profileVersion: 'pv-a', fit: 0.5 }
const B = { seniorId: '5e000000-0000-4000-8000-000000000002', profileVersion: 'pv-b', fit: 0.75 }

describe('relevanceReason', () => {
  it('is order-insensitive', () => {
    expect(relevanceReason(KEY, [A, B])).toBe(relevanceReason(KEY, [B, A]))
  })

  it('same set gives the same reason', () => {
    expect(relevanceReason(KEY, [A, B])).toBe(relevanceReason({ ...KEY }, [{ ...A }, { ...B }]))
  })

  it('two different fit sets give different reasons', () => {
    expect(relevanceReason(KEY, [A, B])).not.toBe(relevanceReason(KEY, [A, { ...B, fit: 0.5 }]))
    expect(relevanceReason(KEY, [A])).not.toBe(relevanceReason(KEY, [A, B]))
  })

  it('a re-grade after a profile change gives a new reason even at the same fit', () => {
    expect(relevanceReason(KEY, [A])).not.toBe(
      relevanceReason(KEY, [{ ...A, profileVersion: 'pv-a2' }]),
    )
  })

  it('a re-grade after the vacancy key moved gives a new reason even at the same fits', () => {
    const base = relevanceReason(KEY, [A])
    expect(relevanceReason({ ...KEY, roles: ['FULLSTACK_ENGINEER'] }, [A])).not.toBe(base)
    expect(relevanceReason({ ...KEY, descriptionSha256: null }, [A])).not.toBe(base)
    expect(relevanceReason({ ...KEY, titleKey: 'java dev' }, [A])).not.toBe(base)
  })

  it('starts with RELEVANCE:rel.1: then 16 hex, and is ≤ 100 chars', () => {
    const r = relevanceReason(KEY, [A, B])
    expect(r).toMatch(/^RELEVANCE:rel\.1:[0-9a-f]{16}$/)
    expect(r.length).toBeLessThanOrEqual(100)
  })

  it('never starts with AVAILABILITY:', () => {
    expect(relevanceReason(KEY, []).startsWith('AVAILABILITY:')).toBe(false)
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

  it('applyGrades: one GRADED upsert per grade, one dirty row at the locked revision', async () => {
    const graded = [
      { senior_id: A.seniorId, senior_profile_version: 'pv-a', fit: '0.5' },
      { senior_id: B.seniorId, senior_profile_version: 'pv-b', fit: 0.75 },
    ]
    const { db, queries } = fakeDb((t) =>
      isLock(t) ? [{ revision: '7' }] : t.includes('AS senior_id') ? graded : [],
    )
    await expect(createRelevanceStore(db).applyGrades(C, [A, B])).resolves.toBe(true)
    const ups = inserts(queries)
    expect(ups).toHaveLength(2)
    expect(ups[0]?.params).toEqual(expect.arrayContaining([OPP, A.seniorId, 'pv-a', 0.5]))
    // The key columns: grader version, title key and description sha of the locked candidate.
    expect(ups[0]?.params).toEqual(expect.arrayContaining(['rel.1', 'java lead', 'abc']))
    expect(ups[1]?.params).toEqual(expect.arrayContaining([B.seniorId, 'pv-b', 0.75]))
    const [d] = dirty(queries)
    expect(dirty(queries)).toHaveLength(1)
    const reason = relevanceReason({ ...KEY, titleKey: 'java lead' }, [A, B])
    expect(d?.params).toEqual(expect.arrayContaining(['OPPORTUNITY', OPP, 7, reason]))
  })

  it('recordFailures: the opportunity moved -> no row written', async () => {
    const { db, queries } = fakeDb(() => [])
    await createRelevanceStore(db).recordFailures(C, [A], NOW)
    expect(inserts(queries)).toEqual([])
  })

  it("recordFailures: backs off by the row's own attempts; a kept GRADED row gets no update", async () => {
    let returning = 0
    const { db, queries } = fakeDb((t) => {
      if (isLock(t)) return [{ revision: 3 }]
      if (!t.includes('RETURNING attempts')) return []
      returning += 1
      // The first pair holds a current GRADED row (the upsert's WHERE kept it): no row back.
      return returning === 1 ? [] : [{ attempts: '2' }]
    })
    await createRelevanceStore(db).recordFailures(C, [A, B], NOW)
    expect(inserts(queries)).toHaveLength(2)
    const updates = queries.filter((q) => q.text.startsWith('UPDATE job_opportunity_relevance'))
    expect(updates).toHaveLength(1)
    // attempts 2 -> RELEVANCE_BACKOFF(1) = 30 minutes after now.
    expect(updates[0]?.params).toEqual(['2026-11-24T10:30:00.000Z', OPP, B.seniorId])
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
