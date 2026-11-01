import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { SourceRateLimitedError } from '../http/source-errors'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import {
  type CollectionBatch,
  type CollectionContext,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
} from '../providers/reporting-provider'
import { type HostBan, recordHostBan } from '../scheduling/host-state'
import {
  type FixtureServer,
  type World,
  hostPausedForHours,
  openWorld,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'
import { BAN_WRITE_ATTEMPTS, LATE_BAN_RETRY_MS, buildCollectionContext } from './collection-context'

/**
 * r5 Task 2.5 T6 against a REAL Postgres AS `crm_app`, through the real `boundedFetchText` and a
 * LOCAL fixture server: AC 4 (a surfaced 404 is the adapter's answer), AC 5 (a 451 pauses the host
 * as a 403 does), AC 6 / SR-M-21 / SPEC-L-3(a) (`Retry-After` reaches `paused_until`, the larger
 * value wins), SR-L-20 (an HTTP-date is an absolute instant), and CR-M-6 / SR-L-3 (a late ban write
 * that fails is retried until the host is paused).
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.transport.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOST = 'api.t6-transport.example'
const URL_ = `https://${HOST}/jobs`

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

/** What the one-request adapter saw: the status of its response, or the refusal's code. */
let seen: { status: number | null; code: string | null }

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

/** One unmetered request; records what came back. */
const oneRequest: ReportingJobSourceProvider = {
  type: 'REMOTIVE_API',
  parseConfig: (raw) => raw as never,
  async collectReport(_config, ctx: CollectionContext) {
    try {
      seen.status = (await ctx.fetchText({ url: URL_ })).status
    } catch (e) {
      seen.code = (e as { code?: string }).code ?? (e as Error).name
    }
    return emptyBatch()
  },
}

async function runOn(hostKey: string) {
  const s = await w.source({ type: 'REMOTIVE_API', config: { n: randomUUID() }, hostKey })
  seen = { status: null, code: null }
  const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [s.sourceId] })
  return report!
}

async function pausedUntil(hostKey: string): Promise<Date | null> {
  const { rows } = await w.admin.query(
    `SELECT paused_until FROM job_source_hosts WHERE host_key = $1`,
    [hostKey],
  )
  return (rows[0]?.paused_until as Date | undefined) ?? null
}

describe.skipIf(!hasDatabaseUrl())('transport wiring against Postgres (T6)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    w.register(oneRequest, [HOST])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      await w.close()
    } finally {
      await session.close()
    }
  })

  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
  })

  afterEach(() => {
    fixture.answer = () => ({ body: {} })
  })

  it('AC 4: a 404 reaches the adapter as its answer; nothing is paused', async () => {
    fixture.answer = () => ({ status: 404, body: 'Not Found' })
    const hostKey = w.fx.host('t6-404')
    await runOn(hostKey)
    expect(seen).toEqual({ status: 404, code: null })
    expect(await pausedUntil(hostKey)).toBeNull()
  })

  it.each([403, 451])('AC 5: a %i pauses the host for at least a day', async (status) => {
    fixture.answer = () => ({ status })
    const hostKey = w.fx.host(`t6-${status}`)
    const report = await runOn(hostKey)
    expect(seen.code).toBe('SourceBlockedError')
    expect(report).toMatchObject({ errorCode: 'ACCESS_POLICY', finished: true })
    const h = await hostPausedForHours(w.admin, hostKey)
    expect(h).toBeGreaterThan(23.9)
    expect(h).toBeLessThan(24.1)
    expect(fixture.requests).toHaveLength(1)
  })

  it('AC 6: a 429 with Retry-After 7200 leaves the host paused at least 24 h (the floor wins)', async () => {
    fixture.answer = () => ({ status: 429, headers: { 'retry-after': '7200' } })
    const hostKey = w.fx.host('t6-7200')
    await runOn(hostKey)
    const h = await hostPausedForHours(w.admin, hostKey)
    expect(h).toBeGreaterThan(23.9)
    expect(h).toBeLessThan(24.1)
  })

  it('SPEC-L-3(a): a Retry-After of three days in seconds wins over the floor', async () => {
    fixture.answer = () => ({ status: 429, headers: { 'retry-after': String(3 * 24 * 3600) } })
    const hostKey = w.fx.host('t6-3d')
    await runOn(hostKey)
    const h = await hostPausedForHours(w.admin, hostKey)
    expect(h).toBeGreaterThan(71.9)
    expect(h).toBeLessThan(72.1)
  })

  it('SR-L-20: a Retry-After HTTP-date three days ahead is the pause, to the second', async () => {
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 24 * 3_600_000)
    fixture.answer = () => ({ status: 429, headers: { 'retry-after': at.toUTCString() } })
    const hostKey = w.fx.host('t6-date')
    await runOn(hostKey)
    expect((await pausedUntil(hostKey))?.getTime()).toBe(at.getTime())
  })

  it('CR-M-6 / SR-L-3: a LATE ban whose write fails is logged, then retried until the host is paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true })
    try {
      const hostKey = w.fx.host('t6-late')
      const logs: string[] = []
      let failures = BAN_WRITE_ATTEMPTS
      let refuse: (e: unknown) => void = () => undefined
      const sourceId = (await w.source({ type: 'REMOTIVE_API', config: {}, hostKey })).sourceId
      const run: ClaimedRun = {
        runId: randomUUID(),
        ownerToken: 'w:1',
        fencingEpoch: 1,
        sourceId,
        cycleId: randomUUID(),
        attemptId: 'late',
        accountKey: null,
        sourceType: 'REMOTIVE_API',
        checkpoint: null,
      }
      const control = buildCollectionContext(
        {
          transport: () =>
            new Promise<string>((_resolve, reject) => {
              refuse = reject
            }),
          // a database error on the first attempts, the real write after
          recordBan: async (ban: HostBan) => {
            if (failures > 0) {
              failures -= 1
              throw new Error('forced database error')
            }
            return recordHostBan(w.db as never, ban)
          },
          savePage: async () => undefined,
          logger: { error: (m) => logs.push(m) },
        },
        {
          run,
          hostKey,
          floorHours: 0,
          banScope: undefined,
          allowedHosts: [HOST],
          requestsPerRun: 100,
          meter: null,
          secrets: [],
          policyVersion: 1,
          deadline: new Date(Date.now() + 60_000),
          leaseMs: 60_000,
          pageWriteTimeoutMs: 5_000,
        },
      )
      const pending = control.ctx.fetchText({ url: URL_ }).catch(() => undefined)
      control.close('DEADLINE')
      await pending
      await control.drain()
      // the host refuses after the worker has read the run's state
      refuse(new SourceRateLimitedError(HOST, '7200'))
      await vi.waitFor(() => expect(logs).toHaveLength(1))
      expect(logs[0]).toBe(
        `host ${hostKey}: ban HTTP_429 could not be recorded after ${BAN_WRITE_ATTEMPTS} attempts`,
      )
      expect(await pausedUntil(hostKey)).toBeNull()
      await vi.advanceTimersByTimeAsync(LATE_BAN_RETRY_MS)
      await vi.waitFor(async () =>
        expect(await hostPausedForHours(w.admin, hostKey)).toBeGreaterThan(23.9),
      )
      expect(logs).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
