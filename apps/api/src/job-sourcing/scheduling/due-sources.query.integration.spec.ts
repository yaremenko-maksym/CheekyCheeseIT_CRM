import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import { jobSources } from '../../database/schema'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { Manifest } from '../providers/manifest'
import type { ActivationFacts } from '../registry/activation'
import { activationFactsByType } from '../providers/manifest.activation'
import { isDue } from './due-policy'
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
const IN_MIN = (m: number): Date => new Date(Date.now() + m * 60_000)

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
  { n: 14, label: 'cadence in 5 min', type: 'REMOTEOK_API', row: { nextAttemptAt: IN_MIN(5) } },
  { n: 15, label: 'cadence in 15 min', type: 'REMOTEOK_API', row: { nextAttemptAt: IN_MIN(15) } },
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

  /** What the SQL pre-filter returns, as ids. */
  async function sqlIds(trigger: JobSourceTriggerMode): Promise<string[]> {
    return (await findDueSources(db, trigger, { onlyIds: IDS })).map((r) => r.id).sort()
  }

  /** The production composition: the SQL rows, then `isDue` with the real facts at the clock. */
  async function selected(trigger: JobSourceTriggerMode): Promise<string[]> {
    const now = new Date()
    const facts = activationFactsByType(manifestAt(now), now)
    const rows = await findDueSources(db, trigger, { onlyIds: IDS })
    return rows
      .filter(
        (r) =>
          isDue(r, {
            trigger,
            now,
            readiness: facts.get(r.type),
            costBlocked: false,
            hostPaused: false,
            alreadyRunning: false,
          }).due,
      )
      .map((r) => r.id)
      .sort()
  }

  const ids = (...ns: number[]): string[] => ns.map(id).sort()

  it('AC1: the deadline-crossed row is stored CANDIDATE, and is not due', async () => {
    const stored = await db
      .select()
      .from(jobSources)
      .where(inArray(jobSources.id, [id(4)]))
    expect(stored[0]?.readiness).toBe('CANDIDATE')
    expect(await selected('SCHEDULED')).not.toContain(id(4))
    expect(await selected('MANUAL')).not.toContain(id(4))
  })

  it('CR-M-2: the SQL pre-filter alone, scheduled, is exactly this literal list', async () => {
    // 1 due, 4 deadline-crossed (readiness is TypeScript, invisible to SQL), 12 cooldown over,
    // 13 two failures. Refused by SQL: 2 disabled, 3 cooling, 5 no manifest, 6 cap, 7 PAUSED,
    // 8 RETIRED, 9 / 14 / 15 cadence ahead, 10 cadence NULL, 11 MANUAL-only.
    expect(await sqlIds('SCHEDULED')).toEqual(ids(1, 4, 12, 13))
  })

  it('CR-M-2: the SQL pre-filter alone, manual, is exactly this literal list', async () => {
    // The scheduled list plus every row only the cadence term (and the trigger policy) refused:
    // 9, 14, 15 (cadence ahead), 10 (NULL), 11 (MANUAL-only). Still refused: 2, 3, 5, 6, 7, 8.
    expect(await sqlIds('MANUAL')).toEqual(ids(1, 4, 9, 10, 11, 12, 13, 14, 15))
  })

  it('CR-M-2: the SQL set EQUALS the rows isDue accepts once readiness is fixed to activatable and the inputs SQL cannot see are false', async () => {
    const now = new Date()
    const activatable: ActivationFacts = {
      readiness: 'CANDIDATE',
      blockerCodes: [],
      payloadVerified: true,
    }
    const all = await db.select().from(jobSources).where(inArray(jobSources.id, IDS))
    expect(all).toHaveLength(SEEDS.length)
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      const accepted = all
        .filter(
          (r) =>
            isDue(r, {
              trigger,
              now,
              readiness: activatable,
              costBlocked: false,
              hostPaused: false,
              alreadyRunning: false,
            }).due,
        )
        .map((r) => r.id)
        .sort()
      expect({ trigger, ids: await sqlIds(trigger) }).toEqual({ trigger, ids: accepted })
    }
  })

  it('a scheduled trigger selects exactly the due rows after readiness (a literal list)', async () => {
    expect(await selected('SCHEDULED')).toEqual(ids(1, 12, 13))
  })

  it('a manual trigger selects the same rows plus those only the cadence term refused (AC7)', async () => {
    expect(await selected('MANUAL')).toEqual(ids(1, 9, 10, 11, 12, 13, 14, 15))
  })

  it('AC3: the early-due slack widens the cadence term in SQL, by at most ten minutes, and nothing else', async () => {
    const withSlack = (
      await findDueSources(db, 'SCHEDULED', { onlyIds: IDS, cadenceSlackMs: 600_000 })
    )
      .map((r) => r.id)
      .sort()
    // 14 is 5 min out: reached. 15 is 15 min out and 9 is 5 h out: not. Cooled-down (3) and
    // capped (6) rows stay out.
    expect(withSlack).toEqual(ids(1, 4, 12, 13, 14))
    await expect(
      findDueSources(db, 'SCHEDULED', { onlyIds: IDS, cadenceSlackMs: 6 * HOUR }),
    ).rejects.toThrow(RangeError)
    await expect(
      findDueSources(db, 'SCHEDULED', { onlyIds: IDS, maxConsecutiveFailures: 99 }),
    ).rejects.toThrow(RangeError)
  })

  it('orders by next_attempt_at, oldest first', async () => {
    const rows = await findDueSources(db, 'MANUAL', { onlyIds: IDS })
    const times = rows.flatMap((r) => (r.nextAttemptAt === null ? [] : [r.nextAttemptAt.getTime()]))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
