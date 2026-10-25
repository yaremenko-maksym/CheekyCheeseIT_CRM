import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { sourceFixture } from '../../test/source-fixtures'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { SMARTRECRUITERS_OWNER_DECISION } from '../providers/owner-decisions'
import {
  type CollectionBatch,
  type CollectionContext,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
} from '../providers/reporting-provider'
import { createJoobleProvider } from '../providers/sources/jooble.provider'
import { createJSearchProvider } from '../providers/sources/jsearch.provider'
import { createReedProvider } from '../providers/sources/reed.provider'
import {
  SMARTRECRUITERS_BOUNDS,
  createSmartRecruitersProvider,
} from '../providers/sources/smartrecruiters.provider'
import { createTheirStackProvider } from '../providers/sources/theirstack.provider'
import {
  type FixtureServer,
  type World,
  meterRow,
  openWorld,
  reservationsOf,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'
import { LEDGER_CATALOG_SNAPSHOT } from './ledger-catalog.snapshot'

/**
 * r5 Task 2.5 T7 — the METERED production context against a REAL Postgres AS
 * `crm_app`, real adapters and the real `boundedFetchText`, answered by a LOCAL fixture server. Every
 * case asserts what the fixture server actually received.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.metered.integration
 */
const TAG = randomUUID().slice(0, 8)
const KEY = 'fake0000t7spec0000key0000fake0000t7spec0000key0000xyz'
const credential = { configured: true, apiKey: KEY, secrets: [KEY] } as const

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

const smartrecruiters = createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, {
  ownerDecision: SMARTRECRUITERS_OWNER_DECISION,
})

/**
 * Every reporting adapter that METERS its requests (reserves before sending): the keyed quota
 * adapters that declare a meter, and SmartRecruiters. Reed is not one -- it declares no meter of
 * its own although the manifest declares a quota for it; see its own case below.
 */
const METERED: {
  type: JobSourceType
  provider: ReportingJobSourceProvider
  config: Record<string, unknown>
  unit: string
  limit: number
  body: unknown
}[] = [
  {
    type: 'JSEARCH_API',
    provider: createJSearchProvider({ credential }),
    config: { query: `t7 ${TAG} backend` },
    unit: 'REQUEST',
    limit: 100,
    body: sourceFixture('jsearch', 'doc-example'),
  },
  {
    type: 'THEIRSTACK_API',
    provider: createTheirStackProvider({ credential }),
    config: { limit: 25, seniority: ['senior'], maxAgeDays: 7 },
    unit: 'RECORD',
    limit: 200,
    body: sourceFixture('theirstack', 'doc-example'),
  },
  {
    type: 'JOOBLE_API',
    provider: createJoobleProvider({ credential }),
    config: { keywords: `t7 ${TAG}`, location: 'remote' },
    unit: 'REQUEST',
    limit: 100,
    body: {},
  },
  {
    type: 'SMARTRECRUITERS_ATS',
    provider: smartrecruiters,
    config: { board: `t7${TAG}` },
    unit: 'REQUEST',
    limit: 100,
    body: { limit: 100, offset: 0, totalFound: 0, content: [] },
  },
]

const reed = createReedProvider({ credential })
const REED_CONFIG = { keywords: `t7 ${TAG}`, locationName: 'remote' }

/** The host an adapter sends its first request to, read off a dry run against an in-memory fake. */
async function firstHostOf(provider: ReportingJobSourceProvider, config: Record<string, unknown>) {
  const f = fakeCollectionContext({ responses: [{ bodyText: '{}' }] })
  await provider
    .collectReport(provider.parseConfig({ configVersion: 1, ...config }), f.ctx)
    .catch(() => undefined)
  const url = f.sent[0]?.url
  if (url === undefined) throw new Error(`setup: ${provider.type} sent nothing on a dry run`)
  return new URL(url).host
}

/** A metered source of `type` on its own account; returns ids, the meter and the account key. */
async function meteredSource(
  type: JobSourceType,
  config: Record<string, unknown>,
  meter: { unit: string; limit: number; used?: number; window?: 'DAY' | 'MONTH' },
  extra: { hostKey?: string; entry?: { banScope?: 'HOST' | 'SOURCE' } } = {},
) {
  const accountKey = w.fx.accountKey(
    `${type.toLowerCase().replace(/_/g, '-')}-${randomUUID().slice(0, 6)}`,
  )
  const meterId = await meterRow(w.admin, accountKey, {
    unit: meter.unit,
    window: meter.window ?? 'MONTH',
    limit: meter.limit,
    ...(meter.used !== undefined && { used: meter.used }),
  })
  const s = await w.source({
    type,
    config,
    accountMeterId: meterId,
    ...(extra.hostKey !== undefined && { hostKey: extra.hostKey }),
    entry: { quotaDeclared: true, ...extra.entry },
  })
  return { ...s, meterId, accountKey }
}

const emptyBatch = (stop: 'EXHAUSTED' | 'ERROR' = 'ERROR'): CollectionBatch =>
  buildCollectionBatch({
    observations: [],
    facts: {
      stop,
      pagesCompleted: 0,
      counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
      scope: { namespace: 'spec', query: null, configVersion: 1, window: null },
      resumed: false,
    },
    requests: [],
    checkpoint: null,
    invalidSamples: [],
  })

/** A custom adapter for one type: `body(ctx)` is the whole collection. */
function custom(type: JobSourceType, body: (ctx: CollectionContext) => Promise<CollectionBatch>) {
  return {
    type,
    parseConfig: (raw: unknown) => raw as never,
    collectReport: (_config: unknown, ctx: CollectionContext) => body(ctx),
  } as ReportingJobSourceProvider
}

const SPEC_HOST = 'api.t7-spec.example'
const KEEP_GOING_URL = `https://${SPEC_HOST}/jobs`

async function counters(meterId: string) {
  const { rows } = await w.admin.query(
    `SELECT used::int AS used, reserved::int AS reserved, uncertain::int AS uncertain FROM job_account_meters WHERE id = $1`,
    [meterId],
  )
  return rows[0] as { used: number; reserved: number; uncertain: number }
}

/**
 * Quota-declaring types that are NOT in the AC 9 list, each with the reason (SPEC-L-1). Anything
 * else the production catalog says is metered must be in `METERED`, or this file fails.
 */
const NOT_IN_AC9: Readonly<Partial<Record<JobSourceType, string>>> = {
  REED_API:
    'the adapter declares no meter of its own; under its account meter it fails closed (pinned below). Master A1: excepted from AC 9, a separate task makes Reed meter',
}

describe('AC 9 covers every metered type the production catalog knows (SPEC-L-1)', () => {
  const quotaTypes = LEDGER_CATALOG_SNAPSHOT.types.filter((t) => t.quotaDeclared).map((t) => t.type)
  const listed = METERED.map((m) => m.type)

  it('every quota-declaring type is run by AC 9, or excepted here with a reason', () => {
    expect(quotaTypes.length).toBeGreaterThan(0)
    expect(quotaTypes.filter((t) => !listed.includes(t) && NOT_IN_AC9[t] === undefined)).toEqual([])
  })

  it('an exception is a quota-declaring type the AC 9 list does not also run', () => {
    for (const t of Object.keys(NOT_IN_AC9) as JobSourceType[]) {
      expect(quotaTypes).toContain(t)
      expect(listed).not.toContain(t)
    }
  })
})

describe.skipIf(!hasDatabaseUrl())('the metered production context against Postgres (T7)', () => {
  const hosts = new Map<JobSourceType, string>()

  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    for (const m of METERED) {
      const host = await firstHostOf(m.provider, m.config)
      hosts.set(m.type, host)
      w.register(m.provider, [host])
    }
    w.register(reed, [await firstHostOf(reed, REED_CONFIG)])
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

  it.each(METERED.map((m) => [m.type, m] as const))(
    'AC 9: %s runs through the production context without NOT_MARKED_SENT',
    async (_type, m) => {
      fixture.answer = () => ({ body: m.body })
      const { sourceId } = await meteredSource(m.type, m.config, { unit: m.unit, limit: m.limit })
      const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
      expect(report, 'the source was claimed and run').toBeDefined()
      expect(report?.errorCode).not.toBe('NOT_MARKED_SENT')
      expect(
        fixture.requests.length,
        JSON.stringify(await runRow(w.admin, report!.runId)),
      ).toBeGreaterThanOrEqual(1)
      expect(fixture.requests.every((r) => r.host === hosts.get(m.type))).toBe(true)
      const statuses = (await reservationsOf(w.admin, report!.runId)).map((r) => r.status)
      // one reservation per request sent, each settled as spent
      expect(statuses).toEqual(fixture.requests.map(() => 'USED'))
    },
  )

  it('Reed (manifest quota, no meter of its own) fails CLOSED under its account meter: nothing sent', async () => {
    // Found by AC 9: the manifest declares a Reed quota, so the claim requires a meter row
    // (METER_MISSING otherwise), while the adapter reserves nothing. The production context refuses
    // its first request. Safe (nothing leaves, nothing is charged), not functional: decision brief.
    const { sourceId } = await meteredSource('REED_API', REED_CONFIG, {
      unit: 'REQUEST',
      limit: 100,
    })
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(report).toMatchObject({ outcome: 'FAILED', errorCode: 'NOT_MARKED_SENT' })
    expect(fixture.requests).toEqual([])
  })

  it('AC 6: a metered fetch without a committed markSent throws NOT_MARKED_SENT; zero requests', async () => {
    w.register(
      custom('HIMALAYAS_API', async (ctx) => {
        await ctx.fetchText({ url: KEEP_GOING_URL })
        return emptyBatch('EXHAUSTED')
      }),
      [SPEC_HOST],
    )
    const { sourceId } = await meteredSource(
      'HIMALAYAS_API',
      { n: 1 },
      { unit: 'REQUEST', limit: 10 },
    )
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(report).toMatchObject({ outcome: 'FAILED', errorCode: 'NOT_MARKED_SENT' })
    expect(fixture.requests).toEqual([])
  })

  it('AC 3: a TheirStack run that would exceed its 200 free records stops COST_STOP, sending nothing', async () => {
    const ts = METERED.find((m) => m.type === 'THEIRSTACK_API')!
    const { sourceId, meterId } = await meteredSource(
      'THEIRSTACK_API',
      { ...ts.config, limit: 20 },
      { unit: 'RECORD', limit: 200, used: 190 },
    )
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(report).toMatchObject({ outcome: 'PARTIAL', errorCode: 'COST_STOP', finished: true })
    expect(fixture.requests).toEqual([])
    expect(await counters(meterId)).toEqual({ used: 190, reserved: 0, uncertain: 0 })
  })

  it('AC 7: every SmartRecruiters request has its reservation SENT before the fixture sees it', async () => {
    const seenAt: { inFlightSent: number; spentSoFar: number }[] = []
    let meterId = ''
    fixture.answer = async (req) => {
      const { rows } = await w.admin.query(
        `SELECT count(*) FILTER (WHERE status = 'SENT')::int AS sent,
                count(*) FILTER (WHERE status IN ('SENT', 'USED'))::int AS spent
           FROM job_account_meter_reservations WHERE meter_id = $1`,
        [meterId],
      )
      seenAt.push({ inFlightSent: rows[0].sent, spentSoFar: rows[0].spent })
      const id = /\/postings\/([^/?]+)$/.exec(req.path)?.[1]
      if (id === undefined) {
        return {
          body: {
            limit: 100,
            offset: 0,
            totalFound: 2,
            content: ['111', '222'].map((i) => ({
              id: i,
              name: `Posting ${i}`,
              company: { identifier: 'Acme', name: 'Acme Inc' },
              releasedDate: '2026-10-01T10:00:00.000Z',
              location: { city: 'Berlin', country: 'de', remote: true },
              ref: `https://api.smartrecruiters.com/api-v1/companies/Acme/postings/${i}`,
            })),
          },
        }
      }
      return {
        body: {
          id,
          name: `Posting ${id}`,
          postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}-posting`,
          applyUrl: `https://www.smartrecruiters.com/Acme/${id}-posting?oga=true`,
          active: true,
          jobAd: { sections: { jobDescription: { title: 'Job', text: '<p>Do.</p>' } } },
        },
      }
    }
    const s = await meteredSource(
      'SMARTRECRUITERS_ATS',
      { board: `t7${TAG}x` },
      { unit: 'REQUEST', limit: 50 },
    )
    meterId = s.meterId
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [s.sourceId] })
    expect(report?.errorCode).not.toBe('NOT_MARKED_SENT')
    // the list and two details; each one arrived with ITS reservation already SENT
    expect(seenAt).toEqual([
      { inFlightSent: 1, spentSoFar: 1 },
      { inFlightSent: 1, spentSoFar: 2 },
      { inFlightSent: 1, spentSoFar: 3 },
    ])
  })
})
