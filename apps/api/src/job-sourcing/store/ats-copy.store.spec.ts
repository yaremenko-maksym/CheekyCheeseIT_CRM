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
    // F8: an ADMIN relink that moved a record out counts as an ADMIN decision too.
    expect(q.match(/OR \w\.unlink_reason LIKE 'ADMIN_RELINK:%'/g)).toHaveLength(3)
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
  it('counts same-title, same-company records of the own board in the window, confirmed in JS', async () => {
    const { tx, queries } = fakeTx([
      { title: 'Senior Go-Engineer', company: 'Acme GmbH' },
      { title: 'senior go engineer', company: 'ACME gmbh' },
      { title: 'SENIOR GO ENGINEER', company: 'Acme, GmbH' },
      { title: 'Senior Go Engineer (Berlin)', company: 'Acme GmbH' },
      { title: 'Senior Go Engineer', company: 'Other Co' },
      { title: null, company: null },
    ])
    expect(await atsSiblings(tx, snap())).toBe(3)
    const q = squash(queries[0]!.sql)
    expect(q).toContain('r.source_type = $1 AND r.namespace = $2')
    expect(q).toContain('r.id <> $3::uuid')
    // F2: the prefilter is the coarse squashed key on both sides, title and company.
    expect(q).toContain(
      "regexp_replace(regexp_replace(regexp_replace(lower(normalize(coalesce(v.normalized->>'title', ''), NFKC)),",
    )
    expect(q).toContain('lower(normalize($4::text, NFKC))')
    expect(q).toContain("lower(normalize(coalesce(v.normalized->>'companyName', ''), NFKC))")
    expect(q).toContain('lower(normalize($5::text, NFKC))')
    expect(q).toContain(
      "'[^[:alnum:]]+', '', 'g'), '([cf])(plusplus|sharp)', '\\1', 'g'), 'dotnet', 'net', 'g')",
    )
    expect(q).toContain('r.last_observed_at >= $6::timestamptz - $7::interval')
    expect(q).toContain('r.first_seen_at <= $8::timestamptz + $9::interval')
    expect(queries[0]!.params).toEqual([
      'LEVER_ATS',
      'lever:global:acme',
      REC,
      'Senior Go Engineer',
      'Acme GmbH',
      '2026-11-01T00:00:00.000Z',
      `${14 * DAY} milliseconds`,
      '2026-11-03T00:00:00.000Z',
      `${14 * DAY} milliseconds`,
      51,
    ])
  })

  it('a read that reaches the cap counts as siblings: a hidden one is never guessed away', async () => {
    const other = { title: 'Data Analyst', company: 'Other Co' }
    expect(await atsSiblings(fakeTx(Array(51).fill(other)).tx, snap())).toBe(51)
    expect(await atsSiblings(fakeTx(Array(50).fill(other)).tx, snap())).toBe(0)
  })

  it('reads nothing for a record without an observation interval', async () => {
    const { tx, queries } = fakeTx([{ title: 'Senior Go Engineer' }])
    const unseen = snap()
    delete unseen.firstSeenAt
    const unobserved = snap()
    delete unobserved.lastObservedAt
    expect(await atsSiblings(tx, unseen)).toBe(0)
    expect(await atsSiblings(tx, unobserved)).toBe(0)
    expect(queries).toHaveLength(0)
  })
})
