import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AdapterIdentityCollisionError } from './api-json.provider'
import { SourcePayloadTooLargeError } from '../http/source-errors'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  collectPages,
  ALLOWED_JSON_REQUEST_HEADERS,
  DEFAULT_OVERLAP_MS,
  defineApiJsonProvider,
  UNBUILT_REQUEST_URL,
} from './api-json.provider'
import { DEFAULT_API_JSON_LIMITS } from './api-json.limits'
import { jsonEnvelopeFingerprint } from './envelope-fingerprint'
import {
  type CachedResponse,
  type CollectionContext,
  type FetchRequest,
  markValidated,
  MAX_CURSOR_CHARS,
  type MeterReservation,
  REDACTED,
  type ReservationResolution,
  type SourceConfigFields,
  toStoredReportCounts,
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
    // Required since SPEC-M-1, and stated here rather than defaulted: this fake adapter keys
    // identity on the provider's id, so its `nativeIdOf` is that same id.
    nativeIdOf: (item) => item.id,
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
  /** Lowercased response headers — how a `last-modified` validator reaches the loop. */
  headers?: Record<string, string>
  throws?: unknown
  /** U6b: the context itself sent the validators this response answers. */
  conditional?: true
}

interface Harness {
  ctx: CollectionContext
  calls: string[]
  reconciles: Array<{ id: string; resolution: ReservationResolution; incurred?: number }>
  saved: ValidatedCheckpoint[]
  /** Every outgoing request, so the conditional-request header can be asserted. */
  sent: FetchRequest[]
  cache: Map<string, CachedResponse>
  /** U6b: how many times the loop told the context the run was a single page. */
  singlePage: { count: number }
}

/**
 * The adapter's slot out of the loop's `[slot, digest]` cache key — see the harness's cache.
 *
 * A key that is not that shape is recorded VERBATIM rather than refused: the loop is the thing
 * under test, so a harness that threw on an unexpected key would hide the call instead of
 * reporting it — and `cache.put` degrades silently by design, so the throw would vanish entirely.
 */
const slotOf = (key: string): string => {
  const parsed = z.tuple([z.string(), z.string()]).safeParse(
    ((): unknown => {
      try {
        return JSON.parse(key)
      } catch {
        return null
      }
    })(),
  )
  return parsed.success ? parsed.data[0] : String(key)
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
  cacheSeed?: Record<string, CachedResponse>
  policyVersion?: number
  /** The response cache is down. READ and WRITE are separate options because their consequences
   * are deliberately different — see the comment on `cache.put` in `api-json.provider.ts`. */
  cacheGetThrows?: boolean
  cachePutThrows?: boolean
  /** `markSent` rejects: the store could not record that the request was about to leave. */
  markSentThrows?: boolean
}): Harness {
  const calls: string[] = []
  const sent: FetchRequest[] = []
  const reconciles: Array<{ id: string; resolution: ReservationResolution; incurred?: number }> = []
  const saved: ValidatedCheckpoint[] = []
  const cache = new Map<string, CachedResponse>(Object.entries(opts.cacheSeed ?? {}))
  const singlePage = { count: 0 }
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
    observeSinglePage() {
      singlePage.count += 1
    },
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
        headers: page.headers ?? {},
        etag: page.etag ?? null,
        ...(page.conditional && { conditional: true as const }),
      }
    },
    meter: {
      async reserve(unit, amount): Promise<MeterReservation | null> {
        reserves += 1
        calls.push(`reserve:${reserves}`)
        if (opts.reserveRefusesOnCall === reserves) return null
        return { id: `r${reserves}`, unit, amount }
      },
      async markSent(reservation) {
        calls.push(`markSent:${reservation.id}`)
        if (opts.markSentThrows === true) throw new Error('the meter is down')
      },
      async reconcile(reservation, resolution, incurred) {
        calls.push(`reconcile:${resolution}`)
        reconciles.push({
          id: reservation.id,
          resolution,
          ...(incurred === undefined ? {} : { incurred }),
        })
      },
    },
    checkpoints: {
      async load() {
        calls.push('load')
        return opts.stored ?? null
      },
      /**
       * THE FAKE GATES ITS LOG ON ITS OWN PROMISE, which is what makes the two order tests below
       * able to fail at all (CR-M-3).
       *
       * It logged `save:N` SYNCHRONOUSLY, before returning. So a loop that dropped the `await` and
       * moved straight on still produced `save:1` before `fetch:2`, and both order assertions —
       * the two tests whose entire subject is "the loop does not advance until the persist
       * resolves" (AC4) — passed. Measured on this suite with the `await` replaced by `void`:
       * 145 of 149 passed, and the four failures were the persist-FAILURE tests catching an
       * unhandled rejection, not the order tests.
       *
       * `setTimeout` rather than `await Promise.resolve()` on purpose: a macrotask is strictly
       * ordered after every pending microtask, and every other fake here is an async function
       * resolving in microtasks. So the gate does not depend on counting the loop's awaits — with
       * the `await` dropped, the loop runs to completion before the first `save:` is ever logged,
       * whatever its internal shape.
       */
      async savePage({ checkpoint }) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        calls.push(`save:${checkpoint.position.page}`)
        if (opts.savePageFailsOnPage === checkpoint.position.page) {
          if (opts.savePageThrows !== undefined) throw opts.savePageThrows
          throw new Error('deadlock detected')
        }
        saved.push(checkpoint)
      },
    },
    // HARNESS PLUMBING: the loop keys an entry on `[slot, request digest]` (SR-H-1), and this
    // harness addresses entries by the adapter's SLOT, so the 2.3 assertions below keep reading
    // `p1`. Every request in this file is a function of its page alone, so one slot is one
    // request here; that the digest separates DIFFERENT requests sharing a slot is pinned against
    // the raw key in `paged-response-cache.spec.ts`.
    cache: {
      async get(key) {
        calls.push(`cache.get:${slotOf(key)}`)
        if (opts.cacheGetThrows === true) throw new Error('the response cache is unreachable')
        return cache.get(slotOf(key)) ?? null
      },
      async put(key, value) {
        calls.push(`cache.put:${slotOf(key)}`)
        if (opts.cachePutThrows === true) throw new Error('the response cache is unreachable')
        cache.set(slotOf(key), value)
      },
    },
  }

  return { ctx, calls, reconciles, saved, sent, cache, singlePage }
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
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
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
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
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

    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      expect.stringContaining('MAPPER_THREW'),
    ])
  })

  it('counts an item the identity seam refused as QUARANTINED, not invalid', async () => {
    const h = harness({
      pages: [onePage([job('1'), job('2', { url: 'http://jobs.example.com/j/2' })])],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
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
  /**
   * THIS TEST PINNED THE DEFECT. It asserted `counts.normalized === 2` for a page whose
   * observations were thrown away, while the test immediately below asserted
   * `observations === []` on the same input — two adjacent assertions stating a contradiction,
   * with the wrong one written as the expected value (CR-M-5 = SPEC-M-3).
   *
   * `discarded` is the field that lets both be true at once: the two items WERE received (`raw`),
   * they were NOT refused (`invalid` and `quarantined` stay at zero, which is the AC3 claim this
   * test exists for), and they were NOT kept either.
   */
  it('reports PERSISTENCE, counts nothing as invalid, and counts nothing as kept', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2')])], savePageFailsOnPage: 1 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 2,
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('does not report observations whose page never landed', async () => {
    const h = harness({ pages: [onePage([job('1')])], savePageFailsOnPage: 1 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.observations).toEqual([])
    expect(batch.checkpoint).toBeNull()
    // The pair the invariant is about, asserted together rather than in two tests that could
    // disagree without either failing.
    expect(batch.counts.normalized).toBe(batch.observations.length)
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
    expect(batch.checkpoint?.position.page).toBe(1)
    // Page one was kept, page two was discarded — one of each, in one batch.
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 1,
    })
  })
})

/**
 * `counts.normalized` IS `observations.length`. One number, and it was in two places.
 *
 * The ACCEPTANCE assertions come first and are taken from the contract rather than from the
 * finding: `normalized` is the count of observations the batch hands over, so it equals the length
 * of the array it hands over — on a clean page, on a page with refusals, on a page with nothing at
 * all. Written from the finding alone this describe would hold only the two failure cases, and
 * `discarded` could have been implemented as a constant 0 on the happy path without a test
 * noticing.
 */
describe('the counts describe the observations in the same batch', () => {
  it('equals the observation count on a clean page', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2'), job('3')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.normalized).toBe(batch.observations.length)
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('equals the observation count on a page that also refused items', async () => {
    const h = harness({ pages: [onePage([job('1'), { id: '2' }, job('3')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.normalized).toBe(batch.observations.length)
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('equals the observation count on an empty page', async () => {
    const h = harness({ pages: [onePage([])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.normalized).toBe(batch.observations.length)
    expect(batch.counts.discarded).toBe(0)
  })

  it('counts a KEPT page only after its persist resolved, across several pages', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1'), job('2')], next: 'c2' } },
        { body: { jobs: [job('3')], next: null } },
      ],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.counts.normalized).toBe(3)
    expect(batch.counts.normalized).toBe(batch.observations.length)
  })

  it('moves a failed page`s items out of normalized, keeping raw honest', async () => {
    // The reviewer's own case: a 5-item page whose second and third items carry distinct provider
    // ids and one shared canonical URL, so an adapter keying identity on the URL collapses them.
    // MEASURED WITHOUT THE FIX: `{ raw: 3, normalized: 2, invalid: 1 }` with ZERO observations,
    // and `toStoredReportCounts` handed that `normalized: 2` to a collector with no rows to
    // dispose of.
    const items = [
      job('1'),
      job('2', { url: 'https://jobs.example.com/same' }),
      job('3', { url: 'https://jobs.example.com/same' }),
      job('4'),
      job('5'),
    ]
    const h = harness({ pages: [{ body: { jobs: items, next: null } }] })
    const batch = await collectJsonPages(
      makeSpec({
        mapItem: (item, c) => ({
          namespace: c.namespace,
          nativeId: null,
          url: item.url,
          title: item.title,
          companyName: item.company,
        }),
        nativeIdOf: (item) => item.id,
      }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 0,
      invalid: 1,
      quarantined: 0,
      discarded: 2,
    })
    expect(batch.counts.normalized).toBe(batch.observations.length)
  })

  it('projects a discarded page into the store`s invalid, not its normalized', async () => {
    const h = harness({ pages: [onePage([job('1'), job('2')])], savePageFailsOnPage: 1 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    // The projection is what the collector consumes, so this is where the defect was actually
    // paid for: `received` must still account for every item, and `normalized` must be a number
    // the collector has rows for.
    expect(toStoredReportCounts(batch.counts)).toEqual({
      received: 2,
      invalid: 2,
      normalized: 0,
    })
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
    expect(batch.checkpoint?.position.page).toBe(1)
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
      position: { kind: 'CURSOR', page: 1, cursor: 'c9' },
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
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 4,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
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
    position: { kind: 'CURSOR', page: 2, cursor: 'c3' },
    completedAt: new Date('2026-10-20T09:00:00Z'),
  }

  it('resumes after the last completed page', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position.page).toBe(3)
    expect(batch.checkpoint?.position.page).toBe(3)
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

    expect(h.saved[0]?.position.page).toBe(1)
    expect(batch.checkpoint?.position.page).toBe(1)
  })

  it('restarts at page one when the ADAPTER version moved', async () => {
    const h = harness({
      pages: [onePage([job('9')])],
      stored: { ...stored, adapterVersion: 'old' },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.checkpoint?.position.page).toBe(1)
  })

  it('restarts at page one when the POLICY version moved', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored, policyVersion: 7 })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.checkpoint?.position.page).toBe(1)
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
      'markSent:r1',
      'fetch:1',
      'reconcile:USED',
      'save:1',
      'reserve:2',
      'cache.get:p2',
      'markSent:r2',
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

    // Both ordinals are pinned before they are compared. `indexOf` returns -1 for a call that
    // never happened, and `-1 < 3` is true — so with the `await` on `savePage` dropped this
    // assertion passed on a run where `save:1` had not been logged at all, which is the opposite
    // of what it claims to check (CR-M-3).
    expect(h.calls).toContain('save:1')
    expect(h.calls).toContain('fetch:2')
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

  it('U6b: a 304 to validators the context sent ends the run clean and saves nothing', async () => {
    const h = harness({ pages: [{ status: 304, conditional: true }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.counts.raw).toBe(0)
    expect(batch.checkpoint).toBeNull()
    expect(h.saved).toEqual([])
    expect(h.sent).toHaveLength(1)
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({ status: 304, error: null })
  })

  it('U6b: a fresh run that read exactly one page and exhausted tells the context it was a single page', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.singlePage.count).toBe(1)
  })

  it('U6b: a paged run (CR-M-2) never claims to be a single page', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }, onePage([job('2')])],
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved).toHaveLength(2)
    expect(h.singlePage.count).toBe(0)
  })

  it('U6b: a crash-resumed run that exhausts after one page is not a single-page run (CR-M-3)', async () => {
    const h = harness({
      pages: [onePage([job('2')])],
      stored: {
        configVersion: 1,
        policyVersion: 1,
        adapterVersion: 'test-1',
        position: { kind: 'CURSOR', page: 1, cursor: 'c2' },
        completedAt: new Date('2026-10-20T09:00:00Z'),
      },
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved).toHaveLength(1)
    expect(h.singlePage.count).toBe(0)
  })

  it('U6b: a single page that then fails to persist is not a single-page run', async () => {
    const h = harness({ pages: [onePage([job('1')])], savePageFailsOnPage: 1 })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.singlePage.count).toBe(0)
  })

  it('U6b: a metered 304 settles its reservation as used', async () => {
    const h = harness({ pages: [{ status: 304, conditional: true }] })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
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
  /*
   * LAST-MODIFIED IS THE SECOND VALIDATOR, and the one feeds send most often without an ETag.
   * Acceptance first (a validator of either kind is stored and replayed), then the refusals (no
   * header for a validator that is absent, and nothing stored when neither arrived).
   */
  it('stores a last-modified validator from a 200 that carried no etag', async () => {
    const h = harness({
      pages: [
        {
          headers: { 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' },
          body: { jobs: [job('1')], next: null },
        },
      ],
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.cache.get('p1')).toEqual({
      etag: null,
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      bodyText: JSON.stringify({ jobs: [job('1')], next: null }),
    })
  })

  it('stores both validators when the 200 carried both', async () => {
    const h = harness({
      pages: [
        {
          etag: 'W/"v4"',
          headers: { 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' },
          body: { jobs: [job('1')], next: null },
        },
      ],
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.cache.get('p1')?.etag).toBe('W/"v4"')
    expect(h.cache.get('p1')?.lastModified).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
  })

  it('replays a cached last-modified as if-modified-since, and sends no if-none-match without an etag', async () => {
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: {
        p1: {
          etag: null,
          lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
          bodyText: JSON.stringify({ jobs: [job('cached')], next: null }),
        },
      },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.sent[0]?.headers).toEqual({ 'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    // The 304 reuses the stored inventory rather than reporting an empty page.
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['cached'])
  })

  it('does not trust a 304 for a cached entry that holds no validator at all', async () => {
    // Nothing was sent that a 304 could be an answer to, so the stored body is not reused: the
    // refusal half of "a 304 reuses the cached inventory".
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: {
        p1: { etag: null, bodyText: JSON.stringify({ jobs: [job('stale')], next: null }) },
      },
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    // The request went out exactly as the adapter built it: no precondition was attached.
    expect(h.sent[0]?.headers).toBeUndefined()
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('replays both validators when both are cached', async () => {
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: {
        p1: {
          etag: 'W/"v1"',
          lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
          bodyText: JSON.stringify({ jobs: [], next: null }),
        },
      },
    })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.sent[0]?.headers).toEqual({
      'if-none-match': 'W/"v1"',
      'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
  })
})

/**
 * THE RESERVATION IS A RESOURCE, SO EVERY PATH RESOLVES IT.
 *
 * The ACCEPTANCE assertions come first and they are not derived from the finding: the
 * specification is `reserve` -> at most one `reconcile` per reservation, on every path out of the
 * span, with the resolution naming what we actually know about the billing. Written from the
 * finding alone, every test here would have asserted a refusal and the arithmetic below — one
 * reconcile per reserve, no more and no fewer — would never have been written.
 */
describe('every reservation an attempt takes is resolved exactly once', () => {
  const metered = { unit: 'REQUEST' as const, amountPerRequest: 1 }

  it('reconciles each page`s reservation once on a clean multi-page run', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('reserve:'))).toHaveLength(2)
    expect(h.reconciles).toEqual([
      { id: 'r1', resolution: 'USED' },
      { id: 'r2', resolution: 'USED' },
    ])
  })

  it('reconciles the reservation of a page the provider refused', async () => {
    const h = harness({ pages: [{ status: 403 }] })
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    // A 403 is a response: it provably arrived, so it is USED, and it is still resolved.
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('releases — not holds — a reservation for a request that never left the process', async () => {
    const h = harness({ pages: [onePage([job('1')])], cacheGetThrows: true })
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    // RELEASED is the third resolution and the only honest one here: the cache threw BEFORE the
    // fetch, so nothing left the process and nothing can have been billed. Asserting merely that
    // *some* reconcile happened would pass for UNCERTAIN, which would overstate what we owe.
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'RELEASED' }])
    expect(batch.outcome).toBe('FAILED')
  })

  it('resolves rather than rejects when the response cache cannot be read', async () => {
    const h = harness({ pages: [onePage([job('1')])], cacheGetThrows: true })

    // `.resolves`, never `.rejects.not.toThrow`. WITHOUT THE FIX this REJECTED: `ctx.cache.get`
    // sat outside every catch and after `reserve`, so the measured meter log was `['reserve:1']`
    // and `collectJsonPages` threw the cache's own error — no batch, no outcome, and a
    // reservation held with no resolution (SR-M-1).
    await expect(
      collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx),
    ).resolves.toBeDefined()
  })

  it('reports a cache read failure as ours, not as the provider`s network', async () => {
    const h = harness({ pages: [onePage([job('1')])], cacheGetThrows: true })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const last = batch.requests.at(-1)
    expect(last?.error?.code).toBe('PERSISTENCE')
    expect(last?.error?.message).toContain('the response cache could not be read')
    expect(last?.status).toBeNull()
  })

  it('keeps the pages that already landed when the cache stops answering', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c2' } }],
      cacheGetThrows: false,
    })
    // Page one succeeds; the cache is then broken for page two by swapping the port under the
    // loop, which is the only way to reach "a cache failure mid-attempt" through this seam.
    let gets = 0
    const realGet = h.ctx.cache.get.bind(h.ctx.cache)
    h.ctx.cache.get = async (key) => {
      gets += 1
      if (gets > 1) throw new Error('the response cache is unreachable')
      return realGet(key)
    }
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
  })
})

/**
 * The cache WRITE is the other direction, and its consequence is deliberately the opposite.
 */
describe('a page whose body arrived is kept, even if it cannot be cached', () => {
  it('reports and persists the page when the cache write succeeds', async () => {
    // ACCEPTANCE FIRST: the specification says a 200 carrying a validator is stored and the page
    // is kept. Both halves, so the test below cannot pass by the page being dropped either way.
    const h = harness({ pages: [{ etag: 'W/"v2"', body: { jobs: [job('1')], next: null } }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.cache.get('p1')).toEqual({ etag: 'W/"v2"', bodyText: expect.any(String) })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(1)
    expect(batch.counts.normalized).toBe(1)
  })

  it('keeps the page when the cache write fails', async () => {
    const h = harness({
      pages: [{ etag: 'W/"v2"', body: { jobs: [job('1')], next: null } }],
      cachePutThrows: true,
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    // WITHOUT THE FIX, measured: `observations` was empty, the outcome was FAILED and the error
    // read `TRANSIENT_NETWORK: redis down` — a cache outage reported as the provider's network,
    // with a page we had already fetched and paid for thrown away (CR-M-4).
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.observations).toHaveLength(1)
    expect(batch.requests.map((r) => r.error)).toEqual([null])
    expect(h.saved).toHaveLength(1)
  })

  it('still resolves the reservation of a page it could not cache', async () => {
    const h = harness({
      pages: [{ etag: 'W/"v2"', body: { jobs: [job('1')], next: null } }],
      cachePutThrows: true,
    })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
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
        position: { kind: 'CURSOR', page: 2, cursor: 'c3' },
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

// ---------------------------------------------------------------------------
// Round-1 review findings. Every test below covers a check that could not fail: the behaviour was
// wrong AND the suite was green, so each one records what its own passing would look like if the
// thing it checks were absent.
// ---------------------------------------------------------------------------

/** A provider with no end: every page hands back a cursor nobody has seen. Only a BOUND stops it,
 *  which is what makes "the bound is per attempt" observable at all. */
function endlessPages(count: number): PageResponse[] {
  return Array.from({ length: count }, (_unused, i) => ({
    body: { jobs: [job(`e${i + 1}`)], next: `cursor-${i + 1}` },
  }))
}

function storedAt(position: unknown, over: Record<string, unknown> = {}): ValidatedCheckpoint {
  return {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'test-1',
    position,
    completedAt: new Date('2026-10-20T09:00:00Z'),
    ...over,
  } as unknown as ValidatedCheckpoint
}

describe('the page bound is per attempt, not absolute (SR-H-1)', () => {
  /**
   * WITHOUT THE FIX this reports `fetches: 0` and `outcome: 'SUCCEEDED'` — and a run that stops on
   * its cap legitimately reports SUCCEEDED, which is why asserting the outcome alone could never
   * catch it. The loop compared the ABSOLUTE page against a limit its own doc calls "per attempt",
   * so a resumed run was born over budget: no request, nothing saved, success claimed, and the
   * same again on every run after it. The source froze at page 10 and page 1 was never re-read.
   */
  it('fetches a full bound of pages starting from where it resumed', async () => {
    const h = harness({
      pages: endlessPages(9),
      stored: storedAt({ kind: 'CURSOR', page: 10, cursor: 'cursor-from-run-1' }),
    })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 5 } }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(5)
    expect(h.sent[0]?.url).toContain('cursor-from-run-1')
    expect(batch.observations).toHaveLength(5)
  })

  it('leaves a checkpoint strictly ahead of where it started, so runs make progress', async () => {
    const h = harness({
      pages: endlessPages(9),
      stored: storedAt({ kind: 'CURSOR', page: 10, cursor: 'cursor-from-run-1' }),
    })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 3 } }), config(), h.ctx)

    expect(batch.checkpoint?.position.page).toBe(13)
  })

  it('reports the cap it hit, instead of stopping silently', async () => {
    const h = harness({ pages: endlessPages(4) })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 2 } }), config(), h.ctx)
    const cap = batch.requests.find((r) => r.error?.code === 'PAGE_CAP')

    expect(cap).toBeDefined()
    expect(cap?.error?.message).toBe('the attempt reached its 2-page bound')
    // The report names a URL that was never built, in a form that still survives the structural
    // redaction a report URL goes through — pinned, because a marker that silently became
    // unparsable would read as "[REDACTED] (unparsable url)" in every capped run.
    // The LITERAL, not the constant: `toBe(UNBUILT_REQUEST_URL)` is tautological — mutating the
    // constant moves both sides of the assertion together and the check cannot fail.
    expect(cap?.url).toBe('about:request-not-built')
    expect(UNBUILT_REQUEST_URL).toBe('about:request-not-built')
    expect(cap?.status).toBeNull()
  })
})

describe('a stored checkpoint is PARSED, not asserted (SR-H-2)', () => {
  /**
   * WITHOUT THE FIX the first case makes the cap vanish outright: `NaN > maxPages` is false, so it
   * never fires and the loop runs until the fake provider runs out — measured as an UNBOUNDED
   * loop, not merely a large one. A denial of service through one bad database row. `page: '7'` is
   * the quieter half: `'7' + 1` is `'71'`, so the attempt resumed at page seventy-one, fetched
   * nothing and reported SUCCEEDED.
   */
  it.each([
    ['page NaN', { kind: 'CURSOR', page: NaN, cursor: 'c' }],
    ['page as a string', { kind: 'CURSOR', page: '7', cursor: 'c' }],
    ['page negative', { kind: 'CURSOR', page: -1_000_000, cursor: 'c' }],
    ['page beyond a PostgreSQL integer', { kind: 'CURSOR', page: 2_147_483_648, cursor: 'c' }],
    ['an empty cursor', { kind: 'CURSOR', page: 2, cursor: '' }],
    ['an unknown kind', { kind: 'SOMETHING_ELSE', page: 2 }],
    ['no position at all', undefined],
  ])('restarts bounded discovery on %s', async (_name, position) => {
    const h = harness({ pages: endlessPages(6), stored: storedAt(position) })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 3 } }), config(), h.ctx)

    // The cap holds — the half a bad `page` used to disable entirely.
    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(3)
    // And discovery restarted from page one rather than resuming a position we cannot trust.
    expect(h.sent[0]?.url).toContain('page=1')
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('still resumes a checkpoint that does parse', async () => {
    const h = harness({
      pages: endlessPages(3),
      stored: storedAt({ kind: 'CURSOR', page: 2, cursor: 'good-cursor' }),
    })
    await collectJsonPages(makeSpec({ limits: { maxPages: 1 } }), config(), h.ctx)

    expect(h.sent[0]?.url).toContain('good-cursor')
  })
})

describe('an unusable page request is a batch, not a throw (SR-H-3)', () => {
  const throwingSpec = () =>
    makeSpec({
      pageRequest: () => {
        throw new TypeError('Invalid URL')
      },
    })

  /**
   * WITHOUT THE FIX this rejects. `spec.pageRequest` is adapter code, it sat outside every `try`,
   * and a cursor the adapter could not parse escaped as a raw `TypeError`: no `CollectionBatch`,
   * no outcome, no error code, nothing for an operator to read.
   */
  it('reports PARSE_DRIFT when the adapter cannot build the first request', async () => {
    const h = harness({ pages: [onePage([job('1')])] })

    const batch = await collectJsonPages(throwingSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error).toEqual({ code: 'PARSE_DRIFT', message: 'Invalid URL' })
    expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(0)
  })

  /** `.resolves`, never `.rejects.not.toThrow` — the second form passes for a promise that rejects
   *  with the wrong error as readily as for one that resolves. */
  it('resolves rather than rejecting', async () => {
    const h = harness({ pages: [onePage([job('1')])] })

    await expect(collectJsonPages(throwingSpec(), config(), h.ctx)).resolves.toMatchObject({
      outcome: 'FAILED',
    })
  })

  /**
   * WITHOUT THE FIX this is the permanent poison. `savePage` stored whatever `nextCursor` returned
   * and the loop handed it to `pageRequest` on the NEXT iteration — so a cursor the adapter
   * rejects was written to the database and replayed into the same rejection on every future
   * attempt, forever, producing no batch at all. The fix builds the next request on THIS side of
   * the persist and stores a `RESTART` instead.
   */
  it('keeps the page, refuses the cursor, and leaves a position that can start over', async () => {
    const h = harness({ pages: [{ body: { jobs: [job('1')], next: 'not a url' } }] })
    const spec = makeSpec({
      pageRequest: (_c, at) => {
        if (at.cursor !== null) new URL(at.cursor)
        return { request: { url: 'https://api.example.com/jobs?page=1' } }
      },
    })

    const batch = await collectJsonPages(spec, config(), h.ctx)

    // The page landed.
    expect(batch.observations).toHaveLength(1)
    expect(h.saved).toHaveLength(1)
    // The poison was never stored.
    expect(h.saved[0]?.position).toEqual({ kind: 'RESTART', page: 1 })
    expect(JSON.stringify(h.saved[0])).not.toContain('not a url')
    // And the reason is reported rather than thrown — with the adapter's own words carried into
    // it, so the message cannot be emptied without a test noticing.
    const drift = batch.requests.find((r) => r.error?.code === 'PARSE_DRIFT')

    expect(drift?.error?.message).toBe("the provider's next cursor is unusable: Invalid URL")
    expect(drift?.page).toBe(2)
    expect(batch.outcome).toBe('PARTIAL')
  })

  it('starts over on the next attempt instead of replaying a refused cursor', async () => {
    const h = harness({
      pages: [onePage([job('2')])],
      stored: storedAt({ kind: 'RESTART', page: 1 }),
    })
    const spec = makeSpec({
      pageRequest: (_c, at) => {
        if (at.cursor !== null) new URL(at.cursor)
        return { request: { url: `https://api.example.com/jobs?page=${at.page}` } }
      },
    })

    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(h.sent[0]?.url).toBe('https://api.example.com/jobs?page=1')
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(1)
  })
})

/**
 * THE CURSOR IS THE ONE VALUE THE PROVIDER CHOOSES, SO ITS SIZE IS BOUNDED BEFORE IT IS STORED.
 *
 * The ACCEPTANCE assertions are first and both sides of the bound are asserted, because the whole
 * risk of a cap is that it refuses cursors that are merely long — a base64 continuation token of a
 * few hundred characters is ordinary, and a cap that broke those would freeze real sources. From
 * the finding alone only the refusal would be here.
 */
describe('the cursor a provider hands back is bounded before it is persisted', () => {
  const twoPages = (cursor: string) => [
    { body: { jobs: [job('1')], next: cursor } },
    { body: { jobs: [job('2')], next: null } },
  ]

  it('persists an ordinary long cursor unchanged', async () => {
    const cursor = 'c'.repeat(600)
    const h = harness({ pages: twoPages(cursor) })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('persists a cursor of exactly the cap', async () => {
    const cursor = 'c'.repeat(MAX_CURSOR_CHARS)
    const h = harness({ pages: twoPages(cursor) })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('refuses the cursor one character past the cap, keeping the page', async () => {
    const cursor = 'c'.repeat(MAX_CURSOR_CHARS + 1)
    const h = harness({ pages: twoPages(cursor) })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    // MEASURED WITHOUT THE FIX: a 1 MiB cursor was persisted at its full 1 048 576 characters,
    // because the loop built `ValidatedCheckpoint` as an object literal and `MAX_CURSOR_CHARS`
    // was enforced only when READING a stored row back (SR-M-2). Ten pages of that is ~10 MiB of
    // checkpoint per attempt, and the row would then be refused on the way in — so the source
    // restarted forever with nothing saying why.
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]?.position).toEqual({ kind: 'RESTART', page: 1 })
    expect(JSON.stringify(h.saved[0]).length).toBeLessThan(MAX_CURSOR_CHARS)
    // The page itself still landed: a provider's bad cursor is not a reason to lose a good page.
    expect(batch.observations).toHaveLength(1)
    expect(batch.outcome).toBe('PARTIAL')
  })

  it('reports WHY the oversized cursor was refused', async () => {
    const h = harness({ pages: twoPages('c'.repeat(MAX_CURSOR_CHARS + 1)) })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const drift = batch.requests.find((r) => r.error?.code === 'PARSE_DRIFT')
    expect(drift?.error?.message).toContain('it cannot be stored')
    // The schema's own words, not ours — the same discipline as the envelope-drift message.
    expect(drift?.error?.message).toMatch(/2048/)
  })

  it('never hands an unstorable cursor to the adapter', async () => {
    // Parsed BEFORE `pageRequest`, so 25 adapters' URL builders are never handed a megabyte of
    // provider-chosen text. Asserted through what the adapter was asked, which is observable.
    const seen: Array<string | null> = []
    const h = harness({ pages: twoPages('c'.repeat(MAX_CURSOR_CHARS + 1)) })
    await collectJsonPages(
      makeSpec({
        pageRequest: (_c, at) => {
          seen.push(at.cursor)
          return { request: { url: `https://api.example.com/jobs?page=${at.page}` } }
        },
      }),
      config(),
      h.ctx,
    )

    expect(seen).toEqual([null])
  })

  it('refuses an empty cursor, which is not a position either', async () => {
    // The schema's `min(1)`, reachable from here: a provider returning `''` means neither "there
    // is more" nor "there is no more", and storing it would resume at a cursor that selects
    // nothing. The `null` the seam documents is how exhaustion is said.
    const h = harness({ pages: twoPages('') })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position).toEqual({ kind: 'RESTART', page: 1 })
    expect(batch.observations).toHaveLength(1)
  })
})

describe('the restart overlap reaches the WIRE, not just the report (SPEC-H-1)', () => {
  /**
   * WITHOUT THE FIX this fails on its first assertion while the three overlap tests already in
   * this file stay green — which is the whole finding. `widenScope`'s result went into a local
   * that reached `batch.scope.window` and never `spec.pageRequest`, so a restart REPORTED a window
   * widened by a day and then asked the provider for the unwidened one. The existing tests
   * asserted `batch.scope.window`, the half that was already right.
   *
   * So these assert on THE REQUEST THE FETCH PORT RECEIVED. That is the only surface on which "the
   * overlap was applied" is distinguishable from "the overlap was reported".
   */
  const window = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
  const widened = new Date('2026-10-09T00:00:00Z')

  /** An adapter that builds its request from `at.window`, as the seam requires. */
  const windowedSpec = (over: Partial<ApiJsonSourceSpec<Config, Envelope, Item>> = {}) =>
    makeSpec({
      pageRequest: (_c, at) => ({
        request: {
          url: `https://api.example.com/jobs?from=${at.window === null ? 'none' : at.window.from.toISOString()}`,
        },
      }),
      ...over,
    })

  const staleConfig = () =>
    storedAt({ kind: 'CURSOR', page: 2, cursor: 'c3' }, { configVersion: 99 })

  it('sends the widened window on a restart', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored: staleConfig() })

    const batch = await collectJsonPages(windowedSpec(), config({ window }), h.ctx)

    expect(h.sent[0]?.url).toBe(`https://api.example.com/jobs?from=${widened.toISOString()}`)
    // The report and the wire now agree, which is the invariant that was broken.
    expect(batch.scope.window?.from).toEqual(widened)
  })

  it('sends the unwidened window on a FRESH run', async () => {
    const h = harness({ pages: [onePage([job('9')])] })

    const batch = await collectJsonPages(windowedSpec(), config({ window }), h.ctx)

    expect(h.sent[0]?.url).toBe(`https://api.example.com/jobs?from=${window.from.toISOString()}`)
    expect(batch.scope.window?.from).toEqual(window.from)
  })

  it('honours a spec`s own overlap on the wire', async () => {
    const h = harness({ pages: [onePage([job('9')])], stored: staleConfig() })

    await collectJsonPages(windowedSpec({ overlapMs: 60_000 }), config({ window }), h.ctx)

    expect(h.sent[0]?.url).toBe(
      `https://api.example.com/jobs?from=${new Date(window.from.getTime() - 60_000).toISOString()}`,
    )
  })
})

describe('a resumed attempt cannot claim the full inventory (SPEC-L-2)', () => {
  /**
   * WITHOUT THE FIX a checkpoint at page 4, one fetch and an exhausted cursor reported
   * `FULL_INVENTORY` on the strength of a single tail page. A batch describes ONE attempt, and an
   * attempt that began at page 5 never looked at pages 1-4.
   */
  it('reports PARTIAL for a tail-only resume that runs to exhaustion', async () => {
    const h = harness({
      pages: [onePage([job('9')])],
      stored: storedAt({ kind: 'CURSOR', page: 4, cursor: 'c4' }),
    })

    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('still reports FULL_INVENTORY for an unresumed exhausted run', async () => {
    const h = harness({ pages: [onePage([job('9')])] })

    expect((await collectJsonPages(makeSpec(), config(), h.ctx)).coverage).toBe('FULL_INVENTORY')
  })
})

describe('a cursor cycle reports its own error code (SR-L-4)', () => {
  /**
   * WITHOUT THE FIX the stop pushed no report carrying `CURSOR_CYCLE`, though the code is in
   * `COLLECTION_ERROR_CODES` for this exact purpose — so a cycle was indistinguishable from a
   * clean finish in everything except the coverage axis. The outcome stays SUCCEEDED on purpose:
   * we stopped on our own bound having kept everything we read. What was missing is the reason.
   */
  it('pushes a CURSOR_CYCLE request report', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c9' } }],
      stored: storedAt({ kind: 'CURSOR', page: 1, cursor: 'c9' }),
    })

    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    const cycle = batch.requests.find((r) => r.error?.code === 'CURSOR_CYCLE')

    expect(cycle).toBeDefined()
    // The report names the request the cycle WOULD have sent, not a placeholder — otherwise the
    // branch choosing between them is unobservable and either arm passes.
    expect(cycle?.url).toContain('c9')
    // The page the cycle WOULD have fetched, pinned so the `at.page + 1` arithmetic is observable.
    // This attempt resumed from a checkpoint at page 1, so it fetched page 2 and the cycle names 3.
    expect(cycle?.page).toBe(3)
    expect(cycle?.error?.message).toBe(
      'the provider handed back a cursor this attempt had already seen',
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('an unknown provider id is not a collision (CR-M-2)', () => {
  /**
   * THE MUTANT THIS KILLS: `if (nativeId !== null)` mutated to `if (true)`. It survived under a
   * suppression calling the guard unobservable, and it is not — with the guard gone, the first
   * item records `null` against its identity key and the SECOND item on that key, carrying a
   * perfectly good provider id, compares `null !== 'b'` and is reported as an identity collapse. A
   * success becomes `FAILED` / `ADAPTER_INVARIANT`. All 113 spec tests passed anyway, because none
   * of them put a null-id item and a known-id item on one key.
   */
  it('records a null native id without inventing a collision', async () => {
    const sharedUrl = 'https://jobs.example.com/j/shared'
    const h = harness({
      pages: [onePage([job('a', { url: sharedUrl }), job('b', { url: sharedUrl })])],
    })
    const spec = makeSpec({
      // Both items key identity on the same canonical URL, so they share an identity key...
      mapItem: (item, cfg) => ({
        namespace: cfg.namespace,
        nativeId: null,
        url: sharedUrl,
        title: item.title,
        companyName: item.company,
      }),
      // ...and only the second one has a provider-issued id.
      nativeIdOf: (item) => (item.id === 'a' ? null : item.id),
    })

    const batch = await collectJsonPages(spec, config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
    expect(batch.counts.normalized).toBe(2)
  })
})

describe('what a completed page stores as its resume position', () => {
  /**
   * The two ways a trail ends store the SAME position, and that is the point of merging them: the
   * next attempt starts over either way. Asserted separately because the branch that chooses the
   * position is otherwise unobservable — both arms produce a checkpoint, and a test that only
   * checks "a checkpoint was saved" cannot tell them apart.
   */
  it('stores RESTART when the provider`s inventory is exhausted', async () => {
    const h = harness({ pages: [onePage([job('1')])] })

    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position).toEqual({ kind: 'RESTART', page: 1 })
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 1 })
  })

  it('stores CURSOR, carrying the cursor itself, while the trail continues', async () => {
    const h = harness({
      pages: [{ body: { jobs: [job('1')], next: 'c-next' } }, onePage([job('2')])],
    })

    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'c-next' })
  })
})

describe('the per-attempt bound, pinned on BOTH sides (SR-H-1)', () => {
  /**
   * The single most consequential number in this change: a resumed attempt reporting SUCCEEDED
   * after zero fetches WAS the finding, so an off-by-one here is the same defect reported as
   * fixed. Both sides of the boundary are asserted — the last page that still fetches and the
   * first that does not — because a one-sided assertion cannot tell `>` from `>=`, which is the
   * defect class this feature has now produced five times.
   */
  const resumedAt10: ValidatedCheckpoint = {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'test-1',
    position: { kind: 'CURSOR', page: 10, cursor: 'cursor-from-run-1' },
    completedAt: new Date('2026-10-20T09:00:00Z'),
  }

  it.each([1, 2, 3, 5, 9])(
    'fetches exactly %s page(s) for maxPages %s on a FRESH run',
    async (n) => {
      const h = harness({ pages: endlessPages(n + 2) })
      await collectJsonPages(makeSpec({ limits: { maxPages: n } }), config(), h.ctx)

      expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(n)
    },
  )

  it.each([1, 2, 3, 5, 9])(
    'fetches exactly %s page(s) for maxPages %s on a RESUMED run too',
    async (n) => {
      const h = harness({ pages: endlessPages(n + 2), stored: resumedAt10 })
      await collectJsonPages(makeSpec({ limits: { maxPages: n } }), config(), h.ctx)

      expect(h.calls.filter((c) => c.startsWith('fetch')).length).toBe(n)
    },
  )

  it('fetches the LAST page inside the bound and stops before the next one', async () => {
    const h = harness({ pages: endlessPages(6), stored: resumedAt10 })
    const batch = await collectJsonPages(makeSpec({ limits: { maxPages: 3 } }), config(), h.ctx)

    // Pages 11, 12, 13 were fetched; the bound stopped page 14.
    const pages = h.saved.map((c) => c.position.page)

    expect(pages).toEqual([11, 12, 13])
    expect(batch.requests.find((r) => r.error?.code === 'PAGE_CAP')?.page).toBe(14)
  })

  it('numbers the resumed pages from the stored page plus one, not from one', async () => {
    const h = harness({ pages: endlessPages(3), stored: resumedAt10 })
    await collectJsonPages(makeSpec({ limits: { maxPages: 2 } }), config(), h.ctx)

    expect(h.saved[0]?.position.page).toBe(11)
  })
})

/**
 * THE NAMESPACE IS PART OF THE IDENTITY KEY, so two boards cannot collide and one board can.
 *
 * The plan's red→green list names "namespace collision" and nothing tested it (SPEC-L-1). Both
 * halves are here because only the pair says anything: that two namespaces differ is vacuous if
 * the same namespace also differs, and that the same namespace collapses is vacuous if everything
 * collapses. The behaviour under test is `buildIdentity`'s tuple, reached through the loop — the
 * seam the 25 adapters use — rather than called directly.
 */
describe('a namespace scopes identity, so boards cannot collide with each other', () => {
  const keysOf = (batch: { observations: Array<{ identity: { identityKey: string } }> }) =>
    batch.observations.map((o) => o.identity.identityKey)

  it('gives one posting different identity keys under different namespaces', async () => {
    const page = [job('shared-id')]
    const a = harness({ pages: [{ body: { jobs: page, next: null } }] })
    const b = harness({ pages: [{ body: { jobs: page, next: null } }] })

    const first = await collectJsonPages(makeSpec(), config({ namespace: 'board-a' }), a.ctx)
    const second = await collectJsonPages(makeSpec(), config({ namespace: 'board-b' }), b.ctx)

    expect(keysOf(first)).toHaveLength(1)
    expect(keysOf(second)).toHaveLength(1)
    expect(keysOf(first)).not.toEqual(keysOf(second))
    // And the namespace is in the key itself, so the difference is the namespace and not some
    // other accident of the two runs.
    expect(keysOf(first)[0]).toContain('board-a')
    expect(keysOf(second)[0]).toContain('board-b')
  })

  it('gives one posting the SAME identity key under the same namespace', async () => {
    const page = [job('shared-id')]
    const a = harness({ pages: [{ body: { jobs: page, next: null } }] })
    const b = harness({ pages: [{ body: { jobs: page, next: null } }] })

    const first = await collectJsonPages(makeSpec(), config({ namespace: 'board-a' }), a.ctx)
    const second = await collectJsonPages(makeSpec(), config({ namespace: 'board-a' }), b.ctx)

    expect(keysOf(first)).toEqual(keysOf(second))
  })

  it('does not call a repeated posting within one namespace an adapter invariant failure', async () => {
    // A provider legitimately re-lists the same posting across pages, and the identity key is
    // SUPPOSED to collapse those: same namespace, same provider id, one posting. AC5 is about
    // DIFFERENT provider ids collapsing, which is the next test.
    const h = harness({
      pages: [
        { body: { jobs: [job('dup')], next: 'c2' } },
        { body: { jobs: [job('dup')], next: null } },
      ],
    })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(new Set(keysOf(batch)).size).toBe(1)
    // Not de-duplicated HERE: the store has a `duplicates` disposition and the collector owns it.
    expect(batch.counts.normalized).toBe(2)
  })

  it('still reports a collapse of two DIFFERENT provider ids within one namespace', async () => {
    const h = harness({
      pages: [
        {
          body: {
            jobs: [
              job('x', { url: 'https://jobs.example.com/one' }),
              job('y', { url: 'https://jobs.example.com/one' }),
            ],
            next: null,
          },
        },
      ],
    })
    const batch = await collectJsonPages(
      makeSpec({
        mapItem: (item, cfg) => ({
          namespace: cfg.namespace,
          nativeId: null,
          url: item.url,
          title: item.title,
          companyName: item.company,
        }),
      }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
  })
})

/**
 * `nativeIdOf` is the ONLY source of the provider id the AC5 guard compares (SPEC-M-1).
 */
describe('the AC5 guard reads nativeIdOf and nothing else', () => {
  const collidingUrl = 'https://jobs.example.com/one'
  const twoItemsOneUrl = {
    body: {
      jobs: [job('x', { url: collidingUrl }), job('y', { url: collidingUrl })],
      next: null,
    },
  }
  const urlKeyed = (over: Partial<ApiJsonSourceSpec<Config, Envelope, Item>> = {}) =>
    makeSpec({
      mapItem: (item, cfg) => ({
        namespace: cfg.namespace,
        // URL-keyed: this is the configuration in which AC5 can actually fire.
        nativeId: null,
        url: item.url,
        title: item.title,
        companyName: item.company,
      }),
      ...over,
    })

  it('catches the collapse for a URL-keyed adapter that supplies the provider id', async () => {
    const h = harness({ pages: [twoItemsOneUrl] })
    const batch = await collectJsonPages(
      urlKeyed({ nativeIdOf: (item) => item.id }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
    expect(batch.outcome).toBe('FAILED')
  })

  it('switches the check off only where the adapter says so in writing', async () => {
    const h = harness({ pages: [twoItemsOneUrl] })
    const batch = await collectJsonPages(urlKeyed({ nativeIdOf: () => null }), config(), h.ctx)

    // A provider with no per-posting id has nothing to compare, so this is correct — and it is now
    // a sentence in the adapter rather than an omission. WITHOUT THE FIX this was what every
    // URL-keyed adapter got by DEFAULT, because `nativeIdOf` was optional and fell back to
    // `raw.nativeId`, which is null in exactly this configuration (SPEC-M-1).
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
  })

  it('does not fall back to the id mapItem supplied', async () => {
    // `mapItem` returns a perfectly good `nativeId` here and `nativeIdOf` returns null. The guard
    // must read the latter: the old `?? raw.nativeId` fallback would make these two items collide
    // on distinct ids and report ADAPTER_INVARIANT, which is the wrong answer for an adapter that
    // has declared the provider issues no ids.
    const h = harness({ pages: [twoItemsOneUrl] })
    const batch = await collectJsonPages(
      makeSpec({
        mapItem: (item, cfg) => ({
          namespace: cfg.namespace,
          nativeId: item.id,
          url: item.url,
          title: item.title,
          companyName: item.company,
        }),
        nativeIdOf: () => null,
      }),
      config(),
      h.ctx,
    )

    expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
  })

  it('is asked for every item, with the validated item and the config', async () => {
    const asked: Array<[string, string]> = []
    const h = harness({ pages: [onePage([job('1'), job('2')])] })
    await collectJsonPages(
      makeSpec({
        nativeIdOf: (item, cfg) => {
          asked.push([item.id, cfg.namespace])
          return item.id
        },
      }),
      config({ namespace: 'board' }),
      h.ctx,
    )

    expect(asked).toEqual([
      ['1', 'board'],
      ['2', 'board'],
    ])
  })
})

/**
 * THE AC5 GATE ASKS IDENTITY WHETHER AN ID WAS USED, AND NOT A SECOND NORMALISER (SR-M-1).
 *
 * `canonicalNativeId` is NFC + trim. Identity's own `normalizeNativeId` is that PLUS three
 * refusals — empty, over `MAX_NATIVE_ID_CHARS`, any C0/DEL character — so asking "is there a
 * usable id" with the first function answered differently from the function that decided. Measured
 * on four inputs, the loop believed in an id identity had declined, and only the length condition
 * was reasoned about or covered anywhere.
 *
 * WHAT THESE CASES PIN, and why each of the three shapes is here:
 *  - identity declines the id, so the entry keys on its URL — the premise the other two rest on;
 *  - two DISTINCT such ids on one URL are still refused. This is the case that fails if the two
 *    sides are made to agree by aligning `canonicalNativeId` with `normalizeNativeId` — the fix
 *    this round rejected — because the gate would then see no id and the collapse would be stored
 *    silently. It also fails if the gate compares `identity.nativeId` on both sides, which was the
 *    review's prescription: `identityKey` contains `nativeId` on the NATIVE_ID branch, so the
 *    comparison can never fire there, and on this branch both sides are `null`;
 *  - the same such id twice is ONE posting, so the refusal above is not simply "any declined id
 *    fails the page".
 *
 * All three are at this layer rather than through a feed, because only two of the four conditions
 * are reachable through XML at all: `readFeed`'s `textOf` trims and reports a blank as `null`, and
 * XML 1.0 forbids C0 characters other than tab, CR and LF. The loop is where all four live.
 */
describe('the AC5 gate follows identity across the ids identity declines', () => {
  const ONE_URL = 'https://jobs.example.com/the-only-link'

  /** URL-keyed: `mapItem` supplies no native id, so identity must fall back to the URL. */
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

  const collectIds = async (ids: readonly string[]): Promise<CollectionBatch> => {
    const h = harness({ pages: [onePage(ids.map((id) => job(id, { url: ONE_URL })))] })
    return collectJsonPages(urlKeyed, config(), h.ctx)
  }

  /** `[name, one id, a different id of the same shape]`. */
  const DECLINED: ReadonlyArray<readonly [string, string, string]> = [
    ['an interior tab', 'ab\tcd', 'ef\tgh'],
    ['an interior C0 control character', 'ab\u0001cd', 'ef\u0001gh'],
    ['an id past the usable length', `a-${'x'.repeat(300)}`, `b-${'x'.repeat(300)}`],
  ]

  it.each(DECLINED)('identity declines %s, so the entry keys on its URL', async (_name, id) => {
    const batch = await collectIds([id])

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations[0]?.identity).toMatchObject({
      identityKind: 'URL_FALLBACK',
      nativeId: null,
    })
  })

  it.each(DECLINED)(
    'two distinct ids with %s on one URL are still the collapse AC5 exists for',
    async (_name, first, second) => {
      const batch = await collectIds([first, second])

      expect(batch.outcome).toBe('FAILED')
      expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
      expect(batch.observations).toEqual([])
    },
  )

  it.each(DECLINED)(
    'the same id with %s twice on one URL is one posting, not a collapse',
    async (_name, id) => {
      const batch = await collectIds([id, id])

      expect(batch.outcome).toBe('SUCCEEDED')
      expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
      expect(batch.observations).toHaveLength(2)
    },
  )

  /**
   * THE FOURTH CONDITION, AND THE ONE WHOSE ANSWER IS THE OPPOSITE. Whitespace-only is not an id
   * identity declined — it is no id at all, and an absent id cannot disagree with anything. The
   * gate therefore spells it as nothing rather than recording `''` against the key: without that,
   * the empty string is remembered as this posting's id and the NEXT entry on the same key, with a
   * real id, reads as a collapse. One entry of each shape, which is the pair that discriminates.
   */
  it('an id that canonicalises to nothing is no id, and so disagrees with nothing', async () => {
    const batch = await collectIds(['   ', 'ab\tcd'])

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
    expect(batch.observations).toHaveLength(2)
  })

  /**
   * THE GATE ITSELF, WHERE IT IS OBSERVABLE — the case that kills the mutant replacing
   * `keyedOn === null` with `true`.
   *
   * The mutation gate found that condition surviving, and it was right: every other case here keys
   * on a URL, so the condition is true throughout and dropping it changes nothing. It is reachable
   * only where identity DID key on a native id while `nativeIdOf` reports something else — an
   * adapter whose `mapItem` pins ONE id for every item (so two items share an identity key through
   * the NATIVE_ID branch) while `nativeIdOf` answers per item.
   *
   * SUCCEEDED is the right answer, and that is why this is a test and not a suppression. Identity
   * keyed on an id the adapter supplied, so the two items were merged because the adapter SAID so
   * in `mapItem` — not because identity could not tell them apart. Refusing here would report
   * `ADAPTER_INVARIANT` for a merge the adapter asked for, which is a false refusal of the same
   * class as SR-M-1. Without the gate this page FAILS.
   */
  it('does not refuse an adapter whose mapItem merges postings its nativeIdOf tells apart', async () => {
    const h = harness({
      pages: [
        onePage([
          job('x', { url: 'https://jobs.example.com/x' }),
          job('y', { url: 'https://jobs.example.com/y' }),
        ]),
      ],
    })
    const batch = await collectJsonPages(
      makeSpec({
        mapItem: (item, cfg) => ({
          namespace: cfg.namespace,
          nativeId: 'one-and-the-same',
          url: item.url,
          title: item.title,
          companyName: item.company,
        }),
        nativeIdOf: (item) => item.id,
      }),
      config(),
      h.ctx,
    )

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error?.code ?? null)).not.toContain('ADAPTER_INVARIANT')
    // One identity key for both, through the NATIVE_ID branch — the premise that makes the gate
    // reachable at all. Asserted, so the case cannot pass by the two items keying separately.
    expect(new Set(batch.observations.map((o) => o.identity.identityKey)).size).toBe(1)
    expect(batch.observations.map((o) => o.identity.identityKind)).toEqual([
      'NATIVE_ID',
      'NATIVE_ID',
    ])
  })
})

/**
 * SPEC-M-2: this layer is SINGLE-NAMESPACE, and that is now a statement with a test behind it
 * rather than a comment claiming a multi-board behaviour the code does not have.
 *
 * What is asserted is the layer boundary itself: one call covers one board, whatever it is handed.
 * The aggregate claim — several boards, one failing, the cycle PARTIAL — is the collector's (plan
 * Task 2.5), and its test belongs with the code that aggregates. What this layer owes that
 * collector is the input that makes the aggregate derivable, which is the second test.
 */
describe('one attempt covers one board', () => {
  it('reports exactly the namespace its scope named', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec(), config({ namespace: 'board-a' }), h.ctx)

    expect(batch.scope.namespace).toBe('board-a')
    // A `SourceCoverageScope` has one `namespace` field, so a batch cannot describe two boards —
    // which is why "one board failing = PARTIAL" has nothing to attach to here.
    expect(Object.keys(batch.scope).sort()).toEqual([
      'configVersion',
      'namespace',
      'query',
      'window',
    ])
  })

  it('gives the collector a failed board it can aggregate: never SUCCEEDED, never FULL_INVENTORY', async () => {
    const h = harness({ pages: [{ status: 500 }] })
    const batch = await collectJsonPages(makeSpec(), config({ namespace: 'board-b' }), h.ctx)

    expect(batch.outcome).not.toBe('SUCCEEDED')
    expect(batch.coverage).not.toBe('FULL_INVENTORY')
    expect(batch.scope.namespace).toBe('board-b')
  })
})

/**
 * The last way out of the reserve→reconcile span: the reconcile itself. Not a finding of this
 * round — found re-reading the `finally` that the findings produced.
 */
describe('a meter that cannot be reconciled loses the reservation, not the batch', () => {
  const metered = { unit: 'REQUEST' as const, amountPerRequest: 1 }

  const brokenReconcile = (h: Harness, failOnCall: number): void => {
    let calls = 0
    h.ctx.meter.reconcile = async () => {
      calls += 1
      if (calls === failOnCall) throw new Error('the meter ledger is unreachable')
    }
  }

  it('resolves rather than rejecting when reconcile throws', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    brokenReconcile(h, 1)

    await expect(
      collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx),
    ).resolves.toBeDefined()
  })

  it('reports the meter failure as ours', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    brokenReconcile(h, 1)
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    const last = batch.requests.at(-1)
    expect(last?.error?.code).toBe('PERSISTENCE')
    expect(last?.error?.message).toContain('the reservation could not be reconciled')
  })

  it('keeps the pages that already landed', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    // Page one reconciles; page two's does not.
    brokenReconcile(h, 2)
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
    expect(batch.counts.normalized).toBe(batch.observations.length)
  })

  it('does not overwrite the reason the page itself failed', async () => {
    // The page failed with a 429 AND the reconcile then threw. The reported code is the one that
    // explains the page, not the bookkeeping that failed after it.
    const h = harness({ pages: [{ status: 429 }] })
    brokenReconcile(h, 1)
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('RATE_LIMIT')
  })
})

/**
 * The non-`Error` branch of each catch this round added, which is the convention the
 * "a thrown non-Error still produces a typed report" block above already follows: a port may
 * reject with a string, and the report must still carry words rather than `undefined`.
 *
 * Added because the mutation gate reported both fallback literals as not executed by any test.
 */
describe('the catches this round added survive a non-Error rejection', () => {
  it('names the cache read failure when the cache rejects with a string', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    h.ctx.cache.get = async () => {
      throw 'redis exploded'
    }
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the response cache could not be read: the cache failed',
    )
  })

  it('names the meter failure when reconcile rejects with a string', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    h.ctx.meter.reconcile = async () => {
      throw 'ledger exploded'
    }
    const batch = await collectJsonPages(
      makeSpec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      h.ctx,
    )

    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the reservation could not be reconciled: the meter failed',
    )
  })
})

/**
 * Task 3.5b, inherited item 1: `markSent` is part of the port and the loop calls it as the request
 * leaves. The store releases only cost it can prove unsent, and that proof is the SENT write
 * having COMMITTED first — so the assertions here are about ORDER and about what a failed write
 * does to the request, not about the call having happened.
 */
describe('SENT is recorded before the request leaves', () => {
  const metered = { unit: 'REQUEST' as const, amountPerRequest: 1 }

  it('awaits markSent to completion before fetchText is entered', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    h.ctx.meter.markSent = async (reservation) => {
      h.calls.push(`markSent:start:${reservation.id}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      h.calls.push(`markSent:committed:${reservation.id}`)
    }
    await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('markSent') || c.startsWith('fetch'))).toEqual([
      'markSent:start:r1',
      'markSent:committed:r1',
      'fetch:1',
    ])
  })

  it('marks the reservation the page took, once per paid request', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('markSent'))).toEqual(['markSent:r1', 'markSent:r2'])
  })

  it('does not send the request when markSent fails, and releases the reservation', async () => {
    const h = harness({ pages: [onePage([job('1')])], markSentThrows: true })
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.sent).toEqual([])
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'RELEASED' }])
    expect(batch.outcome).toBe('FAILED')
    const error = batch.requests.at(-1)?.error
    expect(error?.code).toBe('PERSISTENCE')
    expect(error?.message).toBe(
      'the request was not sent, its reservation could not be marked sent: the meter is down',
    )
  })

  it('names a markSent that rejects with something that is not an Error', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    h.ctx.meter.markSent = () => Promise.reject('boom')
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.sent).toEqual([])
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the request was not sent, its reservation could not be marked sent: the meter failed',
    )
  })

  it('does not mark a reservation sent when the cache read fails first: nothing left', async () => {
    const h = harness({ pages: [onePage([job('1')])], cacheGetThrows: true })
    await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('markSent'))).toEqual([])
  })

  it('does not mark anything for an unmetered source', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)

    expect(h.calls.filter((c) => c.startsWith('markSent'))).toEqual([])
  })

  it('a fetch that throws after markSent still holds UNCERTAIN, not RELEASED', async () => {
    const h = harness({ pages: [{ throws: new Error('timeout') }] })
    await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'UNCERTAIN' }])
  })
})

/**
 * Task 3.5b, inherited item 2: a source whose cost differs from its reservation settles at the
 * cost actually incurred. The reservation here is 50 RECORD units (TheirStack's `limit` maximum);
 * every expected number is written out by hand, not derived from the hook.
 */
describe('settling at the cost actually incurred', () => {
  const metered = (incurredAmount: (bodyText: string) => number | null) => ({
    unit: 'RECORD' as const,
    amountPerRequest: 50,
    incurredAmount,
  })

  it('settles USED at the incurred amount and reports that cost, not the reservation', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => 7) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED', incurred: 7 }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 7 })
  })

  it('hands the hook the body of the response, verbatim', async () => {
    const seen: string[] = []
    const h = harness({ pages: [{ bodyText: JSON.stringify({ jobs: [job('1')], next: null }) }] })
    await collectJsonPages(
      makeSpec({
        meter: metered((body) => {
          seen.push(body)
          return 1
        }),
      }),
      config(),
      h.ctx,
    )

    expect(seen).toEqual([JSON.stringify({ jobs: [job('1')], next: null })])
  })

  it('a free request (0) settles as 1: the store cannot record a USED reservation of nothing', async () => {
    const h = harness({ pages: [onePage([])] })
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => 0) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED', incurred: 1 }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 1 })
  })

  it('1 stays 1: the floor does not raise a real minimum', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec({ meter: metered(() => 1) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED', incurred: 1 }])
  })

  it('AT the reservation (50 of 50) is believed', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => 50) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED', incurred: 50 }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 50 })
  })

  it('PAST the reservation (51 of 50) is not believed: the whole reservation is charged', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => 51) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 50 })
  })

  it.each([
    ['null (the adapter cannot tell)', null],
    ['a negative number', -1],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s charges the whole reservation', async (_label, value) => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => value) }), config(), h.ctx)

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 50 })
  })

  it('a hook that throws is ADAPTER_INVARIANT (no retry acts on it), with its own message, and settles the whole reservation', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(
      makeSpec({
        meter: metered(() => {
          throw new Error('hook bug')
        }),
      }),
      config(),
      h.ctx,
    )

    // The response arrived (so USED, whole): the adapter's defect fails the page instead of being
    // swallowed into a quiet worst-case charge.
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error).toEqual({ code: 'ADAPTER_INVARIANT', message: 'hook bug' })
  })

  it('a hook that throws a non-Error is named as such, not as a network failure', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(
      makeSpec({
        meter: metered(() => {
          throw 'plain string'
        }),
      }),
      config(),
      h.ctx,
    )
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'ADAPTER_INVARIANT',
      message: 'the cost hook threw a non-Error value',
    })
  })

  it('a refused response is charged the whole reservation: the hook is never asked', async () => {
    let asked = 0
    const h = harness({ pages: [{ status: 429 }] })
    await collectJsonPages(
      makeSpec({
        meter: metered(() => {
          asked += 1
          return 3
        }),
      }),
      config(),
      h.ctx,
    )

    expect(asked).toBe(0)
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
  })

  it('an in-flight failure holds UNCERTAIN with no amount: the cost is unknown', async () => {
    let asked = 0
    const h = harness({ pages: [{ throws: new Error('timeout') }] })
    await collectJsonPages(
      makeSpec({
        meter: metered(() => {
          asked += 1
          return 3
        }),
      }),
      config(),
      h.ctx,
    )

    expect(asked).toBe(0)
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'UNCERTAIN' }])
  })

  it('a source with no hook settles without an amount, exactly as before', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(
      makeSpec({ meter: { unit: 'RECORD', amountPerRequest: 50 } }),
      config(),
      h.ctx,
    )

    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'USED' }])
  })

  it('reports the reservation as the cost when the reconcile itself failed', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    h.ctx.meter.reconcile = async () => {
      throw new Error('the meter ledger is unreachable')
    }
    const batch = await collectJsonPages(makeSpec({ meter: metered(() => 7) }), config(), h.ctx)

    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 50 })
  })
})

/**
 * Task 3.5b: the byte cap an adapter declares reaches the transport on the request, and a refusal
 * at that cap is a PAYLOAD_TOO_LARGE that keeps nothing.
 */
describe('the response cap a source declares', () => {
  const TEN_MIB = 10 * 1024 * 1024
  const withCap = (maxBytes: number) => makeSpec({ limits: { maxPages: 5, maxBytes } })
  const metered = { unit: 'REQUEST' as const, amountPerRequest: 1 }

  it('a source that declares no cap sends requests with no maxBytes at all', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(Object.keys(h.sent[0] ?? {})).toEqual(['url'])
  })

  it('a cap equal to the transport default (2 MiB) is not attached: nothing changes for it', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(withCap(2_097_152), config(), h.ctx)
    // DELIBERATELY a deep-equal: this is the pin that a source declaring the default cap puts no
    // new field on the wire at all - the one place where "any new key" is the defect.
    expect(h.sent[0]).toEqual({ url: 'https://api.example.com/jobs?page=1' })
  })

  it('a larger cap (8 000 000) is declared on every request of the attempt', async () => {
    const h = harness({
      pages: [
        { body: { jobs: [job('1')], next: 'c2' } },
        { body: { jobs: [job('2')], next: null } },
      ],
    })
    await collectJsonPages(withCap(8_000_000), config(), h.ctx)
    expect(h.sent.map((r) => r.maxBytes)).toEqual([8_000_000, 8_000_000])
  })

  it('a smaller cap (1000) is declared too, so the transport can stop early', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(withCap(1000), config(), h.ctx)
    expect(h.sent[0]?.maxBytes).toBe(1000)
  })

  it('the smallest cap (1 byte) is a valid declaration: refused only below it', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(withCap(1), config(), h.ctx)
    expect(h.sent[0]?.maxBytes).toBe(1)
  })

  it('a binding that declares no cap at all (the XML bindings) sends no maxBytes key', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const spec = makeSpec()
    await collectPages(
      {
        ...spec,
        limits: { maxPages: 5, maxItemsPerPage: 500 },
        decodeEnvelope: (text) => ({ ok: true, value: JSON.parse(text) as never }),
      },
      config(),
      h.ctx,
    )
    expect(Object.keys(h.sent[0] ?? {})).toEqual(['url'])
  })

  it('the ceiling itself (10 MiB) is accepted and declared', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(withCap(TEN_MIB), config(), h.ctx)
    expect(h.sent[0]?.maxBytes).toBe(10_485_760)
  })

  it.each([
    ['one byte past the ceiling', TEN_MIB + 1],
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    '%s is refused at config time: no checkpoint read, no reservation, no request',
    async (_l, bad) => {
      const h = harness({ pages: [onePage([job('1')])] })
      await expect(
        collectJsonPages(
          makeSpec({ meter: metered, limits: { maxPages: 5, maxBytes: bad } }),
          config(),
          h.ctx,
        ),
      ).rejects.toThrow(/invalid maxBytes/)
      expect(h.calls).toEqual([])
      expect(h.sent).toEqual([])
    },
  )

  it('names the bound in the refusal', async () => {
    const h = harness({ pages: [] })
    await expect(collectJsonPages(withCap(TEN_MIB + 1), config(), h.ctx)).rejects.toThrow(
      'invalid maxBytes: 10485761 (must be 1..10485760)',
    )
  })

  it('a transport refusal at the cap is PAYLOAD_TOO_LARGE, keeps no observation, and holds the cost UNCERTAIN', async () => {
    const h = harness({
      pages: [
        {
          throws: new SourcePayloadTooLargeError(
            'api.example.com',
            8_000_000,
            'exceeded 8000000 bytes',
          ),
        },
      ],
    })
    const batch = await collectJsonPages(
      makeSpec({ meter: metered, limits: { maxPages: 5, maxBytes: 8_000_000 } }),
      config(),
      h.ctx,
    )
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.counts.raw).toBe(0)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'api.example.com response too large: exceeded 8000000 bytes',
    })
    expect(h.reconciles).toEqual([{ id: 'r1', resolution: 'UNCERTAIN' }])
  })

  it('an ordinary network failure is still TRANSIENT_NETWORK, not PAYLOAD_TOO_LARGE', async () => {
    const h = harness({ pages: [{ throws: new Error('socket hang up') }] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.code).toBe('TRANSIENT_NETWORK')
  })

  it('a decoded body past the declared cap is refused as PAYLOAD_TOO_LARGE; at the cap it is parsed', async () => {
    const text = JSON.stringify({ jobs: [], next: null })
    const bytes = new TextEncoder().encode(text).length
    const at = harness({ pages: [{ bodyText: text }] })
    expect((await collectJsonPages(withCap(bytes), config(), at.ctx)).outcome).toBe('SUCCEEDED')
    const past = harness({ pages: [{ bodyText: text }] })
    const batch = await collectJsonPages(withCap(bytes - 1), config(), past.ctx)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })
})

describe('a failure BEFORE the request leaves is named for what it is', () => {
  const metered = { unit: 'REQUEST' as const, amountPerRequest: 1 }

  it('a cache that cannot be read is reported as the cache, not as an unsent request', async () => {
    const h = harness({ pages: [onePage([job('1')])], cacheGetThrows: true })
    const batch = await collectJsonPages(makeSpec({ meter: metered }), config(), h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the response cache could not be read: the response cache is unreachable',
    )
  })
})

describe('SourcePayloadTooLargeError', () => {
  it('carries its name, host and cap, and says which host and why', () => {
    const error = new SourcePayloadTooLargeError('api.example.com', 5, 'exceeded 5 bytes')
    expect(error.name).toBe('SourcePayloadTooLargeError')
    expect(error.host).toBe('api.example.com')
    expect(error.maxBytes).toBe(5)
    expect(error.message).toBe('api.example.com response too large: exceeded 5 bytes')
  })
})

/** SR-M-2: the report states its own URL when the request URL carries a credential. */
describe('a request that carries a credential reports the URL its adapter stated (SR-M-2)', () => {
  const KEY_URL = 'https://api.example.com/key/SECRETKEY12345/jobs'
  const spec = (over: Partial<ReturnType<typeof makeSpec>> = {}) =>
    makeSpec({
      pageRequest: () => ({
        reportUrl: 'https://api.example.com/key/[REDACTED]/jobs',
        request: { url: KEY_URL },
      }),
      ...over,
    })

  it('a successful page reports the stated URL, with NO secret registered', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(spec(), config(), h.ctx)
    expect(batch.requests[0]?.url).toBe('https://api.example.com/key/[REDACTED]/jobs')
    expect(h.sent[0]?.url).toBe(KEY_URL)
    expect(JSON.stringify(batch)).not.toContain('SECRETKEY12345')
  })

  it('a failed page, a cost stop and a refused response all report it', async () => {
    const failed = harness({ pages: [{ status: 500 }] })
    expect((await collectJsonPages(spec(), config(), failed.ctx)).requests.at(-1)?.url).toBe(
      'https://api.example.com/key/[REDACTED]/jobs',
    )
    const stopped = harness({ pages: [], reserveRefusesOnCall: 1 })
    const batch = await collectJsonPages(
      spec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      stopped.ctx,
    )
    expect(batch.requests.at(-1)?.url).toBe('https://api.example.com/key/[REDACTED]/jobs')
    expect(JSON.stringify(batch)).not.toContain('SECRETKEY12345')
  })

  it('a thrown network error that echoes the URL cannot undo the stated URL', async () => {
    const h = harness({ pages: [{ throws: new Error('boom') }] })
    const batch = await collectJsonPages(spec(), config(), h.ctx)
    expect(batch.requests[0]?.url).toBe('https://api.example.com/key/[REDACTED]/jobs')
  })

  it('a request without reportUrl reports its own URL, as before', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    const batch = await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(batch.requests[0]?.url).toBe('https://api.example.com/jobs?page=1')
  })
})

/** SR-M-4: the JSON binding owns what headers an adapter may send. */
describe('the JSON binding admits only argued-for request headers (SR-M-4)', () => {
  const sending = (headers: Record<string, string>) =>
    makeSpec({
      pageRequest: () => ({
        cacheKey: 'p1',
        request: { url: 'https://api.example.com/jobs', headers },
      }),
    })

  it('keeps exactly the allowlist, lowercased', async () => {
    expect([...ALLOWED_JSON_REQUEST_HEADERS].sort()).toEqual([
      'accept',
      'accept-language',
      'authorization',
      'content-type',
      'x-rapidapi-host',
      'x-rapidapi-key',
    ])
  })

  it('drops user-agent, cookie, referer, origin and x-forwarded-for in any letter case', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(
      sending({
        'User-Agent': 'Mozilla/5.0',
        Cookie: 'session=1',
        Referer: 'https://x.test',
        ORIGIN: 'https://x.test',
        'X-Forwarded-For': '1.2.3.4',
        Accept: 'application/json',
      }),
      config(),
      h.ctx,
    )
    expect(h.sent[0]?.headers).toEqual({ accept: 'application/json' })
  })

  it('drops `from` (an e-mail header nobody sends) in any letter case', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(
      sending({ From: 'someone@example.test', Accept: 'a/b' }),
      config(),
      h.ctx,
    )
    expect(h.sent[0]?.headers).toEqual({ accept: 'a/b' })
  })

  it('keeps the credential headers of the keyed schemes', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(
      sending({
        Authorization: 'Bearer k',
        'X-RapidAPI-Key': 'k',
        'x-rapidapi-host': 'h',
        'Content-Type': 'application/json',
      }),
      config(),
      h.ctx,
    )
    expect(h.sent[0]?.headers).toEqual({
      authorization: 'Bearer k',
      'x-rapidapi-key': 'k',
      'x-rapidapi-host': 'h',
      'content-type': 'application/json',
    })
  })

  it('a request whose headers were all refused carries no headers key at all', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectJsonPages(sending({ 'User-Agent': 'x' }), config(), h.ctx)
    expect(Object.keys(h.sent[0] ?? {})).toEqual(['url'])
  })

  it("the loop's own conditional headers are added after the filter", async () => {
    const h = harness({
      pages: [{ status: 304 }],
      cacheSeed: { p1: { etag: '"v1"', bodyText: JSON.stringify({ jobs: [], next: null }) } },
    })
    await collectJsonPages(sending({ Accept: 'application/json', Cookie: 'x' }), config(), h.ctx)
    expect(h.sent[0]?.headers).toEqual({ accept: 'application/json', 'if-none-match': '"v1"' })
  })
})

/** SR-M-5: the cap is validated where the field is consumed, whichever binding set it. */
describe('collectPages validates the cap it consumes (SR-M-5)', () => {
  const bare = (requestMaxBytes: number) => ({
    ...makeSpec(),
    limits: { maxPages: 5, maxItemsPerPage: 500 },
    requestMaxBytes,
    decodeEnvelope: (text: string) => ({ ok: true as const, value: JSON.parse(text) as never }),
  })

  it.each([
    ['ceiling+1', 10 * 1024 * 1024 + 1],
    ['a fraction', 2_097_152.5],
    ['zero', 0],
    ['NaN', Number.NaN],
  ])(
    '%s is refused before any call, by a binding that is not collectJsonPages',
    async (_l, bad) => {
      const h = harness({ pages: [onePage([job('1')])] })
      await expect(collectPages(bare(bad), config(), h.ctx)).rejects.toThrow(/invalid maxBytes/)
      expect(h.calls).toEqual([])
    },
  )

  it('the ceiling is accepted there too', async () => {
    const h = harness({ pages: [onePage([job('1')])] })
    await collectPages(bare(10 * 1024 * 1024), config(), h.ctx)
    expect(h.sent[0]?.maxBytes).toBe(10_485_760)
  })
})

describe('U2: a JSON page`s envelope fingerprint reaches the context', () => {
  it('is the fingerprint of the page body`s field names', async () => {
    const page = onePage([job('1')])
    const h = harness({ pages: [page] })
    const seen: string[] = []
    h.ctx.observeEnvelope = (fp) => {
      seen.push(fp)
    }
    await collectJsonPages(makeSpec(), config(), h.ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(seen[0]).toBe(jsonEnvelopeFingerprint(page.body))
  })
})
