import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import {
  SourceBlockedError,
  SourcePayloadTooLargeError,
  SourceRateLimitedError,
} from '../http/source-errors'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import {
  createGreenhouseProvider,
  fetchGreenhouseDetail,
  greenhouseProvider,
} from '../providers/sources/greenhouse.provider'
import { REPORTING_WIRING } from '../registry/reporting-wiring'
import type { HostBan } from '../scheduling/host-state'
import {
  type FixtureServer,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'
import { buildCollectionContext } from './collection-context'

/**
 * U6a through the PRODUCTION context: the real adapter, the real `boundedFetchText` pinned to the
 * adapter's declared host, a LOCAL fixture server (the harness rewrites the target; nothing leaves
 * the machine). Request counts and bytes are what the server saw; the ban rows are what the
 * context handed to `recordBan`.
 */
const FIXTURES = join(__dirname, '../providers/sources/__fixtures__/greenhouse')
type Job = Record<string, unknown> & { id: number }
const captured = (
  JSON.parse(readFileSync(join(FIXTURES, 'airbnb-board.json'), 'utf8')) as {
    jobs: Job[]
  }
).jobs
const FULL_BOARD = readFileSync(join(FIXTURES, 'airbnb-board.json'), 'utf8')
const LIST_BODY = JSON.stringify({
  jobs: captured.map(({ content: _c, departments: _d, offices: _o, ...rest }) => rest),
})
const DETAIL_BODY = JSON.stringify(captured[0])
const CAP = 10 * 1024 * 1024

const config = greenhouseProvider.parseConfig({ configVersion: 1, board: 'airbnb' })
const HOSTS = REPORTING_WIRING.GREENHOUSE_ATS!.allowedHosts

let fixture: FixtureServer
let restoreFetch: () => void
let bans: HostBan[]

function context() {
  const run: ClaimedRun = {
    runId: '00000000-0000-4000-8000-0000000000aa',
    ownerToken: 'w:1',
    fencingEpoch: 1,
    sourceId: '00000000-0000-4000-8000-0000000000bb',
    cycleId: '00000000-0000-4000-8000-0000000000cc',
    attemptId: 'run-x',
    accountKey: null,
    sourceType: 'GREENHOUSE_ATS',
    checkpoint: null,
  }
  return buildCollectionContext(
    {
      recordBan: async (ban) => {
        bans.push(ban)
      },
      savePage: async () => undefined,
    },
    {
      run,
      hostKey: 'boards-api.greenhouse.io',
      floorHours: 0,
      banScope: undefined,
      allowedHosts: HOSTS,
      requestsPerRun: 100,
      meter: null,
      secrets: [],
      policyVersion: 1,
      deadline: new Date(Date.now() + 120_000),
      leaseMs: 120_000,
      pageWriteTimeoutMs: 5_000,
    },
  )
}

describe('U6a against a fixture server, through the production context', () => {
  beforeAll(async () => {
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  })
  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
  })
  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
    bans = []
  })

  it('ON_DEMAND: one request, to the list path without content, 3 revisions with no description, far fewer bytes than the full board', async () => {
    fixture.answer = () => ({ body: LIST_BODY })
    const provider = createGreenhouseProvider('ON_DEMAND')
    const batch = await provider.collectReport(
      provider.parseConfig({ configVersion: 1, board: 'airbnb' }),
      context().ctx,
    )
    expect(fixture.requests).toEqual([
      { host: 'boards-api.greenhouse.io', path: '/v1/boards/airbnb/jobs', method: 'GET' },
    ])
    expect(batch.observations).toHaveLength(3)
    expect(batch.observations.map((o) => o.normalized.descriptionMd)).toEqual(['', '', ''])
    expect(Buffer.byteLength(LIST_BODY)).toBeLessThan(Buffer.byteLength(FULL_BOARD) / 5)
  })

  it('IN_LIST: the one request carries content=true, as today', async () => {
    fixture.answer = () => ({ body: FULL_BOARD })
    const batch = await greenhouseProvider.collectReport(config, context().ctx)
    expect(fixture.requests.map((r) => r.path)).toEqual(['/v1/boards/airbnb/jobs?content=true'])
    expect(batch.observations[0]?.normalized.descriptionMd).not.toBe('')
  })

  it('ON_DEMAND: a list one byte over the cap is refused PAYLOAD_TOO_LARGE before any parse; at the cap it is read', async () => {
    const provider = createGreenhouseProvider('ON_DEMAND')
    const cfg = provider.parseConfig({ configVersion: 1, board: 'airbnb' })
    const padded = (bytes: number) => {
      const base = Buffer.byteLength(JSON.stringify({ jobs: [], _pad: '' }))
      return JSON.stringify({ jobs: [], _pad: 'x'.repeat(bytes - base) })
    }
    fixture.answer = () => ({ body: padded(CAP + 1) })
    const over = await provider.collectReport(cfg, context().ctx)
    expect(over.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(over.observations).toEqual([])
    fixture.answer = () => ({ body: padded(CAP) })
    const at = await provider.collectReport(cfg, context().ctx)
    expect(at.requests[0]).toMatchObject({ status: 200, error: null })
  })

  it('detail: one request to the per-job path on the allowed host, the description comes back', async () => {
    fixture.answer = () => ({ body: DETAIL_BODY })
    const r = await fetchGreenhouseDetail(context().ctx, config, 8102684)
    expect(fixture.requests).toEqual([
      { host: 'boards-api.greenhouse.io', path: '/v1/boards/airbnb/jobs/8102684', method: 'GET' },
    ])
    expect(r).toMatchObject({ kind: 'FOUND', fields: { nativeId: '8102684' } })
    expect((r as { fields: { description: string } }).fields.description.length).toBeGreaterThan(
      1000,
    )
  })

  it('detail 404 is GONE (an answer), after one request, with no ban', async () => {
    fixture.answer = () => ({ status: 404, body: { error: 'Job not found' } })
    const r = await fetchGreenhouseDetail(context().ctx, config, 1)
    expect(r).toEqual({ kind: 'GONE' })
    expect(fixture.requests).toHaveLength(1)
    expect(bans).toEqual([])
  })

  it('detail 500 is FAILED UPSTREAM, not a network failure, and bans nothing', async () => {
    fixture.answer = () => ({ status: 500, body: {} })
    expect(await fetchGreenhouseDetail(context().ctx, config, 1)).toMatchObject({
      kind: 'FAILED',
      code: 'UPSTREAM',
      status: 500,
    })
    expect(bans).toEqual([])
  })

  it.each([401, 403, 429, 451])(
    'detail %i stops the run: the context throws, records a ban for the host, and sends nothing after',
    async (status) => {
      fixture.answer = () => ({ status, body: {} })
      const { ctx } = context()
      const typed = status === 429 ? SourceRateLimitedError : SourceBlockedError
      await expect(fetchGreenhouseDetail(ctx, config, 1)).rejects.toBeInstanceOf(typed)
      expect(fixture.requests).toHaveLength(1)
      expect(bans.map((b) => b.hostKey)).toEqual(['boards-api.greenhouse.io'])
      // the context is closed: a second detail in the same run sends nothing
      await expect(fetchGreenhouseDetail(ctx, config, 2)).rejects.toBeInstanceOf(Error)
      expect(fixture.requests).toHaveLength(1)
    },
  )

  it('detail body over the cap is refused by the transport before any parse', async () => {
    fixture.answer = () => ({ body: JSON.stringify({ ...captured[0], pad: 'x'.repeat(CAP) }) })
    await expect(fetchGreenhouseDetail(context().ctx, config, 8102684)).rejects.toBeInstanceOf(
      SourcePayloadTooLargeError,
    )
  })
})
