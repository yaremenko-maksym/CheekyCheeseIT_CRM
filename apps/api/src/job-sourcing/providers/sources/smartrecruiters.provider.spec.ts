import { describe, expect, it } from 'vitest'
import { expectNoneOf, expectOnlyPublicRequests } from '../../../test/ats-b-assertions'
import { readFixtureText } from '../../../test/fixture-provenance'
import type {
  CachedResponse,
  CollectionContext,
  FetchRequest,
  ValidatedCheckpoint,
} from '../reporting-provider'
import { boardVerdictOf } from './ats-config'
import {
  createSmartRecruitersProvider,
  SMARTRECRUITERS_BOUNDS,
  smartrecruitersProvider,
} from './smartrecruiters.provider'

/**
 * SmartRecruiters through its provider.
 *
 * !! NO AUTHENTIC PAYLOAD EXISTS FOR THIS SOURCE. `api.smartrecruiters.com/robots.txt` disallows
 * this collector (the committed capture and its provenance say so), so no request was sent to the
 * API. Every payload below is BUILT FROM THE DOCUMENTED SCHEMA
 * (https://developers.smartrecruiters.com/reference/v1getposting) by the builders at the top, and
 * every expected value is a literal written next to the input that produces it. These tests prove
 * the adapter's behaviour on the documented shape; they do not prove the shape matches the live
 * API, which is why the source stays disabled.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const ACME = { name: 'Acme Inc', evidence: 'company.name on the documented example' }

const cfg = (board = 'Acme', extra: Record<string, unknown> = {}) =>
  smartrecruitersProvider.parseConfig({ configVersion: 1, board, ...extra })

// ---- payload builders (documented schema)
const listItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  uuid: `uuid-${id}`,
  name: `Posting ${id}`,
  company: { identifier: 'Acme', name: 'Acme Inc' },
  releasedDate: '2026-10-01T10:00:00.000Z',
  location: { city: 'San Francisco', region: 'CA', country: 'us', remote: true },
  department: { id: '1', label: 'Finance' },
  function: { id: 'f', label: 'Accounting' },
  industry: { id: 'i', label: 'Internet' },
  typeOfEmployment: { id: 't', label: 'Permanent' },
  experienceLevel: { id: 'mid_senior_level', label: 'Mid-Senior Level' },
  ref: `https://api.smartrecruiters.com/api-v1/companies/Acme/postings/${id}`,
  ...extra,
})
const detail = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Posting ${id}`,
  postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}-posting`,
  applyUrl: `https://www.smartrecruiters.com/Acme/${id}-posting?oga=true`,
  active: true,
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p>We build things.</p>' },
      jobDescription: { title: 'Job Description', text: '<p>You run books &amp; ledgers.</p>' },
      qualifications: { title: 'Qualifications', text: '<ul><li>CPA</li></ul>' },
      additionalInformation: { title: 'Additional Information', text: '<p>Remote ok.</p>' },
    },
  },
  ...extra,
})
const listPage = (items: unknown[], total: number | null, offset = 0) => ({
  limit: 100,
  offset,
  ...(total === null ? {} : { totalFound: total }),
  content: items,
})

// ---- the world: scripted answers by URL, a budget, a cache, a store
interface World {
  ctx: CollectionContext
  sent: FetchRequest[]
  reserved: number
  reconciled: string[]
  saved: { observations: unknown[]; checkpoint: ValidatedCheckpoint }[]
  cache: Map<string, CachedResponse>
}
function world(opts: {
  answer: (request: FetchRequest) => {
    status?: number
    body?: unknown
    headers?: Record<string, string>
  }
  budget?: number
  cache?: Map<string, CachedResponse>
  stored?: ValidatedCheckpoint | null
  signal?: AbortSignal
  now?: Date
  failSave?: boolean
}): World {
  const sent: FetchRequest[] = []
  const saved: World['saved'] = []
  const cache = opts.cache ?? new Map<string, CachedResponse>()
  const reconciled: string[] = []
  const w = { reserved: 0 }
  const now = opts.now ?? NOW
  const ctx: CollectionContext = {
    run: { sourceId: 's', cycleId: 'c', attemptId: 'a', fencingEpoch: 1 },
    policyVersion: 1,
    signal: opts.signal ?? new AbortController().signal,
    deadline: new Date('2030-01-01T00:00:00Z'),
    now: () => now,
    secrets: [],
    async fetchText(request) {
      sent.push(request)
      const a = opts.answer(request)
      return {
        status: a.status ?? 200,
        bodyText: typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {}),
        headers: a.headers ?? {},
        etag: null,
      }
    },
    meter: {
      async reserve(unit, amount) {
        if (opts.budget !== undefined && w.reserved >= opts.budget) return null
        w.reserved += 1
        return { id: `r${w.reserved}`, unit, amount }
      },
      async reconcile(_reservation, resolution) {
        reconciled.push(resolution)
      },
    },
    checkpoints: {
      async load() {
        return opts.stored ?? null
      },
      async savePage(page) {
        if (opts.failSave === true) throw new Error('disk full')
        saved.push(page)
      },
    },
    cache: {
      async get(key) {
        return cache.get(key) ?? null
      },
      async put(key, value) {
        cache.set(key, value)
      },
    },
  }
  return {
    ctx,
    sent,
    get reserved() {
      return w.reserved
    },
    reconciled,
    saved,
    cache,
  }
}

const idOf = (url: string) => /\/postings\/([^/?]+)$/.exec(url)?.[1]
const isDetail = (r: FetchRequest) => idOf(r.url) !== undefined
const listUrl = (offset = 0, board = 'Acme') =>
  `https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100&offset=${offset}`

/** One list page of `ids`, and a detail for each, unless `details` says otherwise. */
const simple =
  (ids: string[], details: Record<string, { status?: number; body?: unknown }> = {}) =>
  (request: FetchRequest) => {
    const id = idOf(request.url)
    if (id === undefined)
      return {
        body: listPage(
          ids.map((i) => listItem(i)),
          ids.length,
        ),
      }
    return details[id] ?? { body: detail(id) }
  }

async function run(w: World, config = cfg(), provider = smartrecruitersProvider) {
  return provider.collectReport(config, w.ctx)
}
const detailRequests = (w: World) => w.sent.filter(isDetail)

describe('the requests (public, built here, never from the data)', () => {
  it('asks the list with limit=100 and offset=0, then one detail per posting', async () => {
    const w = world({ answer: simple(['111', '222']) })
    await run(w)
    expect(w.sent.map((r) => r.url)).toEqual([
      listUrl(0),
      'https://api.smartrecruiters.com/v1/companies/Acme/postings/111',
      'https://api.smartrecruiters.com/v1/companies/Acme/postings/222',
    ])
    expect(w.sent.every((r) => JSON.stringify(r.headers) === '{"accept":"application/json"}')).toBe(
      true,
    )
  })

  it('never builds an authorised, token-bearing or foreign request (AC1)', async () => {
    const w = world({ answer: simple(['111', '222']) })
    await run(w)
    expectOnlyPublicRequests(w.sent, /^api\.smartrecruiters\.com$/, ['accept'])
  })

  it('never follows the ref URL in the data: a posting whose ref points elsewhere is fetched from OUR address', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([listItem('111', { ref: 'https://evil.example/steal' })], 1) }
          : { body: detail('111') },
    })
    await run(w)
    expect(w.sent.map((r) => new URL(r.url).host)).toEqual([
      'api.smartrecruiters.com',
      'api.smartrecruiters.com',
    ])
    expectNoneOf(w.sent, ['evil.example'])
  })

  it('a posting id that is not a plain identifier is invalid and is never put in a path', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? {
              body: listPage(
                [listItem('../../x'), listItem('a/b'), listItem('a?b=1'), listItem('ok-1_2')],
                4,
              ),
            }
          : { body: detail('ok-1_2') },
    })
    const batch = await run(w)
    expect(detailRequests(w).map((r) => r.url)).toEqual([
      'https://api.smartrecruiters.com/v1/companies/Acme/postings/ok-1_2',
    ])
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 1,
      invalid: 3,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('is the SMARTRECRUITERS_ATS provider with documented bounds', () => {
    expect(smartrecruitersProvider.type).toBe('SMARTRECRUITERS_ATS')
    expect(SMARTRECRUITERS_BOUNDS).toEqual({ maxListPages: 20, maxRequests: 400, pageSize: 100 })
  })
})

describe('detail enriched', () => {
  it('maps every field of an enriched posting (documented schema, literal expectations)', async () => {
    const w = world({ answer: simple(['111']) })
    const batch = await run(w, cfg('Acme', { employer: ACME }))
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'SMARTRECRUITERS_ATS',
      // The identity seam folds the namespace to lower case, so `Acme` and `acme` are one board.
      namespace: 'smartrecruiters:acme',
      nativeId: '111',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://jobs.smartrecruiters.com/Acme/111-posting')
    expect(o?.applicationUrl).toBe('https://www.smartrecruiters.com/Acme/111-posting?oga=true')
    expect(o?.normalized.title).toBe('Posting 111')
    expect(o?.normalized.companyName).toBe('Acme Inc')
    expect(o?.normalized.location).toBe('San Francisco, CA, us')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.employmentType).toBe('Permanent')
    expect(o?.normalized.seniorityHint).toBe('Mid-Senior Level')
    expect(o?.normalized.tags).toEqual(['Finance', 'Accounting', 'Internet'])
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-01T10:00:00.000Z')
    expect(o?.adapterVersion).toBe('smartrecruiters-1')
  })

  it('the description is the four sections, each under its title, in the documented order', async () => {
    const w = world({ answer: simple(['111']) })
    const batch = await run(w)
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    const order = [
      'Company Description',
      'Job Description',
      'Qualifications',
      'Additional Information',
    ]
    const at = order.map((t) => md.indexOf(t))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(md).toContain('You run books & ledgers.')
    expect(md).not.toContain('&amp;')
  })

  it('a section title is text, never markup', async () => {
    const w = world({
      answer: simple(['111'], {
        '111': {
          body: detail('111', {
            jobAd: {
              sections: { jobDescription: { title: '<script>x</script>', text: '<p>Body</p>' } },
            },
          }),
        },
      }),
    })
    const batch = await run(w)
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    expect(md).toContain('Body')
    expect(md).toContain('\\<script\\>x\\</script\\>')
  })

  it('the batch is a complete inventory with its counts, scope and one report per request', async () => {
    const w = world({ answer: simple(['111', '222']) })
    const batch = await run(w)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.scope).toEqual({
      namespace: 'smartrecruiters:Acme',
      query: null,
      configVersion: 1,
      window: null,
    })
    expect(batch.requests.map((r) => [r.status, r.error, r.cost])).toEqual([
      [200, null, { unit: 'REQUEST', amount: 1 }],
      [200, null, { unit: 'REQUEST', amount: 1 }],
      [200, null, { unit: 'REQUEST', amount: 1 }],
    ])
    expect(w.saved).toHaveLength(1)
    expect(w.saved[0]?.checkpoint.position).toEqual({ kind: 'RESTART', page: 1 })
  })
})

describe('detail absent', () => {
  it('a posting whose detail is 404 is still observed, list-only, with the URL built from the company and id', async () => {
    const w = world({
      answer: simple(['111'], { '111': { status: 404, body: { message: 'gone' } } }),
    })
    const batch = await run(w)
    const o = batch.observations[0]
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(o?.sourcePostingUrl).toBe('https://jobs.smartrecruiters.com/Acme/111')
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.descriptionMd ?? '').toBe('')
    expect(o?.normalized.title).toBe('Posting 111')
    expect(batch.requests.map((r) => [r.status, r.error])).toEqual([
      [200, null],
      [404, null],
    ])
  })

  it('a detail that is not the posting asked for (another id, not JSON) leaves it list-only, is sampled and is not cached', async () => {
    for (const body of [detail('999'), '<html>oops</html>']) {
      const w = world({ answer: simple(['111'], { '111': { body } }) })
      const batch = await run(w)
      expect(batch.observations[0]?.normalized.descriptionMd ?? '').toBe('')
      expect(batch.observations[0]?.sourcePostingUrl).toBe(
        'https://jobs.smartrecruiters.com/Acme/111',
      )
      expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
        'DETAIL_UNUSABLE: not the posting detail asked for',
      ])
      expect(w.cache.size).toBe(0)
    }
  })

  it('a detail of the right id with no sections is usable: no description, but its own URL', async () => {
    const w = world({
      answer: simple(['111'], {
        '111': { body: { id: '111', postingUrl: 'https://jobs.smartrecruiters.com/Acme/111-x' } },
      }),
    })
    const batch = await run(w)
    expect(batch.observations[0]?.sourcePostingUrl).toBe(
      'https://jobs.smartrecruiters.com/Acme/111-x',
    )
    expect(batch.observations[0]?.normalized.descriptionMd ?? '').toBe('')
    expect(batch.invalidSamples).toEqual([])
    expect(w.cache.size).toBe(1)
  })

  it('any other failure of a detail ends the attempt with that code and stores nothing from the page', async () => {
    for (const [status, code] of [
      [403, 'ACCESS_POLICY'],
      [429, 'RATE_LIMIT'],
      [500, 'UPSTREAM'],
    ] as const) {
      const w = world({ answer: simple(['111', '222'], { '111': { status, body: 'x' } }) })
      const batch = await run(w)
      expect(batch.outcome).toBe('FAILED')
      expect(batch.requests.at(-1)?.error?.code).toBe(code)
      expect(batch.counts).toEqual({
        raw: 2,
        normalized: 0,
        invalid: 0,
        quarantined: 0,
        discarded: 2,
      })
      expect(w.saved).toEqual([])
      expect(detailRequests(w)).toHaveLength(1)
    }
  })
})

describe('details only for new or changed postings', () => {
  it('a second run over the same list fetches NO detail and still returns enriched observations', async () => {
    const cache = new Map<string, CachedResponse>()
    const first = world({ answer: simple(['111', '222', '333']), cache })
    await run(first)
    expect(detailRequests(first)).toHaveLength(3)

    const second = world({ answer: simple(['111', '222', '333']), cache })
    const batch = await run(second)
    expect(second.sent.map((r) => r.url)).toEqual([listUrl(0)])
    expect(second.reserved).toBe(1)
    expect(batch.observations).toHaveLength(3)
    expect(batch.observations.map((o) => o.sourcePostingUrl)).toEqual([
      'https://jobs.smartrecruiters.com/Acme/111-posting',
      'https://jobs.smartrecruiters.com/Acme/222-posting',
      'https://jobs.smartrecruiters.com/Acme/333-posting',
    ])
    expect(batch.observations[0]?.normalized.descriptionMd).toContain('You run books')
  })

  it('a changed posting (a new release date) and a new one are fetched; an unchanged one is not', async () => {
    const cache = new Map<string, CachedResponse>()
    await run(world({ answer: simple(['111', '222']), cache }))

    const second = world({
      cache,
      answer: (r) =>
        idOf(r.url) === undefined
          ? {
              body: listPage(
                [
                  listItem('111'),
                  listItem('222', { releasedDate: '2026-10-20T10:00:00.000Z' }),
                  listItem('333'),
                ],
                3,
              ),
            }
          : { body: detail(idOf(r.url) as string) },
    })
    const batch = await run(second)
    expect(detailRequests(second).map((r) => idOf(r.url))).toEqual(['222', '333'])
    expect(batch.observations).toHaveLength(3)
  })

  it.each([
    ['name', { name: 'Renamed' }],
    ['refNumber', { refNumber: 'R-9' }],
    ['releasedDate', { releasedDate: '2026-10-02T10:00:00.000Z' }],
    ['visibility', { visibility: 'INTERNAL' }],
    ['location', { location: { city: 'Berlin' } }],
    ['industry', { industry: { label: 'Other' } }],
    ['department', { department: { label: 'Sales' } }],
    ['function', { function: { label: 'Other' } }],
    ['typeOfEmployment', { typeOfEmployment: { label: 'Contract' } }],
    ['experienceLevel', { experienceLevel: { label: 'Entry' } }],
    ['customField', { customField: [{ fieldId: 'a' }] }],
  ])(
    "a change in the list item's %s makes its detail be fetched again; no change does not",
    async (_field, change) => {
      const withItem = (item: Record<string, unknown>) => (r: FetchRequest) =>
        idOf(r.url) === undefined ? { body: listPage([item], 1) } : { body: detail('111') }
      const base = listItem('111', { refNumber: 'R-1', visibility: 'PUBLIC', customField: [] })
      const cache = new Map<string, CachedResponse>()
      await run(world({ answer: withItem(base), cache }))
      const same = world({ answer: withItem(base), cache })
      await run(same)
      expect(detailRequests(same)).toHaveLength(0)
      const changed = world({ answer: withItem({ ...base, ...change }), cache })
      await run(changed)
      expect(detailRequests(changed)).toHaveLength(1)
    },
  )

  it('a cached detail that is no longer readable is fetched again instead of being trusted', async () => {
    const cache = new Map<string, CachedResponse>()
    await run(world({ answer: simple(['111']), cache }))
    for (const [key, value] of cache) cache.set(key, { ...value, bodyText: 'not json' })
    const second = world({ answer: simple(['111']), cache })
    await run(second)
    expect(detailRequests(second)).toHaveLength(1)
  })

  it('a cache that cannot be read or written costs requests, never the page', async () => {
    const w = world({ answer: simple(['111']) })
    w.ctx.cache.get = async () => {
      throw new Error('cache down')
    }
    w.ctx.cache.put = async () => {
      throw new Error('cache down')
    }
    const batch = await run(w)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(1)
  })
})

describe('the budget includes detail pages (AC4)', () => {
  it('the meter is reserved for the list AND for every detail, before each request', async () => {
    const w = world({ answer: simple(['111', '222']) })
    await run(w)
    expect(w.reserved).toBe(3)
    expect(w.reconciled).toEqual(['USED', 'USED', 'USED'])
  })

  it('a budget that runs out on the details is a COST_STOP: the page is discarded and the counts say so', async () => {
    const w = world({ answer: simple(['111', '222', '333']), budget: 2 })
    const batch = await run(w)
    expect(detailRequests(w)).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 3,
    })
    expect(batch.requests.map((r) => r.error?.code ?? null)).toEqual([null, null, 'COST_STOP'])
    expect(batch.requests.at(-1)?.status).toBeNull()
    expect(w.saved).toEqual([])
    expect(batch.checkpoint).toBeNull()
  })

  it('the next attempt finds the fetched details in the cache and gets further (progress is guaranteed)', async () => {
    const cache = new Map<string, CachedResponse>()
    await run(world({ answer: simple(['111', '222', '333']), budget: 2, cache }))
    const second = world({ answer: simple(['111', '222', '333']), budget: 3, cache })
    const batch = await run(second)
    expect(detailRequests(second).map((r) => idOf(r.url))).toEqual(['222', '333'])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(3)
  })

  it('when pages already landed, a cost stop on a later page is PARTIAL and the checkpoint is the last good page', async () => {
    const pageOne = Array.from({ length: 2 }, (_, i) => listItem(String(100 + i)))
    const pageTwo = [listItem('300'), listItem('301')]
    const provider = createSmartRecruitersProvider({
      maxListPages: 5,
      maxRequests: 50,
      pageSize: 2,
    })
    const w = world({
      budget: 5,
      answer: (r) => {
        const id = idOf(r.url)
        if (id !== undefined) return { body: detail(id) }
        return r.url.endsWith('offset=0')
          ? { body: listPage(pageOne, 4) }
          : { body: listPage(pageTwo, 4, 2) }
      },
    })
    const batch = await run(w, cfg(), provider)
    // list(1) + 2 details + list(1) + 1 detail = 5 reservations; the 6th (the second detail) is refused
    expect(w.reserved).toBe(5)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(2)
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 2,
    })
    expect(batch.checkpoint?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: '2' })
    expect(w.saved).toHaveLength(1)
  })

  it('the request bound counts details too: at the bound it completes, past it it stops with PAGE_CAP', async () => {
    const provider = createSmartRecruitersProvider({
      maxListPages: 5,
      maxRequests: 3,
      pageSize: 100,
    })
    const atBound = world({ answer: simple(['111', '222']) })
    expect((await run(atBound, cfg(), provider)).outcome).toBe('SUCCEEDED')
    expect(atBound.sent).toHaveLength(3)

    const pastBound = world({ answer: simple(['111', '222', '333']) })
    const batch = await run(pastBound, cfg(), provider)
    expect(pastBound.sent).toHaveLength(3)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 3,
    })
  })

  it('a refused reservation is released, an in-flight failure is UNCERTAIN, never claimed unused', async () => {
    const w = world({ answer: simple(['111']), budget: 1 })
    await run(w)
    expect(w.reconciled).toEqual(['USED'])
    const boom = world({ answer: () => ({}) })
    boom.ctx.fetchText = async () => {
      throw new Error('socket hang up')
    }
    const batch = await run(boom)
    expect(boom.reconciled).toEqual(['UNCERTAIN'])
    expect(batch.requests[0]?.error?.code).toBe('TRANSIENT_NETWORK')
  })
})

describe('the list: paging, bounds, resume', () => {
  const small = createSmartRecruitersProvider({ maxListPages: 2, maxRequests: 100, pageSize: 2 })
  const pages =
    (answer: (offset: number) => { items: string[]; total: number | null }) =>
    (r: FetchRequest) => {
      const id = idOf(r.url)
      if (id !== undefined) return { body: detail(id) }
      const offset = Number(new URL(r.url).searchParams.get('offset'))
      const { items, total } = answer(offset)
      return {
        body: listPage(
          items.map((i) => listItem(i)),
          total,
          0,
        ),
      }
    }

  it('asks the next page at the offset it has actually read, whatever the provider echoes', async () => {
    const w = world({
      answer: pages((o) => ({ items: o === 0 ? ['1', '2'] : ['3'], total: 3 })),
    })
    const batch = await run(w, cfg(), small)
    expect(
      w.sent.filter((r) => !isDetail(r)).map((r) => new URL(r.url).searchParams.get('offset')),
    ).toEqual(['0', '2'])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.normalized).toBe(3)
    expect(w.saved.map((s) => s.checkpoint.position)).toEqual([
      { kind: 'CURSOR', page: 1, cursor: '2' },
      { kind: 'RESTART', page: 2 },
    ])
  })

  it('stops at totalFound; with no totalFound a full page continues and a short one ends', async () => {
    const full = world({
      answer: pages((o) => ({ items: o === 0 ? ['1', '2'] : ['3'], total: null })),
    })
    await run(full, cfg(), small)
    expect(full.sent.filter((r) => !isDetail(r))).toHaveLength(2)
    const short = world({ answer: pages(() => ({ items: ['1'], total: null })) })
    await run(short, cfg(), small)
    expect(short.sent.filter((r) => !isDetail(r))).toHaveLength(1)
  })

  it('an empty page ends the walk even when totalFound promises more (no loop on a lying provider)', async () => {
    const w = world({ answer: pages(() => ({ items: [], total: 50 })) })
    const batch = await run(w, cfg(), small)
    expect(w.sent).toHaveLength(1)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('the page bound: at it the walk completes, past it PAGE_CAP and a PARTIAL coverage', async () => {
    const two = world({ answer: pages((o) => ({ items: o === 0 ? ['1', '2'] : ['3'], total: 3 })) })
    expect((await run(two, cfg(), small)).coverage).toBe('FULL_INVENTORY')
    const endless = world({
      answer: pages((o) => ({ items: [String(o + 1), String(o + 2)], total: 99 })),
    })
    const batch = await run(endless, cfg(), small)
    expect(endless.sent.filter((r) => !isDetail(r))).toHaveLength(2)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.checkpoint?.position).toEqual({ kind: 'CURSOR', page: 2, cursor: '4' })
  })

  it('a page with more postings than the page size is drift, not silently truncated', async () => {
    const w = world({ answer: pages(() => ({ items: ['1', '2', '3'], total: 3 })) })
    const batch = await run(w, cfg(), small)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(detailRequests(w)).toEqual([])
    expect(batch.observations).toEqual([])
  })

  it('resumes at the stored offset and does not claim a full inventory', async () => {
    const stored: ValidatedCheckpoint = {
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'smartrecruiters-1',
      position: { kind: 'CURSOR', page: 3, cursor: '300' },
      completedAt: new Date('2026-10-23T00:00:00Z'),
    }
    const w = world({ answer: simple(['9']), stored })
    const batch = await run(w)
    expect(w.sent[0]?.url).toBe(listUrl(300))
    expect(batch.coverage).toBe('PARTIAL')
    expect(w.saved[0]?.checkpoint.position).toEqual({ kind: 'RESTART', page: 4 })
  })

  it('a stored cursor that is not an offset is refused before any request', async () => {
    for (const cursor of ['abc', '-1', '1.5', '1234567890', '0; drop']) {
      const stored: ValidatedCheckpoint = {
        configVersion: 1,
        policyVersion: 1,
        adapterVersion: 'smartrecruiters-1',
        position: { kind: 'CURSOR', page: 1, cursor },
        completedAt: new Date('2026-10-23T00:00:00Z'),
      }
      const w = world({ answer: simple(['9']), stored })
      const batch = await run(w)
      expect(w.sent).toEqual([])
      expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
    }
  })

  it('a stored cursor of nine digits is an offset', async () => {
    const stored: ValidatedCheckpoint = {
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'smartrecruiters-1',
      position: { kind: 'CURSOR', page: 1, cursor: '123456789' },
      completedAt: new Date('2026-10-23T00:00:00Z'),
    }
    const w = world({ answer: simple(['9']), stored })
    await run(w)
    expect(w.sent[0]?.url).toBe(listUrl(123456789))
  })
})

describe('failures, cancellation and isolation', () => {
  it('a cancelled run makes no request', async () => {
    const controller = new AbortController()
    controller.abort()
    const w = world({ answer: simple(['1']), signal: controller.signal })
    const batch = await run(w)
    expect(w.sent).toEqual([])
    expect(batch.outcome).toBe('CANCELLED')
  })

  it("a board that does not exist is a BOARD problem; 401/403/429 are the source's", async () => {
    const gone = await run(world({ answer: () => ({ status: 404, body: 'x' }) }))
    expect(boardVerdictOf(gone)).toBe('BOARD_NOT_FOUND')
    for (const [status, code] of [
      [401, 'ACCESS_POLICY'],
      [403, 'ACCESS_POLICY'],
      [429, 'RATE_LIMIT'],
    ] as const) {
      const batch = await run(world({ answer: () => ({ status, body: 'x' }) }))
      expect(batch.requests.map((r) => r.error?.code)).toEqual([code])
      expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
    }
  })

  it('error reports carry the status and never the body or headers (AC2, by value)', async () => {
    const secret = 'sr_tok_83ac19f0e2'
    const batch = await run(
      world({
        answer: () => ({
          status: 403,
          body: `{"message":"${secret}"}`,
          headers: { 'x-smart-token': secret },
        }),
      }),
    )
    expect(batch.requests.map((r) => r.error?.message)).toEqual(['provider answered HTTP 403'])
    expectNoneOf(batch, [secret, 'x-smart-token'])
  })

  it('a list body that is not JSON or not the envelope is drift', async () => {
    for (const body of ['<html/>', { items: [] }, { content: 'nope' }]) {
      const batch = await run(world({ answer: () => ({ body }) }))
      expect(batch.outcome).toBe('FAILED')
      expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    }
  })

  it("a page that cannot be persisted is discarded as ours, not the provider's", async () => {
    const w = world({ answer: simple(['111']), failSave: true })
    const batch = await run(w)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error).toEqual({ code: 'PERSISTENCE', message: 'disk full' })
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 1,
    })
  })

  it('one bad posting is isolated; its neighbours are kept', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([{ id: 5 }, listItem('111'), { name: 'no id' }], 3) }
          : { body: detail('111') },
    })
    const batch = await run(w)
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 1,
      invalid: 2,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['111'])
  })

  it('an internal posting or an inactive detail is not an open vacancy', async () => {
    const w = world({
      answer: (r) => {
        const id = idOf(r.url)
        if (id === undefined) {
          return {
            body: listPage(
              [listItem('1', { visibility: 'INTERNAL' }), listItem('2'), listItem('3')],
              3,
            ),
          }
        }
        return { body: detail(id, id === '2' ? { active: false } : {}) }
      },
    })
    const batch = await run(w)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['3'])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 1,
      invalid: 0,
      quarantined: 2,
      discarded: 0,
    })
  })

  it('with no payload company and no verified employer the posting is quarantined; with the evidence it is named', async () => {
    const body = (id: string) => ({ body: listPage([listItem(id, { company: null })], 1) })
    const without = world({
      answer: (r) => (idOf(r.url) === undefined ? body('1') : { body: detail('1') }),
    })
    expect((await run(without)).counts.quarantined).toBe(1)
    const withEvidence = world({
      answer: (r) => (idOf(r.url) === undefined ? body('1') : { body: detail('1') }),
    })
    expect(
      (await run(withEvidence, cfg('Acme', { employer: ACME }))).observations[0]?.normalized
        .companyName,
    ).toBe('Acme Inc')
  })

  it('workplace: remote true, hybrid and remote false are not remote, no flag is unknown', async () => {
    const cases: [Record<string, unknown>, boolean | null][] = [
      [{ remote: true }, true],
      [{ hybrid: true }, false],
      [{ remote: false }, false],
      [{}, null],
    ]
    for (const [location, expected] of cases) {
      const w = world({
        answer: (r) =>
          idOf(r.url) === undefined
            ? { body: listPage([listItem('1', { location })], 1) }
            : { body: detail('1') },
      })
      const batch = await run(w)
      expect(batch.observations[0]?.normalized.remote ?? null).toBe(expected)
    }
  })
})

describe('the committed evidence', () => {
  it('the robots.txt capture says the API is disallowed to every agent but one named crawler', () => {
    expect(readFixtureText('smartrecruiters', 'api-robots.txt')).toBe(
      'User-agent: LinkedInBot\nAllow: /v1/companies/\nUser-agent: *\nDisallow: /\n',
    )
  })
})
