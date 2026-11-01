import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { baseSourceConfigSchema, collectJsonPages } from '../providers/api-json.provider'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * Source fetch strategy U6b, end to end: a REAL Postgres AS `crm_app`, the real `boundedFetchText`
 * against a LOCAL fixture server (nothing leaves the machine), the real context, worker, ledger and
 * `collectJsonPages`. Run 1 shows a validator and is stored; run 2 sends it; a `304` ends run 2
 * clean without touching any source record.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.conditional.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOST = 'api.u6b-conditional.example'
const NS = `u6b-${TAG}`
const URL_ = `https://${HOST}/jobs`
const MODIFIED = 'Wed, 21 Oct 2026 07:28:00 GMT'

const configSchema = baseSourceConfigSchema.extend({})
const itemSchema = z.object({ id: z.string(), title: z.string(), company: z.string() })
const envelopeSchema = z.object({ jobs: z.array(z.unknown()) })
const BODY = { jobs: [{ id: '1', title: 'Senior Engineer', company: 'Studio' }] }

const provider: ReportingJobSourceProvider = {
  type: 'REMOTIVE_API',
  parseConfig: (raw) => configSchema.parse(raw) as never,
  collectReport: (config, ctx) =>
    collectJsonPages(
      {
        type: 'REMOTIVE_API',
        adapterVersion: 'u6b-1',
        configSchema,
        envelopeSchema,
        itemSchema,
        pageRequest: () => ({ request: { url: URL_ }, cacheKey: 'p1' }),
        extractItems: (e) => e.jobs,
        nextCursor: () => null,
        nativeIdOf: (i) => i.id,
        mapItem: (i, c) => ({
          namespace: c.namespace,
          nativeId: i.id,
          url: `https://jobs.example.com/${i.id}`,
          title: i.title,
          companyName: i.company,
        }),
        scopeOf: (c) => ({
          namespace: c.namespace,
          query: c.query,
          configVersion: c.configVersion,
          window: c.window,
        }),
        limits: { maxPages: 3 },
      },
      config as never,
      ctx,
    ),
}

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
let sourceId: string

async function runAgain(): Promise<Record<string, unknown>> {
  await w.admin.query(
    `UPDATE job_sources SET next_attempt_at = clock_timestamp() - interval '1 second', cooldown_until = NULL
      WHERE id = $1`,
    [sourceId],
  )
  await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
  const { rows } = await w.admin.query(
    `SELECT outcome, error_code, received::int AS received, request_count, last_http_status,
            checkpoint->'validators' AS validators
       FROM job_collection_runs WHERE source_id = $1 ORDER BY fencing_epoch DESC LIMIT 1`,
    [sourceId],
  )
  return rows[0] as Record<string, unknown>
}

async function recordState(): Promise<{ records: number; revisions: number; touched: string }> {
  const { rows } = await w.admin.query(
    `SELECT count(DISTINCT r.id)::int AS records, count(v.id)::int AS revisions,
            coalesce(max(r.updated_at)::text, '') AS touched
       FROM job_source_records r LEFT JOIN job_source_record_revisions v ON v.source_record_id = r.id
      WHERE r.namespace = $1`,
    [NS],
  )
  return rows[0] as { records: number; revisions: number; touched: string }
}

const headerOf = (i: number, name: string) => fixture.requests[i]?.headers[name]

describe.skipIf(!hasDatabaseUrl())('U6b: conditional requests, end to end', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    w = await openWorld(session, TAG)
    w.register(provider, [HOST])
    sourceId = (
      await w.source({ type: 'REMOTIVE_API', config: { namespace: NS, configVersion: 1 } })
    ).sourceId
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      await w.admin.query(
        `DELETE FROM job_source_record_revisions WHERE source_record_id IN (SELECT id FROM job_source_records WHERE namespace = $1)`,
        [NS],
      )
      await w.admin.query(`DELETE FROM job_source_records WHERE namespace = $1`, [NS])
      await w.close()
    } finally {
      await session.close()
    }
  })

  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
  })

  it('run 1: a host that has shown nothing gets no conditional header; its validators are stored', async () => {
    fixture.answer = () => ({ body: BODY, headers: { etag: '"v1"', 'last-modified': MODIFIED } })
    const run = await runAgain()
    expect(fixture.requests).toHaveLength(1)
    expect(headerOf(0, 'if-none-match')).toBeUndefined()
    expect(headerOf(0, 'if-modified-since')).toBeUndefined()
    expect(run).toMatchObject({ outcome: 'SUCCEEDED', received: 1, last_http_status: 200 })
    expect(run['validators']).toEqual({ url: URL_, etag: '"v1"', lastModified: MODIFIED })
    expect((await recordState()).records).toBe(1)
  })

  it('run 2: sends the stored validators, and a 304 ends the run clean without touching any record', async () => {
    const before = await recordState()
    fixture.answer = () => ({ status: 304 })
    const run = await runAgain()
    expect(headerOf(0, 'if-none-match')).toBe('"v1"')
    expect(headerOf(0, 'if-modified-since')).toBe(MODIFIED)
    // The exact shape the EMPTY_RESPONSE detector reads: a clean success, received 0, status 304.
    expect(run).toMatchObject({
      outcome: 'SUCCEEDED',
      error_code: null,
      received: 0,
      request_count: 1,
      last_http_status: 304,
    })
    expect(await recordState()).toEqual(before)
    // The validators stand for the next run.
    expect(run['validators']).toEqual({ url: URL_, etag: '"v1"', lastModified: MODIFIED })
  })

  it('run 3: still conditional after a 304; a 200 replaces the stored validators', async () => {
    fixture.answer = () => ({ body: BODY, headers: { etag: '"v2"' } })
    const run = await runAgain()
    expect(headerOf(0, 'if-none-match')).toBe('"v1"')
    expect(run['validators']).toEqual({ url: URL_, etag: '"v2"', lastModified: null })
  })

  it('run 4: a failed run stores nothing, so the next run still asks with the last good validators', async () => {
    fixture.answer = () => ({ status: 500 })
    const failed = await runAgain()
    expect(failed['outcome']).not.toBe('SUCCEEDED')
    expect(failed['validators']).toBeNull()
    fixture.requests.length = 0
    fixture.answer = () => ({ status: 304 })
    await runAgain()
    expect(headerOf(0, 'if-none-match')).toBe('"v2"')
  })

  it('run 5: a 200 that shows no validator drops the stored ones', async () => {
    fixture.answer = () => ({ body: BODY })
    const run = await runAgain()
    expect(run['validators']).toBeNull()
    fixture.requests.length = 0
    fixture.answer = () => ({ body: BODY })
    await runAgain()
    expect(headerOf(0, 'if-none-match')).toBeUndefined()
  })

  it('run 6: validators stored under one config version are not sent after the config changes', async () => {
    fixture.answer = () => ({ body: BODY, headers: { etag: '"v6"' } })
    await runAgain()
    await w.admin.query(
      `UPDATE job_sources SET config_version = config_version + 1 WHERE id = $1`,
      [sourceId],
    )
    await w.admin.query(
      `UPDATE job_sources SET config = jsonb_set(config, '{configVersion}', to_jsonb(config_version)) WHERE id = $1`,
      [sourceId],
    )
    fixture.requests.length = 0
    fixture.answer = () => ({ body: BODY })
    await runAgain()
    expect(headerOf(0, 'if-none-match')).toBeUndefined()
  })
})
