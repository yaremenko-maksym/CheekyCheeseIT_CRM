import { describe, expect, it, vi } from 'vitest'
import type { BoundedFetchOptions } from '../../http/bounded-fetch'
import { SourceHttpStatusError } from '../../http/source-errors'
import type { StoredValidators } from '../../http/stored-validators'
import type { ClaimedRun } from '../../ownership/job-run-ledger'
import { buildCollectionContext, type ContextDeps } from '../../runtime/collection-context'
import { baseSourceConfigSchema, type PageTarget } from '../api-json.provider'
import type { FetchRequest } from '../reporting-provider'
import { type HtmlDiscoveryStrategy, InMemoryEnrichmentState } from './html-ports'
import { HtmlProvider, type HtmlProviderDeps } from './html-provider'

/*
 * U6b conditional GET for an HTML listing, end to end through the PRODUCTION collection context
 * (`buildCollectionContext`): only the transport and the robots port are doubles. The provider
 * reaches the context through the shared page loop, which marks a fresh one-page read with
 * `observeSinglePage`, so the listing's validators are stored and sent back on the next run.
 */

const HOST = 'jobs.example'
const BASE = `https://${HOST}`
const PAGE1 = `${BASE}/list?page=1`
const PAGE2 = `${BASE}/list?page=2&after=c2`
const DETAIL_A = `${BASE}/jobs/a`
const STORED: StoredValidators = {
  url: PAGE1,
  etag: '"L1"',
  lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
}

type Cfg = { namespace: string; configVersion: number; query: string | null; window: null }

class TestHtmlProvider extends HtmlProvider<Cfg> {
  readonly type = 'THEHUB_HTML' as const
  readonly adapterVersion = 'thehub-test-1'
  readonly parserVersion = 'p1'
  protected readonly configSchema = baseSourceConfigSchema as never
  protected baseUrl(): string {
    return BASE
  }
  protected approvedHosts(): readonly string[] {
    return [HOST]
  }
  protected listingRequest(_config: Cfg, at: PageTarget): FetchRequest {
    return { url: `${BASE}/list?page=${at.page}${at.cursor === null ? '' : `&after=${at.cursor}`}` }
  }
}

const jsonStrategy: HtmlDiscoveryStrategy = {
  parseListing: (html) => (html.startsWith('{') ? (JSON.parse(html) as never) : null),
  parseDetail: (html) => JSON.parse(html) as never,
}
const listing = (ids: string[], nextCursor: string | null = null) =>
  JSON.stringify({
    items: ids.map((id) => ({
      id,
      postingUrl: `/jobs/${id}`,
      title: `Engineer ${id}`,
      companyName: 'Acme',
    })),
    nextCursor,
  })

type Transport = NonNullable<ContextDeps['transport']>
interface Route {
  status?: number
  body?: string
  validators?: { etag: string | null; lastModified: string | null }
}

const RUN: ClaimedRun = {
  runId: '00000000-0000-4000-8000-0000000000aa',
  ownerToken: 'w:1',
  fencingEpoch: 1,
  sourceId: '00000000-0000-4000-8000-0000000000bb',
  cycleId: '00000000-0000-4000-8000-0000000000cc',
  attemptId: 'run-x',
  accountKey: null,
  sourceType: 'THEHUB_HTML',
  checkpoint: null,
}

function world(
  routes: Record<string, Route>,
  run: { validators?: StoredValidators | null; checkpoint?: unknown } = {},
) {
  const seen: { url: string; opts: BoundedFetchOptions }[] = []
  const recordBan = vi.fn(async () => undefined)
  const transport: Transport = async (url, opts) => {
    seen.push({ url, opts })
    const route = routes[url]
    if (route === undefined) throw new Error(`unrouted ${url}`)
    const status = route.status ?? 200
    if (status !== 200) throw new SourceHttpStatusError(HOST, status)
    opts.onValidators?.(
      route.validators !== undefined,
      route.validators ?? { etag: null, lastModified: null },
    )
    return route.body ?? ''
  }
  const control = buildCollectionContext(
    {
      transport,
      recordBan,
      savePage: async () => undefined,
      monotonicNow: () => 0,
      now: () => new Date('2026-11-20T10:00:00Z'),
    },
    {
      run: { ...RUN, checkpoint: run.checkpoint ?? null, validators: run.validators ?? null },
      hostKey: HOST,
      floorHours: 0,
      banScope: undefined,
      allowedHosts: [HOST],
      requestsPerRun: null,
      meter: null,
      secrets: [],
      policyVersion: 1,
      deadline: new Date('2026-11-20T11:00:00Z'),
      leaseMs: 60_000,
      pageWriteTimeoutMs: 5_000,
    },
  )
  const observeSinglePage = vi.spyOn(control.ctx, 'observeSinglePage')
  const deps: HtmlProviderDeps = {
    robots: {
      check: async () => ({
        verdict: 'ALLOWED',
        reason: null,
        crawlDelaySeconds: null,
        aiInput: 'yes',
      }),
    },
    hostGate: { acquire: async () => undefined },
    enrichment: new InMemoryEnrichmentState(),
    strategy: jsonStrategy,
  }
  const provider = new TestHtmlProvider(deps)
  const config = provider.parseConfig({ namespace: 'board', configVersion: 1, query: null })
  return {
    ...control,
    seen,
    recordBan,
    observeSinglePage,
    collect: () => provider.collectHtml(config, control.ctx),
  }
}

describe('U6b conditional GET on an HTML listing', () => {
  it('AC1: a fresh single-page listing stores the validators of its first request', async () => {
    const w = world({
      [PAGE1]: { body: listing(['a']), validators: { etag: '"L2"', lastModified: null } },
      [DETAIL_A]: { body: '{}' },
    })
    const r = await w.collect()
    expect(w.seen.map((s) => s.url)).toEqual([PAGE1, DETAIL_A])
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(w.observeSinglePage).toHaveBeenCalledTimes(1)
    // The listing, not the detail page that came after it.
    expect(w.metrics().nextValidators).toEqual({ url: PAGE1, etag: '"L2"', lastModified: null })
  })

  it('AC2: the next run asks conditionally and a 304 ends it as an unchanged success', async () => {
    const w = world({ [PAGE1]: { status: 304 } }, { validators: STORED })
    const r = await w.collect()
    expect(w.seen.map((s) => s.url)).toEqual([PAGE1])
    expect(w.seen[0]?.opts.headers).toMatchObject({
      'if-none-match': '"L1"',
      'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.batch.observations).toEqual([])
    expect(r.batch.requests.map((q) => q.error)).toEqual([null])
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', items: 0, stop: null, stops: {} })
    expect(r.detail.status).toBe('SKIPPED')
    expect(w.metrics()).toMatchObject({ lastHttpStatus: 304, nextValidators: STORED })
    expect(w.recordBan).not.toHaveBeenCalled()
    expect(w.state.banCode).toBeNull()
  })

  it('AC2: the stored validators go only to the listing URL they were shown for', async () => {
    const w = world(
      { [PAGE1]: { body: listing(['a']) }, [DETAIL_A]: { body: '{}' } },
      { validators: { ...STORED, url: `${BASE}/robots.txt` } },
    )
    await w.collect()
    expect(w.seen.map((s) => s.opts.headers ?? {})).toEqual([{}, {}])
  })

  it('AC3: a paged listing stores nothing and drops the stored validators', async () => {
    const w = world(
      {
        [PAGE1]: { body: listing(['a'], 'c2'), validators: { etag: '"L2"', lastModified: null } },
        [PAGE2]: { body: listing(['b']) },
        [DETAIL_A]: { body: '{}' },
        [`${BASE}/jobs/b`]: { body: '{}' },
      },
      { validators: STORED },
    )
    // The stored validators were sent and the host answered 200: the listing changed.
    const r = await w.collect()
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(w.observeSinglePage).not.toHaveBeenCalled()
    expect(w.metrics().nextValidators).toBeNull()
  })

  it('AC3: a resumed listing stores nothing, even when it reads one page', async () => {
    const w = world(
      {
        [PAGE2]: { body: listing(['b']), validators: { etag: '"L2"', lastModified: null } },
        [`${BASE}/jobs/b`]: { body: '{}' },
      },
      {
        checkpoint: {
          position: { kind: 'CURSOR', page: 1, cursor: 'c2' },
          configVersion: 1,
          policyVersion: 1,
          adapterVersion: 'thehub-test-1',
          completedAt: '2026-11-20T09:00:00.000Z',
        },
      },
    )
    const r = await w.collect()
    expect(w.seen[0]?.url).toBe(PAGE2)
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(w.observeSinglePage).not.toHaveBeenCalled()
    expect(w.metrics().nextValidators).toBeNull()
  })

  it('AC4: a 304 to a detail request is still an item failure, never conditional', async () => {
    const w = world(
      { [PAGE1]: { body: listing(['a']) }, [DETAIL_A]: { status: 304 } },
      { validators: { ...STORED, url: DETAIL_A } },
    )
    const r = await w.collect()
    expect(w.seen.map((s) => s.opts.headers ?? {})).toEqual([{}, {}])
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.detail).toMatchObject({ failed: 1, unchanged: 0 })
  })
})
