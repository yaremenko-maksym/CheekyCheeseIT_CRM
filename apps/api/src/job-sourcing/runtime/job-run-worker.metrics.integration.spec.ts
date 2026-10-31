import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import {
  type CollectionBatch,
  type CollectionContext,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
} from '../providers/reporting-provider'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * Source fetch strategy U2 AC 2 and AC 3, end to end: a REAL Postgres AS `crm_app`, the real
 * `boundedFetchText` against a LOCAL fixture server, the real context, worker and ledger.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.metrics.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOST = 'api.u2-metrics.example'
const URL_ = `https://${HOST}/jobs`

/** Three bodies of known size: 14 + 2 + 12 = 28 bytes, counted by hand. */
const BODIES = ['{"jobs":[1,2]}', '{}', '{"total":42}']
const BYTES = 14 + 2 + 12

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

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

/** Three unmetered requests; a refused one ends the run as the worker maps it. */
const threeRequests: ReportingJobSourceProvider = {
  type: 'REMOTIVE_API',
  parseConfig: (raw) => raw as never,
  async collectReport(_config, ctx: CollectionContext) {
    for (let i = 0; i < 3; i += 1) await ctx.fetchText({ url: `${URL_}?page=${i}` })
    return emptyBatch()
  },
}

async function runOnce(level = 0) {
  const s = await w.source({ type: 'REMOTIVE_API', config: { n: randomUUID() } })
  await w.admin.query(`UPDATE job_sources SET slowdown_level = $2 WHERE id = $1`, [
    s.sourceId,
    level,
  ])
  await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [s.sourceId] })
  const { rows } = await w.admin.query(
    `SELECT r.request_count, r.bytes_read::int AS bytes_read, r.last_http_status,
            r.validators_seen, r.envelope_fingerprint, r.error_code, s.slowdown_level
       FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
      WHERE r.source_id = $1`,
    [s.sourceId],
  )
  expect(rows).toHaveLength(1)
  return rows[0] as Record<string, unknown>
}

describe.skipIf(!hasDatabaseUrl())('U2: run metrics and the slow-down, end to end', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    w = await openWorld(session, TAG)
    w.register(threeRequests, [HOST])
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

  it('AC 2: a run of 3 requests records request_count 3 and bytes_read equal to the three bodies', async () => {
    let i = 0
    fixture.answer = () => {
      const body = BODIES[i] as string
      i += 1
      return i === 2 ? { body, headers: { etag: '"v2"' } } : { body }
    }
    const row = await runOnce()
    expect(fixture.requests).toHaveLength(3)
    expect(row).toMatchObject({
      request_count: 3,
      bytes_read: BYTES,
      last_http_status: 200,
      validators_seen: true,
      error_code: null,
    })
    // This adapter decodes nothing, so it reports no envelope.
    expect(row['envelope_fingerprint']).toBeNull()
    // A clean run at level 0 stays at 0.
    expect(row['slowdown_level']).toBe(0)
  })

  it('AC 3: a run the host refuses with 429 ends RATE_LIMIT and raises slowdown_level by 1', async () => {
    fixture.answer = () => ({ status: 429 })
    const row = await runOnce(2)
    expect(row).toMatchObject({
      error_code: 'RATE_LIMIT',
      request_count: 1,
      bytes_read: 0,
      last_http_status: 429,
      validators_seen: false,
      slowdown_level: 3,
    })
  })

  it('AC 3: a clean run lowers slowdown_level by 1', async () => {
    fixture.answer = () => ({ body: {} })
    expect((await runOnce(3))['slowdown_level']).toBe(2)
  })
})
