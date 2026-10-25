import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { sourceFixture } from '../../test/source-fixtures'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import type { JobSourceProvider } from '../job-source.provider'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import {
  type CollectionBatch,
  type CollectionContext,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
} from '../providers/reporting-provider'
import { createJSearchProvider } from '../providers/sources/jsearch.provider'
import { LegacyDouAdapter } from '../registry/registered-adapter'
import {
  type FixtureServer,
  SPEC_LEDGER_OPTIONS,
  type World,
  meterRow,
  openWorld,
  reservationsOf,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * r5 Task 2.5 T7 — ownership in flight against a REAL Postgres AS `crm_app`: a worker fenced out
 * between `reserve` and `markSent` (AC 8), a frozen worker (SR-L-22), the heartbeat behind a page
 * write (AC 14), a never-settling request (SR-M-18), the deadline (#1138 SR-M-1), and DOU staying
 * out of the ledger (AC 15, 17). Requests go to a LOCAL fixture server only.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.lease.integration
 */
const TAG = randomUUID().slice(0, 8)
const KEY = 'fake0000t7lease0000key0000fake0000t7lease0000key0000xyz'
const HOST = 'api.t7-lease.example'
const L = SPEC_LEDGER_OPTIONS.leaseMs

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
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

/** The custom adapter's behaviour for the current test. */
let behave: (ctx: CollectionContext) => Promise<CollectionBatch> = async () => emptyBatch()
const scripted: ReportingJobSourceProvider = {
  type: 'JOBICY_API',
  parseConfig: (raw) => raw as never,
  collectReport: (_c, ctx) => behave(ctx),
}

/** JSearch, with a hook between its reservation and its markSent (AC 8). */
let betweenReserveAndMarkSent: ((ctx: CollectionContext) => Promise<void>) | null = null
const jsearch = createJSearchProvider({
  credential: { configured: true, apiKey: KEY, secrets: [KEY] },
})
const hookedJsearch: ReportingJobSourceProvider = {
  type: 'JSEARCH_API',
  parseConfig: (raw) => jsearch.parseConfig(raw),
  collectReport: (config, ctx) =>
    jsearch.collectReport(config as never, {
      ...ctx,
      meter: {
        ...ctx.meter,
        async reserve(unit, amount) {
          const r = await ctx.meter.reserve(unit, amount)
          const hook = betweenReserveAndMarkSent
          betweenReserveAndMarkSent = null
          if (hook !== null) await hook(ctx)
          return r
        },
      },
    }),
}

async function scriptedSource(hostKey = w.fx.host(`s${seq + 1}`)) {
  seq += 1
  return w.source({ type: 'JOBICY_API', config: { n: seq }, hostKey })
}

async function runIdOfAttempt(attemptId: string): Promise<string> {
  const { rows } = await w.admin.query(`SELECT id FROM job_collection_runs WHERE attempt_id = $1`, [
    attemptId,
  ])
  return rows[0].id as string
}

async function manualClaim(sourceId: string) {
  return w.ledger.claimSource({
    cycleId: await w.manualCycle(),
    owner: 'spec-worker',
    sourceId,
    actor: w.actor,
  })
}

async function release(claim: Awaited<ReturnType<typeof manualClaim>>) {
  if (claim.kind !== 'CLAIMED') return
  const r: ClaimedRun = claim.run
  await w.ledger.finish(
    { runId: r.runId, ownerToken: r.ownerToken, fencingEpoch: r.fencingEpoch },
    { outcome: 'CANCELLED', errorCode: 'CANCELLED' },
  )
}

describe.skipIf(!hasDatabaseUrl())('ownership in flight against Postgres (T7)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    w.register(scripted, [HOST])
    w.register(hookedJsearch, ['jsearch.p.rapidapi.com'])
    w.registerAdapter(new LegacyDouAdapter({ type: 'DOU_RSS' } as unknown as JobSourceProvider))
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
    behave = async () => emptyBatch()
  })

  it('AC 8: fenced out between reserve and markSent, a worker sends nothing; the account pays the successor`s request', async () => {
    fixture.answer = () => ({ body: sourceFixture('jsearch', 'doc-example') })
    const accountKey = w.fx.accountKey('fenced')
    const meterId = await meterRow(w.admin, accountKey, {
      unit: 'REQUEST',
      window: 'MONTH',
      limit: 10,
    })
    const { sourceId } = await w.source({
      type: 'JSEARCH_API',
      config: { query: `t7 ${TAG} fenced` },
      accountMeterId: meterId,
      entry: { quotaDeclared: true },
    })
    let successor: Awaited<ReturnType<ReturnType<World['worker']>['runDue']>> = []
    let firstRunId = ''
    betweenReserveAndMarkSent = async (ctx) => {
      // The first worker stalls here; its lease expires and recovery hands the source on.
      firstRunId = await runIdOfAttempt(ctx.run.attemptId)
      await ageRun(w.admin, firstRunId, 10 * L)
      await w.ledger.recoverExpired()
      await ageSource(w.admin, sourceId, 3 * 24 * 3_600_000)
      successor = await w.worker({}, { owner: 'spec-successor' }).runDue({
        cycleId: await w.cycle(),
        onlyIds: [sourceId],
      })
    }
    const [first] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })

    expect(successor).toHaveLength(1)
    expect(successor[0]?.outcome).not.toBe('FAILED')
    // the fenced worker: reported RUN_FENCED, could not finish (recovery ended its run)
    expect(first).toMatchObject({ errorCode: 'RUN_FENCED', finished: false })
    expect(await runRow(w.admin, firstRunId)).toMatchObject({
      outcome: 'FAILED',
      error_code: 'LEASE_EXPIRED',
    })
    // its reservation was never sent, so it was released; only the successor's request left
    expect((await reservationsOf(w.admin, firstRunId)).map((r) => r.status)).toEqual(['RELEASED'])
    expect(fixture.requests).toHaveLength(1)
    const { rows } = await w.admin.query(
      `SELECT used::int AS used FROM job_account_meters WHERE id = $1`,
      [meterId],
    )
    expect(rows[0].used).toBe(1)
  })

  it('SR-L-22: a worker frozen past L while a successor claims the host sends nothing more', async () => {
    let mono = 0
    const hostKey = w.fx.host('frozen')
    const a = await scriptedSource(hostKey)
    const sibling = await scriptedSource(hostKey)
    let successorClaim: Awaited<ReturnType<typeof manualClaim>> | null = null
    const outcomes: string[] = []
    behave = async (ctx) => {
      await ctx.fetchText({ url: `https://${HOST}/one` })
      outcomes.push('sent')
      // frozen: the monotonic clock jumps past L, the lease expires and a successor takes the host
      mono += L + 1
      const runId = await runIdOfAttempt(ctx.run.attemptId)
      await ageRun(w.admin, runId, 10 * L)
      await w.ledger.recoverExpired()
      successorClaim = await manualClaim(sibling.sourceId)
      try {
        await ctx.fetchText({ url: `https://${HOST}/two` })
        outcomes.push('sent')
      } catch (e) {
        outcomes.push((e as { code?: string }).code ?? 'threw')
      }
      return emptyBatch()
    }
    const [report] = await w
      .worker({ monotonicNow: () => mono })
      .runDue({ cycleId: await w.cycle(), onlyIds: [a.sourceId] })
    expect(successorClaim?.kind).toBe('CLAIMED')
    expect(outcomes).toEqual(['sent', 'RUN_FENCED'])
    expect(fixture.requests.map((r) => r.path)).toEqual(['/one'])
    expect(report).toMatchObject({ finished: false })
    await release(successorClaim!)
  })

  it('AC 14: a heartbeat queued behind a page write lands before the lease expires', async () => {
    const { sourceId } = await scriptedSource()
    const [run] = (
      await w.ledger.claimDue({
        cycleId: await w.cycle(),
        owner: 'spec-worker',
        limit: 1,
        onlyIds: [sourceId],
      })
    ).claimed
    const h = { runId: run!.runId, ownerToken: run!.ownerToken, fencingEpoch: run!.fencingEpoch }
    const identityKey = `["t7-${TAG}-locked"]`
    await w.admin.query(
      `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
       VALUES ('JOBICY_API', $1, 'NATIVE_ID', $2)`,
      [`t3spec-${TAG}`, identityKey],
    )
    const blocker = await w.admin.connect()
    const H = 600
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT 1 FROM job_source_records WHERE identity_key = $1 FOR UPDATE`, [
        identityKey,
      ])
      const started = Date.now()
      // the page write takes the run row, then waits on the locked record, bounded to H
      const page = w.ledger
        .savePage(
          h,
          {
            observations: [
              {
                identity: {
                  provider: 'JOBICY_API',
                  namespace: `t3spec-${TAG}`,
                  nativeId: 'locked',
                  identityKey,
                  identityKind: 'NATIVE_ID',
                },
              } as never,
            ],
            checkpoint: {
              configVersion: 1,
              policyVersion: 1,
              adapterVersion: 'jobicy_api-spec',
              position: { kind: 'CURSOR', page: 1, cursor: 'c1' },
              completedAt: new Date('2026-10-25T00:00:00Z'),
            },
          },
          { timeoutMs: H },
        )
        .then(
          () => 'saved',
          (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code ?? 'failed',
        )
      await new Promise((r) => setTimeout(r, 100))
      // the heartbeat, on its own connection, queues behind the page write's run-row lock
      const beat = await w.heartbeat(h)
      const elapsed = Date.now() - started
      expect(beat).toBe(true)
      // cut at its H budget: by lock_timeout (55P03) or statement_timeout (57014), both set to H
      expect(['55P03', '57014']).toContain(await page)
      expect(elapsed).toBeGreaterThanOrEqual(H - 50)
      expect(elapsed).toBeLessThan(L)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await w.admin.query(`DELETE FROM job_source_records WHERE identity_key = $1`, [identityKey])
      await w.ledger.finish(h, { outcome: 'CANCELLED', errorCode: 'CANCELLED' })
    }
  })

  it('SR-M-18: an adapter whose request never settles has its run ended, and the host is claimable again', async () => {
    const hostKey = w.fx.host('hang')
    const a = await scriptedSource(hostKey)
    const sibling = await scriptedSource(hostKey)
    behave = () => new Promise<CollectionBatch>(() => {})
    const started = Date.now()
    const [report] = await w
      .worker({}, { runDeadlineMs: 1_500, deadlineGraceMs: 500 })
      .runDue({ cycleId: await w.cycle(), onlyIds: [a.sourceId] })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(report).toMatchObject({ outcome: 'PARTIAL', errorCode: 'DEADLINE', finished: true })
    const claim = await manualClaim(sibling.sourceId)
    expect(claim.kind).toBe('CLAIMED')
    await release(claim)
  })

  it('the per-run deadline: an overrun stops before the next subrequest', async () => {
    const { sourceId } = await scriptedSource()
    const outcomes: string[] = []
    behave = async (ctx) => {
      for (const path of ['/a', '/b']) {
        try {
          await ctx.fetchText({ url: `https://${HOST}${path}` })
          outcomes.push('sent')
        } catch (e) {
          outcomes.push((e as { code?: string }).code ?? 'threw')
        }
        await new Promise((r) => setTimeout(r, 1_300))
      }
      return emptyBatch()
    }
    const [report] = await w
      .worker({}, { runDeadlineMs: 1_000, deadlineGraceMs: 2_000 })
      .runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(outcomes).toEqual(['sent', 'DEADLINE'])
    expect(fixture.requests.map((r) => r.path)).toEqual(['/a'])
    expect(report).toMatchObject({ outcome: 'PARTIAL', errorCode: 'DEADLINE' })
  })

  it('AC 15, 17: DOU is refused by the ledger for its KIND, and never gets a run row', async () => {
    // even with a manifest entry and a host key, which is not what keeps DOU out
    const { sourceId } = await w.source({
      type: 'DOU_RSS',
      config: { t7: TAG },
      hostKey: w.fx.host('dou'),
    })
    expect(await manualClaim(sourceId)).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
    const { claimed, refused } = await w.ledger.claimDue({
      cycleId: await w.cycle(),
      owner: 'spec-worker',
      limit: 1,
      onlyIds: [sourceId],
    })
    expect(claimed).toEqual([])
    expect(refused).toEqual([{ sourceId, reason: 'NOT_ACTIVATABLE' }])
    expect(await w.fx.runs(sourceId)).toEqual([])
  })
})
