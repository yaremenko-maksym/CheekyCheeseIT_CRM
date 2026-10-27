import { randomUUID } from 'node:crypto'
import type { SessionUser } from '@crm/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from '../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'
import { ageRun } from '../test/run-aging'
import { JobSourceAdminService } from './admin/job-source-admin.service'
import { __resetThrottleForTests } from './http/bounded-fetch'
import { JobSourcingCronService } from './job-sourcing.cron'
import {
  type CollectionBatch,
  type CollectionContext,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
} from './providers/reporting-provider'
import {
  type FixtureServer,
  type World,
  meterRow,
  openWorld,
  routeFetchTo,
  startFixtureServer,
} from './runtime/__test-helpers__/runtime-harness'
import type { JobRunWorker } from './runtime/job-run-worker'
import { ReportingAdapter } from './registry/registered-adapter'
import type { HostBan } from './scheduling/host-state'

/**
 * r5 Task 2.5 T5 — the two daily handlers against a REAL Postgres AS `crm_app`, with the real
 * ledger and worker. Adapters are scripted (an API type and an HTML type); the one ban case uses a
 * LOCAL fixture server. Time is moved by the aging helpers on stored instants; the windows are
 * real, a second or two long. The handlers claim with `onlyIds` (the spec seam) so a shared
 * database's other rows are never touched.
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-sourcing.cron.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOST = 'api.t5-cron.example'
const BAN_HOST = 'api.t5-ban.example'

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
let adminUser: SessionUser
let seq = 0

const emptyBatch = (): CollectionBatch =>
  buildCollectionBatch({
    observations: [],
    facts: {
      stop: 'EXHAUSTED',
      pagesCompleted: 0,
      counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
      scope: { namespace: 'spec', query: null, configVersion: 1, window: null },
      resumed: false,
    },
    requests: [],
    checkpoint: null,
    invalidSamples: [],
  })

/** What the scripted adapters ran, in order, and the gates they wait on. */
let ran: string[] = []
const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
function gate(key: string) {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  gates.set(key, { promise, open })
  return gates.get(key)!
}
const scripted = (type: 'JOBICY_API' | 'JUSTJOIN_HTML'): ReportingJobSourceProvider => ({
  type,
  parseConfig: (raw) => raw as never,
  async collectReport(config) {
    const key = (config as unknown as { key: string }).key
    ran.push(key)
    await gates.get(key)?.promise
    return emptyBatch()
  },
})

/** Three paid requests in a row, whatever happens (the ban spec's adapter). */
const keepGoing: ReportingJobSourceProvider = {
  type: 'MUSE_API',
  parseConfig: (raw) => raw as never,
  async collectReport(_config, ctx: CollectionContext) {
    for (let i = 0; i < 3; i += 1) {
      try {
        const r = await ctx.meter.reserve('REQUEST', 1)
        await ctx.meter.markSent(r!)
        await ctx.fetchText({ url: `https://${BAN_HOST}/jobs` })
      } catch {
        // the context latched closed on the refusal; the loop just ends
      }
    }
    return emptyBatch()
  },
}

const stubService = {
  collectAll: async () => ({ results: [], failures: [] }),
  purgeStalePostings: async () => 0,
}

const OPTIONS = { poolSize: 4, heartbeatMs: 1_000, runDeadlineMs: 20_000, deadlineGraceMs: 500 }

function handler(
  ids: readonly string[],
  windowMs: number,
  worker: JobRunWorker = w.worker({}, OPTIONS),
) {
  const svc = new JobSourcingCronService(stubService as never, w.ledger, worker, {
    get: () => windowMs,
  } as never)
  svc.tuning.intervalMs = 100
  svc.tuning.onlyIds = ids
  // U3: the API types moved from 05:00 to the tick; its 9-minute window is shortened for specs
  svc.tuning.tickWindowMs = windowMs
  return { svc, worker }
}

async function src(type: 'JOBICY_API' | 'JUSTJOIN_HTML', hostKey?: string) {
  seq += 1
  const key = `t5-${TAG}-${seq}`
  const s = await w.source({ type, config: { key }, ...(hostKey === undefined ? {} : { hostKey }) })
  return { ...s, key }
}

async function runsOf(sourceId: string) {
  return w.fx.runs(sourceId)
}

async function cyclesOf(sourceIds: readonly string[]) {
  const { rows } = await w.admin.query(
    `SELECT DISTINCT c.id, c.status, c.closed_at IS NOT NULL AS has_closed_at
       FROM job_collection_cycles c JOIN job_collection_runs r ON r.cycle_id = c.id
      WHERE r.source_id = ANY($1::uuid[])`,
    [sourceIds],
  )
  return rows as { id: string; status: string; has_closed_at: boolean }[]
}

async function dailyCycleCount(prefix: string): Promise<number> {
  const { rows } = await w.admin.query(
    `SELECT count(*)::int AS n FROM job_collection_cycles WHERE trigger_key LIKE $1`,
    [`${prefix}:%`],
  )
  return rows[0].n as number
}

describe.skipIf(!hasDatabaseUrl())('the daily collection handlers against Postgres (T5)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    w.register(scripted('JOBICY_API'), [HOST])
    w.register(scripted('JUSTJOIN_HTML'), [HOST])
    w.register(keepGoing, [BAN_HOST])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
    adminUser = {
      id: w.actor,
      email: `t7spec-${TAG}@example.test`,
      displayName: 'T5 spec',
      avatarUrl: null,
      role: 'ADMIN',
      seniorSharePercent: 0,
      legalFullName: null,
    }
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      await clean()
      await w.close()
    } finally {
      await session.close()
    }
  })

  /** Runs and the daily cycles first (a cycle is referenced by its runs), then the fixtures. */
  async function clean() {
    await w.admin.query(
      `DELETE FROM job_account_meter_reservations WHERE run_id IN
         (SELECT id FROM job_collection_runs WHERE source_id = ANY($1::uuid[]))`,
      [w.fx.sourceIds],
    )
    await w.admin.query(`DELETE FROM job_collection_runs WHERE source_id = ANY($1::uuid[])`, [
      w.fx.sourceIds,
    ])
    await w.admin.query(
      `DELETE FROM job_collection_cycles
        WHERE trigger_key LIKE 'daily-%' OR trigger_key LIKE 'tick:%' OR trigger_key LIKE 'sweep:%'`,
    )
  }

  beforeEach(() => {
    __resetThrottleForTests()
    ran = []
    gates.clear()
    fixture.requests.length = 0
  })

  afterEach(async () => {
    for (const g of gates.values()) g.open()
    await new Promise((r) => setTimeout(r, 150))
    await clean()
    fixture.answer = () => ({ body: {} })
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('U3 AC 3: the 08:00 sweep runs every interval-profile source once (a slot tomorrow included), never a null profile; firing again the same day runs nothing', async () => {
    const tomorrow = await src('JOBICY_API')
    const due = await src('JOBICY_API')
    seq += 1
    const nullKey = `t5-${TAG}-${seq}`
    const unscheduled = await w.source({
      type: 'JOBICY_API',
      config: { key: nullKey },
      entry: { fetchProfile: null },
    })
    await w.admin.query(
      `UPDATE job_sources SET next_attempt_at = clock_timestamp() + interval '1 day' WHERE id = $1`,
      [tomorrow.sourceId],
    )
    const ids = [tomorrow.sourceId, due.sourceId, unscheduled.sourceId]
    await handler(ids, 6_000).svc.handleSweep()
    expect([...ran].sort()).toEqual([tomorrow.key, due.key].sort())
    expect(await dailyCycleCount('sweep')).toBe(1)
    await handler(ids, 2_000).svc.handleSweep()
    expect(ran).toHaveLength(2)
    expect(await runsOf(tomorrow.sourceId)).toHaveLength(1)
    expect(await runsOf(unscheduled.sourceId)).toEqual([])
    // the 05:00 handler runs no API-type source any more (U3 AC 1)
    await handler(ids, 2_000).svc.handleDailyCollection()
    expect(ran).toHaveLength(2)
  })

  it('02:30 claims HTML types only, the tick API types only; each closes its cycle', async () => {
    const html = await src('JUSTJOIN_HTML')
    const api = await src('JOBICY_API')
    const ids = [html.sourceId, api.sourceId]
    await handler(ids, 3_000).svc.handleHtmlCollection()
    expect(ran).toEqual([html.key])
    await handler(ids, 3_000).svc.handleTick()
    expect(ran).toEqual([html.key, api.key])
    expect(await dailyCycleCount('daily-html')).toBe(1)
    expect(await dailyCycleCount('tick')).toBe(1)
    const cycles = await cyclesOf(ids)
    expect(cycles).toHaveLength(2)
    expect(cycles.every((c) => c.status === 'CLOSED' && c.has_closed_at)).toBe(true)
  })

  it('AC 4: a source refused HOST_BUSY at window start is claimed later in the same window', async () => {
    const hostKey = w.fx.host('ac4')
    const a = await src('JOBICY_API', hostKey)
    const b = await src('JOBICY_API', hostKey)
    const g = gate(a.key)
    const t0 = Date.now()
    const done = handler([a.sourceId, b.sourceId], 6_000).svc.handleTick()
    await new Promise((r) => setTimeout(r, 500))
    expect(ran).toEqual([a.key]) // B waits: the host has a run
    expect(await runsOf(b.sourceId)).toHaveLength(0)
    g.open()
    await done
    expect(ran).toEqual([a.key, b.key])
    expect((await runsOf(a.sourceId))[0]).toMatchObject({ outcome: 'SUCCEEDED' })
    expect((await runsOf(b.sourceId))[0]).toMatchObject({ outcome: 'SUCCEEDED' })
    expect(Date.now() - t0).toBeLessThan(5_000) // drained, not the whole window
  })

  it('AC 5, 9, 10: the window ends at COLLECTION_WINDOW while work is due; the cycle is closed; the starved source stays visible to T9', async () => {
    const hostKey = w.fx.host('ac5')
    const a = await src('JOBICY_API', hostKey)
    const b = await src('JOBICY_API', hostKey)
    // A is the oldest due (claimed first); B, behind it on the same host, is starved for 30 days.
    await w.admin.query(
      `UPDATE job_sources SET next_attempt_at = clock_timestamp() - interval '1000 hours' WHERE id = $1`,
      [a.sourceId],
    )
    await w.admin.query(
      `UPDATE job_sources SET next_attempt_at = clock_timestamp() - interval '720 hours' WHERE id = $1`,
      [b.sourceId],
    )
    gate(a.key) // never opened inside the window
    const t0 = Date.now()
    await handler([a.sourceId, b.sourceId], 1_500).svc.handleTick()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(1_400)
    expect(elapsed).toBeLessThan(2_300)
    expect(ran).toEqual([a.key])
    expect(await runsOf(b.sourceId)).toHaveLength(0) // still due, waits for the next day
    expect((await runsOf(a.sourceId))[0]).toMatchObject({ outcome: 'STARTED' })
    // every run references a closed cycle, though a run is still in flight
    const cycles = await cyclesOf([a.sourceId])
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({ status: 'CLOSED', has_closed_at: true })
    // AC 10: the starved source is in T9's listing as OVERDUE
    const service = new JobSourceAdminService(session.databaseService, w.ledger)
    const listed = (await service.listExcluded(adminUser)).find((i) => i.sourceId === b.sourceId)
    expect(listed?.reasons).toContain('OVERDUE')
  })

  it('AC 3, 9: two replicas run the handler at once: one claim per source, one cycle row', async () => {
    const sources = [await src('JOBICY_API'), await src('JOBICY_API'), await src('JOBICY_API')]
    const ids = sources.map((s) => s.sourceId)
    await Promise.all([handler(ids, 3_000).svc.handleTick(), handler(ids, 3_000).svc.handleTick()])
    expect([...ran].sort()).toEqual(sources.map((s) => s.key).sort())
    for (const s of sources) expect(await runsOf(s.sourceId)).toHaveLength(1)
    expect(await dailyCycleCount('tick')).toBe(1)
    const cycles = await cyclesOf(ids)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({ status: 'CLOSED', has_closed_at: true })
  })

  it('AC 7: an expired lease left before the handler is recovered by its second step', async () => {
    const stale = await src('JOBICY_API')
    const fresh = await src('JOBICY_API')
    const { claimed } = await w.ledger.claimDue({
      cycleId: await w.cycle(),
      owner: 'dead-worker',
      limit: 1,
      onlyIds: [stale.sourceId],
    })
    expect(claimed).toHaveLength(1)
    await ageRun(w.admin, claimed[0]!.runId, 60_000)
    await handler([fresh.sourceId], 2_000).svc.handleTick()
    expect((await runsOf(stale.sourceId))[0]).toMatchObject({
      outcome: 'FAILED',
      error_code: 'LEASE_EXPIRED',
    })
    expect((await runsOf(fresh.sourceId))[0]).toMatchObject({ outcome: 'SUCCEEDED' })
  })

  it('AC 8 (SR-M-19): 12 due sources on a busy host do not hide another host`s source, and a run killed mid-window is recovered within it', async () => {
    const busy = w.fx.host('ac8busy')
    const x = await src('JOBICY_API', busy)
    const queued = []
    for (let i = 0; i < 12; i += 1) queued.push(await src('JOBICY_API', busy))
    const other = await src('JOBICY_API', w.fx.host('ac8other'))
    const { claimed } = await w.ledger.claimDue({
      cycleId: await w.cycle(),
      owner: 'live-worker',
      limit: 1,
      onlyIds: [x.sourceId],
    })
    expect(claimed).toHaveLength(1)
    const ids = [x.sourceId, ...queued.map((q) => q.sourceId), other.sourceId]
    const done = handler(ids, 15_000).svc.handleTick()
    await new Promise((r) => setTimeout(r, 800))
    // the first call already claimed the other host's source; none of the 12 ran
    expect(ran).toEqual([other.key])
    // the run on the busy host is killed mid-window: its lease is gone
    await ageRun(w.admin, claimed[0]!.runId, 60_000)
    await done
    expect((await runsOf(x.sourceId))[0]).toMatchObject({
      outcome: 'FAILED',
      error_code: 'LEASE_EXPIRED',
    })
    expect(ran.slice(1).sort()).toEqual(queued.map((q) => q.key).sort())
  }, 40_000)

  /** A source on a host whose rate allows one claim per `60 / perMinute` seconds. */
  async function rateGapped(perMinute: number) {
    const hostKey = w.fx.host(`gap${perMinute}`)
    const policy = { rate: { perMinute, perDay: 1_000 }, floorHours: 0 }
    seq += 1
    const a = await w.source({
      type: 'JOBICY_API',
      config: { key: `t5-${TAG}-ga${seq}` },
      hostKey,
      policy,
    })
    seq += 1
    const b = await w.source({
      type: 'JOBICY_API',
      config: { key: `t5-${TAG}-gb${seq}` },
      hostKey,
      policy,
    })
    return { a, b, keyOf: (id: string) => (id === a.sourceId ? 'a' : 'b') }
  }

  async function sourceState(sourceId: string) {
    const { rows } = await w.admin.query(
      `SELECT last_error_code, next_attempt_at > clock_timestamp() AS ahead,
              next_attempt_at > clock_timestamp() + interval '1 hour' AS far
         FROM job_sources WHERE id = $1`,
      [sourceId],
    )
    return rows[0] as { last_error_code: string | null; ahead: boolean; far: boolean }
  }

  it('SPEC-M-1: a source refused HOST_RATE_GAP whose gap opens inside the window is claimed in the same window', async () => {
    const { a, b } = await rateGapped(12) // one claim per 5 s on the host
    const t0 = Date.now()
    await handler([a.sourceId, b.sourceId], 15_000).svc.handleTick()
    const elapsed = Date.now() - t0
    expect(ran).toHaveLength(2) // A, then B once the gap opened: not DRAINED with B left for tomorrow
    expect((await runsOf(b.sourceId))[0]).toMatchObject({ outcome: 'SUCCEEDED' })
    expect(elapsed).toBeGreaterThanOrEqual(4_000) // it really waited for the gap
    expect(elapsed).toBeLessThan(12_000) // and ended DRAINED, not at the window
  }, 40_000)

  it('SPEC-M-1: a gap that opens beyond the window ends the window DRAINED, the source left for the next day', async () => {
    const { a, b } = await rateGapped(1) // one claim per minute
    const t0 = Date.now()
    await handler([a.sourceId, b.sourceId], 4_000).svc.handleTick()
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(ran).toHaveLength(1)
    expect(await runsOf(b.sourceId)).toHaveLength(0)
    expect(await sourceState(b.sourceId)).toMatchObject({
      last_error_code: 'HOST_RATE_GAP',
      ahead: true,
    })
  }, 20_000)

  it.each([
    ['NOT_ACTIVATABLE', false],
    ['TRANSPORT_NOT_WIRED', true],
  ] as const)(
    'SPEC-L-1: a persistent refusal (%s) is pushed hours out and the window ends DRAINED at once',
    async (reason, unwired) => {
      if (unwired) w.registerAdapter(new ReportingAdapter({ type: 'REED_API' } as never))
      const s = await w.source({ type: 'REED_API', config: { key: `t5-${TAG}-${reason}` } })
      const t0 = Date.now()
      await handler([s.sourceId], 6_000).svc.handleTick()
      expect(Date.now() - t0).toBeLessThan(2_500) // not the whole window
      expect(await runsOf(s.sourceId)).toHaveLength(0)
      expect(await sourceState(s.sourceId)).toMatchObject({ last_error_code: reason, far: true })
      expect(await w.ledger.countDue({ onlyIds: [s.sourceId], lookaheadMs: 600_000 })).toBe(0)
    },
  )

  it('AC 11, 12: a ban store that hangs on the post-finish re-write does not hold the slot or stretch the window', async () => {
    fixture.answer = () => ({ status: 429 })
    seq += 1
    const meterId = await meterRow(w.admin, w.fx.accountKey(`t5-ban-${seq}`), {
      unit: 'REQUEST',
      window: 'MONTH',
      limit: 10,
    })
    const s = await w.source({
      type: 'MUSE_API',
      config: { n: seq },
      hostKey: BAN_HOST,
      accountMeterId: meterId,
      entry: { quotaDeclared: true, banScope: 'HOST' },
    })
    let calls = 0
    // the context's bounded retries fail like a database error; the re-write after `finish` hangs
    const recordBan = (_ban: HostBan): Promise<unknown> => {
      calls += 1
      return calls <= 3
        ? Promise.reject(new Error('could not write the ban'))
        : new Promise(() => undefined)
    }
    const worker = w.worker({ recordBan }, OPTIONS)
    const t0 = Date.now()
    await handler([s.sourceId], 10_000, worker).svc.handleTick()
    const elapsed = Date.now() - t0
    expect(calls).toBe(4)
    expect(worker.activeRuns).toBe(0) // the slot was freed
    expect(elapsed).toBeLessThan(5_000) // drained long before COLLECTION_WINDOW
    expect((await runsOf(s.sourceId))[0]).toMatchObject({
      outcome: 'FAILED',
      error_code: 'HOST_BAN_UNRECORDED',
    })
  }, 30_000)
})
