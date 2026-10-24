import { describe, expect, it } from 'vitest'
import { expectNoneOf, expectOnlyPublicRequests } from '../../../test/ats-b-assertions'
import { readFixtureText } from '../../../test/fixture-provenance'
import {
  HN_OWNER_DECISION,
  type OwnerDecision,
  SMARTRECRUITERS_OWNER_DECISION,
} from '../owner-decisions'
import type {
  CachedResponse,
  CollectionContext,
  FetchRequest,
  ValidatedCheckpoint,
} from '../reporting-provider'
import { boardVerdictOf } from './ats-config'
import {
  createSmartRecruitersProvider,
  smartrecruitersAllowedHosts,
  SMARTRECRUITERS_BOUNDS,
  SMARTRECRUITERS_ENDPOINT_VARIANT,
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

const cfg = (board = 'acme', extra: Record<string, unknown> = {}) =>
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
  deadline?: Date
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
    deadline: opts.deadline ?? new Date('2030-01-01T00:00:00Z'),
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
const listUrl = (offset = 0, board = 'acme') =>
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

const live = createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, {
  ownerDecision: SMARTRECRUITERS_OWNER_DECISION,
})

async function run(w: World, config = cfg(), provider = live) {
  return provider.collectReport(config, w.ctx)
}
const detailRequests = (w: World) => w.sent.filter(isDetail)

describe('the requests (public, built here, never from the data)', () => {
  it('asks the list with limit=100 and offset=0, then one detail per posting', async () => {
    const w = world({ answer: simple(['111', '222']) })
    await run(w)
    expect(w.sent.map((r) => r.url)).toEqual([
      listUrl(0),
      'https://api.smartrecruiters.com/v1/companies/acme/postings/111',
      'https://api.smartrecruiters.com/v1/companies/acme/postings/222',
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
      'https://api.smartrecruiters.com/v1/companies/acme/postings/ok-1_2',
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
    const batch = await run(w, cfg('acme', { employer: ACME }))
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'SMARTRECRUITERS_ATS',
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
      namespace: 'smartrecruiters:acme',
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
    expect(o?.sourcePostingUrl).toBe('https://jobs.smartrecruiters.com/acme/111')
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
        'https://jobs.smartrecruiters.com/acme/111',
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
    const provider = createSmartRecruitersProvider(
      {
        maxListPages: 5,
        maxRequests: 50,
        pageSize: 2,
      },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
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
    const provider = createSmartRecruitersProvider(
      {
        maxListPages: 5,
        maxRequests: 3,
        pageSize: 100,
      },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
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
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('the list: paging, bounds, resume', () => {
  const small = createSmartRecruitersProvider(
    { maxListPages: 2, maxRequests: 100, pageSize: 2 },
    { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
  )
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
      (await run(withEvidence, cfg('acme', { employer: ACME }))).observations[0]?.normalized
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

describe('every refusal says what it is (messages, codes, statuses asserted exactly)', () => {
  const small = createSmartRecruitersProvider(
    { maxListPages: 2, maxRequests: 3, pageSize: 2 },
    { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
  )

  it('the request bound reports its own number', async () => {
    const w = world({ answer: simple(['1', '2', '3']) })
    const provider = createSmartRecruitersProvider(
      {
        maxListPages: 5,
        maxRequests: 3,
        pageSize: 100,
      },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
    const batch = await run(w, cfg(), provider)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PAGE_CAP',
      message: 'the attempt reached its 3-request bound',
    })
    expect(batch.requests.at(-1)?.status).toBeNull()
  })

  it('the page bound reports its own number', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([listItem('1'), listItem('2')], 99) }
          : { body: detail(idOf(r.url) as string) },
    })
    const pageBound = createSmartRecruitersProvider(
      {
        maxListPages: 2,
        maxRequests: 100,
        pageSize: 2,
      },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
    const batch = await run(w, cfg(), pageBound)
    expect(batch.requests.map((r) => r.error?.message ?? null)).toContain(
      'the attempt reached its 2-page bound',
    )
  })

  it('a cancelled run says so, and a cancel in the middle of the details ends the run CANCELLED', async () => {
    const controller = new AbortController()
    controller.abort()
    const before = await run(world({ answer: simple(['1']), signal: controller.signal }))
    expect(before.requests[0]?.error).toEqual({
      code: 'CANCELLED',
      message: 'the run was cancelled before this request',
    })

    const mid = new AbortController()
    const w = world({
      signal: mid.signal,
      answer: (r) => {
        if (idOf(r.url) === undefined) {
          mid.abort()
          return { body: listPage([listItem('1')], 1) }
        }
        return { body: detail('1') }
      },
    })
    const batch = await run(w)
    expect(batch.outcome).toBe('CANCELLED')
    expect(batch.requests.at(-1)?.error?.code).toBe('CANCELLED')
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 1,
    })
  })

  it('a fetch that throws after the run was cancelled is CANCELLED, not a network error', async () => {
    const controller = new AbortController()
    const w = world({ answer: simple(['1']), signal: controller.signal })
    w.ctx.fetchText = async () => {
      controller.abort()
      throw new Error('aborted')
    }
    const batch = await run(w)
    expect(batch.outcome).toBe('CANCELLED')
    expect(batch.requests[0]?.error).toEqual({ code: 'CANCELLED', message: 'aborted' })
  })

  it('the deadline: before it the run goes on, AT it nothing is sent', async () => {
    const deadline = new Date('2026-10-24T05:00:00Z')
    const before = world({ answer: simple(['1']), deadline, now: new Date(deadline.getTime() - 1) })
    expect((await run(before)).outcome).toBe('SUCCEEDED')
    const at = world({ answer: simple(['1']), deadline, now: deadline })
    const batch = await run(at)
    expect(at.sent).toEqual([])
    expect(batch.requests[0]?.error).toEqual({
      code: 'DEADLINE',
      message: 'the attempt deadline passed before this request',
    })
  })

  it('a refused reservation says COST_STOP in words, with no status and no cost', async () => {
    const batch = await run(world({ answer: simple(['1']), budget: 0 }))
    expect(batch.requests[0]).toMatchObject({ status: null, cost: null })
    expect(batch.requests[0]?.error).toEqual({
      code: 'COST_STOP',
      message: 'the meter refused a reservation',
    })
  })

  it('a reconcile that fails is reported as ours (PERSISTENCE), and the run stops', async () => {
    const w = world({ answer: simple(['1']) })
    w.ctx.meter.reconcile = async () => {
      throw new Error('ledger down')
    }
    const batch = await run(w)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the reservation could not be reconciled: ledger down',
    })
    expect(w.sent).toHaveLength(1)
  })

  it('a thrown value that is not an Error still gets a message (fetch, meter, store)', async () => {
    const fetchThrows = world({ answer: simple(['1']) })
    fetchThrows.ctx.fetchText = async () => {
      throw 'plain string'
    }
    expect((await run(fetchThrows)).requests[0]?.error).toEqual({
      code: 'TRANSIENT_NETWORK',
      message: 'the request failed',
    })

    const meterThrows = world({ answer: simple(['1']) })
    meterThrows.ctx.meter.reconcile = async () => {
      throw 'plain string'
    }
    expect((await run(meterThrows)).requests[0]?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the reservation could not be reconciled: the meter failed',
    })

    const storeThrows = world({ answer: simple(['1']) })
    storeThrows.ctx.checkpoints.savePage = async () => {
      throw 'plain string'
    }
    expect((await run(storeThrows)).requests.at(-1)?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the page could not be persisted',
    })
  })

  it('a stored cursor that is not an offset says so', async () => {
    const stored: ValidatedCheckpoint = {
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: 'smartrecruiters-1',
      position: { kind: 'CURSOR', page: 1, cursor: 'abc' },
      completedAt: new Date('2026-10-23T00:00:00Z'),
    }
    const batch = await run(world({ answer: simple(['1']), stored }))
    expect(batch.requests[0]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'the stored page cursor is not an offset',
    })
    expect(batch.requests[0]?.url).toBe('about:request-not-built')
  })

  it('a list that is not JSON, is too large or is the wrong shape says which', async () => {
    const notJson = await run(world({ answer: () => ({ body: '<html/>' }) }))
    expect(notJson.requests[0]?.error?.code).toBe('PARSE_DRIFT')
    expect(notJson.requests[0]?.error?.message).toMatch(/^NOT_JSON: /)

    const pad = 'x'.repeat(2 * 1024 * 1024)
    const big = await run(world({ answer: () => ({ body: `{"content":[],"pad":"${pad}"}` }) }))
    expect(big.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(big.requests[0]?.error?.message).toMatch(/^TOO_MANY_BYTES: /)

    const shape = await run(world({ answer: () => ({ body: { content: 'no' } }) }))
    expect(shape.requests[0]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'envelope: did not match',
    })
  })

  it('a page over the page size says how many and what the cap is', async () => {
    const w = world({
      answer: () => ({ body: listPage([listItem('1'), listItem('2'), listItem('3')], 3) }),
    })
    const batch = await run(w, cfg(), small)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'page carried 3 items, over the 2 cap',
    })
  })

  it('a list that answers 404 is a failed request (UPSTREAM) at that status, not an answer', async () => {
    const batch = await run(world({ answer: () => ({ status: 404, body: 'x' }) }))
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({ status: 404, error: { code: 'UPSTREAM' } })
  })

  it('statuses: 200, 204 and 299 pass, 199, 300 and 301 do not (the success range is 2xx exactly)', async () => {
    for (const status of [200, 204, 299]) {
      const batch = await run(world({ answer: () => ({ status, body: listPage([], 0) }) }))
      expect(batch.outcome).toBe('SUCCEEDED')
    }
    for (const status of [199, 300, 301]) {
      const batch = await run(world({ answer: () => ({ status, body: listPage([], 0) }) }))
      expect(batch.requests[0]?.error?.code).toBe('UPSTREAM')
    }
  })

  it('a page that cannot be persisted is reported at the list address and status', async () => {
    const batch = await run(world({ answer: simple(['1']), failSave: true }))
    expect(batch.requests.at(-1)).toMatchObject({ status: 200, url: listUrl(0) })
  })
})

describe('what a sample says, and what a discarded page counts', () => {
  it('an invalid posting and a quarantined one are sampled with their reasons', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([{ id: 5 }, listItem('1', { company: null }), listItem('2')], 3) }
          : { body: detail(idOf(r.url) as string) },
    })
    const batch = await run(w)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'ITEM_SCHEMA',
      'QUARANTINED: MISSING_COMPANY',
    ])
  })

  it('a page thrown away still counts its invalid and quarantined postings (received, then lost)', async () => {
    const w = world({
      budget: 2,
      answer: (r) =>
        idOf(r.url) === undefined
          ? {
              body: listPage(
                [{ id: 5 }, listItem('1', { company: null }), listItem('2'), listItem('3')],
                4,
              ),
            }
          : { body: detail(idOf(r.url) as string) },
    })
    const batch = await run(w)
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 0,
      invalid: 1,
      quarantined: 1,
      discarded: 2,
    })
  })

  it('a kept page counts them too', async () => {
    const w = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([{ id: 5 }, listItem('1', { company: null }), listItem('2')], 3) }
          : { body: detail(idOf(r.url) as string) },
    })
    const batch = await run(w)
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 1,
      invalid: 1,
      quarantined: 1,
      discarded: 0,
    })
  })

  it('a 404 detail is no sample', async () => {
    const gone = await run(
      world({ answer: simple(['111'], { '111': { status: 404, body: 'x' } }) }),
    )
    expect(gone.invalidSamples).toEqual([])
  })

  it("the observation is dated by the attempt's clock: a release date after it is flagged FUTURE", async () => {
    const w = world({
      now: new Date('2026-01-01T00:00:00Z'),
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([listItem('1', { releasedDate: '2026-06-01T00:00:00Z' })], 1) }
          : { body: detail('1') },
    })
    const batch = await run(w)
    expect(batch.observations[0]?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'FUTURE',
    })
  })

  it('a short page that totalFound says is not the last continues', async () => {
    const provider = createSmartRecruitersProvider(
      {
        maxListPages: 3,
        maxRequests: 50,
        pageSize: 5,
      },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
    const w = world({
      answer: (r) => {
        const id = idOf(r.url)
        if (id !== undefined) return { body: detail(id) }
        const offset = Number(new URL(r.url).searchParams.get('offset'))
        return { body: listPage([listItem(String(offset + 1))], 2) }
      },
    })
    const batch = await run(w, cfg(), provider)
    expect(
      w.sent.filter((r) => !isDetail(r)).map((r) => new URL(r.url).searchParams.get('offset')),
    ).toEqual(['0', '1'])
    expect(batch.observations).toHaveLength(2)
  })

  it('the detail cache is keyed by company and posting id, under its own name', async () => {
    const cache = new Map<string, CachedResponse>()
    await run(world({ answer: simple(['111']), cache }))
    expect([...cache.keys()]).toEqual([
      JSON.stringify(['smartrecruiters-detail', 'smartrecruiters:acme', '111']),
    ])
  })
})

describe('the description and the workplace, section by section', () => {
  const withDetail = (body: unknown, listExtra: Record<string, unknown> = {}) =>
    world({
      answer: (r) =>
        idOf(r.url) === undefined ? { body: listPage([listItem('1', listExtra)], 1) } : { body },
    })
  const mdOf = async (body: unknown) =>
    (await run(withDetail(body))).observations[0]?.normalized.descriptionMd ?? ''

  it('no jobAd, no sections, no section, a blank or missing text: no description at all', async () => {
    for (const body of [
      { id: '1' },
      { id: '1', jobAd: null },
      { id: '1', jobAd: {} },
      { id: '1', jobAd: { sections: null } },
      { id: '1', jobAd: { sections: {} } },
      { id: '1', jobAd: { sections: { jobDescription: null } } },
      { id: '1', jobAd: { sections: { jobDescription: { title: 'T', text: '   ' } } } },
      { id: '1', jobAd: { sections: { jobDescription: { title: 'T' } } } },
    ]) {
      expect(await mdOf(body)).toBe('')
    }
  })

  it('sections are joined with nothing between them: two sections, exactly', async () => {
    const md = await mdOf({
      id: '1',
      jobAd: {
        sections: {
          jobDescription: { text: '<p>One</p>' },
          qualifications: { text: '<p>Two</p>' },
        },
      },
    })
    expect(md).toBe('One\n\nTwo')
  })

  it('a section without a title is just its text', async () => {
    const md = await mdOf({
      id: '1',
      jobAd: { sections: { jobDescription: { text: '<p>Only text</p>' } } },
    })
    expect(md).toBe('Only text')
  })

  it('a section title is a heading and is text, never markup', async () => {
    const md = await mdOf({
      id: '1',
      jobAd: { sections: { jobDescription: { title: 'R&D <i>x</i> > y', text: '<p>Body</p>' } } },
    })
    expect(md).toContain('R&D')
    expect(md).toContain('\\<i\\>x\\</i\\>')
    expect(md).toContain('\\> y')
    expect(md).not.toContain('R&amp;D')
    expect(md).toContain('Body')
  })

  it('a posting with no location has no location and no workplace', async () => {
    const nulled = world({
      answer: (r) =>
        idOf(r.url) === undefined
          ? { body: listPage([listItem('1', { location: null })], 1) }
          : { body: detail('1') },
    })
    const o = (await run(nulled)).observations[0]
    expect(o?.normalized.location ?? null).toBeNull()
    expect(o?.normalized.remote ?? null).toBeNull()
    const { location: _gone, ...without } = listItem('1')
    const absent = world({
      answer: (r) =>
        idOf(r.url) === undefined ? { body: listPage([without], 1) } : { body: detail('1') },
    })
    expect((await run(absent)).observations[0]?.normalized.location ?? null).toBeNull()
  })

  it('a location with only some parts keeps those parts', async () => {
    const country = (await run(withDetail(detail('1'), { location: { country: 'de' } })))
      .observations[0]
    expect(country?.normalized.location).toBe('de')
    const both = (
      await run(withDetail(detail('1'), { location: { city: 'Berlin', country: 'de' } }))
    ).observations[0]
    expect(both?.normalized.location).toBe('Berlin, de')
  })

  it('visibility: PUBLIC and none are open; INTERNAL on the list or the detail, or an inactive detail, is not', async () => {
    const open = [
      await run(withDetail(detail('1'), { visibility: 'PUBLIC' })),
      await run(withDetail(detail('1', { visibility: 'PUBLIC' }))),
      await run(withDetail(detail('1'))),
    ]
    expect(open.map((b) => b.counts.normalized)).toEqual([1, 1, 1])
    const closed = [
      await run(withDetail(detail('1'), { visibility: 'INTERNAL' })),
      await run(withDetail(detail('1', { visibility: 'INTERNAL' }))),
      await run(withDetail(detail('1', { active: false }))),
    ]
    expect(closed.map((b) => b.counts.quarantined)).toEqual([1, 1, 1])
  })
})

describe('the decision gate: without the owner decision robots.txt stands and nothing is sent', () => {
  const expectRefused = async (provider: typeof smartrecruitersProvider) => {
    const w = world({ answer: simple(['111', '222']) })
    const batch = await provider.collectReport(
      provider.parseConfig({ configVersion: 1, board: 'acme' }),
      w.ctx,
    )
    expect(w.sent).toEqual([])
    expect(w.reserved).toBe(0)
    expect(w.saved).toEqual([])
    expect(w.cache.size).toBe(0)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.checkpoint).toBeNull()
    expect(batch.invalidSamples).toEqual([])
    expect(batch.scope).toEqual({
      namespace: 'smartrecruiters:acme',
      query: null,
      configVersion: 1,
      window: null,
    })
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({
      status: null,
      cost: null,
      url: 'about:request-not-built',
    })
    expect(batch.requests[0]?.error).toEqual({
      code: 'ACCESS_POLICY',
      message:
        'robots.txt of api.smartrecruiters.com disallows this collector and no owner decision covers it, so no request was made',
    })
  }

  it('the default export is armed with the recorded decision and sends', async () => {
    const w = world({ answer: simple(['111']) })
    const batch = await smartrecruitersProvider.collectReport(
      smartrecruitersProvider.parseConfig({ configVersion: 1, board: 'acme' }),
      w.ctx,
    )
    expect(w.sent.map((r) => r.url)).toEqual([
      listUrl(0),
      'https://api.smartrecruiters.com/v1/companies/acme/postings/111',
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('built without a decision (default options, custom bounds) it sends nothing, reserves nothing, stores nothing and says why', async () => {
    await expectRefused(createSmartRecruitersProvider())
  })

  it('custom bounds do not arm it', async () => {
    await expectRefused(
      createSmartRecruitersProvider({ maxListPages: 5, maxRequests: 50, pageSize: 100 }),
    )
  })

  it('only an ACCEPT_RISK decision about this endpoint arms it: absent, informational, another source or malformed do not', async () => {
    const armed = (ownerDecision: OwnerDecision | undefined) =>
      createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, { ownerDecision })
    await expectRefused(armed(undefined))
    await expectRefused(armed({ ...SMARTRECRUITERS_OWNER_DECISION, decision: 'INFORMATIONAL' }))
    await expectRefused(armed(HN_OWNER_DECISION))
    await expectRefused(
      armed({ ...SMARTRECRUITERS_OWNER_DECISION, endpointVariant: 'posting-api-v2' }),
    )
    await expectRefused(armed({ ...SMARTRECRUITERS_OWNER_DECISION, decidedAt: 'yesterday' }))
    await expectRefused(armed({ ...SMARTRECRUITERS_OWNER_DECISION, scope: '  ' }))
  })

  it('the recorded decision is about the endpoint variant this adapter sends to', () => {
    expect(SMARTRECRUITERS_OWNER_DECISION.endpointVariant).toBe(SMARTRECRUITERS_ENDPOINT_VARIANT)
    expect(SMARTRECRUITERS_ENDPOINT_VARIANT).toBe('posting-api')
    expect(SMARTRECRUITERS_OWNER_DECISION.decision).toBe('ACCEPT_RISK')
  })

  it('the armed factory is the same adapter and does send (the spec above runs on it)', async () => {
    const w = world({ answer: simple(['111']) })
    await run(w)
    expect(w.sent.length).toBeGreaterThan(0)
  })

  it('every request of the armed adapter is on the declared host', async () => {
    const w = world({ answer: simple(['111', '222']) })
    await run(w)
    expect(smartrecruitersAllowedHosts()).toEqual(['api.smartrecruiters.com'])
    for (const r of w.sent) expect(smartrecruitersAllowedHosts()).toContain(new URL(r.url).host)
  })
})

describe('stop on ban, never evade (owner decision of 2026-10-24)', () => {
  const stops = [
    [401, 'ACCESS_POLICY'],
    [403, 'ACCESS_POLICY'],
    [451, 'ACCESS_POLICY'],
    [429, 'RATE_LIMIT'],
  ] as const

  it.each(stops)(
    'HTTP %i on the list ends the run after exactly one request',
    async (status, code) => {
      const w = world({ answer: () => ({ status, body: 'blocked' }) })
      const batch = await run(w)
      expect(w.sent).toHaveLength(1)
      expect(w.reserved).toBe(1)
      expect(batch.outcome).toBe('FAILED')
      expect(batch.requests.map((r) => r.error?.code)).toEqual([code])
    },
  )

  it.each(stops)(
    'HTTP %i on a detail stops the run: no later detail, no next page, nothing stored',
    async (status, code) => {
      const w = world({
        answer: simple(['111', '222', '333'], { '222': { status, body: 'blocked' } }),
      })
      const batch = await run(w)
      expect(w.sent.map((r) => r.url)).toEqual([
        listUrl(0),
        'https://api.smartrecruiters.com/v1/companies/acme/postings/111',
        'https://api.smartrecruiters.com/v1/companies/acme/postings/222',
      ])
      expect(w.saved).toEqual([])
      expect(batch.observations).toEqual([])
      expect(batch.requests.at(-1)?.error?.code).toBe(code)
    },
  )

  it('a block on a later list page ends the run without another request, keeping the pages already stored', async () => {
    const w = world({
      answer: (r) => {
        if (r.url === listUrl(0)) return { body: listPage([listItem('1')], 2) }
        if (idOf(r.url) !== undefined) return { body: detail('1') }
        return { status: 403, body: 'blocked' }
      },
    })
    const batch = await run(w)
    expect(w.sent.map((r) => r.url)).toEqual([
      listUrl(0),
      'https://api.smartrecruiters.com/v1/companies/acme/postings/1',
      listUrl(1),
    ])
    expect(w.saved).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('never evades: every request carries the accept header and nothing else, and a refusal is not answered by a retry', async () => {
    const w = world({ answer: () => ({ status: 403, body: 'blocked' }) })
    await run(w)
    for (const r of w.sent) expect(r.headers).toEqual({ accept: 'application/json' })
    expect(w.sent).toHaveLength(1)
  })

  it('keeps the per-attempt request ceiling', async () => {
    const small = createSmartRecruitersProvider(
      { maxListPages: 20, maxRequests: 2, pageSize: 100 },
      { ownerDecision: SMARTRECRUITERS_OWNER_DECISION },
    )
    const w = world({ answer: simple(['1', '2', '3']) })
    await run(w, cfg(), small)
    expect(w.sent).toHaveLength(2)
  })
})

describe('a company identifier is lower case, so two spellings cannot write the same identities', () => {
  it('refuses capitals and accepts the lower-case spelling', () => {
    expect(() => cfg('Acme')).toThrow()
    expect(() => cfg('ACME')).toThrow()
    expect(cfg('acme').namespace).toBe('smartrecruiters:acme')
  })
})

describe('the committed evidence', () => {
  it('the robots.txt capture says the API is disallowed to every agent but one named crawler', () => {
    expect(readFixtureText('smartrecruiters', 'api-robots.txt')).toBe(
      'User-agent: LinkedInBot\nAllow: /v1/companies/\nUser-agent: *\nDisallow: /\n',
    )
  })
})
