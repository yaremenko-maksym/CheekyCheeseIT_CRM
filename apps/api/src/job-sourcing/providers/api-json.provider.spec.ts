import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AdapterIdentityCollisionError } from './api-json.provider'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  DEFAULT_OVERLAP_MS,
  defineApiJsonProvider,
} from './api-json.provider'
import { DEFAULT_API_JSON_LIMITS } from './api-json.limits'
import {
  type CollectionContext,
  type FetchRequest,
  markValidated,
  type MeterReservation,
  REDACTED,
  type ReservationResolution,
  type SourceConfigFields,
  type ValidatedCheckpoint,
} from './reporting-provider'

/**
 * The collection loop, exercised through the interface the ~25 phase-3 adapters use. The context
 * is a set of fakes because every dependency is a port by design; nothing here reaches behind the
 * seam, and nothing constructs a `CollectionBatch` by hand.
 *
 * `.resolves`, never `.rejects.not.toThrow` — the plan says so explicitly, and the second form
 * passes for a promise that rejects with the wrong error as readily as for one that resolves.
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  url: z.string(),
})
type Item = z.infer<typeof itemSchema>

const envelopeSchema = z.object({
  /** OPAQUE on purpose: a bad item must be isolated, not fail the page. */
  jobs: z.array(z.unknown()),
  next: z.string().nullable(),
})
type Envelope = z.infer<typeof envelopeSchema>

function job(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    title: `Senior Engineer ${id}`,
    company: `Studio ${id}`,
    url: `https://jobs.example.com/j/${id}`,
    ...overrides,
  }
}

function makeSpec(
  overrides: Partial<ApiJsonSourceSpec<Config, Envelope, Item>> = {},
): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'REMOTEOK_API',
    adapterVersion: 'test-1',
    configSchema,
    envelopeSchema,
    itemSchema,
    pageRequest: (config, at) => ({
      request: { url: `https://api.example.com/jobs?page=${at.cursor ?? String(at.page)}` },
      cacheKey: `p${at.page}`,
    }),
    extractItems: (envelope) => envelope.jobs,
    nextCursor: (envelope) => envelope.next,
    mapItem: (item, config) => ({
      namespace: config.namespace,
      nativeId: item.id,
      url: item.url,
      title: item.title,
      companyName: item.company,
    }),
    scopeOf: (config) => ({
      namespace: config.namespace,
      query: config.query,
      configVersion: config.configVersion,
      window: config.window,
    }),
    limits: { maxPages: 5 },
    ...overrides,
  }
}

function config(overrides: Partial<SourceConfigFields> = {}): Config {
  return configSchema.parse({ namespace: 'board', configVersion: 1, ...overrides })
}

interface PageResponse {
  status?: number
  body?: unknown
  bodyText?: string
  etag?: string | null
  throws?: unknown
}

interface Harness {
  ctx: CollectionContext
  calls: string[]
  reconciles: Array<{ id: string; resolution: ReservationResolution }>
  saved: ValidatedCheckpoint[]
  /** Every outgoing request, so the conditional-request header can be asserted. */
  sent: FetchRequest[]
  cache: Map<string, { etag: string; bodyText: string }>
}

function harness(opts: {
  pages: PageResponse[]
  stored?: ValidatedCheckpoint | null
  savePageFailsOnPage?: number
  /** Thrown instead of an Error, to exercise the non-Error branch of every catch. */
  savePageThrows?: unknown
  reserveRefusesOnCall?: number
  aborted?: boolean
  /** Abort DURING the fetch, so the in-flight cancellation path is reached rather than the
   * pre-request check. */
  abortOnFetch?: number
  now?: Date
  deadline?: Date
  secrets?: string[]
  cacheSeed?: Record<string, { etag: string; bodyText: string }>
  policyVersion?: number
}): Harness {
  const calls: string[] = []
  const sent: FetchRequest[] = []
  const reconciles: Array<{ id: string; resolution: ReservationResolution }> = []
  const saved: ValidatedCheckpoint[] = []
  const cache = new Map(Object.entries(opts.cacheSeed ?? {}))
  const controller = new AbortController()
  if (opts.aborted === true) controller.abort()
  let fetches = 0
  let reserves = 0

  const ctx: CollectionContext = {
    run: { sourceId: 's', cycleId: 'c', attemptId: 'a', fencingEpoch: 1 },
    policyVersion: opts.policyVersion ?? 1,
    signal: controller.signal,
    deadline: opts.deadline ?? new Date('2030-01-01T00:00:00Z'),
    now: () => opts.now ?? new Date('2026-10-20T10:00:00Z'),
    secrets: opts.secrets ?? [],
    async fetchText(request) {
      const page = opts.pages[fetches]
      fetches += 1
      sent.push(request)
      calls.push(`fetch:${fetches}`)
      if (opts.abortOnFetch === fetches) {
        controller.abort()
        throw new Error('aborted')
      }
      if (page === undefined) throw new Error(`no fake response for fetch ${fetches}`)
      if (page.throws !== undefined) throw page.throws
      return {
        status: page.status ?? 200,
        bodyText: page.bodyText ?? JSON.stringify(page.body ?? { jobs: [], next: null }),
        headers: {},
        etag: page.etag ?? null,
      }
    },
    meter: {
      async reserve(unit, amount): Promise<MeterReservation | null> {
        reserves += 1
        calls.push(`reserve:${reserves}`)
        if (opts.reserveRefusesOnCall === reserves) return null
        return { id: `r${reserves}`, unit, amount }
      },
      async reconcile(reservation, resolution) {
        calls.push(`reconcile:${resolution}`)
        reconciles.push({ id: reservation.id, resolution })
      },
    },
    checkpoints: {
      async load() {
        calls.push('load')
        return opts.stored ?? null
      },
      async savePage({ checkpoint }) {
        calls.push(`save:${checkpoint.page}`)
        if (opts.savePageFailsOnPage === checkpoint.page) {
          if (opts.savePageThrows !== undefined) throw opts.savePageThrows
          throw new Error('deadlock detected')
        }
        saved.push(checkpoint)
      },
    },
    cache: {
      async get(key) {
        calls.push(`cache.get:${String(key)}`)
        return cache.get(key) ?? null
      },
      async put(key, value) {
        cache.set(key, value)
      },
    },
  }

  return { ctx, calls, reconciles, saved, sent, cache }
}

const onePage = (jobs: unknown[]) => ({ body: { jobs, next: null } })

// ---------------------------------------------------------------------------

describe('the envelope', () => {
  it('collects a valid single-page envelope and claims the full inventory', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.observations).toHaveLength(2)
    expect(batch.counts).toEqual({ raw: 2, normalized: 2, invalid: 0, quarantined: 0 })
  })

  it('fails the subrequest on a drifted envelope and claims nothing', async () => {
    const h = harness({ pages: [{ body: { postings: [] } }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('fails the subrequest when the body is not JSON at all', async () => {
    const h = harness({ pages: [{ bodyText: '<html>blocked</html>' }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.outcome).toBe('FAILED')
  })

  it('treats a valid EMPTY envelope as a success with the full inventory', async () => {
    const h = harness({ pages: [onePage([])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts.raw).toBe(0)
  })

  it('refuses a payload nested past the JSON depth bound as PAYLOAD_TOO_LARGE, not drift', async () => {
    const deep = '['.repeat(200) + '1' + ']'.repeat(200)
    const h = harness({ pages: [{ bodyText: `{"jobs":[],"next":null,"x":${deep}}` }] })
    const batch = await collectJsonPages(makeSpec({ limits: { maxDepth: 8 } }), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('bad items are isolated, not fatal', () => {
  it('keeps the good items when one fails the item schema', async () => {
    const h = harness({ pages: [onePage([job('1'), { id: '2' }, job('3')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(2)
    expect(batch.counts).toEqual({ raw: 3, normalized: 2, invalid: 1, quarantined: 0 })
  })

  it('loses the FULL_INVENTORY claim over a single unobservable item', async () => {
    const h = harness({ pages: [onePage([job('1'), { id: '2' }])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('isolates an extractor exception as one bad item', async () => {
    const spec = makeSpec({
      mapItem: (item, cfg) => {
        if (item.id === '2') throw new Error('unexpected salary shape')
        return {
          namespace: cfg.namespace,
          nativeId: item.id,
          url: item.url,
          title: item.title,
          companyName: item.company,
        }
      },
    })
    const h = harness({ pages: [onePage([job('1'), job('2'), job('3')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.counts).toEqual({ raw: 3, normalized: 2, invalid: 1, quarantined: 0 })
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      expect.stringContaining('MAPPER_THREW'),
    ])
  })

  it('counts an item the identity seam refused as QUARANTINED, not invalid', async () => {
    const h = harness({
      pages: [onePage([job('1'), job('2', { url: 'http://jobs.example.com/j/2' })])],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts).toEqual({ raw: 2, normalized: 1, invalid: 0, quarantined: 1 })
    expect(batch.invalidSamples[0]?.reason).toContain('QUARANTINED')
  })

  it('bounds the samples it keeps, however many items were refused', async () => {
    const bad = Array.from({ length: 40 }, (_, i) => ({ id: String(i) }))
    const h = harness({ pages: [onePage(bad)] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.invalid).toBe(40)
    expect(batch.invalidSamples).toHaveLength(5)
  })

  it('refuses a page carrying more items than the cap, rather than truncating it silently', async () => {
    const spec = makeSpec({ limits: { maxItemsPerPage: 2, maxPages: 5 } })
    const atCap = harness({ pages: [onePage([job('1'), job('2')])] })
    await expect(collectJsonPages(spec, config(), atCap.ctx)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    })

    const pastCap = harness({ pages: [onePage([job('1'), job('2'), job('3')])] })
    const batch = await collectJsonPages(spec, config(), pastCap.ctx)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.outcome).toBe('FAILED')
  })
})

/**
 * THE OPEN DECISION CARRIED IN FROM TASK 2.1, pinned at this seam so it is visible rather than
 * inherited silently.
 *
 * The stored-link policy (`normalize/url-policy.ts`) refuses IP literals but accepts internal
 * hosts BY NAME — `localhost`, `*.localhost`, `metadata.google.internal`. Task 2.2's egress policy
 * runs at FETCH time and never sees a stored link that is later rendered or fetched by the
 * autosubmit path, so nothing between a hostile provider and a stored
 * `https://metadata.google.internal/...` says no.
 *
 * MY CALL: the fix belongs in `url-policy.ts`, as ONE rule in ONE place, and not here — a second
 * link policy at this seam would be the parallel-vocabulary defect this task exists to avoid. The
 * rule I recommend is structural rather than a denylist (`localhost`, `metadata.*` is the
 * allowlist-vs-denylist mistake again): refuse a single-label host, and refuse the RFC 6761 /
 * RFC 8375 special-use suffixes `.localhost .local .internal .home.arpa .test .example .invalid`,
 * which is a closed standards-derived set and which `metadata.google.internal` falls under.
 *
 * It is NOT mine to apply: it changes behaviour that merged with #1065 and the test that pins it,
 * on a security surface (an SSRF / cloud-metadata credential path), so it is an A2 question for
 * the owner, in my report, not an A1 edit. What is mine is that it is written down at both seams.
 */
describe('internal hostnames — today`s behaviour, pinned', () => {
  it('stores a link to an internal host rather than quarantining it', async () => {
    const h = harness({
      pages: [onePage([job('1', { url: 'https://metadata.google.internal/j/1' })])],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.quarantined).toBe(0)
    expect(batch.observations[0]?.sourcePostingUrl).toBe('https://metadata.google.internal/j/1')
  })

  it('does quarantine the IP literal form of the same host', async () => {
    const h = harness({ pages: [onePage([job('1', { url: 'https://169.254.169.254/j/1' })])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.quarantined).toBe(1)
    expect(batch.observations).toEqual([])
  })
})

describe('a database failure is not a bad record', () => {
  it('reports PERSISTENCE and leaves the invalid count at zero', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2')])], savePageFailsOnPage: 1 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.counts.invalid).toBe(0)
    expect(batch.counts.quarantined).toBe(0)
    expect(batch.counts.normalized).toBe(2)
    expect(batch.outcome).toBe('FAILED')
  })

  it('does not report observations whose page never landed', async () => {
    const h = harness({ pages: [onePage([job('1')])], savePageFailsOnPage: 1 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.observations).toEqual([])
    expect(batch.checkpoint).toBeNull()
  })

  it('keeps the pages that DID land when a later page fails to persist', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
      savePageFailsOnPage: 2,
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
    expect(batch.checkpoint?.page).toBe(1)
  })
})

describe('stops preserve completed work', () => {
  it.each([
    [429, 'RATE_LIMIT'],
    [403, 'ACCESS_POLICY'],
    [401, 'ACCESS_POLICY'],
    [503, 'UPSTREAM'],
  ] as const)('reports %i as %s after a completed page', async (status, code) => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }, { status }],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe(code)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
    expect(batch.checkpoint?.page).toBe(1)
  })

  it('reports a network failure as TRANSIENT_NETWORK with no status', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }, { throws: new Error('socket hang up') }],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const last = batch.requests.at(-1)
    expect(last?.error?.code).toBe('TRANSIENT_NETWORK')
    expect(last?.status).toBeNull()
    expect(batch.observations).toHaveLength(1)
  })

  it('reports a cancelled run as CANCELLED and claims no coverage', async () => {
    const h = harness({ pages: [onePage([job('1')])], aborted: true })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('CANCELLED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.requests.at(-1)?.error?.code).toBe('CANCELLED')
  })

  it('stops at the deadline before issuing the request', async () => {
    const h = harness({
      pages: [onePage([job('1')])],
      now: new Date('2026-10-20T10:00:00Z'),
      deadline: new Date('2026-10-20T09:59:00Z'),
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('DEADLINE')
    expect(h.calls).not.toContain('fetch:1')
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('bounded page iteration', () => {
  const endless = Array.from({ length: 20 }, (_, i) => ({
    body: { jobs: [job(String(i))], next: `c${i + 1}` },
  }))

  it('fetches exactly maxPages pages and not one more', async () => {
    const h = harness({ pages: endless })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 3 } }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(3)
    expect(batch.observations).toHaveLength(3)
  })

  it('calls a page cap on a SEARCH scope a WINDOW', async () => {
    const h = harness({ pages: endless })
    const batch = await collectJsonPages(
      makeSpec({ limits: { maxPages: 2 } }),
      config({ query: 'golang' }),
      h.ctx,
    )

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
  })

  it('calls the SAME page cap on a full-inventory scope PARTIAL', async () => {
    const h = harness({ pages: endless })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 2 } }), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('stops when a cursor repeats, rather than looping forever', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: 'c2' } },
      ],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(2)
    expect(batch.observations).toHaveLength(2)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('stops when the provider hands back the cursor we arrived on', async () => {
    const stored: ValidatedCheckpoint = {
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'test-1',
      cursor: 'c9',
      page: 1,
      completedAt: new Date('2026-10-20T09:00:00Z'),
    }
    const h = harness({ pages: [{ body: { jobs: [job('1')], next: 'c9' } }], stored })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(1)
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('the adapter identity invariant', () => {
  /**
   * The reachable collapse: the adapter keys identity on the canonical URL while the provider was
   * issuing distinct ids all along. Two records, one key — and no ratio could tell this apart from
   * a healthy overlap, which is why there is no ratio.
   */
  const urlKeyed = makeSpec({
    mapItem: (item, cfg) => ({
      namespace: cfg.namespace,
      nativeId: null,
      url: item.url,
      title: item.title,
      companyName: item.company,
    }),
    nativeIdOf: (item) => item.id,
  })

  it('fails the batch when two distinct native ids collapse to one identity key', async () => {
    const h = harness({
      pages: [
        onePage([
          job('1', { url: 'https://jobs.example.com/j/same' }),
          job('2', { url: 'https://jobs.example.com/j/same' }),
        ]),
      ],
    })
    const batch = await collectJsonPages(urlKeyed, config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
  })

  it('names both colliding ids, so the adapter bug is actionable', async () => {
    const h = harness({
      pages: [
        onePage([
          job('alpha', { url: 'https://jobs.example.com/j/same' }),
          job('beta', { url: 'https://jobs.example.com/j/same' }),
        ]),
      ],
    })
    const batch = await collectJsonPages(urlKeyed, config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.message).toContain('alpha')
    expect(batch.requests.at(-1)?.error?.message).toContain('beta')
  })

  /**
   * The counterpart, and the reason there is NO 50 %-duplicate heuristic: a provider legitimately
   * re-listing the same posting is normal traffic, and a ratio would fire on it. Three of four
   * items here are the same record; the batch succeeds and reports all four, leaving the
   * `duplicates` disposition to the collector, which is the side that owns it.
   */
  it('succeeds with a 75 % duplicate page, because a duplicate is not a collision', async () => {
    const same = job('1')
    const h = harness({ pages: [onePage([same, same, same, job('2')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({ raw: 4, normalized: 4, invalid: 0, quarantined: 0 })
    expect(batch.observations).toHaveLength(4)
  })

  it('accepts the same native id repeated at the same URL', async () => {
    const h = harness({
      pages: [
        onePage([
          job('1', { url: 'https://jobs.example.com/j/x' }),
          job('1', { url: 'https://jobs.example.com/j/x' }),
        ]),
      ],
    })
    await expect(collectJsonPages(urlKeyed, config(), h.ctx)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    })
  })
})

describe('checkpoints', () => {
  const stored: ValidatedCheckpoint = {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'test-1',
    cursor: 'c3',
    page: 2,
    completedAt: new Date('2026-10-20T09:00:00Z'),
  }

  it('resumes after the last completed page', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.page).toBe(3)
    expect(batch.checkpoint?.page).toBe(3)
  })

  it('asks the provider for the stored cursor, not for page one', async () => {
    const urls: string[] = []
    const spec = makeSpec({
      pageRequest: (_c, at) => {
        urls.push(`page=${at.page},cursor=${at.cursor ?? 'none'}`)
        return { request: { url: `https://api.example.com/jobs?c=${at.cursor ?? ''}` } }
      },
    })
    const h = harness({ pages: [onePage([job('9')])], stored })
    await collectJsonPages(spec, config(), h.ctx)

    expect(urls).toEqual(['page=3,cursor=c3'])
  })

  it.each([
    ['the config moved', { configVersion: 2 }, { configVersion: 2 }],
    ['the policy moved', {}, {}],
  ] as const)('restarts discovery at page one when %s', async (_name, cfg) => {
    const h = harness({
      pages: [onePage([job('9')])],
      stored: { ...stored, configVersion: 99 },
      ...cfg,
    })
    const batch = await collectJsonPages(makeSpec(), config(cfg), h.ctx)

    expect(h.saved[0]?.page).toBe(1)
    expect(batch.checkpoint?.page).toBe(1)
  })

  it('restarts at page one when the ADAPTER version moved', async () => {
    const h = harness({
      pages: [onePage([job('9')])],
      stored: { ...stored, adapterVersion: 'old' },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.checkpoint?.page).toBe(1)
  })

  it('restarts at page one when the POLICY version moved', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored, policyVersion: 7 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.checkpoint?.page).toBe(1)
  })

  /**
   * "Restart bounded discovery WITH OVERLAP" (AC4). The widened window is the whole point: what
   * moved across the old boundary while the config changed would otherwise never be read again.
   */
  it('widens a windowed scope by the overlap on a restart', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    const h = harness({
      pages: [onePage([job('9')])],
      stored: { ...stored, configVersion: 99 },
    })
    const batch = await collectJsonPages(makeSpec(), config({ window }), h.ctx)

    expect(batch.scope.window?.from).toEqual(new Date(window.from.getTime() - DEFAULT_OVERLAP_MS))
    expect(batch.scope.window?.to).toEqual(window.to)
  })

  it('does NOT widen the window on a clean resume', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    const h = harness({ pages: [onePage([job('9')])], stored })
    const batch = await collectJsonPages(makeSpec(), config({ window }), h.ctx)

    expect(batch.scope.window?.from).toEqual(window.from)
  })

  it('honours a spec`s own overlap', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    const h = harness({ pages: [onePage([job('9')])], stored: { ...stored, configVersion: 99 } })
    const batch = await collectJsonPages(makeSpec({ overlapMs: 60_000 }), config({ window }), h.ctx)

    expect(batch.scope.window?.from).toEqual(new Date(window.from.getTime() - 60_000))
  })

  it('stamps the checkpoint with the versions that produced it', async () => {
    const h = harness({ pages: [onePage([job('1')])], policyVersion: 4 })
    const batch = await collectJsonPages(makeSpec(), config({ configVersion: 9 }), h.ctx)

    expect(batch.checkpoint).toMatchObject({
      configVersion: 9,
      policyVersion: 4,
      adapterVersion: 'test-1',
    })
  })
})

describe('the order of operations', () => {
  /**
   * Asserted as a SEQUENCE, not as a set of calls. A loop that reserved after fetching, or
   * continued to page two before page one's persist resolved, would satisfy every per-call
   * assertion and still be wrong — which is the whole claim AC4 makes.
   */
  it('reserves, fetches, persists, and only then moves on', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.calls).toEqual([
      'load',
      'reserve:1',
      'cache.get:p1',
      'fetch:1',
      'reconcile:USED',
      'save:1',
      'reserve:2',
      'cache.get:p2',
      'fetch:2',
      'reconcile:USED',
      'save:2',
    ])
  })

  it('does not fetch a page before the previous page is persisted', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.calls.indexOf('save:1')).toBeLessThan(h.calls.indexOf('fetch:2'))
  })
})

describe('cost reporting', () => {
  it('reports what a page cost in the store`s own meter units', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(
      makeSpec({ meter: { unit: 'RECORD', amountPerRequest: 25 } }),
      config(),
      h.ctx,
    )

    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 25 })
  })

  it('reports no cost for a provider that is not metered', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests[0]?.cost).toBeNull()
    expect(h.calls).not.toContain('reserve:1')
  })

  it('stops on a refused reservation and keeps the pages already persisted', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }],
      reserveRefusesOnCall: 2,
    })
    const batch = await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
  })

  it('never reaches the network when the reservation is refused', async () => {
    const h = harness({ pages: [onePage([job('1')])], reserveRefusesOnCall: 1 })
    const batch = await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.calls).not.toContain('fetch:1')
    expect(batch.outcome).toBe('FAILED')
  })

  it('holds a reservation UNCERTAIN when no response arrived — a timeout may have been billed', async () => {
    const h = harness({ pages: [{ throws: new Error('timeout') }] })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'UNCERTAIN' }])
  })

  it('reconciles USED once a response provably arrived, even a 429', async () => {
    const h = harness({ pages: [{ status: 429 }] })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
  })
})

describe('credentials never reach a report', () => {
  it('redacts a key carried in the request URL', async () => {
    const spec = makeSpec({
      pageRequest: () => ({
        request: { url: 'https://api.example.com/jobs?api_key=TOPSECRET123' },
      }),
    })
    const h = harness({ pages: [onePage([job('1')])], secrets: ['TOPSECRET123'] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.requests[0]?.url).toBe(`https://api.example.com/jobs?api_key=${REDACTED}`)
    expect(JSON.stringify(batch.requests)).not.toContain('TOPSECRET123')
  })

  it('redacts a key that an upstream error echoed back at us', async () => {
    const h = harness({
      pages: [{ throws: new Error('connect failed for api_key=TOPSECRET123') }],
      secrets: ['TOPSECRET123'],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(JSON.stringify(batch.requests)).not.toContain('TOPSECRET123')
    expect(batch.requests[0]?.error?.message).toContain(REDACTED)
  })

  it('redacts a key that reached us inside a bad item`s sample', async () => {
    const h = harness({
      pages: [onePage([{ id: 'x', token: 'TOPSECRET123' }])],
      secrets: ['TOPSECRET123'],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.invalidSamples).toHaveLength(1)
    expect(JSON.stringify(batch.invalidSamples)).not.toContain('TOPSECRET123')
  })
})

describe('conditional requests', () => {
  it('reuses the cached body on a valid 304', async () => {
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: {
        p1: { etag: 'W/"v1"', bodyText: JSON.stringify({ jobs: [job('1')], next: null }) },
      },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(1)
  })

  it('treats a 304 we never sent a validator for as drift', async () => {
    const h = harness({ pages: [{ status: 304 }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('the loop stamps provider and adapter version itself', () => {
  it('uses the spec`s values, which mapItem has no slot to override', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec({ adapterVersion: 'v42' }), config(), h.ctx)

    expect(batch.observations[0]?.adapterVersion).toBe('v42')
    expect(batch.observations[0]?.identity.provider).toBe('REMOTEOK_API')
  })
})

describe('defineApiJsonProvider', () => {
  const provider = defineApiJsonProvider(makeSpec())

  it('exposes the spec`s source type', () => {
    expect(provider.type).toBe('REMOTEOK_API')
  })

  it('validates a seed config through the adapter`s own schema', () => {
    const parsed = provider.parseConfig({ namespace: 'board', configVersion: 3 })
    expect(parsed).toMatchObject({
      namespace: 'board',
      configVersion: 3,
      query: null,
      window: null,
    })
  })

  it('refuses a config missing its version', () => {
    expect(() => provider.parseConfig({ namespace: 'board' })).toThrow()
  })

  it('refuses a config version of zero', () => {
    expect(() => provider.parseConfig({ namespace: 'b', configVersion: 0 })).toThrow()
  })

  it('refuses a namespace one character past the store`s column', () => {
    expect(() => provider.parseConfig({ namespace: 'n'.repeat(201), configVersion: 1 })).toThrow()
  })

  it('accepts a namespace of exactly the store`s column width', () => {
    expect(
      provider.parseConfig({ namespace: 'n'.repeat(200), configVersion: 1 }).namespace,
    ).toHaveLength(200)
  })

  it('collects through a config that parseConfig produced', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await expect(
      provider.collectReport(provider.parseConfig({ namespace: 'b', configVersion: 1 }), h.ctx),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' })
  })

  it('refuses a config that parseConfig never validated', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const unvalidated = { namespace: 'b', configVersion: 1, query: null, window: null }
    await expect(
      // The shape is right and the validation never happened — which is the point.
      provider.collectReport(unvalidated as ReturnType<typeof provider.parseConfig>, h.ctx),
    ).rejects.toThrow(/never validated/)
  })

  it('refuses a config whose marker was lost to a spread', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const tweaked = { ...provider.parseConfig({ namespace: 'b', configVersion: 1 }) }
    await expect(
      provider.collectReport(tweaked as ReturnType<typeof provider.parseConfig>, h.ctx),
    ).rejects.toThrow(/never validated/)
  })

  it('has no slot in which an adapter could supply its own collectReport', () => {
    // The spec is data: every key is config, a schema or a pure mapping function.
    expect(Object.keys(makeSpec())).not.toContain('collectReport')
    expect(markValidated({ namespace: 'b', configVersion: 1 })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The boundaries the mutation gate found untested
// ---------------------------------------------------------------------------

describe('HTTP status classification', () => {
  it.each([200, 201, 299])('treats %i as a success', async (status) => {
    const h = harness({ pages: [{ status, body: { jobs: [job('1')], next: null } }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  /**
   * 100 is in this list to make the LOWER bound of the success range observable. Without it,
   * `status >= 200 && status < 300` could lose its first operand and nothing would notice: every
   * status any test used was already 200 or above, so `true && status < 300` behaved identically.
   * A 1xx is not a body we may treat as a page.
   */
  it.each([100, 300, 400, 404, 499, 500, 502])('treats %i as UPSTREAM', async (status) => {
    const h = harness({ pages: [{ status }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.code).toBe('UPSTREAM')
    expect(batch.outcome).toBe('FAILED')
  })

  it('names the status in the failure message, so an operator need not guess', async () => {
    const h = harness({ pages: [{ status: 503 }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe('provider answered HTTP 503')
  })
})

describe('the deadline boundary', () => {
  it('stops when the clock has REACHED the deadline, not only once it is past', async () => {
    const instant = new Date('2026-10-20T10:00:00Z')
    const h = harness({ pages: [onePage([job('1')])], now: instant, deadline: instant })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('DEADLINE')
    expect(h.calls).not.toContain('fetch:1')
  })

  it('proceeds with one millisecond left', async () => {
    const h = harness({
      pages: [onePage([job('1')])],
      now: new Date('2026-10-20T10:00:00.000Z'),
      deadline: new Date('2026-10-20T10:00:00.001Z'),
    })
    await expect(collectJsonPages(makeSpec(), config(), h.ctx)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    })
  })
})

describe('conditional-request plumbing', () => {
  it('sends if-none-match when a validator is cached', async () => {
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: { p1: { etag: 'W/"v1"', bodyText: JSON.stringify({ jobs: [], next: null }) } },
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.sent[0]?.headers?.['if-none-match']).toBe('W/"v1"')
  })

  it('sends no validator when nothing is cached', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.sent[0]?.headers?.['if-none-match']).toBeUndefined()
  })

  it('stores the validator a 200 carried, so the next attempt can revalidate', async () => {
    const h = harness({ pages: [{ etag: 'W/"v2"', body: { jobs: [job('1')], next: null } }] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.cache.get('p1')?.etag).toBe('W/"v2"')
  })

  it('stores nothing when the provider sent no validator', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.cache.has('p1')).toBe(false)
  })

  it('stores nothing for a page the adapter gave no cache key', async () => {
    const spec = makeSpec({
      pageRequest: () => ({ request: { url: 'https://api.example.com/jobs' } }),
    })
    const h = harness({ pages: [{ etag: 'W/"v3"', body: { jobs: [job('1')], next: null } }] })
    await collectJsonPages(spec, config(), h.ctx)

    expect(h.cache.size).toBe(0)
  })

  it('keeps the adapter`s own headers alongside the validator', async () => {
    const spec = makeSpec({
      pageRequest: () => ({
        request: { url: 'https://api.example.com/jobs', headers: { accept: 'application/json' } },
        cacheKey: 'p1',
      }),
    })
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: { p1: { etag: 'W/"v1"', bodyText: JSON.stringify({ jobs: [], next: null }) } },
    })
    await collectJsonPages(spec, config(), h.ctx)

    expect(h.sent[0]?.headers).toEqual({ accept: 'application/json', 'if-none-match': 'W/"v1"' })
  })
})

describe('failure messages name what broke', () => {
  it('names the bound a payload broke', async () => {
    const deep = '['.repeat(40) + '1' + ']'.repeat(40)
    const h = harness({ pages: [{ bodyText: `{"jobs":[],"next":null,"x":${deep}}` }] })
    const batch = await collectJsonPages(makeSpec({ limits: { maxDepth: 8 } }), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.message).toBe('TOO_DEEP: nesting exceeds 8')
  })

  it('names the ENVELOPE as the thing that drifted, with the schema`s own words', async () => {
    const h = harness({ pages: [{ body: { jobs: 'not an array', next: null } }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const message = batch.requests.at(-1)?.error?.message
    expect(message).toMatch(/^envelope: /)
    // The schema's own message, not a placeholder of ours.
    expect(message).not.toBe('envelope: did not match')
    expect(message).toContain('array')
  })

  it('names both numbers when a page carried too many items', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2'), job('3')])] })
    const batch = await collectJsonPages(
      makeSpec({ limits: { maxItemsPerPage: 2 } }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.message).toBe('page carried 3 items, over the 2 cap')
  })

  it('labels a schema-refused item ITEM_SCHEMA, with the schema`s own words', async () => {
    const h = harness({ pages: [onePage([{ id: '2' }])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const reason = batch.invalidSamples[0]?.reason
    expect(reason).toMatch(/^ITEM_SCHEMA: /)
    expect(reason).not.toBe('ITEM_SCHEMA: invalid')
  })

  it('labels a quarantined item with the identity seam`s own reason', async () => {
    const h = harness({ pages: [onePage([job('1', { url: 'http://jobs.example.com/j/1' })])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.invalidSamples[0]?.reason).toBe('QUARANTINED: UNSAFE_URL')
  })

  it('names the mapper`s own error', async () => {
    const spec = makeSpec({
      mapItem: () => {
        throw new Error('unexpected salary shape')
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.invalidSamples[0]?.reason).toBe('MAPPER_THREW: unexpected salary shape')
  })

  it('reports a failure to read the next cursor as drift', async () => {
    const spec = makeSpec({
      nextCursor: () => {
        throw new Error('cursor field moved')
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'cursor field moved',
    })
    expect(batch.observations).toEqual([])
  })

  it('reports a failure to extract the items as drift', async () => {
    const spec = makeSpec({
      extractItems: () => {
        throw new Error('jobs field moved')
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'jobs field moved',
    })
  })
})

describe('the stop messages say which stop it was', () => {
  it('names the cancellation', async () => {
    const h = harness({ pages: [onePage([job('1')])], aborted: true })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe('the run was cancelled before this page')
  })

  it('names the deadline', async () => {
    const instant = new Date('2026-10-20T10:00:00Z')
    const h = harness({ pages: [onePage([job('1')])], now: instant, deadline: instant })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the attempt deadline passed before this page',
    )
  })

  it('names the refused reservation', async () => {
    const h = harness({ pages: [onePage([job('1')])], reserveRefusesOnCall: 1 })
    const batch = await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )
    expect(batch.requests.at(-1)?.error?.message).toBe('the meter refused a reservation')
  })

  it('names an unsolicited 304', async () => {
    const h = harness({ pages: [{ status: 304 }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'provider answered 304 for a request that carried no validator',
    )
  })
})

describe('a fresh response is never replaced by a stale cached one', () => {
  /**
   * The condition is `status === 304 AND something is cached`, and the `304` half is only
   * observable when BOTH a cache entry exists and the provider answered 200: then a loop that
   * checked only "is anything cached" would serve the stale body and silently report yesterday's
   * inventory as today's.
   */
  it('uses the 200 body even though a validator was cached', async () => {
    const h = harness({
      pages: [{ status: 200, body: { jobs: [job('fresh')], next: null } }],
      cacheSeed: {
        p1: { etag: 'W/"v1"', bodyText: JSON.stringify({ jobs: [job('stale')], next: null }) },
      },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.observations).toHaveLength(1)
    expect(batch.observations[0]?.normalized.title).toContain('fresh')
  })
})

describe('the cache is not consulted for an uncacheable page', () => {
  it('asks the cache nothing when the adapter named no key', async () => {
    const spec = makeSpec({
      pageRequest: () => ({ request: { url: 'https://api.example.com/jobs' } }),
    })
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(spec, config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('cache.get'))).toEqual([])
  })

  it('asks the cache for the key the adapter named', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.calls).toContain('cache.get:p1')
  })
})

describe('an abort that lands mid-flight', () => {
  it('reports CANCELLED rather than a network failure', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }, {}],
      abortOnFetch: 2,
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('CANCELLED')
    expect(batch.outcome).toBe('CANCELLED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
  })
})

describe('the overlap is a real duration, not whatever the constant says', () => {
  /**
   * The earlier overlap test asserted the widened boundary against `DEFAULT_OVERLAP_MS` itself —
   * tautological: change the constant and the expectation changes with it, so all three arithmetic
   * mutants in `24 * 60 * 60 * 1000` survived. The expected instant is now a hand-written date and
   * the constant is pinned to a hand-written number.
   */
  it('is twenty-four hours', () => {
    expect(DEFAULT_OVERLAP_MS).toBe(86_400_000)
  })

  it('widens the window back by exactly one day', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    const h = harness({
      pages: [onePage([job('9')])],
      stored: {
        configVersion: 99,
        policyVersion: 1,
        adapterVersion: 'test-1',
        cursor: 'c3',
        page: 2,
        completedAt: new Date('2026-10-20T09:00:00Z'),
      },
    })
    const batch = await collectJsonPages(makeSpec(), config({ window }), h.ctx)

    expect(batch.scope.window?.from).toEqual(new Date('2026-10-09T00:00:00Z'))
  })

  it('does not widen a FRESH run`s window — there is nothing to overlap with', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    const h = harness({ pages: [onePage([job('9')])] })
    const batch = await collectJsonPages(makeSpec(), config({ window }), h.ctx)

    expect(batch.scope.window?.from).toEqual(new Date('2026-10-10T00:00:00Z'))
  })
})

describe('the defaults', () => {
  it('caps pages at ten for a spec that states no limits of its own', async () => {
    const endless = Array.from({ length: 30 }, (_, i) => ({
      body: { jobs: [job(String(i))], next: `c${i + 1}` },
    }))
    const h = harness({ pages: endless })
    const batch = await collectJsonPages(makeSpec({ limits: undefined }), config(), h.ctx)

    expect(DEFAULT_API_JSON_LIMITS.maxPages).toBe(10)
    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(10)
    expect(batch.observations).toHaveLength(10)
  })

  it('defaults a config`s namespace to the empty string the store uses for a global provider', () => {
    expect(baseSourceConfigSchema.parse({ configVersion: 1 }).namespace).toBe('')
  })
})

describe('the collision error identifies itself', () => {
  it('carries its own name and the key that collided', () => {
    const error = new AdapterIdentityCollisionError('key', 'a', 'b')
    expect(error.name).toBe('AdapterIdentityCollisionError')
    expect(error.identityKey).toBe('key')
  })
})

describe('the observation builder is given the run`s clock', () => {
  /**
   * `ctx.now()` is passed into `buildSourceObservation`, and the only way to observe that is a date
   * that is FUTURE relative to the run's clock while being PAST relative to the wall clock. With
   * the real `Date.now()` substituted this posting reads as published; with the run's clock the
   * identity seam refuses to treat it as published.
   */
  it('judges a publication date against the run`s clock, not the wall clock', async () => {
    const spec = makeSpec({
      mapItem: (item, cfg) => ({
        namespace: cfg.namespace,
        nativeId: item.id,
        url: item.url,
        title: item.title,
        companyName: item.company,
        dates: [
          {
            field: 'publishedAt',
            contract: 'ISO_ZONED' as const,
            semantics: 'PUBLISHED' as const,
            raw: '2026-06-01T00:00:00Z',
          },
        ],
      }),
    })
    // The run's clock is in January; the date is in June — FUTURE by the date policy's own 24-hour
    // skew tolerance. Both instants are in the past relative to any wall clock that will ever run
    // this test, so it is stable, and only the clock the loop PASSES IN decides the answer.
    const h = harness({ pages: [onePage([job('1')])], now: new Date('2026-01-01T00:00:00Z') })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.observations[0]?.normalized.publishedAt).toBeNull()
  })
})

/**
 * Every `catch` in the loop reads `error instanceof Error ? error.message : '<fallback>'`, and the
 * fallback branch was reached by no test at all — nine mutants the gate reported as NO COVERAGE
 * rather than as survivors, which is the quieter failure of the two.
 *
 * It is not a hypothetical branch: `throw 'string'` is legal, a rejected promise can carry
 * anything, and several of phase 3's providers are reached through libraries that reject with
 * plain objects. A page that throws a non-Error must still produce a typed, bounded report rather
 * than `undefined` in an error message.
 */
describe('a thrown non-Error still produces a typed report', () => {
  it('reports a mapper that threw a string', async () => {
    const spec = makeSpec({
      mapItem: () => {
        throw 'not an Error'
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.invalidSamples[0]?.reason).toBe('MAPPER_THREW: mapItem threw')
    expect(batch.counts.invalid).toBe(1)
  })

  it('reports a fetch that rejected with a non-Error', async () => {
    const h = harness({ pages: [{ throws: { code: 'ECONNRESET' } }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'TRANSIENT_NETWORK',
      message: 'the request failed',
    })
  })

  it('reports a persist that rejected with a non-Error', async () => {
    const h = harness({
      pages: [onePage([job('1')])],
      savePageFailsOnPage: 1,
      savePageThrows: 'pg went away',
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the page could not be persisted',
    })
    // Still OUR failure, not a bad record.
    expect(batch.counts.invalid).toBe(0)
  })

  it('reports an item extractor that threw a non-Error', async () => {
    const spec = makeSpec({
      extractItems: () => {
        throw 'jobs gone'
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'the items could not be extracted',
    })
  })

  it('reports a cursor reader that threw a non-Error', async () => {
    const spec = makeSpec({
      nextCursor: () => {
        throw 'cursor gone'
      },
    })
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'the next cursor could not be read',
    })
  })
})
