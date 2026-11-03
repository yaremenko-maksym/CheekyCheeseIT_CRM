import { describe, expect, it, vi } from 'vitest'
import type { RobotsCheck } from '../../structuring/robots-policy'
import type {
  HtmlStructurer,
  StructuredRecord,
  StructurerOutcome,
} from '../../structuring/html-structurer.port'
import { baseSourceConfigSchema, type PageTarget } from '../api-json.provider'
import type {
  CollectionContext,
  FetchedText,
  FetchRequest,
  ReservationResolution,
  ValidatedCheckpoint,
} from '../reporting-provider'
import {
  type EnrichmentStatePort,
  type HtmlDetailFields,
  type HtmlDiscoveryStrategy,
  InMemoryEnrichmentState,
  InMemoryHostGate,
} from './html-ports'
import { HtmlProvider, type HtmlLimits, type HtmlProviderDeps } from './html-provider'

/*
 * Seams: a fake `fetchText` routed by URL, a fake robots port, a JSON "page" strategy (the base
 * never parses markup itself — the strategy is a port), a fake structurer, in-memory state, and an
 * injectable clock on the host gate. No network, no model, no key.
 */

const BASE = 'https://jobs.example'
const NOW = new Date('2026-11-01T10:00:00Z')

type Cfg = { namespace: string; configVersion: number; query: string | null; window: null }

class TestHtmlProvider extends HtmlProvider<Cfg> {
  readonly type = 'THEHUB_HTML' as const
  readonly adapterVersion = 'thehub-test-1'
  protected readonly configSchema = baseSourceConfigSchema as never
  constructor(
    deps: HtmlProviderDeps,
    readonly parserVersion = 'p1',
    private readonly listingUrl: (at: PageTarget) => string = (at) =>
      `${BASE}/list?page=${at.page}${at.cursor === null ? '' : `&after=${at.cursor}`}`,
  ) {
    super(deps)
  }
  protected baseUrl(): string {
    return BASE
  }
  protected approvedHosts(): readonly string[] {
    return ['jobs.example', 'Tenant.Example']
  }
  protected listingRequest(_config: Cfg, at: PageTarget): FetchRequest {
    return { url: this.listingUrl(at) }
  }
}

/** A listing body: JSON standing in for markup, read by the JSON strategy below. */
const listing = (items: unknown[], nextCursor: string | null = null) =>
  JSON.stringify({ items, nextCursor })
const item = (id: string, postingUrl = `/jobs/${id}`, extra: Record<string, unknown> = {}) => ({
  id,
  postingUrl,
  title: `Engineer ${id}`,
  companyName: 'Acme',
  ...extra,
})
const detail = (fields: HtmlDetailFields) => JSON.stringify(fields)

const jsonStrategy: HtmlDiscoveryStrategy = {
  parseListing: (html) => (html.startsWith('{') ? (JSON.parse(html) as never) : null),
  parseDetail: (html) => JSON.parse(html) as HtmlDetailFields,
}

const allowed = (crawlDelaySeconds: number | null = null): RobotsCheck => ({
  verdict: 'ALLOWED',
  reason: null,
  crawlDelaySeconds,
  aiInput: 'yes',
})

interface Reply {
  status?: number
  bodyText?: string
  etag?: string | null
  conditional?: true
  throws?: unknown
}

function world(opts: {
  routes: Record<string, Reply>
  robots?: (url: string) => RobotsCheck
  now?: Date
  policyVersion?: number
  reserveNullAfter?: number
  markSentThrows?: boolean
  deadline?: Date
  stored?: ValidatedCheckpoint | null
}) {
  const sent: string[] = []
  const robotsChecked: string[] = []
  const reserved: number[] = []
  const reconciled: ReservationResolution[] = []
  const saved: ValidatedCheckpoint[] = []
  let marked = 0
  const ctx: CollectionContext = {
    run: { sourceId: 's', cycleId: 'c', attemptId: 'a', fencingEpoch: 1 },
    policyVersion: opts.policyVersion ?? 1,
    signal: new AbortController().signal,
    deadline: opts.deadline ?? new Date('2030-01-01T00:00:00Z'),
    now: () => opts.now ?? NOW,
    secrets: [],
    async fetchText(request: FetchRequest): Promise<FetchedText> {
      sent.push(request.url)
      const reply = opts.routes[request.url]
      if (reply === undefined) throw new Error(`unrouted ${request.url}`)
      if (reply.throws !== undefined) throw reply.throws
      return {
        status: reply.status ?? 200,
        bodyText: reply.bodyText ?? '',
        headers: {},
        etag: reply.etag ?? null,
        ...(reply.conditional ? { conditional: true as const } : {}),
      }
    },
    meter: {
      async reserve(unit, amount) {
        if (opts.reserveNullAfter !== undefined && reserved.length >= opts.reserveNullAfter) {
          return null
        }
        reserved.push(amount)
        return { id: `r${reserved.length}`, unit, amount }
      },
      async markSent() {
        if (opts.markSentThrows) throw new Error('meter down')
        marked += 1
      },
      async reconcile(_r, resolution) {
        reconciled.push(resolution)
      },
    },
    checkpoints: {
      async load() {
        return opts.stored ?? null
      },
      async savePage({ checkpoint }) {
        saved.push(checkpoint)
      },
    },
    cache: {
      async get() {
        return null
      },
      async put() {},
    },
  }
  const robots = {
    check: vi.fn(async (url: string) => {
      robotsChecked.push(url)
      return (opts.robots ?? (() => allowed()))(url)
    }),
  }
  return {
    ctx,
    sent,
    robots,
    robotsChecked,
    reserved,
    reconciled,
    saved,
    get marked() {
      return marked
    },
  }
}

function provider(
  w: ReturnType<typeof world>,
  extra: Partial<HtmlProviderDeps> & {
    limits?: Partial<HtmlLimits>
    parserVersion?: string
    listingUrl?: (at: PageTarget) => string
  } = {},
) {
  const acquired: { origin: string; gap: number }[] = []
  const enrichment: EnrichmentStatePort = extra.enrichment ?? new InMemoryEnrichmentState()
  const p = new TestHtmlProvider(
    {
      robots: w.robots,
      hostGate: extra.hostGate ?? {
        async acquire(origin, gap) {
          acquired.push({ origin, gap })
        },
      },
      enrichment,
      strategy: extra.strategy ?? jsonStrategy,
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.limits ? { limits: extra.limits } : {}),
    },
    extra.parserVersion,
    extra.listingUrl,
  )
  return { p, acquired, enrichment }
}

const config = (query: string | null = null) =>
  new TestHtmlProvider({} as HtmlProviderDeps).parseConfig({
    namespace: 'board',
    configVersion: 1,
    query,
  })

const page1 = `${BASE}/list?page=1`
const detailUrl = (id: string) => `${BASE}/jobs/${id}`

// ---------------------------------------------------------------------------
// AC1 — discovery / detail separation and truncation
// ---------------------------------------------------------------------------

describe('AC1 discovery and detail are separate stages', () => {
  it('fetches the listing first, then only the due detail pages', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a'), item('b')]) },
        [detailUrl('a')]: { bodyText: detail({ description: 'A' }) },
        [detailUrl('b')]: { bodyText: detail({ description: 'B' }) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1, detailUrl('a'), detailUrl('b')])
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.batch.observations.map((o) => o.identity.nativeId)).toEqual(['a', 'b'])
    expect(r.discovery).toMatchObject({
      method: 'HTML_LISTING',
      status: 'COMPLETE',
      items: 2,
      stop: null,
      stops: {},
      policyReason: null,
    })
    expect(r.discovery.scope).toEqual({
      namespace: 'board',
      query: null,
      configVersion: 1,
      window: null,
    })
    expect(r.detail).toMatchObject({ method: 'HTML_DETAIL', status: 'COMPLETE', fetched: 2 })
    expect(r.enrichments).toEqual([
      {
        id: 'a',
        fields: { description: 'A' },
        methods: { description: 'DETAIL_HTML' },
        evidence: [],
      },
      {
        id: 'b',
        fields: { description: 'B' },
        methods: { description: 'DETAIL_HTML' },
        evidence: [],
      },
    ])
  })

  it('collectReport returns the discovery batch', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a', 'https://elsewhere.example/a')]) },
      },
    })
    const { p } = provider(w)
    const batch = await p.collectReport(config(), w.ctx)
    expect(batch.observations).toHaveLength(1)
    expect(w.sent).toEqual([page1])
  })

  it('refuses a config parseConfig never validated', async () => {
    const w = world({ routes: {} })
    const { p } = provider(w)
    await expect(
      p.collectHtml(
        { namespace: 'b', configVersion: 1, query: null, window: null } as never,
        w.ctx,
      ),
    ).rejects.toThrow(/never validated/)
    expect(w.sent).toEqual([])
  })

  it('a page cap is a counted stop: discovery PARTIAL, nothing past the cap fetched', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([item('b')], 'c3') },
      },
    })
    const { p } = provider(w, { limits: { maxPages: 2 } })
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent.filter((u) => u.includes('/list'))).toHaveLength(2)
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', stop: 'PAGE_CAP', items: 2 })
    expect(r.discovery.stops).toEqual({ PAGE_CAP: 1 })
    expect(r.batch.coverage).toBe('PARTIAL')
  })

  it('a SEARCH scope that hits the cap is a WINDOW on the batch, PARTIAL in discovery', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')], 'c2') },
      },
    })
    const { p } = provider(w, { limits: { maxPages: 1 } })
    const r = await p.collectHtml(config('rust'), w.ctx)
    expect(r.batch.coverage).toBe('WINDOW')
    expect(r.discovery.status).toBe('PARTIAL')
    expect(r.discovery.scope.query).toBe('rust')
  })

  it('a page over the item cap after a kept page is PARTIAL, and the kept page stands', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([item('b'), item('c'), item('d')]) },
        [detailUrl('a')]: { bodyText: detail({ description: 'A' }) },
      },
    })
    const { p } = provider(w, { limits: { maxItemsPerPage: 2 } })
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.batch.outcome).toBe('PARTIAL')
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', stop: 'PAYLOAD_TOO_LARGE', items: 1 })
    expect(r.detail.fetched).toBe(1)
  })

  it('a listing body over the byte cap is refused before parsing (PAYLOAD_TOO_LARGE)', async () => {
    const parseListing = vi.fn(jsonStrategy.parseListing)
    const w = world({ routes: { [page1]: { bodyText: listing([item('a')]) } } })
    const { p } = provider(w, {
      limits: { maxListingBytes: 10 },
      strategy: { ...jsonStrategy, parseListing },
    })
    const r = await p.collectHtml(config(), w.ctx)
    expect(parseListing).not.toHaveBeenCalled()
    expect(r.discovery).toMatchObject({ status: 'FAILED', stop: 'PAYLOAD_TOO_LARGE', items: 0 })
    expect(r.detail.status).toBe('SKIPPED')
  })

  it('accepts a listing body exactly at the byte cap', async () => {
    const body = listing([item('a', 'https://elsewhere.example/a')])
    const w = world({ routes: { [page1]: { bodyText: body } } })
    const { p } = provider(w, { limits: { maxListingBytes: Buffer.byteLength(body) } })
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery.status).toBe('COMPLETE')
  })

  it('a body that is not a listing (null or a throwing strategy) is PARSE_DRIFT', async () => {
    for (const parseListing of [
      () => null,
      () => {
        throw new Error('boom')
      },
    ]) {
      const w = world({ routes: { [page1]: { bodyText: '<html>captcha</html>' } } })
      const { p } = provider(w, { strategy: { ...jsonStrategy, parseListing } })
      const r = await p.collectHtml(config(), w.ctx)
      expect(r.discovery).toMatchObject({ status: 'FAILED', stop: 'PARSE_DRIFT' })
      expect(r.batch.requests[0]?.error?.message).toBe('not a listing page')
    }
  })
})

// ---------------------------------------------------------------------------
// AC2 — pagination and cursor loops
// ---------------------------------------------------------------------------

describe('AC2 pagination stops on loops with a counted reason', () => {
  it('a repeated cursor stops as CURSOR_CYCLE', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')], 'x') },
        [`${BASE}/list?page=2&after=x`]: { bodyText: listing([item('b')], 'x') },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery).toMatchObject({
      status: 'PARTIAL',
      stop: 'CURSOR_CYCLE',
      duplicatePages: 0,
    })
    expect(r.discovery.stops).toEqual({ CURSOR_CYCLE: 1 })
    expect(w.sent.filter((u) => u.includes('/list'))).toHaveLength(2)
  })

  it('a page repeating an earlier page under a new cursor is a counted duplicate', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a'), item('b')], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([item('a'), item('b')], 'c3') },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery).toMatchObject({
      status: 'PARTIAL',
      stop: 'CURSOR_CYCLE',
      duplicatePages: 1,
      items: 2,
    })
    expect(r.batch.requests[1]?.error?.message).toBe('listing page repeats an earlier page')
    expect(w.sent.filter((u) => u.includes('/list'))).toHaveLength(2)
  })

  it('two empty pages are not a duplicate', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([]) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery).toMatchObject({ status: 'COMPLETE', duplicatePages: 0, items: 0 })
    expect(r.detail.status).toBe('SKIPPED')
  })

  it('pages with different items continue to the end', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([item('b')]) },
        [detailUrl('a')]: { bodyText: detail({}) },
        [detailUrl('b')]: { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery).toMatchObject({ status: 'COMPLETE', items: 2, duplicatePages: 0 })
    expect(r.batch.coverage).toBe('FULL_INVENTORY')
  })

  it('resumes the listing from a stored checkpoint without refetching earlier pages', async () => {
    const stored: ValidatedCheckpoint = {
      position: { kind: 'CURSOR', page: 1, cursor: 'c2' },
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'thehub-test-1',
      completedAt: new Date('2026-11-01T09:00:00Z'),
    } as ValidatedCheckpoint
    const w = world({
      stored,
      routes: {
        [page1]: { bodyText: listing([item('a')], 'c2') },
        [`${BASE}/list?page=2&after=c2`]: { bodyText: listing([item('b')]) },
        [detailUrl('b')]: { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([`${BASE}/list?page=2&after=c2`, detailUrl('b')])
    expect(r.batch.observations.map((o) => o.identity.nativeId)).toEqual(['b'])
  })
})

// ---------------------------------------------------------------------------
// AC3 — links
// ---------------------------------------------------------------------------

describe('AC3 links: base resolution, approved hosts, posting vs application', () => {
  it('resolves a relative posting URL against the validated base and fetches it as detail', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a', '  /jobs/a  ')]) },
        [detailUrl('a')]: { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.batch.observations[0]?.sourcePostingUrl).toBe(detailUrl('a'))
    expect(w.sent).toContain(detailUrl('a'))
  })

  it('fetches a tenant host from the approved list (case-insensitive)', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a', 'https://tenant.example/jobs/a')]) },
        'https://tenant.example/jobs/a': { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toContain('https://tenant.example/jobs/a')
    expect(r.detail.fetched).toBe(1)
  })

  it('keeps an off-host posting as navigation only: observed, never detail-fetched', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a', 'https://other.example/a')]) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.batch.observations[0]?.sourcePostingUrl).toBe('https://other.example/a')
    expect(r.discovery.navigationOnly).toBe(1)
    expect(r.detail).toMatchObject({ navigationOnly: 1, fetched: 0, status: 'COMPLETE' })
  })

  it('keeps the application URL distinct from the posting URL and never fetches it', async () => {
    const w = world({
      routes: {
        [page1]: {
          bodyText: listing([item('a', '/jobs/a', { applicationUrl: '/apply/a' })]),
        },
        [detailUrl('a')]: { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.batch.observations[0]?.sourcePostingUrl).toBe(detailUrl('a'))
    expect(r.batch.observations[0]?.applicationUrl).toBe(`${BASE}/apply/a`)
    expect(w.sent).not.toContain(`${BASE}/apply/a`)
  })

  it('drops an application URL that checkStoredLink refuses', async () => {
    const w = world({
      routes: {
        [page1]: {
          bodyText: listing([item('a', '/jobs/a', { applicationUrl: 'javascript:alert(1)' })]),
        },
        [detailUrl('a')]: { bodyText: detail({}) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.batch.observations[0]?.applicationUrl).toBeNull()
  })

  it.each([
    ['credentials', 'https://user:pw@jobs.example/jobs/a'],
    ['an odd scheme', 'javascript:alert(1)'],
    ['plain http', 'http://jobs.example/jobs/a'],
    ['an IP literal', 'https://127.0.0.1/jobs/a'],
  ])('refuses a posting link with %s: quarantined, never fetched', async (_name, link) => {
    const w = world({ routes: { [page1]: { bodyText: listing([item('a', link)]) } } })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.discovery.rejectedLinks).toBe(1)
    expect(r.batch.counts.quarantined).toBe(1)
    expect(r.batch.observations).toHaveLength(0)
  })

  it('normalises the item id the way identity does, so the detail stage finds it', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('  a  ', '/jobs/a')]) },
        [detailUrl('a')]: { bodyText: detail({ location: 'Kyiv' }) },
      },
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.enrichments.map((e) => e.id)).toEqual(['a'])
  })

  it('refuses a listing request the adapter pointed off the approved hosts (no fetch of it)', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a', 'https://other.example/a')], 'c2') },
      },
    })
    const { p } = provider(w, {
      listingUrl: (at) => (at.page === 1 ? page1 : `https://evil.example/list?after=${at.cursor}`),
    })
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', stop: 'ACCESS_POLICY' })
    expect(r.batch.requests[1]?.error?.message).toBe('html request refused: HOST_NOT_APPROVED')
  })

  it('refuses a listing request whose URL fails checkStoredLink', async () => {
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a', 'https://other.example/a')], 'c2') } },
    })
    const { p } = provider(w, {
      listingUrl: (at) => (at.page === 1 ? page1 : 'http://jobs.example/list'),
    })
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.batch.requests[1]?.error?.message).toBe('html request refused: UNSAFE_SCHEME')
  })

  it('refuses to run when the base URL fails the link policy or is not approved', async () => {
    class BadBase extends TestHtmlProvider {
      protected override baseUrl(): string {
        return 'http://jobs.example'
      }
    }
    class Unapproved extends TestHtmlProvider {
      protected override approvedHosts(): readonly string[] {
        return ['tenant.example']
      }
    }
    const w = world({ routes: {} })
    const deps = {
      robots: w.robots,
      hostGate: { acquire: async () => {} },
      enrichment: new InMemoryEnrichmentState(),
      strategy: jsonStrategy,
    }
    await expect(new BadBase(deps).collectHtml(config(), w.ctx)).rejects.toThrow(
      'html provider: base URL refused (UNSAFE_SCHEME)',
    )
    await expect(new Unapproved(deps).collectHtml(config(), w.ctx)).rejects.toThrow(
      'html provider: the base host is not among the approved hosts',
    )
    expect(w.sent).toEqual([])
    expect(w.robotsChecked).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// shared fakes for the later sections
// ---------------------------------------------------------------------------

const fakeStructurer = (
  outcome: StructurerOutcome | Error,
): HtmlStructurer & {
  calls: Parameters<HtmlStructurer['structure']>[0][]
} => {
  const calls: Parameters<HtmlStructurer['structure']>[0][] = []
  return {
    calls,
    async structure(request) {
      calls.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

const modelRecord = (sourceId: string, fields: Partial<StructuredRecord> = {}): StructuredRecord =>
  ({
    sourceId,
    externalId: null,
    title: null,
    company: null,
    location: null,
    remote: null,
    employmentType: null,
    salary: null,
    description: null,
    postedAt: null,
    postingUrl: null,
    applyUrl: null,
    evidence: [],
    uncertainty: 0.1,
    ...fields,
  }) as StructuredRecord

/** Two items on the base host, both with a detail page. */
const twoItems = (a: HtmlDetailFields = {}, b: HtmlDetailFields = {}) => ({
  [page1]: { bodyText: listing([item('a'), item('b')]) },
  [detailUrl('a')]: { bodyText: detail(a) },
  [detailUrl('b')]: { bodyText: detail(b) },
})

// ---------------------------------------------------------------------------
// AC4 — robots and the host gap
// ---------------------------------------------------------------------------

describe('AC4 policy: robots verdicts and the host gap', () => {
  it.each(['DENIED', 'PAUSED', 'UNREACHABLE_DENIED'] as const)(
    'all-robots-%s: a policy-block outcome with no fetch and no reservation at all',
    async (verdict) => {
      const w = world({
        routes: twoItems(),
        robots: () => ({
          verdict,
          reason: `R_${verdict}`,
          crawlDelaySeconds: null,
          aiInput: 'yes',
        }),
      })
      const { p } = provider(w)
      const r = await p.collectHtml(config(), w.ctx)
      expect(w.sent).toEqual([])
      expect(w.reserved).toEqual([])
      expect(w.robotsChecked).toEqual([page1])
      expect(r.batch.outcome).toBe('FAILED')
      expect(r.batch.coverage).toBe('PARTIAL')
      expect(r.batch.observations).toEqual([])
      expect(r.batch.requests).toHaveLength(1)
      expect(r.batch.requests[0]).toMatchObject({
        attempt: 1,
        page: 1,
        url: page1,
        status: null,
        startedAt: NOW,
        endedAt: NOW,
        error: { code: 'ACCESS_POLICY', message: `robots: R_${verdict}` },
        cost: null,
      })
      expect(r.discovery).toEqual({
        method: 'HTML_LISTING',
        status: 'POLICY_BLOCKED',
        scope: { namespace: 'board', query: null, configVersion: 1, window: null },
        items: 0,
        stop: 'ACCESS_POLICY',
        stops: { ACCESS_POLICY: 1 },
        duplicatePages: 0,
        rejectedLinks: 0,
        navigationOnly: 0,
        policyReason: `R_${verdict}`,
      })
      expect(r.detail).toMatchObject({ status: 'SKIPPED', fetched: 0, checkpoint: null })
      expect(r.model).toMatchObject({ status: 'SKIPPED', reason: 'POLICY_BLOCKED' })
      expect(r.enrichments).toEqual([])
      expect(r.usage).toEqual({ requests: 0, bytes: 0 })
    },
  )

  it('a refusal without a reason reports its verdict', async () => {
    const w = world({
      routes: twoItems(),
      robots: () => ({ verdict: 'PAUSED', reason: null, crawlDelaySeconds: null, aiInput: 'yes' }),
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.discovery.policyReason).toBe('PAUSED')
  })

  it.each(['DENIED', 'PAUSED', 'UNREACHABLE_DENIED'] as const)(
    'a %s detail URL is never fetched; the others are',
    async (verdict) => {
      const w = world({
        routes: twoItems({ description: 'A' }, { description: 'B' }),
        robots: (url) =>
          url === detailUrl('a')
            ? { verdict, reason: 'X', crawlDelaySeconds: null, aiInput: 'yes' }
            : allowed(),
      })
      const { p } = provider(w)
      const r = await p.collectHtml(config(), w.ctx)
      expect(w.sent).toEqual([page1, detailUrl('b')])
      expect(w.reserved).toHaveLength(2)
      expect(r.detail).toMatchObject({ status: 'PARTIAL', policyDenied: 1, fetched: 1 })
      expect(r.enrichments.map((e) => e.id)).toEqual(['b'])
    },
  )

  it('every detail denied is a POLICY_BLOCKED detail stage; discovery stands', async () => {
    const w = world({
      routes: twoItems(),
      robots: (url) =>
        url.includes('/jobs/')
          ? { verdict: 'DENIED', reason: 'X', crawlDelaySeconds: null, aiInput: 'yes' }
          : allowed(),
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.detail).toMatchObject({ status: 'POLICY_BLOCKED', policyDenied: 2 })
    expect(r.discovery.status).toBe('COMPLETE')
    expect(r.batch.observations).toHaveLength(2)
  })

  it('a later listing page denied by robots is refused before it is fetched', async () => {
    const page2 = `${BASE}/list?page=2&after=c2`
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a', 'https://o.example/a')], 'c2') } },
      robots: (url) =>
        url === page2
          ? {
              verdict: 'DENIED',
              reason: 'DISALLOWED_BY_ROBOTS',
              crawlDelaySeconds: null,
              aiInput: 'yes',
            }
          : allowed(),
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', stop: 'ACCESS_POLICY' })
    expect(r.batch.requests[1]?.error?.message).toBe('html request refused: DISALLOWED_BY_ROBOTS')
  })

  it('a later listing page refused without a reason reports its verdict', async () => {
    const page2 = `${BASE}/list?page=2&after=c2`
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a', 'https://o.example/a')], 'c2') } },
      robots: (url) =>
        url === page2
          ? { verdict: 'PAUSED', reason: null, crawlDelaySeconds: null, aiInput: 'yes' }
          : allowed(),
    })
    const { p } = provider(w)
    const r = await p.collectHtml(config(), w.ctx)
    expect(r.batch.requests[1]?.error?.message).toBe('html request refused: PAUSED')
  })

  it('asks the host gate for 3 s, or for a larger Crawl-delay, per origin', async () => {
    const w = world({
      routes: twoItems(),
      robots: (url) => (url === detailUrl('b') ? allowed(10) : allowed(1)),
    })
    const { p, acquired } = provider(w)
    await p.collectHtml(config(), w.ctx)
    expect(acquired).toEqual([
      { origin: BASE, gap: 3_000 },
      { origin: BASE, gap: 3_000 },
      { origin: BASE, gap: 10_000 },
    ])
  })

  it('the host gap is real: on a fake clock every request after the first waits', async () => {
    let clock = 0
    const sleeps: number[] = []
    const hostGate = new InMemoryHostGate(
      () => clock,
      async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    )
    const w = world({
      routes: twoItems(),
      robots: (url) => (url === detailUrl('b') ? allowed(7) : allowed()),
    })
    const { p } = provider(w, { hostGate })
    await p.collectHtml(config(), w.ctx)
    expect(sleeps).toEqual([3_000, 3_000])
    expect(clock).toBe(6_000)
  })
})

// ---------------------------------------------------------------------------
// AC5 — enrichment state
// ---------------------------------------------------------------------------

describe('AC5 enrichment state: reuse, invalidation, resume, failures', () => {
  const later = new Date(NOW.getTime() + 73 * 60 * 60 * 1000)

  it('records attempted/succeeded/next-due/hash/parser version per item', async () => {
    const w = world({ routes: twoItems({ description: 'A' }) })
    const { p, enrichment } = provider(w)
    await p.collectHtml(config(), w.ctx)
    const rec = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
    expect(rec).toEqual({
      attempts: 1,
      lastAttemptAt: NOW,
      succeededAt: NOW,
      error: null,
      nextDueAt: new Date(NOW.getTime() + 72 * 60 * 60 * 1000),
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      validator: null,
      parserVersion: 'p1',
      policyVersion: 1,
    })
  })

  it('an item not yet due is not fetched again', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({ routes: twoItems() })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const second = world({ routes: twoItems(), now: new Date(NOW.getTime() + 1000) })
    const r = await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(second.sent).toEqual([page1])
    expect(r.detail).toMatchObject({ status: 'COMPLETE', notDue: 2, fetched: 0 })
  })

  it('is due again exactly at next-due', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({ routes: twoItems() })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const at = new Date(NOW.getTime() + 72 * 60 * 60 * 1000)
    const second = world({ routes: twoItems(), now: at })
    const r = await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(r.detail.notDue).toBe(0)
    expect(r.detail.unchanged).toBe(2)
  })

  it('unchanged content (same hash) is reused without reparsing', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({ routes: twoItems({ description: 'A' }) })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const parseDetail = vi.fn(jsonStrategy.parseDetail)
    const second = world({ routes: twoItems({ description: 'A' }), now: later })
    const r = await provider(second, {
      enrichment,
      strategy: { ...jsonStrategy, parseDetail },
    }).p.collectHtml(config(), second.ctx)
    expect(parseDetail).not.toHaveBeenCalled()
    expect(r.detail).toMatchObject({ unchanged: 2, fetched: 0, status: 'COMPLETE' })
    expect(r.enrichments).toEqual([])
    const rec = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
    expect(rec).toMatchObject({ attempts: 2, succeededAt: later, lastAttemptAt: later })
  })

  it('a matching validator (ETag) is reused even when the body differs', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const routes = (body: string) => ({
      [page1]: { bodyText: listing([item('a')]) },
      [detailUrl('a')]: { bodyText: body, etag: '"v1"' },
    })
    const first = world({ routes: routes(detail({ description: 'A' })) })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const second = world({ routes: routes(detail({ description: 'A2' })), now: later })
    const r = await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(r.detail.unchanged).toBe(1)
    const rec = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
    expect(rec?.validator).toBe('"v1"')
  })

  it('a conditional 304 is unchanged content and keeps the stored validator and hash', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({
      routes: {
        [page1]: { bodyText: listing([item('a')]) },
        [detailUrl('a')]: { bodyText: detail({ description: 'A' }), etag: '"v1"' },
      },
    })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const key = JSON.stringify(['THEHUB_HTML', 'board', 'a'])
    const before = await enrichment.get(key)
    const second = world({
      routes: {
        [page1]: { bodyText: listing([item('a')]) },
        [detailUrl('a')]: { status: 304, bodyText: '', conditional: true },
      },
      now: later,
    })
    const r = await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(r.detail.unchanged).toBe(1)
    const after = await enrichment.get(key)
    expect(after?.contentHash).toBe(before?.contentHash)
    expect(after?.validator).toBe('"v1"')
  })

  it('an unasked-for 304 is a failure, not unchanged content', async () => {
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a')]) }, [detailUrl('a')]: { status: 304 } },
    })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ failed: 1, unchanged: 0 })
  })

  it('changed content is reparsed and its new hash stored', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({ routes: twoItems({ description: 'A' }) })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const key = JSON.stringify(['THEHUB_HTML', 'board', 'a'])
    const before = await enrichment.get(key)
    const second = world({ routes: twoItems({ description: 'A2' }), now: later })
    const r = await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(r.detail).toMatchObject({ fetched: 1, unchanged: 1 })
    expect(r.enrichments[0]?.fields).toEqual({ description: 'A2' })
    expect((await enrichment.get(key))?.contentHash).not.toBe(before?.contentHash)
  })

  it.each([
    ['parser version', { parserVersion: 'p2' }, 1],
    ['policy version', {}, 2],
  ])(
    'a %s change invalidates the cache, even before next-due',
    async (_n, extra, policyVersion) => {
      const enrichment = new InMemoryEnrichmentState()
      const first = world({ routes: twoItems({ description: 'A' }) })
      await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
      const second = world({ routes: twoItems({ description: 'A' }), policyVersion })
      const r = await provider(second, { enrichment, ...extra }).p.collectHtml(config(), second.ctx)
      expect(r.detail).toMatchObject({ fetched: 2, notDue: 0, unchanged: 0 })
      const rec = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
      expect(rec).toMatchObject({ parserVersion: extra.parserVersion ?? 'p1', policyVersion })
    },
  )

  it('exhaustion checkpoints the remaining items, and the next attempt resumes from them only', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const routes = {
      [page1]: { bodyText: listing(['a', 'b', 'c', 'd'].map((id) => item(id))) },
      ...Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((id) => [detailUrl(id), { bodyText: detail({}) }]),
      ),
    }
    const first = world({ routes })
    const r1 = await provider(first, { enrichment, limits: { maxDetails: 2 } }).p.collectHtml(
      config(),
      first.ctx,
    )
    expect(r1.detail).toMatchObject({
      status: 'PARTIAL',
      fetched: 2,
      stop: 'DETAIL_QUOTA',
      checkpoint: { reason: 'DETAIL_QUOTA', remainingIds: ['c', 'd'] },
    })
    expect(r1.batch.outcome).toBe('SUCCEEDED')
    const second = world({ routes })
    const r2 = await provider(second, { enrichment, limits: { maxDetails: 2 } }).p.collectHtml(
      config(),
      second.ctx,
    )
    expect(second.sent).toEqual([page1, detailUrl('c'), detailUrl('d')])
    expect(r2.detail).toMatchObject({ status: 'COMPLETE', fetched: 2, notDue: 2, checkpoint: null })
  })

  it('a detail failure is recorded with a retry due date and leaves discovery intact', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a'), item('b')]) },
        [detailUrl('a')]: { status: 500, bodyText: 'oops' },
        [detailUrl('b')]: { status: 404 },
      },
    })
    const r = await provider(w, { enrichment }).p.collectHtml(config(), w.ctx)
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.batch.observations).toHaveLength(2)
    expect(r.discovery.status).toBe('COMPLETE')
    expect(r.detail).toMatchObject({ status: 'PARTIAL', failed: 2, fetched: 0 })
    const recA = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
    expect(recA).toEqual({
      attempts: 1,
      lastAttemptAt: NOW,
      succeededAt: null,
      error: 'HTTP_500',
      nextDueAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
      contentHash: null,
      validator: null,
      parserVersion: 'p1',
      policyVersion: 1,
    })
    const recB = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'b']))
    expect(recB?.error).toBe('HTTP_404')
  })

  it('a failure after a success keeps the earlier success, hash and versions', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const first = world({ routes: twoItems({ description: 'A' }) })
    await provider(first, { enrichment }).p.collectHtml(config(), first.ctx)
    const key = JSON.stringify(['THEHUB_HTML', 'board', 'a'])
    const before = await enrichment.get(key)
    const second = world({
      routes: { ...twoItems(), [detailUrl('a')]: { status: 503 } },
      now: later,
    })
    await provider(second, { enrichment }).p.collectHtml(config(), second.ctx)
    expect(await enrichment.get(key)).toEqual({
      ...before,
      attempts: 2,
      lastAttemptAt: later,
      error: 'HTTP_503',
      nextDueAt: new Date(later.getTime() + 6 * 60 * 60 * 1000),
    })
  })

  it('accepts a 2xx at both ends of the range', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a'), item('b')]) },
        [detailUrl('a')]: { status: 200, bodyText: detail({}) },
        [detailUrl('b')]: { status: 299, bodyText: detail({}) },
      },
    })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ fetched: 2, failed: 0 })
  })

  it('refuses a 1xx/3xx detail answer', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a'), item('b')]) },
        [detailUrl('a')]: { status: 199 },
        [detailUrl('b')]: { status: 300 },
      },
    })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ fetched: 0, failed: 2 })
  })

  it('a detail page the parser throws on is PARSE_DRIFT, retried later, success kept', async () => {
    const enrichment = new InMemoryEnrichmentState()
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a')]) }, [detailUrl('a')]: { bodyText: '<x' } },
    })
    const r = await provider(w, { enrichment }).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ failed: 1, fetched: 0, status: 'PARTIAL' })
    expect(r.enrichments).toEqual([])
    const rec = await enrichment.get(JSON.stringify(['THEHUB_HTML', 'board', 'a']))
    expect(rec).toMatchObject({
      error: 'PARSE_DRIFT',
      succeededAt: null,
      nextDueAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
      attempts: 1,
    })
  })

  it('drops null and undefined detail fields so "absent" has one spelling', async () => {
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')]) },
        [detailUrl('a')]: {
          bodyText: JSON.stringify({ description: 'D', location: null, remote: false }),
        },
      },
    })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.enrichments[0]?.fields).toEqual({ description: 'D', remote: false })
    expect(r.enrichments[0]?.methods).toEqual({ description: 'DETAIL_HTML', remote: 'DETAIL_HTML' })
  })
})

// ---------------------------------------------------------------------------
// AC6 — the model is optional
// ---------------------------------------------------------------------------

const policy = { onUnspecified: 'block' as const }

describe('AC6 Stage C is optional and never closes or fails discovery', () => {
  it('without a structurer, A and B complete and C is SKIPPED', async () => {
    const w = world({ routes: twoItems() })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail.status).toBe('COMPLETE')
    expect(r.model).toEqual({
      method: 'MODEL',
      status: 'SKIPPED',
      reason: 'NOT_CONFIGURED',
      requested: 0,
      applied: 0,
      falseIdentity: 0,
      remainingIds: [],
    })
  })

  it('is not called when B recovered every fillable field', async () => {
    const full = { description: 'D', location: 'L', employmentType: 'FT', remote: true }
    const s = fakeStructurer(new Error('must not be called'))
    const w = world({ routes: twoItems(full, full) })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(s.calls).toEqual([])
    expect(r.model).toMatchObject({ status: 'SKIPPED', reason: 'NOTHING_TO_FILL' })
  })

  it('fills only the gaps B left, with MODEL method and evidence; drops a false identity', async () => {
    const s = fakeStructurer({
      kind: 'EXTRACTED',
      extractionVersion: 'p1',
      perRecordIssues: [],
      records: [
        modelRecord('a', {
          description: 'model desc',
          location: 'model loc',
          remote: true,
          evidence: [
            { field: 'location', quote: 'Kyiv' },
            { field: 'description', quote: 'nope' },
          ],
        }),
        modelRecord('a', { employmentType: 'second record ignored' }),
        modelRecord('zzz', { description: 'invented' }),
      ],
    })
    const w = world({
      routes: {
        [page1]: { bodyText: listing([item('a')]) },
        [detailUrl('a')]: { bodyText: detail({ description: 'deterministic' }) },
      },
    })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({
      aiInput: 'yes',
      policy,
      extractionVersion: 'p1',
      records: [{ id: 'a', url: detailUrl('a'), text: detail({ description: 'deterministic' }) }],
    })
    expect(s.calls[0]?.signal).toBe(w.ctx.signal)
    expect(r.enrichments).toEqual([
      {
        id: 'a',
        fields: { description: 'deterministic', location: 'model loc', remote: true },
        methods: { description: 'DETAIL_HTML', location: 'MODEL', remote: 'MODEL' },
        evidence: [{ field: 'location', quote: 'Kyiv' }],
      },
    ])
    expect(r.model).toEqual({
      method: 'MODEL',
      status: 'COMPLETE',
      reason: null,
      requested: 1,
      applied: 1,
      falseIdentity: 1,
      remainingIds: [],
    })
    expect(w.sent).not.toContain('https://jobs.example/zzz')
  })

  it('a model record that fills nothing is not counted as applied', async () => {
    const s = fakeStructurer({
      kind: 'EXTRACTED',
      extractionVersion: 'p1',
      perRecordIssues: [],
      records: [modelRecord('a')],
    })
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a')]) }, [detailUrl('a')]: { bodyText: '{}' } },
    })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(r.model.applied).toBe(0)
    expect(r.enrichments[0]?.methods).toEqual({})
  })

  it.each([
    [['yes', 'no'], 'no'],
    [['yes', 'unspecified'], 'unspecified'],
    [['unspecified', 'no'], 'no'],
    [['yes', 'yes'], 'yes'],
  ] as const)('sends the strictest ai-input signal of %j: %s', async (signals, expected) => {
    const s = fakeStructurer({ kind: 'SKIPPED_AI_INPUT_NO' })
    const w = world({
      routes: twoItems(),
      robots: (url) => ({
        ...allowed(),
        aiInput: url === detailUrl('a') ? signals[0] : url === detailUrl('b') ? signals[1] : 'yes',
      }),
    })
    await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(s.calls[0]?.aiInput).toBe(expected)
  })

  it.each([
    [
      {
        kind: 'BUDGET_EXHAUSTED',
        cause: 'CYCLE_LIMIT',
        remainingIds: ['a', 'b'],
        perRecordIssues: [],
      },
      'FAILED',
      ['a', 'b'],
    ],
    [
      {
        kind: 'MODEL_UNAVAILABLE',
        code: 'NOT_CONFIGURED',
        remainingIds: ['a'],
        perRecordIssues: [],
      },
      'FAILED',
      ['a'],
    ],
    [{ kind: 'SKIPPED_AI_INPUT_NO' }, 'SKIPPED', []],
    [{ kind: 'SKIPPED_AI_INPUT_UNSPECIFIED' }, 'SKIPPED', []],
  ] as const)('%j never fails the run or touches discovery', async (outcome, status, remaining) => {
    const s = fakeStructurer(outcome as StructurerOutcome)
    const w = world({ routes: twoItems({ title: 'T' }) })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.batch.observations).toHaveLength(2)
    expect(r.detail.status).toBe('COMPLETE')
    expect(r.enrichments[0]?.fields).toEqual({ title: 'T' })
    expect(r.model).toEqual({
      method: 'MODEL',
      status,
      reason: outcome.kind,
      requested: 2,
      applied: 0,
      falseIdentity: 0,
      remainingIds: remaining,
    })
  })

  it('a PARTIAL model outcome applies what it has and reports the rest', async () => {
    const s = fakeStructurer({
      kind: 'PARTIAL',
      extractionVersion: 'p1',
      perRecordIssues: [],
      records: [modelRecord('a', { employmentType: 'FT' })],
      remainingIds: ['b'],
      stoppedBy: { kind: 'BUDGET_EXHAUSTED', cause: 'RATE_LIMITED' },
    })
    const w = world({ routes: twoItems() })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(r.model).toEqual({
      method: 'MODEL',
      status: 'PARTIAL',
      reason: 'BUDGET_EXHAUSTED',
      requested: 2,
      applied: 1,
      falseIdentity: 0,
      remainingIds: ['b'],
    })
    expect(r.enrichments.find((e) => e.id === 'a')?.fields).toEqual({ employmentType: 'FT' })
  })

  it('a throwing structurer is a FAILED model stage, not a failed run', async () => {
    const s = fakeStructurer(new Error('endpoint exploded'))
    const w = world({ routes: twoItems() })
    const r = await provider(w, { model: { structurer: s, policy } }).p.collectHtml(config(), w.ctx)
    expect(r.batch.outcome).toBe('SUCCEEDED')
    expect(r.model).toEqual({
      method: 'MODEL',
      status: 'FAILED',
      reason: 'PORT_THREW',
      requested: 2,
      applied: 0,
      falseIdentity: 0,
      remainingIds: [],
    })
  })
})

// ---------------------------------------------------------------------------
// AC7 — metering and aggregate caps
// ---------------------------------------------------------------------------

describe('AC7 every subrequest is metered; aggregate caps stop with a checkpoint', () => {
  it('reserves, marks sent and reconciles USED for every listing and detail request', async () => {
    const w = world({ routes: twoItems() })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.sent).toHaveLength(3)
    expect(w.reserved).toEqual([1, 1, 1])
    expect(w.marked).toBe(3)
    expect(w.reconciled).toEqual(['USED', 'USED', 'USED'])
    expect(r.usage).toEqual({
      requests: 3,
      bytes: Buffer.byteLength(listing([item('a'), item('b')])) + 2 * Buffer.byteLength(detail({})),
    })
  })

  it('a refused detail reservation is a COST_STOP with a checkpoint', async () => {
    const w = world({ routes: twoItems(), reserveNullAfter: 2 })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1, detailUrl('a')])
    expect(r.detail).toMatchObject({
      status: 'PARTIAL',
      stop: 'COST_STOP',
      checkpoint: { reason: 'COST_STOP', remainingIds: ['b'] },
    })
    expect(r.batch.outcome).toBe('SUCCEEDED')
  })

  it('a meter that throws on reserve stops the stage as METER_FAILED', async () => {
    const w = world({ routes: twoItems() })
    let calls = 0
    w.ctx.meter.reserve = async (unit, amount) => {
      calls += 1
      if (calls > 1) throw new Error('db down')
      return { id: 'r', unit, amount }
    }
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.detail.checkpoint).toEqual({ reason: 'METER_FAILED', remainingIds: ['a', 'b'] })
  })

  it('a markSent failure sends nothing and releases the reservation', async () => {
    const w = world({ routes: twoItems() })
    const markSent = w.ctx.meter.markSent
    let calls = 0
    w.ctx.meter.markSent = async (r) => {
      calls += 1
      if (calls > 1) throw new Error('meter down')
      return markSent(r)
    }
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(w.reconciled).toEqual(['USED', 'RELEASED'])
    expect(r.detail.checkpoint).toEqual({ reason: 'METER_FAILED', remainingIds: ['a', 'b'] })
  })

  it('a reconcile failure does not lose the attempt', async () => {
    const w = world({ routes: twoItems() })
    let calls = 0
    w.ctx.meter.reconcile = async () => {
      calls += 1
      if (calls > 1) throw new Error('meter down')
    }
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ status: 'COMPLETE', fetched: 2 })
  })

  it('a context refusal during a detail fetch stops the stage with its code; the reservation is UNCERTAIN', async () => {
    const fenced = Object.assign(new Error('fenced'), { code: 'RUN_FENCED' })
    const w = world({ routes: { ...twoItems(), [detailUrl('a')]: { throws: fenced } } })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.reconciled).toEqual(['USED', 'UNCERTAIN'])
    expect(r.detail.checkpoint).toEqual({ reason: 'RUN_FENCED', remainingIds: ['a', 'b'] })
    expect(r.batch.observations).toHaveLength(2)
  })

  it('an uncoded network error during a detail fetch is TRANSIENT_NETWORK', async () => {
    const w = world({ routes: { ...twoItems(), [detailUrl('a')]: { throws: new Error('reset') } } })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail.stop).toBe('TRANSIENT_NETWORK')
    const w2 = world({ routes: { ...twoItems(), [detailUrl('a')]: { throws: null } } })
    w2.ctx.fetchText = async (req) => {
      w2.sent.push(req.url)
      if (req.url === detailUrl('a')) throw null
      return { status: 200, bodyText: listing([item('a'), item('b')]), headers: {}, etag: null }
    }
    const r2 = await provider(w2).p.collectHtml(config(), w2.ctx)
    expect(r2.detail.stop).toBe('TRANSIENT_NETWORK')
  })

  it('the aggregate byte budget stops detail fetching with a checkpoint', async () => {
    const body = listing([item('a'), item('b')])
    const w = world({ routes: twoItems({ description: 'x'.repeat(50) }) })
    const r = await provider(w, {
      limits: { maxTotalBytes: Buffer.byteLength(body) + 10 },
    }).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1, detailUrl('a')])
    expect(r.detail.checkpoint).toEqual({ reason: 'BYTE_BUDGET', remainingIds: ['b'] })
  })

  it('caps every request at the bytes that remain', async () => {
    const seen: (number | undefined)[] = []
    const w = world({ routes: twoItems() })
    const inner = w.ctx.fetchText
    w.ctx.fetchText = async (req) => {
      seen.push(req.maxBytes)
      return inner(req)
    }
    const listingBytes = Buffer.byteLength(listing([item('a'), item('b')]))
    await provider(w, {
      limits: { maxTotalBytes: 5_000, maxListingBytes: 9_000, maxDetailBytes: 100 },
    }).p.collectHtml(config(), w.ctx)
    expect(seen).toEqual([5_000, 100, 100])
    expect(listingBytes).toBeLessThan(4_900)
  })

  it('caps a listing request with no own cap at the bytes that remain', async () => {
    const seen: (number | undefined)[] = []
    const w = world({ routes: twoItems() })
    const inner = w.ctx.fetchText
    w.ctx.fetchText = async (req) => {
      seen.push(req.maxBytes)
      return inner(req)
    }
    await provider(w, { limits: { maxTotalBytes: 3_000 } }).p.collectHtml(config(), w.ctx)
    expect(seen[0]).toBe(3_000)
  })

  it('a listing request after the byte budget is spent is a COST_STOP before any fetch', async () => {
    const first = listing([item('a', 'https://o.example/a')], 'c2')
    const w = world({ routes: { [page1]: { bodyText: first } } })
    const r = await provider(w, {
      limits: { maxTotalBytes: Buffer.byteLength(first) },
    }).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.discovery).toMatchObject({ status: 'PARTIAL', stop: 'COST_STOP' })
  })

  it('a detail page over its byte cap fails that item', async () => {
    const w = world({ routes: twoItems({ description: 'x'.repeat(200) }) })
    const r = await provider(w, { limits: { maxDetailBytes: 50 } }).p.collectHtml(config(), w.ctx)
    expect(r.detail).toMatchObject({ failed: 1, fetched: 1 })
  })

  it('accepts a detail page exactly at its byte cap', async () => {
    const body = detail({ description: 'D' })
    const w = world({
      routes: { [page1]: { bodyText: listing([item('a')]) }, [detailUrl('a')]: { bodyText: body } },
    })
    const r = await provider(w, {
      limits: { maxDetailBytes: Buffer.byteLength(body) },
    }).p.collectHtml(config(), w.ctx)
    expect(r.detail.fetched).toBe(1)
  })

  it('a passed deadline stops before the first detail request', async () => {
    const w = world({ routes: twoItems(), deadline: new Date(NOW.getTime() + 1) })
    const listingOnly = world({ routes: twoItems(), deadline: NOW })
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(r.detail.fetched).toBe(2)
    const r2 = await provider(listingOnly).p.collectHtml(config(), listingOnly.ctx)
    expect(listingOnly.sent).toEqual([])
    expect(r2.detail.status).toBe('SKIPPED')
    let now = NOW
    const w3 = world({ routes: twoItems() })
    w3.ctx.deadline = new Date(NOW.getTime() + 10)
    w3.ctx.now = () => now
    const inner = w3.ctx.fetchText
    w3.ctx.fetchText = async (req) => {
      const res = await inner(req)
      now = new Date(NOW.getTime() + 10)
      return res
    }
    const r3 = await provider(w3).p.collectHtml(config(), w3.ctx)
    expect(w3.sent).toEqual([page1])
    expect(r3.detail.checkpoint).toEqual({ reason: 'DEADLINE', remainingIds: ['a', 'b'] })
  })

  it('an aborted run stops detail fetching as CANCELLED', async () => {
    const controller = new AbortController()
    const w = world({ routes: twoItems() })
    w.ctx.signal = controller.signal
    const inner = w.ctx.fetchText
    w.ctx.fetchText = async (req) => {
      const res = await inner(req)
      controller.abort()
      return res
    }
    const r = await provider(w).p.collectHtml(config(), w.ctx)
    expect(w.sent).toEqual([page1])
    expect(r.detail.checkpoint).toEqual({ reason: 'CANCELLED', remainingIds: ['a', 'b'] })
  })
})
