import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  VACANCY_RETENTION_FAILURE_MARKER,
  isGoneAvailability,
  isRemoved,
  purgeClosedOwners,
  purgeOpportunity,
  purgeOpportunityInline,
  purgeRetiredOpportunities,
  readActiveRecordStates,
  retiredOpportunityPredicate,
  retiredRecordPredicate,
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

const MEMBERS = 'ORDER BY r.id FOR UPDATE SKIP LOCKED'
/** The opportunity's lock, with the re-check columns. */
const OPP_LOCK = 'AS old'
/** The unlocked existence probe that tells a busy opportunity from a missing one. */
const EXISTS_PROBE = 'SELECT 1 FROM job_opportunities WHERE id'
/** The member set re-read under the opportunity lock. */
const CURRENT = 'bool_or(unlinked_at IS NULL) AS active'
const KEPT = 'AS kept'
const RETIRE = 'SET namespace ='
const lockRow = (over: Rows[number] = {}): Rows => [
  { manual: false, tombstone: false, suppressed: false, availability: 'OPEN', old: true, ...over },
]
/** Past retention: purged whatever its members say. */
const OLD = lockRow()
const isWrite = (q: Seen) => /^\s*(delete|update|insert)/i.test(q.sql)
const SAVEPOINT = 'SAVEPOINT vacancy_retention_purge'
const statements = (s: { seen: Seen[] }) => s.seen.map((q) => q.sql.trim())
const boom = (): Rows => {
  throw new Error('permission denied for table job_opportunities')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

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
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, OLD],
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
      [OPP_LOCK, OLD],
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
      [
        CURRENT,
        [
          { id: REC, active: true },
          { id: REC_2, active: true },
        ],
      ],
      [OPP_LOCK, OLD],
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

  it('a historical (unlinked) link does not keep a record; its RESTRICT row goes before the record', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    const del = s.find('DELETE FROM job_source_records') as Seen
    expect(del.sql).toContain('s.source_record_id = r.id AND s.unlinked_at IS NULL')
    const at = (f: string) => s.seen.findIndex((q) => q.sql.includes(f))
    const history = at('DELETE FROM job_opportunity_sources h')
    expect(history).toBeGreaterThan(at('DELETE FROM job_opportunity_sources WHERE opportunity_id'))
    expect(history).toBeLessThan(at('DELETE FROM job_source_records'))
    expect(s.seen[history]?.params).toEqual([REC])
  })

  it('a kept probe with no row deletes (the RESTRICT FK still refuses a logged row)', async () => {
    const s = scripted([[OPP_LOCK, OLD]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
  })

  it('no members: no record statement at all', async () => {
    const s = scripted([
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
    expect(s.has('job_source_records r WHERE')).toBe(false)
    expect(s.has(RETIRE)).toBe(false)
  })

  it('TOMBSTONED: a logged opportunity keeps its row, loses its text and derived rows', async () => {
    const s = scripted([
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: true }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('TOMBSTONED')
    expect(s.has('DELETE FROM job_opportunities WHERE')).toBe(false)
    for (const table of [
      'job_opportunity_identity_tokens',
      'job_opportunity_matches',
      'job_opportunity_team_triage',
      'job_opportunity_relevance',
      'job_queue_dismissals',
    ])
      expect(s.find(`DELETE FROM "${table}"`)?.params).toEqual([OPP])
    // SR-M-2: the senior submissions stay, so the duplicate guard still sees them.
    expect(s.has('job_queue_assignments')).toBe(false)
    // Immutable entries: the trigger refuses a direct delete; they leave with their generation.
    expect(s.has('job_queue_generation_entries')).toBe(false)
    const update = s.find('UPDATE job_opportunities') as Seen
    expect(update.params).toEqual([OPP])
    for (const cleared of [
      `field_revisions = '{"retention":"TOMBSTONE"}'::jsonb`,
      'location = NULL',
      'application_url = NULL',
      'description_sha256 = NULL',
      'salary_min = NULL',
      'revision = revision + 1',
      "ELSE 'EXPIRED'::job_availability",
    ])
      expect(update.sql).toContain(cleared)
    // The guard's keys and the preview's text stay.
    for (const kept of ['title', 'title_key', 'employer_name', 'employer_key'])
      expect(update.sql).not.toContain(` ${kept} =`)
    // The action log is never written.
    expect(
      s.seen.some((q) => /(update|delete from|insert into)\s+job_queue_actions/i.test(q.sql)),
    ).toBe(false)
  })

  it('a member record named by the log is retired: its text and identity go, the row stays', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, OLD],
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

  it('every lock is SKIP LOCKED: the purge never waits on a row another transaction holds', async () => {
    const s = scripted([[OPP_LOCK, OLD]])
    await purgeOpportunity(s.tx, OPP)
    const locks = s.seen.filter((q) => q.sql.includes('FOR UPDATE'))
    expect(locks).toHaveLength(2)
    expect(locks[0]?.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(locks[1]?.sql).toContain('FOR UPDATE OF o SKIP LOCKED')
  })

  it('the opportunity lock reads the tombstone marker and an ADMIN suppression', async () => {
    const s = scripted([[OPP_LOCK, OLD]])
    await purgeOpportunity(s.tx, OPP)
    const lock = s.find(OPP_LOCK) as Seen
    expect(lock.sql).toContain(
      `(o.field_revisions @> '{"retention":"TOMBSTONE"}'::jsonb) AS tombstone`,
    )
    expect(lock.sql).toContain(
      "sup.opportunity_id = o.id AND sup.kind = 'SUPPRESSED') AS suppressed",
    )
    expect(lock.params).toEqual([60, OPP])
  })

  it('SKIPPED: a tombstone is never purged again', async () => {
    const s = scripted([[OPP_LOCK, lockRow({ tombstone: true })]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('SKIPPED: an opportunity an ADMIN suppressed is never purged, even past retention (SR-M-2)', async () => {
    const s = scripted([[OPP_LOCK, lockRow({ suppressed: true })]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('CR-M-3: a historical member is locked and re-checked, but only active members are purged', async () => {
    const REC_2 = '0000000b-0000-4000-8000-000000000002'
    const s = scripted([
      [MEMBERS, [{ id: REC }, { id: REC_2 }]],
      [
        CURRENT,
        [
          { id: REC, active: true },
          { id: REC_2, active: false },
        ],
      ],
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
    expect(s.find(CURRENT)?.sql).toContain('GROUP BY source_record_id')
    expect(s.find('DELETE FROM job_source_records')?.params).toEqual([REC])
    expect(s.find(RETIRE)?.params).toEqual(['retired:', REC, 'retired:%'])
  })

  it('CR-M-3: only historical members: the links go, no record statement at all', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: false }]],
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
    expect(s.find('DELETE FROM job_opportunity_sources WHERE')?.params).toEqual([OPP])
    expect(s.has('job_source_records r WHERE')).toBe(false)
  })

  it('SKIPPED: a historical member locked elsewhere still blocks the purge', async () => {
    const REC_2 = '0000000b-0000-4000-8000-000000000002'
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [
        CURRENT,
        [
          { id: REC, active: true },
          { id: REC_2, active: false },
        ],
      ],
      [OPP_LOCK, OLD],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('SKIPPED: an opportunity locked elsewhere (it exists, the lock skipped it) is not touched', async () => {
    const s = scripted([[EXISTS_PROBE, [{ '?column?': 1 }]]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('SKIPPED: a member locked elsewhere (or linked after the member lock) is not touched', async () => {
    const s = scripted([
      [MEMBERS, []],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, OLD],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('SKIPPED: a manual card is never purged, even past retention', async () => {
    const s = scripted([[OPP_LOCK, lockRow({ manual: true })]])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('not past retention: re-derived under the lock; an OPEN member keeps it', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, lockRow({ old: false, availability: 'CLOSED' })],
      ['SELECT r.availability', [{ availability: 'CLOSED' }, { availability: 'OPEN' }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('SKIPPED')
    expect(s.seen.some(isWrite)).toBe(false)
  })

  it('not past retention: active members all CLOSED/EXPIRED purge it', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, lockRow({ old: false })],
      ['SELECT r.availability', [{ availability: 'EXPIRED' }]],
    ])
    expect(await purgeOpportunity(s.tx, OPP)).toBe('DELETED')
  })

  it('not past retention, no active member: its own availability decides', async () => {
    const closed = scripted([[OPP_LOCK, lockRow({ old: false, availability: 'CLOSED' })]])
    expect(await purgeOpportunity(closed.tx, OPP)).toBe('DELETED')
    const open = scripted([[OPP_LOCK, lockRow({ old: false, availability: 'OPEN' })]])
    expect(await purgeOpportunity(open.tx, OPP)).toBe('SKIPPED')
  })

  it('beforeWrite runs after the checks and before the first write; never on SKIPPED', async () => {
    const s = scripted([[OPP_LOCK, OLD]])
    let writesBefore = -1
    await purgeOpportunity(s.tx, OPP, async () => {
      writesBefore = s.seen.filter(isWrite).length
    })
    expect(writesBefore).toBe(0)
    expect(s.seen.some(isWrite)).toBe(true)
    let called = false
    const skipped = scripted([[OPP_LOCK, lockRow({ manual: true })]])
    await purgeOpportunity(skipped.tx, OPP, async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it('a member record nobody retires keeps its revisions (no follow-up deletes)', async () => {
    const s = scripted([
      [MEMBERS, [{ id: REC }]],
      [CURRENT, [{ id: REC, active: true }]],
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    await purgeOpportunity(s.tx, OPP)
    expect(s.has('DELETE FROM job_source_record_revisions')).toBe(false)
    expect(s.has('DELETE FROM job_source_record_inventory_misses')).toBe(false)
  })
})

describe('isRemoved', () => {
  it('is true only for DELETED and TOMBSTONED', () => {
    expect(isRemoved('DELETED')).toBe(true)
    expect(isRemoved('TOMBSTONED')).toBe(true)
    expect(isRemoved('SKIPPED')).toBe(false)
    expect(isRemoved('MISSING')).toBe(false)
    expect(isRemoved('FAILED')).toBe(false)
  })
})

describe('purgeOpportunityInline (CR-M-2)', () => {
  it('runs the purge inside a savepoint and releases it on success', async () => {
    const s = scripted([
      [OPP_LOCK, OLD],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunityInline(s.tx, OPP)).toBe('DELETED')
    const all = statements(s)
    expect(all[0]).toBe(SAVEPOINT)
    expect(all.at(-1)).toBe(`RELEASE ${SAVEPOINT}`)
    expect(all.some((q) => q.startsWith('ROLLBACK'))).toBe(false)
  })

  it('passes beforeWrite through and returns the purge outcome', async () => {
    const s = scripted([[OPP_LOCK, lockRow({ manual: true })]])
    let called = false
    expect(
      await purgeOpportunityInline(s.tx, OPP, async () => {
        called = true
      }),
    ).toBe('SKIPPED')
    expect(called).toBe(false)
    const ok = scripted([[OPP_LOCK, OLD]])
    await purgeOpportunityInline(ok.tx, OPP, async () => {
      called = true
    })
    expect(called).toBe(true)
  })

  it('a purge that throws is rolled back to the savepoint, logged with the marker, and reported FAILED', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const s = scripted([
      [OPP_LOCK, OLD],
      ['DELETE FROM job_opportunities WHERE', boom],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeOpportunityInline(s.tx, OPP)).toBe('FAILED')
    const all = statements(s)
    expect(all.slice(-2)).toEqual([`ROLLBACK TO ${SAVEPOINT}`, `RELEASE ${SAVEPOINT}`])
    expect(error).toHaveBeenCalledTimes(1)
    const [message] = error.mock.calls[0] as [string]
    expect(message.startsWith(`${VACANCY_RETENTION_FAILURE_MARKER} `)).toBe(true)
    expect(message).toContain(OPP)
  })

  it('a failed rollback is not swallowed', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const s = scripted([
      [OPP_LOCK, boom],
      [
        'ROLLBACK TO',
        () => {
          throw new Error('connection terminated')
        },
      ],
    ])
    await expect(purgeOpportunityInline(s.tx, OPP)).rejects.toThrow('connection terminated')
  })
})

describe('purgeClosedOwners', () => {
  it('each owner is its own savepoint: a failing purge is passed over and the next one still goes', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    let lockCalls = 0
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }, { opportunity_id: OPP_B }]],
      ['SELECT r.availability', [{ availability: 'CLOSED' }]],
      [
        OPP_LOCK,
        () => {
          lockCalls += 1
          return lockCalls === 1 ? boom() : OLD
        },
      ],
      [KEPT, [{ kept: false }]],
    ])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(1)
    expect(statements(s).filter((q) => q === SAVEPOINT)).toHaveLength(2)
    expect(statements(s).filter((q) => q === `ROLLBACK TO ${SAVEPOINT}`)).toHaveLength(1)
    const deleted = s.seen.filter((q) => q.sql.includes('DELETE FROM job_opportunities WHERE'))
    expect(deleted.map((q) => q.params)).toEqual([[OPP_B]])
  })

  it('VACANCY_RETENTION_ENABLED=false: removes nothing and reads nothing (SR-M-3)', async () => {
    vi.stubEnv('VACANCY_RETENTION_ENABLED', 'FALSE')
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }]],
      ['SELECT r.availability', [{ availability: 'CLOSED' }]],
      [OPP_LOCK, OLD],
    ])
    expect(await purgeClosedOwners(s.tx, REC)).toBe(0)
    expect(s.seen).toHaveLength(0)
  })

  it('purges only the owners whose active members are all gone and counts them', async () => {
    const states: Record<string, Rows> = {
      [OPP]: [{ availability: 'CLOSED' }, { availability: 'EXPIRED' }],
      [OPP_B]: [{ availability: 'CLOSED' }, { availability: 'OPEN' }],
    }
    const s = scripted([
      ['SELECT DISTINCT opportunity_id', [{ opportunity_id: OPP }, { opportunity_id: OPP_B }]],
      ['SELECT r.availability', (q) => states[String(q.params[0])] ?? []],
      // Not past retention: the purge re-derives OPP_B under its lock too, so only OPP goes.
      [OPP_LOCK, lockRow({ old: false })],
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
      [OPP_LOCK, OLD],
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
  it('selects non-manual, non-tombstone, unsuppressed opportunities past 60 days by publication date, or closed/expired', () => {
    const q = dialect.sqlToQuery(retiredOpportunityPredicate)
    expect(q.params).toEqual([60])
    expect(q.sql).toContain('o.manual_team_id IS NULL')
    // SR-M-1: no link-row test, so an opportunity that lost its last link is still swept; the
    // tombstone is recognised by its marker instead, and an ADMIN takedown is never selected.
    expect(q.sql).not.toContain('job_opportunity_sources')
    expect(q.sql).toContain(
      `AND NOT (o.field_revisions @> '{"retention":"TOMBSTONE"}'::jsonb) AND NOT EXISTS (SELECT 1 FROM job_queue_actions sup`,
    )
    expect(q.sql).toContain("sup.opportunity_id = o.id AND sup.kind = 'SUPPRESSED')")
    expect(q.sql).toContain('COALESCE(o.published_at, o.first_seen_at)')
    expect(q.sql).toContain("OR o.availability IN ('CLOSED', 'EXPIRED')")
  })
})

describe('retiredRecordPredicate', () => {
  it('selects unretired records with no ACTIVE link, past 60 days by revision date, or closed/expired', () => {
    const q = dialect.sqlToQuery(retiredRecordPredicate)
    expect(q.params).toEqual(['retired:%', 60])
    expect(q.sql).toContain('r.namespace NOT LIKE')
    expect(q.sql).toContain('s.source_record_id = r.id AND s.unlinked_at IS NULL')
    expect(q.sql).toContain("r.availability IN ('CLOSED', 'EXPIRED')")
    expect(q.sql).toContain('v.id = r.latest_revision_id), r.first_seen_at)')
  })
})

describe('purgeRetiredOpportunities', () => {
  type Outcome = 'DELETED' | 'TOMBSTONED' | 'MISSING' | 'SKIPPED' | 'THROWS'

  /**
   * A db whose page selects return the queued batches (opportunities, then unlinked records) and
   * whose blob delete returns `blobs`; each opportunity/record runs in its own transaction.
   */
  function sweepDb(
    batches: Rows[],
    outcomeOf: (id: string) => Outcome,
    opts: {
      records?: Rows[]
      recordLocked?: (id: string) => boolean
      recordThrows?: (id: string) => boolean
      blobs?: Rows[]
    } = {},
  ) {
    const oppQueue = [...batches]
    const recQueue = [...(opts.records ?? [])]
    const blobQueue = [...(opts.blobs ?? [])]
    const selects: Seen[] = []
    const recordSelects: Seen[] = []
    const blobDeletes: Seen[] = []
    const writes: Seen[] = []
    const isolation: unknown[] = []
    const db = {
      execute: (q: SQL) => {
        const r = dialect.sqlToQuery(q)
        if (r.sql.includes('DELETE FROM job_text_blobs')) {
          blobDeletes.push(r)
          return Promise.resolve({ rows: blobQueue.shift() ?? [] })
        }
        if (r.sql.includes('FROM job_source_records r')) {
          recordSelects.push(r)
          return Promise.resolve({ rows: recQueue.shift() ?? [] })
        }
        selects.push(r)
        return Promise.resolve({ rows: oppQueue.shift() ?? [] })
      },
      transaction: async (fn: (tx: SqlExecutor) => Promise<unknown>, config?: unknown) => {
        isolation.push(config)
        let current = ''
        const tx: SqlExecutor = {
          execute: (q: SQL) => {
            const r = dialect.sqlToQuery(q)
            if (isWrite(r)) writes.push(r)
            if (r.sql.includes('r.id = $1::uuid AND')) {
              const id = String(r.params[0])
              if (opts.recordThrows?.(id) === true) return Promise.reject(new Error('lock timeout'))
              return Promise.resolve({ rows: opts.recordLocked?.(id) === true ? [] : [{ id }] })
            }
            if (r.sql.includes(OPP_LOCK) || r.sql.includes(EXISTS_PROBE))
              current = String(r.params.at(-1))
            const outcome = outcomeOf(current)
            if (r.sql.includes(OPP_LOCK)) {
              if (outcome === 'THROWS') return Promise.reject(new Error('deadlock detected'))
              return Promise.resolve({
                rows: outcome === 'MISSING' || outcome === 'SKIPPED' ? [] : OLD,
              })
            }
            if (r.sql.includes(EXISTS_PROBE))
              return Promise.resolve({ rows: outcome === 'SKIPPED' ? [{ '?column?': 1 }] : [] })
            if (r.sql.includes(KEPT))
              return Promise.resolve({ rows: [{ kept: outcome === 'TOMBSTONED' }] })
            return Promise.resolve({ rows: [] })
          },
        }
        return fn(tx)
      },
    }
    return { db: db as unknown as MeterDb, selects, recordSelects, blobDeletes, writes, isolation }
  }

  const zero = { deleted: 0, tombstoned: 0, skipped: 0, failed: 0, records: 0, blobs: 0 }
  const idOf = (c: string) => `0000000${c}-0000-4000-8000-000000000009`

  it('counts each outcome separately and stops on a short batch', async () => {
    const ids = ['a', 'b', 'c', 'd'].map(idOf)
    const outcomes: Record<string, Outcome> = {
      [ids[0] as string]: 'DELETED',
      [ids[1] as string]: 'TOMBSTONED',
      [ids[2] as string]: 'MISSING',
      [ids[3] as string]: 'SKIPPED',
    }
    const { db, selects, isolation } = sweepDb(
      [[{ id: ids[0] }, { id: ids[1] }], [{ id: ids[2] }, { id: ids[3] }], []],
      (id) => outcomes[id] ?? 'MISSING',
    )
    expect(await purgeRetiredOpportunities(db, { batchSize: 2 })).toEqual({
      ...zero,
      deleted: 1,
      tombstoned: 1,
      skipped: 1,
    })
    expect(selects).toHaveLength(3)
    expect(selects[0]?.params).toEqual([60, 2])
    expect(selects[0]?.sql).toContain('ORDER BY o.id LIMIT')
    expect(isolation).toEqual(
      Array.from({ length: 4 }, () => ({ isolationLevel: 'read committed' })),
    )
  })

  it('keyset: each batch starts after the last id seen, so a stuck row is not re-read at the head', async () => {
    const ids = ['a', 'b', 'c'].map(idOf)
    const { db, selects } = sweepDb(
      [[{ id: ids[0] }, { id: ids[1] }], [{ id: ids[2] }]],
      () => 'SKIPPED',
    )
    await purgeRetiredOpportunities(db, { batchSize: 2 })
    expect(selects[0]?.sql).not.toContain('o.id >')
    expect(selects[1]?.sql).toContain('o.id > $2::uuid')
    expect(selects[1]?.params).toEqual([60, ids[1], 2])
  })

  it('a row that throws is counted and reported, and the sweep goes on with the next one', async () => {
    const ids = ['a', 'b'].map(idOf)
    const errors: [string, string, unknown][] = []
    const { db } = sweepDb([[{ id: ids[0] }, { id: ids[1] }]], (id) =>
      id === ids[0] ? 'THROWS' : 'DELETED',
    )
    const result = await purgeRetiredOpportunities(db, {
      batchSize: 10,
      onError: (kind, id, error) => errors.push([kind, id, error]),
    })
    expect(result).toEqual({ ...zero, deleted: 1, failed: 1 })
    expect(errors.map(([kind, id]) => [kind, id])).toEqual([['OPPORTUNITY', ids[0]]])
    expect(String(errors[0]?.[2])).toContain('deadlock detected')
  })

  it('stops after maxBatches even when every batch is full', async () => {
    const ids = ['a', 'b', 'c'].map(idOf)
    const { db, selects } = sweepDb(
      ids.map((id) => [{ id }]),
      () => 'DELETED',
    )
    expect(await purgeRetiredOpportunities(db, { batchSize: 1, maxBatches: 2 })).toEqual({
      ...zero,
      deleted: 2,
    })
    expect(selects).toHaveLength(2)
  })

  it('defaults to batches of 200', async () => {
    const { db, selects } = sweepDb([[]], () => 'DELETED')
    expect(await purgeRetiredOpportunities(db)).toEqual(zero)
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

  it('then purges unlinked retired records, re-tested under a SKIP LOCKED lock', async () => {
    const recs = ['e', 'f'].map(idOf)
    const { db, recordSelects, writes } = sweepDb([[]], () => 'MISSING', {
      records: [[{ id: recs[0] }, { id: recs[1] }]],
      recordLocked: (id) => id === recs[1],
    })
    expect(await purgeRetiredOpportunities(db, { batchSize: 10 })).toEqual({
      ...zero,
      records: 1,
      skipped: 1,
    })
    expect(recordSelects[0]?.sql).toContain('ORDER BY r.id LIMIT')
    expect(recordSelects[0]?.params).toEqual(['retired:%', 60, 10])
    // The free record is the one purged; the locked one wrote nothing.
    expect(writes.find((q) => q.sql.includes('DELETE FROM job_source_records'))?.params).toEqual([
      recs[0],
    ])
    expect(writes.some((q) => q.params.includes(recs[1]))).toBe(false)
  })

  it('record keyset: the second record page starts after the last record id', async () => {
    const recs = ['e', 'f', '1'].map(idOf)
    const { db, recordSelects } = sweepDb([[]], () => 'MISSING', {
      records: [[{ id: recs[0] }, { id: recs[1] }], [{ id: recs[2] }]],
    })
    await purgeRetiredOpportunities(db, { batchSize: 2 })
    expect(recordSelects[0]?.sql).not.toContain('r.id >')
    expect(recordSelects[1]?.sql).toContain('AND r.id > $3::uuid')
    expect(recordSelects[1]?.params).toEqual(['retired:%', 60, recs[1], 2])
  })

  it('a record that throws is counted and reported as RECORD, and the next one still goes', async () => {
    const recs = ['e', 'f'].map(idOf)
    const errors: [string, string][] = []
    const { db } = sweepDb([[]], () => 'MISSING', {
      records: [[{ id: recs[0] }, { id: recs[1] }]],
      recordThrows: (id) => id === recs[0],
    })
    expect(
      await purgeRetiredOpportunities(db, {
        batchSize: 10,
        onError: (kind, id) => errors.push([kind, id]),
      }),
    ).toEqual({ ...zero, records: 1, failed: 1 })
    expect(errors).toEqual([['RECORD', recs[0]]])
  })

  /** A blob page whose highest key is neither its first nor its last row (RETURNING has no order). */
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sha256: String((i * 7) % 1000).padStart(4, '0') }))

  it('then collects unreferenced description text; a short page stops it with more queued', async () => {
    const { db, blobDeletes } = sweepDb([[]], () => 'MISSING', {
      blobs: [page(1000), page(3), page(1000)],
    })
    expect(await purgeRetiredOpportunities(db)).toEqual({ ...zero, blobs: 1003 })
    expect(blobDeletes).toHaveLength(2)
  })

  it('the blob pass is bounded by maxBatches even when every page is full', async () => {
    const { db, blobDeletes } = sweepDb([[]], () => 'MISSING', {
      blobs: [page(1000), page(1000), page(1000)],
    })
    expect(await purgeRetiredOpportunities(db, { maxBatches: 2 })).toEqual({
      ...zero,
      blobs: 2000,
    })
    expect(blobDeletes).toHaveLength(2)
  })

  it('blob keyset (CR-M-7): each page starts after the highest key the previous one deleted', async () => {
    const { db, blobDeletes } = sweepDb([[]], () => 'MISSING', { blobs: [page(1000), page(1)] })
    await purgeRetiredOpportunities(db)
    expect(blobDeletes[0]?.sql).toMatch(/WHERE TRUE\s+AND NOT EXISTS/)
    expect(blobDeletes[0]?.sql).toContain('ORDER BY x.sha256 LIMIT')
    expect(blobDeletes[0]?.params).toEqual([1000])
    expect(blobDeletes[1]?.sql).toMatch(/WHERE x\.sha256 > \$1\s+AND NOT EXISTS/)
    expect(blobDeletes[1]?.params).toEqual(['0999', 1000])
  })

  it('the first opportunity page has no lower bound (a literal TRUE)', async () => {
    const { db, selects } = sweepDb([[]], () => 'MISSING')
    await purgeRetiredOpportunities(db)
    expect(selects[0]?.sql).toMatch(/AND TRUE\s+ORDER BY o\.id/)
  })

  it('MISSING is not counted as skipped (two SKIPPED, one MISSING)', async () => {
    const ids = ['a', 'b', 'c'].map(idOf)
    const { db } = sweepDb([[{ id: ids[0] }, { id: ids[1] }, { id: ids[2] }]], (id) =>
      id === ids[2] ? 'MISSING' : 'SKIPPED',
    )
    expect(await purgeRetiredOpportunities(db, { batchSize: 10 })).toEqual({
      ...zero,
      skipped: 2,
    })
  })

  it('without onError a throwing row and a throwing blob pass still resolve (never rethrows)', async () => {
    const ids = ['a', 'b'].map(idOf)
    const { db } = sweepDb([[{ id: ids[0] }, { id: ids[1] }]], (id) =>
      id === ids[0] ? 'THROWS' : 'DELETED',
    )
    const base = db as unknown as SqlExecutor
    const failing = {
      ...(db as unknown as Record<string, unknown>),
      execute: (q: SQL) =>
        dialect.sqlToQuery(q).sql.includes('DELETE FROM job_text_blobs')
          ? Promise.reject(new Error('fk'))
          : base.execute(q),
    } as unknown as MeterDb
    expect(await purgeRetiredOpportunities(failing, { batchSize: 10 })).toEqual({
      ...zero,
      deleted: 1,
      failed: 2,
    })
  })

  it('a failed blob pass is counted and reported, not thrown', async () => {
    const errors: string[] = []
    const { db } = sweepDb([[]], () => 'MISSING')
    const failing = {
      ...(db as unknown as Record<string, unknown>),
      execute: (q: SQL) =>
        dialect.sqlToQuery(q).sql.includes('DELETE FROM job_text_blobs')
          ? Promise.reject(new Error('fk'))
          : Promise.resolve({ rows: [] }),
    } as unknown as MeterDb
    expect(
      await purgeRetiredOpportunities(failing, {
        onError: (kind, id) => errors.push(`${kind} ${id}`),
      }),
    ).toEqual({ ...zero, failed: 1 })
    expect(errors).toEqual(['BLOBS job_text_blobs'])
  })
})
