import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  isGoneAvailability,
  purgeClosedOwners,
  purgeOpportunity,
  purgeRetiredOpportunities,
  readActiveRecordStates,
  retiredOpportunityPredicate,
} from './opportunity-purge'

/**
 * Unit seam of the vacancy purge (owner 2026-11-25). The real statements run against Postgres in
 * `opportunity-purge.integration.spec.ts`; this spec pins the decisions (delete vs tombstone vs
 * retire, what counts, when the sweep stops) behind a scripted executor.
 */
const dialect = new PgDialect()
const OPP = '0000000a-0000-4000-8000-000000000001'
const OPP_B = '0000000a-0000-4000-8000-000000000002'
const REC = '0000000b-0000-4000-8000-000000000001'

type Rows = Record<string, unknown>[]
type Seen = { sql: string; params: unknown[] }

/** An executor answering by the first matching fragment; everything else returns no rows. */
function scripted(answers: [fragment: string, rows: Rows | ((q: Seen) => Rows)][]) {
  const seen: Seen[] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      const r = dialect.sqlToQuery(q)
      seen.push(r)
      const hit = answers.find(([fragment]) => r.sql.includes(fragment))
      const rows = hit === undefined ? [] : typeof hit[1] === 'function' ? hit[1](r) : hit[1]
      return Promise.resolve({ rows })
    },
  }
  const has = (fragment: string) => seen.some((q) => q.sql.includes(fragment))
  const find = (fragment: string) => seen.find((q) => q.sql.includes(fragment))
  return { tx, seen, has, find }
}

const MEMBERS = 'ORDER BY r.id FOR UPDATE'
const OPP_LOCK = 'FROM job_opportunities WHERE id ='
const KEPT = 'AS kept'
const RETIRE = 'SET namespace ='

describe('isGoneAvailability', () => {
  it('is true only for CLOSED and EXPIRED', () => {
    expect(isGoneAvailability('CLOSED')).toBe(true)
    expect(isGoneAvailability('EXPIRED')).toBe(true)
    expect(isGoneAvailability('OPEN')).toBe(false)
    expect(isGoneAvailability('UNKNOWN')).toBe(false)
  })
})

describe('readActiveRecordStates', () => {
  it('reads the active links of one opportunity and returns their availability', async () => {
    const s = scripted([
      ['SELECT r.availability', [{ availability: 'OPEN' }, { availability: 'CLOSED' }]],
    ])
    expect(await readActiveRecordStates(s.tx, OPP)).toEqual(['OPEN', 'CLOSED'])
    const q = s.seen[0] as Seen
    expect(q.sql).toContain('unlinked_at IS NULL')
    expect(q.params).toEqual([OPP])
  })
})

describe('purgeOpportunity', () => {
  it('MISSING: an absent opportunity touches nothing', async () => {
    const s = scripted([[MEMBERS, [{ id: REC }]]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('MISSING')
    expect(s.seen.some((q) => /^\s*(delete|update)/i.test(q.sql))).toBe(false)
  })

  it('DELETED: no logged action and no tailored resume deletes links, orphan records and the row', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
    // Lock order: member records (by id) first, then the opportunity.
    expect(s.seen[0]?.sql).toContain(MEMBERS)
    expect(s.seen[1]?.sql).toContain('FOR UPDATE')
    expect(s.seen[1]?.sql).toContain(OPP_LOCK)
    expect(s.find('DELETE FROM job_opportunity_sources')?.params).toEqual([OPP])
    expect(s.find('DELETE FROM job_source_records')?.params).toEqual([REC])
    expect(s.find('DELETE FROM job_opportunities WHERE')?.params).toEqual([OPP])
    expect(s.has('UPDATE job_opportunities')).toBe(false)
    // The link delete precedes the record delete (RESTRICT on both sides).
    const at = (f: string) => s.seen.findIndex((q) => q.sql.includes(f))
    expect(at('DELETE FROM job_opportunity_sources')).toBeLessThan(
      at('DELETE FROM job_source_records'),
    )
  })

  it('the kept probe looks at the action log and at tailored resumes', async () => {
    const s = scripted([
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: false }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    const probe = s.find(KEPT) as Seen
    expect(probe.sql).toContain('FROM job_queue_actions WHERE opportunity_id')
    expect(probe.sql).toContain('FROM tailored_resumes WHERE job_opportunity_id')
  })

  it('several members: one comma-separated id list; the log check guards both record statements', async () => {
    const REC_2 = '0000000b-0000-4000-8000-000000000002'
    const s = scripted([
      [MEMBERS, [{ id: REC }, { id: REC_2 }]],
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: false }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    const del = s.find('DELETE FROM job_source_records') as Seen
    expect(del.params).toEqual([REC, REC_2])
    expect(del.sql).toMatch(/\$1::uuid, \$2::uuid/)
    const logged = 'EXISTS (SELECT 1 FROM job_queue_actions a WHERE a.source_record_id = r.id)'
    expect(del.sql).toContain(`NOT ${logged}`)
    expect(s.find(RETIRE)?.sql).toContain(`AND ${logged}`)
  })

  it('a kept probe with no row deletes (the RESTRICT FK still refuses a logged row)', async () => {
    const s = scripted([[OPP_LOCK, [{ id: OPP }]]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
  })

  it('no members: no record statement at all', async () => {
    const s = scripted([
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
    expect(s.has('job_source_records r WHERE')).toBe(false)
    expect(s.has(RETIRE)).toBe(false)
  })

  it('TOMBSTONED: a logged opportunity keeps its row, loses its text and derived rows', async () => {
    const s = scripted([
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: true }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('TOMBSTONED')
    expect(s.has('DELETE FROM job_opportunities WHERE')).toBe(false)
    for (const table of [
      'job_opportunity_identity_tokens',
      'job_opportunity_matches',
      'job_opportunity_team_triage',
      'job_queue_generation_entries',
      'job_opportunity_relevance',
    ])
      expect(s.find(`DELETE FROM "${table}"`)?.params).toEqual([OPP])
    const update = s.find('UPDATE job_opportunities') as Seen
    expect(update.params).toEqual([OPP])
    for (const cleared of [
      "title = ''",
      'employer_name = NULL',
      'application_url = NULL',
      'description_sha256 = NULL',
      'salary_min = NULL',
      'revision = revision + 1',
      "ELSE 'EXPIRED'::job_availability",
    ])
      expect(update.sql).toContain(cleared)
    // The action log is never written.
    expect(
      s.seen.some((q) => /(update|delete from|insert into)\s+job_queue_actions/i.test(q.sql)),
    ).toBe(false)
  })

  it('a member record named by the log is retired: its text and identity go, the row stays', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [OPP_LOCK, [{ id: OPP }]],
      [RETIRE, [{ id: REC }]],
      [KEPT, [{ kept: true }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    const retire = s.find(RETIRE) as Seen
    expect(retire.params).toEqual(['retired:', REC, 'retired:%'])
    expect(retire.sql).toContain('original_url = NULL')
    expect(retire.sql).toContain('latest_revision_id = NULL')
    expect(s.find('DELETE FROM job_source_record_revisions')?.params).toEqual([REC])
    expect(s.find('DELETE FROM job_source_record_inventory_misses')?.params).toEqual([REC])
    expect(
      s.find('DELETE FROM job_opportunity_identity_tokens WHERE source_record_id')?.params,
    ).toEqual([REC])
  })

  it('a member record nobody retires keeps its revisions (no follow-up deletes)', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: false }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    expect(s.has('DELETE FROM job_source_record_revisions')).toBe(false)
    expect(s.has('DELETE FROM job_source_record_inventory_misses')).toBe(false)
  })
})

describe('purgeClosedOwners', () => {
  it('purges only the owners whose active members are all gone and counts them', async () => {
    const states: Record<string, Rows> = {
      [OPP]: [{ availability: 'CLOSED' }, { availability: 'EXPIRED' }],
      [OPP_B]: [{ availability: 'CLOSED' }, { availability: 'OPEN' }],
    }
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }, { opportunity_id: OPP_B }]],
      ['SELECT r.availability', (q) => states[String(q.params[0])] ?? []],
      [OPP_LOCK, (q) => [{ id: q.params[0] }]],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(1)
    const deleted = s.seen.filter((q) => q.sql.includes('DELETE FROM job_opportunities WHERE'))
    expect(deleted.map((q) => q.params)).toEqual([[OPP]])
    expect(s.find('SELECT DISTINCT opportunity_id')?.params).toEqual([REC])
  })

  it('an owner already gone (MISSING) is not counted', async () => {
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }]],
      ['SELECT r.availability', [{ availability: 'CLOSED' }]],
    ])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(0)
  })

  it('a tombstoned owner counts as purged', async () => {
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }]],
      ['SELECT r.availability', [{ availability: 'EXPIRED' }]],
      [OPP_LOCK, [{ id: OPP }]],
      [KEPT, [{ kept: true }]],
    ])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(1)
  })

  it('no owners: nothing read, nothing purged', async () => {
    const s = scripted([])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(0)
    expect(s.seen).toHaveLength(1)
  })
})

describe('retiredOpportunityPredicate', () => {
  it('selects sourced, non-manual opportunities past 60 days by publication date, or closed/expired', () => {
    const q = dialect.sqlToQuery(retiredOpportunityPredicate)
    expect(q.params).toEqual([60])
    expect(q.sql).toContain('o.manual_team_id IS NULL')
    expect(q.sql).toContain(
      'EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.opportunity_id = o.id)',
    )
    expect(q.sql).toContain('COALESCE(o.published_at, o.first_seen_at)')
    expect(q.sql).toContain("OR o.availability IN ('CLOSED', 'EXPIRED')")
  })
})

describe('purgeRetiredOpportunities', () => {
  /** A db whose sweep select returns the queued batches; each purge runs in its own transaction. */
  function sweepDb(
    batches: Rows[],
    outcomeOf: (id: string) => 'DELETED' | 'TOMBSTONED' | 'MISSING',
  ) {
    const queue = [...batches]
    const selects: Seen[] = []
    const isolation: unknown[] = []
    const db = {
      execute: (q: SQL) => {
        selects.push(dialect.sqlToQuery(q))
        return Promise.resolve({ rows: queue.shift() ?? [] })
      },
      transaction: async (fn: (tx: SqlExecutor) => Promise<unknown>, config?: unknown) => {
        isolation.push(config)
        let current = ''
        const tx: SqlExecutor = {
          execute: (q: SQL) => {
            const r = dialect.sqlToQuery(q)
            if (r.sql.includes(OPP_LOCK)) current = String(r.params[0])
            const outcome = outcomeOf(current)
            if (r.sql.includes(OPP_LOCK))
              return Promise.resolve({ rows: outcome === 'MISSING' ? [] : [{ id: current }] })
            if (r.sql.includes(KEPT))
              return Promise.resolve({ rows: [{ kept: outcome === 'TOMBSTONED' }] })
            return Promise.resolve({ rows: [] })
          },
        }
        return fn(tx)
      },
    }
    return { db: db as unknown as MeterDb, selects, isolation }
  }

  it('counts deletes and tombstones separately, skips MISSING, and stops on a short batch', async () => {
    const ids = ['a', 'b', 'c'].map((c) => `0000000${c}-0000-4000-8000-000000000009`)
    const outcomes: Record<string, 'DELETED' | 'TOMBSTONED' | 'MISSING'> = {
      [ids[0] as string]: 'DELETED',
      [ids[1] as string]: 'TOMBSTONED',
      [ids[2] as string]: 'MISSING',
    }
    const { db, selects, isolation } = sweepDb(
      [[{ id: ids[0] }, { id: ids[1] }], [{ id: ids[2] }], [{ id: ids[0] }]],
      (id) => outcomes[id] ?? 'MISSING',
    )
    expect(await purgeRetiredOpportunities(db, { batchSize: 2 })).toEqual({
      deleted: 1,
      tombstoned: 1,
    })
    // The second batch was short (1 < 2), so the third select never ran.
    expect(selects).toHaveLength(2)
    expect(selects[0]?.params).toEqual([60, 2])
    expect(selects[0]?.sql).toContain('ORDER BY o.id LIMIT')
    expect(isolation).toEqual([
      { isolationLevel: 'read committed' },
      { isolationLevel: 'read committed' },
      { isolationLevel: 'read committed' },
    ])
  })

  it('a MISSING outcome is counted as neither a delete nor a tombstone', async () => {
    const ids = ['a', 'b', 'c', 'd'].map((c) => `0000000${c}-0000-4000-8000-000000000009`)
    const outcomes = ['DELETED', 'TOMBSTONED', 'TOMBSTONED', 'MISSING'] as const
    const { db } = sweepDb(
      [ids.map((id) => ({ id }))],
      (id) => outcomes[ids.indexOf(id)] ?? 'MISSING',
    )
    expect(await purgeRetiredOpportunities(db, { batchSize: 10 })).toEqual({
      deleted: 1,
      tombstoned: 2,
    })
  })

  it('stops after maxBatches even when every batch is full', async () => {
    const id = '0000000d-0000-4000-8000-000000000009'
    const { db, selects } = sweepDb([[{ id }], [{ id }], [{ id }]], () => 'DELETED')
    expect(await purgeRetiredOpportunities(db, { batchSize: 1, maxBatches: 2 })).toEqual({
      deleted: 2,
      tombstoned: 0,
    })
    expect(selects).toHaveLength(2)
  })

  it('defaults to batches of 200', async () => {
    const { db, selects } = sweepDb([[]], () => 'DELETED')
    expect(await purgeRetiredOpportunities(db)).toEqual({ deleted: 0, tombstoned: 0 })
    expect(selects[0]?.params).toEqual([60, 200])
  })

  it('defaults to at most 50 batches', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }))
    const { db, selects } = sweepDb(
      Array.from({ length: 60 }, () => full),
      () => 'MISSING',
    )
    await purgeRetiredOpportunities(db)
    expect(selects).toHaveLength(50)
  })
})
