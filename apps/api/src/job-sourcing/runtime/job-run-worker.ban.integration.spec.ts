import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { ageHostPause } from '../../test/host-pause-aging'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
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
  meterRow,
  openWorld,
  reservationsOf,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * r5 Task 2.5 T7 — stop-on-ban (AC 10-12, SR-M-21, SR-M-24) and the meter binding (AC 13) against a
 * REAL Postgres AS `crm_app`, through the real `boundedFetchText` and a LOCAL fixture server. The
 * adapter here is written to KEEP GOING after a refusal: what stops it is the production context.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.ban.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOST = 'api.t7-ban.example'
const URL_ = `https://${HOST}/jobs`

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
let seq = 0

const emptyBatch = (): CollectionBatch =>
  buildCollectionBatch({
    observations: [],
    facts: {
      stop: 'ERROR',
      pagesCompleted: 0,
      counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
      scope: { namespace: 'spec', query: null, configVersion: 1, window: null },
      resumed: false,
    },
    requests: [],
    checkpoint: null,
    invalidSamples: [],
  })

/** What the keep-going adapter saw; reset per test. */
let seen: { outcomes: string[]; pausedHoursWhenRefused: number | null; hostKey: string }

/** Three paid requests in a row, whatever happens: the adapter the ADR says must not matter. */
const keepGoing: ReportingJobSourceProvider = {
  type: 'MUSE_API',
  parseConfig: (raw) => raw as never,
  async collectReport(_config, ctx: CollectionContext) {
    for (let i = 0; i < 3; i += 1) {
      try {
        const r = await ctx.meter.reserve('REQUEST', 1)
        await ctx.meter.markSent(r!)
        await ctx.fetchText({ url: URL_ })
        seen.outcomes.push('sent')
      } catch (e) {
        if (seen.outcomes.every((o) => o === 'sent')) {
          // The FIRST refusal the adapter sees: the pause must already be written.
          seen.pausedHoursWhenRefused = await hostPausedForHours(w.admin, seen.hostKey)
        }
        seen.outcomes.push((e as { code?: string }).code ?? (e as Error).name)
      }
    }
    return emptyBatch()
  },
}

/** A metered keep-going source on `hostKey`; `banScope` per SR-M-24. */
async function source(hostKey: string, banScope: 'HOST' | 'SOURCE' = 'HOST') {
  seq += 1
  const accountKey = w.fx.accountKey(`ban-${seq}`)
  const meterId = await meterRow(w.admin, accountKey, {
    unit: 'REQUEST',
    window: 'MONTH',
    limit: 10,
  })
  const s = await w.source({
    type: 'MUSE_API',
    config: { n: seq },
    hostKey,
    accountMeterId: meterId,
    entry: { quotaDeclared: true, banScope },
  })
  return { ...s, meterId }
}

async function manualClaim(sourceId: string) {
  return w.ledger.claimSource({
    cycleId: await w.manualCycle(),
    owner: 'spec-worker',
    sourceId,
    actor: w.actor,
  })
}

/** End a run this spec claimed only to prove it could be claimed. */
async function release(claim: Awaited<ReturnType<typeof manualClaim>>) {
  if (claim.kind !== 'CLAIMED') return
  const r: ClaimedRun = claim.run
  await w.ledger.finish(
    { runId: r.runId, ownerToken: r.ownerToken, fencingEpoch: r.fencingEpoch },
    { outcome: 'CANCELLED', errorCode: 'CANCELLED' },
  )
}

describe.skipIf(!hasDatabaseUrl())(
  'stop-on-ban and the meter binding against Postgres (T7)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      w = await openWorld(session, TAG)
      w.register(keepGoing, [HOST])
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

    it.each([
      [403, 'ACCESS_POLICY', {}],
      [429, 'RATE_LIMIT', { 'retry-after': '7200' }],
    ] as const)(
      'AC 10-12: a %i pauses the host before the adapter sees it; the run sends and spends nothing more',
      async (status, code, headers) => {
        fixture.answer = () => ({ status, headers })
        const hostKey = w.fx.host(`ban${status}`)
        const a = await source(hostKey)
        seen = { outcomes: [], pausedHoursWhenRefused: null, hostKey }
        const [report] = await w
          .worker()
          .runDue({ cycleId: await w.cycle(), onlyIds: [a.sourceId] })

        // AC 10: written before the adapter saw the refusal, a day at least (SR-M-21: the larger wins)
        expect(seen.pausedHoursWhenRefused).toBeGreaterThan(23.9)
        // ... and ZERO further requests from that run, though the adapter kept going
        expect(fixture.requests).toHaveLength(1)
        expect(seen.outcomes[1]).toBe(code)
        expect(seen.outcomes.slice(2)).toEqual([code])
        expect(report).toMatchObject({ outcome: 'FAILED', errorCode: code, finished: true })
        // AC 12: at most the refused request's reservation is USED; nothing else was taken
        expect((await reservationsOf(w.admin, report!.runId)).map((r) => r.status)).toEqual([
          'USED',
        ])

        // AC 11: a source on the paused host is refused at claim until the pause expires
        const sibling = await source(hostKey)
        expect(await manualClaim(sibling.sourceId)).toEqual({
          kind: 'REFUSED',
          reason: 'HOST_PAUSED',
        })
        await ageHostPause(w.admin, hostKey, 31 * 24 * 3_600_000)
        const after = await manualClaim(sibling.sourceId)
        expect(after.kind).toBe('CLAIMED')
        await release(after)
      },
    )

    it('SR-M-21: a ban write that fails every retry still ends with the host paused', async () => {
      fixture.answer = () => ({ status: 429 })
      const hostKey = w.fx.host('banfail')
      const a = await source(hostKey)
      seen = { outcomes: [], pausedHoursWhenRefused: null, hostKey }
      let calls = 0
      const recordBan = async (ban: HostBan) => {
        calls += 1
        // the context's bounded retry all fail, as a database error would
        if (calls <= 3) throw new Error('could not write the ban')
        return recordHostBan(w.db as never, ban)
      }
      const [report] = await w
        .worker({ recordBan })
        .runDue({ cycleId: await w.cycle(), onlyIds: [a.sourceId] })
      expect(report).toMatchObject({ outcome: 'FAILED', errorCode: 'HOST_BAN_UNRECORDED' })
      expect(calls).toBe(4)
      expect(await hostPausedForHours(w.admin, hostKey)).toBeGreaterThan(23.9)
      expect(fixture.requests).toHaveLength(1)
      expect((await runRow(w.admin, report!.runId)).error_code).toBe('HOST_BAN_UNRECORDED')
    })

    it('SR-M-24: a 403 on a SOURCE-scoped type bans nothing; a sibling tenant stays claimable', async () => {
      fixture.answer = () => ({ status: 403 })
      const hostKey = w.fx.host('tenant')
      const a = await source(hostKey, 'SOURCE')
      seen = { outcomes: [], pausedHoursWhenRefused: null, hostKey }
      const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [a.sourceId] })
      expect(report).toMatchObject({ outcome: 'FAILED', errorCode: 'ACCESS_POLICY' })
      expect(fixture.requests).toHaveLength(1)
      expect(await hostPausedForHours(w.admin, hostKey)).toBeNull()
      const sibling = await source(hostKey, 'SOURCE')
      const claim = await manualClaim(sibling.sourceId)
      expect(claim.kind).toBe('CLAIMED')
      await release(claim)
    })

    it('AC 13: a meter of another account bound after the claim is refused; nothing is sent', async () => {
      const hostKey = w.fx.host('acct')
      const a = await source(hostKey)
      const [run] = (
        await w.ledger.claimDue({
          cycleId: await w.cycle(),
          owner: 'spec-worker',
          limit: 1,
          onlyIds: [a.sourceId],
        })
      ).claimed
      expect(run?.accountKey).toMatch(/^t3spec:/)
      const other = await meterRow(w.admin, w.fx.accountKey(`other-${seq}`), {
        unit: 'REQUEST',
        window: 'MONTH',
        limit: 10,
      })
      await w.admin.query(`UPDATE job_sources SET account_meter_id = $2 WHERE id = $1`, [
        a.sourceId,
        other,
      ])
      seen = { outcomes: [], pausedHoursWhenRefused: null, hostKey }
      const report = await w.worker().runClaimed(run!)
      expect(report).toMatchObject({
        outcome: 'FAILED',
        errorCode: 'ADAPTER_INVARIANT',
        finished: true,
      })
      expect((await runRow(w.admin, run!.runId)).error_message).toBe(
        'the adapter threw MeterBindingRefusedError',
      )
      expect(fixture.requests).toEqual([])
      expect(seen.outcomes).toEqual([])
    })
  },
)
