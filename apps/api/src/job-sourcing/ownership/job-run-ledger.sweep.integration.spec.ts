import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import type { FetchProfile } from '../scheduling/next-slot'
import { type ClaimedRun, JobRunLedger, SWEEP_RECENT_RUN_MS, toTextArray } from './job-run-ledger'

/**
 * Source fetch strategy U3 (ADR docs/architecture/2026-10-25-source-fetch-strategy.md, unit U3):
 * the sweep predicate and the tick's claim, against a REAL Postgres, AS `crm_app`. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.sweep.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger

const HOURLY: FetchProfile = { intervalMinutes: 60, offIntervalMinutes: null, window: null }
const HIMALAYAS_LIKE: FetchProfile = {
  intervalMinutes: 1440,
  offIntervalMinutes: null,
  window: null,
  fixedSlots: { timeZone: 'Europe/Kyiv', times: ['08:00'] },
}

/** A cycle keyed like a handler's, tagged so `fx.cleanup` removes it. */
async function cycle(key = fx.cycleKey()): Promise<string> {
  return (await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })).cycleId
}

/** Every sweep claim of the cycle, over these rows, until nothing more is claimed. */
async function sweepAll(cycleId: string, ids: readonly string[]): Promise<ClaimedRun[]> {
  const all: ClaimedRun[] = []
  const skipIds: string[] = []
  for (let pass = 0; pass < 10; pass += 1) {
    const { claimed, refused } = await ledger.claimDue({
      cycleId,
      owner: 'spec-worker',
      limit: 50,
      onlyIds: ids,
      sweep: { cycleId, skipIds },
    })
    skipIds.push(...refused.map((r) => r.sourceId))
    for (const run of claimed) {
      all.push(run)
      await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
    }
    if (claimed.length === 0) break
  }
  return all
}

const sourcesOf = (runs: readonly ClaimedRun[]) => runs.map((r) => r.sourceId).sort()

/** One sweep or tick claim of these rows; every run it claims is finished at once. */
async function claimOnce(
  cycleId: string,
  ids: readonly string[],
  sweep?: { skipIds: string[] },
): Promise<{ claimed: ClaimedRun[]; refused: { sourceId: string; reason: string }[] }> {
  const out = await ledger.claimDue({
    cycleId,
    owner: 'spec-worker',
    limit: 10,
    onlyIds: ids,
    ...(sweep === undefined ? {} : { sweep: { cycleId, skipIds: sweep.skipIds } }),
  })
  for (const run of out.claimed) {
    await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
  }
  return out
}

/** Time passes for a host and its source together: the stored instants move back by `ms`. */
async function passTime(hostKey: string, sourceId: string, ms: number): Promise<void> {
  await session.admin.query(
    `UPDATE job_source_hosts
        SET last_claimed_at = last_claimed_at - make_interval(secs => $2::double precision / 1000)
      WHERE host_key = $1`,
    [hostKey, ms],
  )
  await ageSource(session.admin, sourceId, ms)
}

describe.skipIf(!hasDatabaseUrl())('U3: the sweep and the tick claim, as crm_app', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'U3 spec', 'ADMIN') RETURNING id`,
      [`u3-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('AC 3: a sweep claims every enabled scheduled source once, a slot tomorrow included; the same cycle again claims none', async () => {
    const tomorrow = await kit.reporting(
      { nextAttemptSql: "clock_timestamp() + interval '1 day'" },
      { fetchProfile: HOURLY },
    )
    const passed = await kit.reporting({}, { fetchProfile: HOURLY })
    const ids = [tomorrow, passed]
    const key = fx.cycleKey()
    const sweepId = await cycle(key)
    expect(sourcesOf(await sweepAll(sweepId, ids))).toEqual([...ids].sort())
    // finished runs set a next slot in the future; the cycle still remembers them
    expect(await sweepAll(sweepId, ids)).toEqual([])
    // the handler fired again the same Kyiv day: same key, same cycle, closed by the first window
    expect(await ledger.closeCycle(sweepId)).toBe(true)
    expect(await cycle(key)).toBe(sweepId)
    await expect(sweepAll(sweepId, ids)).rejects.toThrow(/no open cycle/)
    for (const id of ids) expect(await fx.runs(id)).toHaveLength(1)
  })

  it('AC 3 control: the same sources outside a sweep: the tick claims only the passed slot', async () => {
    const tomorrow = await kit.reporting(
      { nextAttemptSql: "clock_timestamp() + interval '1 day'" },
      { fetchProfile: HOURLY },
    )
    const passed = await kit.reporting({}, { fetchProfile: HOURLY })
    const { claimed } = await ledger.claimDue({
      cycleId: await cycle(),
      owner: 'spec-worker',
      limit: 10,
      onlyIds: [tomorrow, passed],
    })
    expect(sourcesOf(claimed)).toEqual([passed])
  })

  it('AC 4: the sweep claims none of the excluded sources, and the control beside them', async () => {
    const control = await kit.reporting({}, { fetchProfile: HOURLY })
    const pausedHost = fx.host(`paused-${randomUUID().slice(0, 6)}`)
    const onPausedHost = await kit.reporting({ hostKey: pausedHost }, { fetchProfile: HOURLY })
    await session.admin.query(
      `INSERT INTO job_source_hosts (host_key, paused_until, pause_reason, pause_source_id)
       VALUES ($1, clock_timestamp() + interval '1 day', 'RATE_LIMIT', $2)`,
      [pausedHost, onPausedHost],
    )
    const excluded = {
      pausedHost: onPausedHost,
      failureCap: await kit.reporting({ consecutiveFailures: 3 }, { fetchProfile: HOURLY }),
      cooldown: await kit.reporting({}, { fetchProfile: HOURLY }),
      readinessPassed: await kit.reporting(
        {},
        { fetchProfile: HOURLY, entryReadiness: () => 'BLOCKED' },
      ),
      paused: await kit.reporting({ adminState: 'PAUSED' }, { fetchProfile: HOURLY }),
      retired: await kit.reporting({ adminState: 'RETIRED' }, { fetchProfile: HOURLY }),
      manualOnly: await kit.reporting({ triggerMode: 'MANUAL' }, { fetchProfile: HOURLY }),
      nullProfile: await kit.reporting({}, { fetchProfile: null }),
      disabled: await kit.reporting({ enabled: false }, { fetchProfile: HOURLY }),
    }
    await session.admin.query(
      `UPDATE job_sources SET cooldown_until = clock_timestamp() + interval '1 hour' WHERE id = $1`,
      [excluded.cooldown],
    )
    const ids = [control, ...Object.values(excluded)]
    const runs = await sweepAll(await cycle(), ids)
    expect(sourcesOf(runs)).toEqual([control])
    for (const id of Object.values(excluded)) expect(await fx.runs(id)).toEqual([])
    // the null profile is left alone, not even refused: its row is untouched
    expect((await fx.sourceRow(excluded.nullProfile)).last_error_code).toBeNull()
  })

  it('AC 4: a source refused in the sweep is not picked again within it (skipIds)', async () => {
    const blocked = await kit.reporting(
      {},
      { fetchProfile: HOURLY, entryReadiness: () => 'BLOCKED' },
    )
    const sweepId = await cycle()
    const first = await ledger.claimDue({
      cycleId: sweepId,
      owner: 'spec-worker',
      limit: 5,
      onlyIds: [blocked],
      sweep: { cycleId: sweepId, skipIds: [] },
    })
    expect(first.refused).toEqual([{ sourceId: blocked, reason: 'READINESS_BLOCKED' }])
    const again = await ledger.claimDue({
      cycleId: sweepId,
      owner: 'spec-worker',
      limit: 5,
      onlyIds: [blocked],
      sweep: { cycleId: sweepId, skipIds: [blocked] },
    })
    expect(again).toEqual({ claimed: [], refused: [] })
    expect(
      await ledger.countDue({
        onlyIds: [blocked],
        sweep: { cycleId: sweepId, skipIds: [blocked] },
      }),
    ).toBe(0)
    // without the skip it would still count: the sweep predicate ignores the refusal's next slot
    expect(
      await ledger.countDue({ onlyIds: [blocked], sweep: { cycleId: sweepId, skipIds: [] } }),
    ).toBe(1)
  })

  it('a sweep claim naming another cycle is refused', async () => {
    const a = await cycle()
    const b = await cycle()
    await expect(
      ledger.claimDue({
        cycleId: a,
        owner: 'spec-worker',
        limit: 1,
        sweep: { cycleId: b, skipIds: [] },
      }),
    ).rejects.toThrow(RangeError)
  })

  it('AC 5: two concurrent ticks with one key open one cycle and claim no source twice', async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => kit.reporting({}, { fetchProfile: HOURLY })),
    )
    const key = fx.cycleKey()
    const [c1, c2] = await Promise.all([cycle(key), cycle(key)])
    expect(c1).toBe(c2)
    const claims = await Promise.all(
      ['spec-a', 'spec-b'].map((owner) =>
        ledger.claimDue({ cycleId: c1, owner, limit: 6, onlyIds: ids }),
      ),
    )
    const claimed = claims.flatMap((c) => c.claimed)
    expect(sourcesOf(claimed)).toEqual([...ids].sort())
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM job_collection_cycles WHERE trigger_key = $1`,
      [key],
    )
    expect(rows[0].n).toBe(1)
  })

  it('AC 5 (sweep): two replicas sweeping one cycle at once claim each source exactly once', async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => kit.reporting({}, { fetchProfile: HOURLY })),
    )
    const sweepId = await cycle()
    const runs = (await Promise.all([sweepAll(sweepId, ids), sweepAll(sweepId, ids)])).flat()
    expect(sourcesOf(runs)).toEqual([...ids].sort())
    for (const id of ids) expect(await fx.runs(id)).toHaveLength(1)
  })

  it('AC 6: a tick claims a source whose slot passed and not one whose slot is a minute ahead', async () => {
    const passed = await kit.reporting(
      { nextAttemptSql: "clock_timestamp() - interval '1 second'" },
      { fetchProfile: HOURLY },
    )
    const ahead = await kit.reporting(
      { nextAttemptSql: "clock_timestamp() + interval '1 minute'" },
      { fetchProfile: HOURLY },
    )
    const { claimed } = await ledger.claimDue({
      cycleId: await cycle(),
      owner: 'spec-worker',
      limit: 10,
      onlyIds: [passed, ahead],
    })
    expect(sourcesOf(claimed)).toEqual([passed])
  })

  it('AC 7: at 08:00 Kyiv the sweep skips a fixed-slot source and the tick claims it: one run', async () => {
    // Himalayas: a fixed 08:00 Kyiv slot, the sweep's own time; the slot has come
    const himalayas = await kit.reporting({}, { fetchProfile: HIMALAYAS_LIKE })
    const hourly = await kit.reporting({}, { fetchProfile: HOURLY })
    const ids = [himalayas, hourly]
    const sweepId = await cycle()
    const tickId = await cycle()
    expect(sourcesOf(await sweepAll(sweepId, ids))).toEqual([hourly])
    expect(
      await ledger.countDue({ onlyIds: [himalayas], sweep: { cycleId: sweepId, skipIds: [] } }),
    ).toBe(0)
    const tick = await ledger.claimDue({
      cycleId: tickId,
      owner: 'spec-worker',
      limit: 10,
      onlyIds: [himalayas],
    })
    expect(sourcesOf(tick.claimed)).toEqual([himalayas])
    expect(await fx.runs(himalayas)).toHaveLength(1)
  })

  it('SR-M-1: a sweep refused HOST_RATE_GAP, then a tick, then the sweep retry: exactly ONE run', async () => {
    const host = fx.host(`gap-${randomUUID().slice(0, 6)}`)
    const s = await kit.reporting(
      { hostKey: host, nextAttemptSql: "clock_timestamp() + interval '1 day'" },
      { fetchProfile: HOURLY },
      { rate: { perMinute: 1, perDay: 100 }, floorHours: 0 },
    )
    // another source of the host was claimed a moment ago: the host gap is open for 60 s
    await session.admin.query(
      `INSERT INTO job_source_hosts (host_key, last_claimed_at) VALUES ($1, clock_timestamp())`,
      [host],
    )
    const before = (await fx.sourceRow(s)).next_in_s ?? -1
    const sweepId = await cycle()
    const refused = await claimOnce(sweepId, [s], { skipIds: [] })
    expect(refused.refused).toEqual([{ sourceId: s, reason: 'HOST_RATE_GAP' }])
    // (a) the sweep's refusal does not pull a not-due source forward
    expect((await fx.sourceRow(s)).next_in_s ?? -1).toBeGreaterThan(before - 60)
    await passTime(host, s, 2 * 60_000)
    // the 08:10 tick: the source is still not due by its own slot
    const tick = await claimOnce(await cycle(), [s])
    await passTime(host, s, 2 * 60_000)
    // the sweep retries the host-timed refusal (SWEEP_RETRIED) once the gap is open
    const retry = await claimOnce(sweepId, [s], { skipIds: [] })
    expect(tick.claimed.length + retry.claimed.length).toBe(1)
    expect(await fx.runs(s)).toHaveLength(1)
  })

  it('SR-M-1 / CR-M-1: a source the 08:00 tick ran is not swept again at 08:05', async () => {
    const s = await kit.reporting({}, { fetchProfile: HOURLY })
    const tick = await claimOnce(await cycle(), [s])
    expect(sourcesOf(tick.claimed)).toEqual([s])
    const sweepId = await cycle()
    expect(await sweepAll(sweepId, [s])).toEqual([])
    expect(await ledger.countDue({ onlyIds: [s], sweep: { cycleId: sweepId, skipIds: [] } })).toBe(
      0,
    )
    expect(await fx.runs(s)).toHaveLength(1)
  })

  it('CR-M-3: the 07:50 tick edge and the window boundary, anchored on the sweep cycle start', async () => {
    const edge = await kit.reporting({}, { fetchProfile: HOURLY })
    const atBoundary = await kit.reporting({}, { fetchProfile: HOURLY })
    const pastBoundary = await kit.reporting({}, { fetchProfile: HOURLY })
    const ids = [edge, atBoundary, pastBoundary]
    const ticked = await claimOnce(await cycle(), ids)
    expect(ticked.claimed).toHaveLength(3)
    const sweepId = await cycle()
    const startedBefore = async (sourceId: string, ms: number) => {
      const { rowCount } = await session.admin.query(
        `UPDATE job_collection_runs
            SET started_at = (SELECT started_at FROM job_collection_cycles WHERE id = $2)
                             - make_interval(secs => $3::double precision / 1000)
          WHERE source_id = $1`,
        [sourceId, sweepId, ms],
      )
      expect(rowCount).toBe(1)
    }
    // the 07:50 tick claimed it a second before the window edge of the old 10-minute rule
    await startedBefore(edge, 10 * 60_000 + 1_000)
    await startedBefore(atBoundary, SWEEP_RECENT_RUN_MS)
    await startedBefore(pastBoundary, SWEEP_RECENT_RUN_MS + 1_000)
    // edge and boundary already ran around the sweep; only the run past the window is swept again
    expect(sourcesOf(await sweepAll(sweepId, ids))).toEqual([pastBoundary])
    expect(SWEEP_RECENT_RUN_MS).toBe(19 * 60_000)
  })

  it('a run older than the recent-run window does not stop the sweep; one inside the provider floor does', async () => {
    const plain = await kit.reporting({}, { fetchProfile: HOURLY })
    const floored = await kit.reporting({}, { fetchProfile: HOURLY, floorHours: 2 })
    const tickId = await cycle()
    const earlier = await claimOnce(tickId, [plain, floored])
    expect(earlier.claimed).toHaveLength(2)
    // the tick ran 30 minutes before the sweep opened
    for (const run of earlier.claimed)
      await ageRun(session.admin, run.runId, 30 * 60_000, 'started_at')
    const swept = await sweepAll(await cycle(), [plain, floored])
    expect(sourcesOf(swept)).toEqual([plain])
    expect(await fx.runs(floored)).toHaveLength(1)
  })

  it('CR-M-2: toTextArray round-trips a quote, a backslash, a comma, braces and NULL through Postgres', async () => {
    // job_sources.manifest_id is constrained to [a-z0-9._:-], so these never reach the sweep from
    // the table; the escaping is defensive and is proven here against Postgres's own array parser.
    const values = [
      'plain',
      'q"uote',
      'back\\slash',
      'com,ma',
      '{brace}',
      'NULL',
      ' sp ',
      '',
      'a\\"b',
    ]
    const db = drizzle(session.pool, { schema })
    const { rows } = await db.execute(sql`SELECT ${toTextArray(values)} AS a`)
    expect(rows[0]?.['a']).toEqual(values)
    // and the allowed punctuation of a real manifest id goes through the sweep scope itself
    const colon = `t3.spec.${TAG}:x-y_z`
    const s = await kit.reporting({ manifestId: colon }, { fetchProfile: HOURLY })
    expect(sourcesOf(await sweepAll(await cycle(), [s]))).toEqual([s])
  })
})
