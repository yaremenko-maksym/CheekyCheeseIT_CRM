import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import { jobSources } from '../../database/schema'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { Manifest } from '../providers/manifest'
import { activationFactsByType } from '../providers/manifest.activation'
import { type DueRow, isDue } from './due-policy'
import { findDueSources } from './due-sources.query'

/**
 * Task 2.5 T4, real Postgres: the due QUERY over a seeded mix, compared with the pure `isDue` over
 * the same rows. Plus a literal list of which rows each trigger must select, so agreement of the two
 * is not the only assertion (two wrong implementations can agree).
 *
 * The mix: enabled and disabled rows, a cooled-down row, a deadline-crossed row (the stored
 * `readiness` column still says CANDIDATE), a row with no manifest entry, a row at the failure cap,
 * a PAUSED and a RETIRED row with `enabled = true`, a row whose cadence is in the future, a row with
 * no `next_attempt_at`, and a MANUAL-only row. Every spec timestamp is hours away from "now", so the
 * database clock the query uses and the application clock `isDue` is handed cannot disagree.
 *
 * Scope: every query is narrowed to this spec's own ids (`crm_qa` is shared).
 */
const NS = 'e4a1c0de-7a4b-4d3e-a400-'
const id = (n: number): string => `${NS}${String(n).padStart(12, '0')}`
const HOUR = 3_600_000

interface Seed {
  readonly n: number
  readonly label: string
  readonly type: JobSourceType
  readonly row: Partial<typeof jobSources.$inferInsert>
}

const PAST = (): Date => new Date(Date.now() - 2 * HOUR)
const FUTURE = (): Date => new Date(Date.now() + 5 * HOUR)

const SEEDS: Seed[] = [
  { n: 1, label: 'due', type: 'REMOTEOK_API', row: {} },
  { n: 2, label: 'disabled', type: 'REMOTEOK_API', row: { enabled: false } },
  { n: 3, label: 'cooled down', type: 'REMOTEOK_API', row: { cooldownUntil: FUTURE() } },
  { n: 4, label: 'deadline crossed', type: 'RECRUITEE_ATS', row: {} },
  { n: 5, label: 'no manifest entry', type: 'REMOTEOK_API', row: { manifestId: null } },
  { n: 6, label: 'failure cap', type: 'REMOTEOK_API', row: { consecutiveFailures: 3 } },
  { n: 7, label: 'PAUSED', type: 'REMOTEOK_API', row: { adminState: 'PAUSED' } },
  { n: 8, label: 'RETIRED', type: 'REMOTEOK_API', row: { adminState: 'RETIRED' } },
  { n: 9, label: 'cadence in future', type: 'REMOTEOK_API', row: { nextAttemptAt: FUTURE() } },
  { n: 10, label: 'cadence NULL', type: 'REMOTEOK_API', row: { nextAttemptAt: null } },
  { n: 11, label: 'MANUAL only', type: 'REMOTEOK_API', row: { triggerMode: 'MANUAL' } },
  { n: 12, label: 'cooldown over', type: 'REMOTEOK_API', row: { cooldownUntil: PAST() } },
  { n: 13, label: 'two failures', type: 'REMOTEOK_API', row: { consecutiveFailures: 2 } },
]
const IDS = SEEDS.map((s) => id(s.n))

/** A hand-built manifest: the deadline of RECRUITEE_ATS is already behind us, REMOTEOK has none. */
function manifestAt(now: Date): Pick<Manifest, 'types'> {
  const t = (type: string, deadlines: unknown[]) =>
    ({
      type,
      blockers: [],
      deadlines,
      payloadVerified: true,
    }) as unknown as Manifest['types'][number]
  return {
    types: [
      t('REMOTEOK_API', []),
      t('RECRUITEE_ATS', [
        { kind: 'AUTH_REQUIRED_FROM', at: new Date(now.getTime() - HOUR), symbol: 'D' },
      ]),
    ],
  }
}

describe.skipIf(!hasDatabaseUrl())('due query vs pure isDue over a seeded mix (T4)', () => {
  let pool: Pool
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    await db.delete(jobSources).where(inArray(jobSources.id, IDS))
    for (const s of SEEDS) {
      await db.insert(jobSources).values({
        id: id(s.n),
        type: s.type,
        config: { t4: s.label },
        manifestId: `t4.due.row${s.n}`,
        enabled: true,
        adminState: 'ACTIVE',
        triggerMode: 'BOTH',
        // The STORED readiness says CANDIDATE for every row, the deadline-crossed one included.
        readiness: 'CANDIDATE',
        nextAttemptAt: PAST(),
        cooldownUntil: null,
        consecutiveFailures: 0,
        ...s.row,
      })
    }
  }, 30_000)

  afterAll(async () => {
    await db.delete(jobSources).where(inArray(jobSources.id, IDS))
    await pool.end()
  })

  /** The query's rows, then `isDue` over them -- the production composition. */
  async function selected(trigger: JobSourceTriggerMode): Promise<string[]> {
    const now = new Date()
    const facts = activationFactsByType(manifestAt(now), now)
    const rows = await findDueSources(db, trigger, { onlyIds: IDS })
    return rows
      .filter((r) => isDue(r, { trigger, now, readiness: facts.get(r.type) }).due)
      .map((r) => r.id)
  }

  it('AC1: the deadline-crossed row is stored CANDIDATE, and is not due', async () => {
    const stored = await db
      .select()
      .from(jobSources)
      .where(inArray(jobSources.id, [id(4)]))
    expect(stored[0]?.readiness).toBe('CANDIDATE')
    expect(await selected('SCHEDULED')).not.toContain(id(4))
    expect(await selected('MANUAL')).not.toContain(id(4))
  })

  it('a scheduled trigger selects exactly the due rows (a literal list)', async () => {
    // 1 due, 12 cooldown over, 13 two failures. Everything else is refused for its own reason.
    expect((await selected('SCHEDULED')).sort()).toEqual([id(1), id(12), id(13)].sort())
  })

  it('a manual trigger selects the same rows plus those only the cadence term refused (AC7)', async () => {
    // + 9 cadence in future, 10 cadence NULL, 11 MANUAL only. Still not: 2, 3, 4, 5, 6, 7, 8.
    expect((await selected('MANUAL')).sort()).toEqual(
      [id(1), id(9), id(10), id(11), id(12), id(13)].sort(),
    )
  })

  it('agrees with the pure isDue on every seeded row, for both triggers', async () => {
    const now = new Date()
    const facts = activationFactsByType(manifestAt(now), now)
    const all = await db.select().from(jobSources).where(inArray(jobSources.id, IDS))
    expect(all).toHaveLength(SEEDS.length)
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      const fromQuery = new Set(await selected(trigger))
      for (const r of all) {
        const row: DueRow = r
        const pure = isDue(row, { trigger, now, readiness: facts.get(r.type) }).due
        expect({ id: r.id, trigger, due: fromQuery.has(r.id) }).toEqual({
          id: r.id,
          trigger,
          due: pure,
        })
      }
    }
  })

  it('the SQL pre-filter alone already drops every row the scalar terms refuse', async () => {
    // The readiness term is TypeScript; the deadline-crossed row passes the SQL and fails there.
    const sched = (await findDueSources(db, 'SCHEDULED', { onlyIds: IDS })).map((r) => r.id)
    expect(sched.sort()).toEqual([id(1), id(4), id(12), id(13)].sort())
  })

  it('AC3: the early-due slack widens the cadence term in SQL and nothing else', async () => {
    // Row 9 is 5 h out: a 10-minute slack does not reach it, a 6 h slack does; the cooled-down row
    // (3) stays out under both.
    const tenMin = (
      await findDueSources(db, 'SCHEDULED', { onlyIds: IDS, cadenceSlackMs: 600_000 })
    ).map((r) => r.id)
    expect(tenMin).not.toContain(id(9))
    const sixHours = (
      await findDueSources(db, 'SCHEDULED', { onlyIds: IDS, cadenceSlackMs: 6 * HOUR })
    ).map((r) => r.id)
    expect(sixHours).toContain(id(9))
    expect(sixHours).not.toContain(id(3))
    expect(sixHours).not.toContain(id(6))
  })

  it('orders by next_attempt_at, oldest first', async () => {
    const rows = await findDueSources(db, 'MANUAL', { onlyIds: IDS })
    const times = rows
      .filter((r) => r.nextAttemptAt !== null)
      .map((r) => r.nextAttemptAt!.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
