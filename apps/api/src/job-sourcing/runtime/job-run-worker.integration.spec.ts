import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { arbeitnowProvider } from '../providers/sources/arbeitnow.provider'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * r5 Task 2.5 T7 — the run worker against a REAL Postgres AS `crm_app`, with REAL adapters and the
 * REAL `boundedFetchText`, answered by a LOCAL fixture server (nothing leaves the machine). Time is
 * moved by the aging helpers on stored instants, never by an injected clock.
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.integration
 */
const TAG = randomUUID().slice(0, 8)
const ARBEITNOW = 'www.arbeitnow.com'

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

/** An Arbeitnow page of `n` jobs whose slugs carry this run's tag (cleaned up by namespace key). */
function arbeitnowPage(ids: readonly string[], next: boolean) {
  return {
    data: ids.map((id) => ({
      slug: `t7-${TAG}-${id}`,
      url: `https://www.arbeitnow.com/jobs/t7-${TAG}-${id}`,
      title: `Engineer ${id}`,
      company_name: 'Acme',
      description: '<p>Build.</p>',
      remote: true,
      location: 'Berlin',
      tags: [],
      job_types: [],
      created_at: 1_761_000_000,
    })),
    links: { next: next ? 'https://www.arbeitnow.com/api/job-board-api?page=2' : null },
  }
}

const pageOf = (path: string) => Number(new URL(path, 'http://x').searchParams.get('page'))

describe.skipIf(!hasDatabaseUrl())('the run worker against Postgres, as crm_app (T7)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    w.register(arbeitnowProvider, [ARBEITNOW])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_source_records WHERE identity_key LIKE $1`, [
        `%t7-${TAG}-%`,
      ])
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

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('AC 2: a reporting adapter runs end to end against the fixture server', async () => {
    fixture.answer = (r) => ({
      body: arbeitnowPage(pageOf(r.path) === 1 ? ['a1', 'a2'] : [], false),
    })
    const { sourceId } = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 2 } })
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(report).toMatchObject({ outcome: 'SUCCEEDED', errorCode: null, finished: true })
    expect(fixture.requests).toEqual([
      { host: ARBEITNOW, path: '/api/job-board-api?page=1', method: 'GET' },
    ])
    expect(await runRow(w.admin, report!.runId)).toMatchObject({
      outcome: 'SUCCEEDED',
      received: 2,
    })
  })

  it('an empty run and a partial run are recorded honestly', async () => {
    fixture.answer = () => ({ body: arbeitnowPage([], false) })
    // (type, config) is unique, and Arbeitnow's config is strict: each source takes its own maxPages
    // (5 is the manifest's own entry).
    const empty = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 1 } })
    const [e] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [empty.sourceId] })
    expect(await runRow(w.admin, e!.runId)).toMatchObject({ outcome: 'SUCCEEDED', received: 0 })

    fixture.answer = (r) =>
      pageOf(r.path) === 1 ? { body: arbeitnowPage(['p1', 'p2', 'p3'], true) } : { status: 500 }
    const partial = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 3 } })
    const [p] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [partial.sourceId] })
    // page 1 persisted, page 2 failed: the run failed, and its row keeps what it received
    expect(await runRow(w.admin, p!.runId)).toMatchObject({
      outcome: 'FAILED',
      error_code: 'TRANSIENT_NETWORK',
      received: 3,
    })
    expect(fixture.requests.map((r) => pageOf(r.path))).toEqual([1, 1, 2])
  })

  it('AC 4: a throwing source leaves the other source`s run SUCCEEDED', async () => {
    const good = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 4 } })
    const bad = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 'many' } })
    fixture.answer = () => ({ body: arbeitnowPage(['g1'], false) })
    const reports = await w.worker().runDue({
      cycleId: await w.cycle(),
      onlyIds: [good.sourceId, bad.sourceId],
    })
    const by = new Map(reports.map((r) => [r.sourceId, r]))
    expect(by.get(good.sourceId)).toMatchObject({ outcome: 'SUCCEEDED' })
    expect(by.get(bad.sourceId)).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'ADAPTER_INVARIANT',
    })
  })

  it('two workers on one source: one wins, through the ledger', async () => {
    fixture.answer = () => ({ body: arbeitnowPage([], false) })
    const { sourceId } = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 6 } })
    const cycleId = await w.cycle()
    const [a, b] = await Promise.all([
      w.worker().runDue({ cycleId, onlyIds: [sourceId] }),
      w.worker({}, { owner: 'spec-worker-b' }).runDue({ cycleId, onlyIds: [sourceId] }),
    ])
    expect(a.length + b.length).toBe(1)
    expect((await w.fx.runs(sourceId)).length).toBe(1)
  })

  it('AC 16: at worker start an expired run left by a previous process is recovered first', async () => {
    const { sourceId } = await w.source({ type: 'ARBEITNOW_API', config: { maxPages: 7 } })
    const [orphan] = (
      await w.ledger.claimDue({
        cycleId: await w.cycle(),
        owner: 'dead-process',
        limit: 1,
        onlyIds: [sourceId],
      })
    ).claimed
    await ageRun(w.admin, orphan!.runId, 10 * 60_000)
    const worker = w.worker()
    const recovered = await worker.start()
    expect(recovered).toBeGreaterThanOrEqual(1)
    expect(await runRow(w.admin, orphan!.runId)).toMatchObject({
      outcome: 'FAILED',
      error_code: 'LEASE_EXPIRED',
    })
    // once: a second start does not recover again
    await ageSource(w.admin, sourceId, 0)
    expect(await worker.start()).toBe(recovered)
  })
})
