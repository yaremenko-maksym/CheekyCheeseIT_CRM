import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  ATS_COPY_MAX_CANDIDATES,
  atsSiblings,
  copyCandidates,
  copyCandidatesSql,
} from './ats-copy.store'
import type { MemberSnapshot } from './canonical-plan'

/**
 * The SQL shape of the ATS_COPY reads (sources-18). The real predicates run against Postgres in
 * `./ats-copy.integration.spec.ts`; this spec is what the mutation gate can execute.
 */

const dialect = new PgDialect()
const REC = '11111111-1111-4111-8111-111111111111'
const DAY = 24 * 60 * 60 * 1000

function snap(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    recordId: REC,
    revisionId: 'v1',
    receivedSeq: 1,
    receivedAt: new Date('2026-11-01T00:00:00Z'),
    provider: 'LEVER_ATS',
    namespace: 'lever:global:acme',
    nativeId: 'job',
    title: 'Senior Go Engineer',
    companyName: 'Acme GmbH',
    location: 'Remote',
    sourceUrl: null,
    applicationUrl: null,
    descriptionSha256: null,
    publishedAt: null,
    tags: [],
    salary: null,
    firstSeenAt: new Date('2026-11-01T00:00:00Z'),
    lastObservedAt: new Date('2026-11-03T00:00:00Z'),
    ...over,
  }
}

function fakeTx(rows: Record<string, unknown>[]) {
  const queries: { sql: string; params: unknown[] }[] = []
  return {
    queries,
    tx: {
      async execute(query: SQL) {
        queries.push(dialect.sqlToQuery(query))
        return { rows }
      },
    },
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ')

describe('copyCandidates', () => {
  it('reads the stored keys with the AUTO-only, no-split, no-team predicates', async () => {
    const { tx, queries } = fakeTx([{ id: 'o1' }, { id: 'o2' }])
    expect(await copyCandidates(tx, snap())).toEqual(['o1', 'o2'])
    expect(queries).toHaveLength(1)
    const q = squash(queries[0]!.sql)
    expect(q).toContain('o.employer_key = $1 AND o.title_key = $2')
    expect(q).toContain('o.manual_team_id IS NULL')
    expect(q).toContain("s.unlinked_at IS NULL AND s.decision <> 'AUTO'")
    expect(q.match(/LIKE 'ADMIN_SPLIT:%'/g)).toHaveLength(3)
    expect(q).toContain('ORDER BY o.id')
    expect(q).not.toContain('o.id IN')
    expect(queries[0]!.params).toEqual([
      'acme gmbh',
      'senior go engineer',
      REC,
      ATS_COPY_MAX_CANDIDATES + 1,
    ])
  })

  it('restricts to the locked ids when given', () => {
    const q = dialect.sqlToQuery(copyCandidatesSql(snap(), ['a', 'b'])!)
    expect(squash(q.sql)).toContain('AND o.id IN ($3::uuid, $4::uuid)')
    expect(q.params.slice(2, 4)).toEqual(['a', 'b'])
  })

  it('reads nothing without a company, a title, or ids to restrict to', async () => {
    const { tx, queries } = fakeTx([{ id: 'o1' }])
    expect(await copyCandidates(tx, snap({ companyName: '' }))).toEqual([])
    expect(await copyCandidates(tx, snap({ title: '  ' }))).toEqual([])
    expect(await copyCandidates(tx, snap(), [])).toEqual([])
    expect(queries).toHaveLength(0)
  })
})

describe('atsSiblings', () => {
  it('counts same-title records of the own board within the window, confirmed in JS', async () => {
    const { tx, queries } = fakeTx([
      { title: 'Senior Go-Engineer' },
      { title: 'senior go engineer' },
      { title: 'SENIOR GO ENGINEER' },
      { title: 'Senior Go Engineer (Berlin)' },
      { title: null },
    ])
    expect(await atsSiblings(tx, snap())).toBe(3)
    const q = squash(queries[0]!.sql)
    expect(q).toContain('r.source_type = $1 AND r.namespace = $2')
    expect(q).toContain('r.id <> $3::uuid')
    expect(q).toContain("lower(v.normalized->>'title') = lower($4)")
    expect(q).toContain('r.last_observed_at >= $5::timestamptz - $6::interval')
    expect(q).toContain('r.first_seen_at <= $7::timestamptz + $8::interval')
    expect(queries[0]!.params).toEqual([
      'LEVER_ATS',
      'lever:global:acme',
      REC,
      'Senior Go Engineer',
      '2026-11-01T00:00:00.000Z',
      `${14 * DAY} milliseconds`,
      '2026-11-03T00:00:00.000Z',
      `${14 * DAY} milliseconds`,
      50,
    ])
  })

  it('reads nothing for a record without an observation interval', async () => {
    const { tx, queries } = fakeTx([{ title: 'Senior Go Engineer' }])
    expect(await atsSiblings(tx, snap({ firstSeenAt: undefined }))).toBe(0)
    expect(await atsSiblings(tx, snap({ lastObservedAt: undefined }))).toBe(0)
    expect(queries).toHaveLength(0)
  })
})
