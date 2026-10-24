import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { himalayasProvider } from './himalayas.provider'

/**
 * Himalayas through its public provider. Expected values are hand-read from the three authentic
 * captures in `__fixtures__/himalayas/` and from the provider's documentation (cursor browse,
 * page search, OpenAPI enums). Unix instants were derived by hand from a known anchor
 * (1792673908 = 2026-10-22T12:58:28Z) plus the difference in seconds.
 */

const NOW = new Date('2026-10-24T00:00:00Z')
const BROWSE = 'https://himalayas.app/jobs/api'
const SEARCH = 'https://himalayas.app/jobs/api/search'

const cfg = (extra: Record<string, unknown> = {}) =>
  himalayasProvider.parseConfig({ configVersion: 1, ...extra })

type Page = { jobs: Record<string, unknown>[]; nextCursor?: string } & Record<string, unknown>
const page1 = () => sourceFixture('himalayas', 'browse-page1') as Page
const page2 = () => sourceFixture('himalayas', 'browse-page2') as Page
const searchPage = () => sourceFixture('himalayas', 'search-page1') as Page
const noNext = (p: Page): Page => {
  const { nextCursor: _n, ...rest } = p
  return rest as Page
}
const body = (v: unknown): FakeResponse => ({ bodyText: JSON.stringify(v) })

async function run(responses: FakeResponse[], config = cfg()) {
  const f = fakeCollectionContext({ now: NOW, responses })
  const batch = await himalayasProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const GUID = (slug: string) => `https://himalayas.app/companies/${slug}`
const byGuid = (b: Batch, guid: string) => b.observations.find((o) => o.identity.nativeId === guid)

describe('mapping the authentic browse capture', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([body(noNext(page1()))])
    const g = GUID('bright-vision-technologies/jobs/data-platform-architect-1149275416')
    const o = byGuid(batch, g)
    expect(o?.identity).toMatchObject({
      provider: 'HIMALAYAS_API',
      namespace: 'himalayas',
      nativeId: g,
      identityKind: 'NATIVE_ID',
    })
    // Source page and Apply link are different things: the Apply link carries the API's tracking
    // parameter and is the ONLY link the terms allow for applying.
    expect(o?.sourcePostingUrl).toBe(g)
    expect(o?.applicationUrl).toBe(g + '?utm_source=api')
    expect(o?.normalized.title).toBe('Data Platform Architect')
    expect(o?.normalized.companyName).toBe('Bright Vision Technologies')
    expect(o?.normalized.location).toBe('United States')
    expect(o?.normalized.employmentType).toBe('Full Time')
    expect(o?.normalized.seniorityHint).toBe('Senior')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.tags?.slice(0, 3)).toEqual([
      'Developer',
      'Data-Platform-Architect',
      'Data-Architect',
    ])
    expect(o?.adapterVersion).toBe('himalayas-1')
  })

  it('pubDate is the UPDATE instant (not publication) and expiryDate is EXPIRY; publishedAt stays null', async () => {
    const { batch } = await run([body(noNext(page1()))])
    const o = byGuid(
      batch,
      GUID('bright-vision-technologies/jobs/data-platform-architect-1149275416'),
    )
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'UPDATED',
        contract: 'UNIX_SECONDS',
        raw: '1792779280',
        status: 'OK',
        value: new Date('2026-10-23T18:14:40.000Z'),
      },
      {
        semantics: 'EXPIRY',
        contract: 'UNIX_SECONDS',
        raw: '1797963279',
        status: 'OK',
        value: new Date('2026-12-22T18:14:39.000Z'),
      },
    ])
  })

  it('an empty locationRestrictions array means open worldwide', async () => {
    const { batch } = await run(
      [body(noNext(searchPage())), body({ jobs: [] })],
      cfg({ endpoint: 'search' }),
    )
    const o = byGuid(batch, GUID('micro1/jobs/mechanical-engineering-expert-msc-or-phd'))
    expect(o?.normalized.location).toBe('Worldwide')
  })

  it('an ABSENT locationRestrictions is unknown geography, not worldwide', async () => {
    const job = { ...page1().jobs[0] }
    delete job['locationRestrictions']
    const { batch } = await run([body({ jobs: [job] })])
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.normalized.location).toBeNull()
  })

  it('joins several restrictions, and accepts the documented object form as well as the observed strings', async () => {
    const two = { ...page1().jobs[4] } // Philippines + South Africa
    const { batch } = await run([body({ jobs: [two] })])
    expect(batch.observations[0]?.normalized.location).toBe('Philippines, South Africa')
    const objects = {
      ...two,
      locationRestrictions: [{ alpha2: 'PH', name: 'Philippines', slug: 'philippines' }],
    }
    const b2 = await run([body({ jobs: [objects] })])
    expect(b2.batch.observations[0]?.normalized.location).toBe('Philippines')
  })

  it('a job with 41 restrictions is kept whole in originalFields; display is cut by the normalizer', async () => {
    const { batch } = await run([body(noNext(page1()))])
    const o = byGuid(batch, GUID('savanta/jobs/head-of-strategic-research-north-america'))
    expect(o?.normalized.location?.startsWith('Anguilla, ')).toBe(true)
    expect(o?.originalFields.location?.value.startsWith('Anguilla, ')).toBe(true)
  })

  it('only DOCUMENTED seniority values reach the hint: Mid-level + Senior joined, an unknown value dropped', async () => {
    const mk = (seniority: string[]) => ({ ...page1().jobs[0], seniority })
    const a = await run([body({ jobs: [mk(['Mid-level', 'Senior'])] })])
    expect(a.batch.observations[0]?.normalized.seniorityHint).toBe('Mid-level, Senior')
    const b = await run([body({ jobs: [mk(['Wizard', 'Director'])] })])
    expect(b.batch.observations[0]?.normalized.seniorityHint).toBe('Director')
    const c = await run([body({ jobs: [mk(['Wizard'])] })])
    expect(c.batch.observations[0]?.normalized.seniorityHint).toBeNull()
    const d = await run([body({ jobs: [mk([])] })])
    expect(d.batch.observations[0]?.normalized.seniorityHint).toBeNull()
  })

  it('every documented seniority value is kept', async () => {
    for (const s of ['Entry-level', 'Mid-level', 'Senior', 'Manager', 'Director', 'Executive']) {
      const { batch } = await run([body({ jobs: [{ ...page1().jobs[0], seniority: [s] }] })])
      expect(batch.observations[0]?.normalized.seniorityHint).toBe(s)
    }
  })

  it('identity is the guid: a changed title or applicationLink does not move it', async () => {
    const base = await run([body(noNext(page1()))])
    const edited = {
      ...page1().jobs[0],
      title: 'Renamed',
      applicationLink: 'https://himalayas.app/other?utm_source=api',
    }
    const { batch } = await run([body({ jobs: [edited] })])
    const g = GUID('bright-vision-technologies/jobs/data-platform-architect-1149275416')
    expect(byGuid(batch, g)?.identity.identityKey).toBe(byGuid(base.batch, g)?.identity.identityKey)
  })
})

describe('bounds, at the limit and past it', () => {
  const job = (over: Record<string, unknown>) => ({ ...page1().jobs[0], ...over })
  const invalid = async (over: Record<string, unknown>) =>
    (await run([body({ jobs: [job(over)] })])).batch.counts.invalid

  it('title 2000 / 2001', async () => {
    expect(await invalid({ title: 'T'.repeat(2000) })).toBe(0)
    expect(await invalid({ title: 'T'.repeat(2001) })).toBe(1)
  })
  it('companyName 1000 / 1001', async () => {
    expect(await invalid({ companyName: 'C'.repeat(1000) })).toBe(0)
    expect(await invalid({ companyName: 'C'.repeat(1001) })).toBe(1)
  })
  it('categories: 200 items ok / 201 invalid; an item of 200 chars ok / 201 invalid', async () => {
    expect(await invalid({ categories: Array.from({ length: 200 }, () => 'c') })).toBe(0)
    expect(await invalid({ categories: Array.from({ length: 201 }, () => 'c') })).toBe(1)
    expect(await invalid({ categories: ['c'.repeat(200)] })).toBe(0)
    expect(await invalid({ categories: ['c'.repeat(201)] })).toBe(1)
  })
  it('locationRestrictions: 300 entries ok / 301 invalid', async () => {
    expect(await invalid({ locationRestrictions: Array.from({ length: 300 }, () => 'X') })).toBe(0)
    expect(await invalid({ locationRestrictions: Array.from({ length: 301 }, () => 'X') })).toBe(1)
  })
  it('guid and applicationLink: 2048 chars accepted by the schema, 2049 invalid', async () => {
    const link = (n: number) =>
      'https://himalayas.app/' + 'a'.repeat(n - 'https://himalayas.app/'.length)
    expect(await invalid({ applicationLink: link(2049) })).toBe(1)
    expect(await invalid({ guid: link(2049) })).toBe(1)
    expect(await invalid({ applicationLink: link(2048) })).toBe(0)
  })
  it('a timestamp as a string of 64 chars is accepted by the schema; 65 is invalid', async () => {
    expect(await invalid({ pubDate: '1'.repeat(65) })).toBe(1)
  })
  it('a page of 20 jobs is accepted, 21 is drift and fails the page (search and browse)', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        job({ guid: `https://himalayas.app/companies/c/jobs/j${i}`, applicationLink: null }),
      )
    expect((await run([body({ jobs: many(20) })])).batch.counts.raw).toBe(20)
    const bad = await run([body({ jobs: many(21) })])
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
    const s = cfg({ endpoint: 'search' })
    expect((await run([body({ jobs: many(20) }), body({ jobs: [] })], s)).batch.counts.raw).toBe(20)
    expect((await run([body({ jobs: many(21) })], s)).batch.outcome).toBe('FAILED')
  })
  it('pageSize smaller than the page is the bound: 3 configured, 4 returned = drift', async () => {
    const c = cfg({ pageSize: 3 })
    const four = { jobs: page1().jobs.slice(0, 4) }
    expect((await run([body(four)], c)).batch.outcome).toBe('FAILED')
    const three = { jobs: page1().jobs.slice(0, 3) }
    expect((await run([body(three)], c)).batch.counts.raw).toBe(3)
  })
})

describe('missing data', () => {
  it('an empty employer is quarantined (no slug-derived name is invented)', async () => {
    const { batch } = await run([
      body({ jobs: [{ ...page1().jobs[0], companyName: '' }, page1().jobs[1]] }),
    ])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
  })
  it('an absent employer key is an invalid item', async () => {
    const j = { ...page1().jobs[0] }
    delete j['companyName']
    expect((await run([body({ jobs: [j] })])).batch.counts.invalid).toBe(1)
  })
  it('an absent guid is an invalid item (no identity can be formed)', async () => {
    const j = { ...page1().jobs[0] }
    delete j['guid']
    expect((await run([body({ jobs: [j] })])).batch.counts.invalid).toBe(1)
  })
  it('an absent applicationLink is allowed: the job is kept with no application URL', async () => {
    const j = { ...page1().jobs[0] }
    delete j['applicationLink']
    const { batch } = await run([body({ jobs: [j] })])
    expect(batch.observations[0]?.applicationUrl).toBeNull()
  })
  it('an implausible expiry is kept as evidence, not dropped', async () => {
    const { batch } = await run([body({ jobs: [{ ...page1().jobs[0], expiryDate: 5 }] })])
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.evidence).toContainEqual({
      field: 'date.EXPIRY',
      kind: 'DATE_UNCERTAIN',
      detail: 'IMPLAUSIBLE',
    })
  })
})

describe('browse pagination: cursor, termination, ceiling', () => {
  it('follows nextCursor and ends when it is omitted; request URLs are exact', async () => {
    const { batch, f } = await run([body(page1()), body(noNext(page2()))])
    expect(f.sent.map((r) => r.url)).toEqual([
      `${BROWSE}?limit=20`,
      `${BROWSE}?limit=20&cursor=MjAyNi0xMC0yM1QxODowNjo1Ny42Nzg1MzhafDI0NDQzODc`,
    ])
    expect(batch.counts).toEqual({
      raw: 9,
      normalized: 9,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.page)).toEqual([1, 2])
    expect(f.sent.map((r) => r.headers)).toEqual([
      { accept: 'application/json' },
      { accept: 'application/json' },
    ])
    expect(f.saved.map((c) => c.position)).toEqual([
      { kind: 'CURSOR', page: 1, cursor: 'MjAyNi0xMC0yM1QxODowNjo1Ny42Nzg1MzhafDI0NDQzODc' },
      { kind: 'RESTART', page: 2 },
    ])
  })

  it('a clean full walk still claims only WINDOW (a job updated mid-walk jumps ahead of the cursor)', async () => {
    const { batch } = await run([body(noNext(page1()))])
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope).toMatchObject({ namespace: 'himalayas', query: 'browse-feed' })
  })

  it('the cursor is a PARAMETER: reserved characters are encoded and cannot add parameters or change the host', async () => {
    const evil = 'a&limit=1&x=y z/../?#'
    const { f } = await run([body({ ...page1(), nextCursor: evil }), body({ jobs: [] })])
    const second = f.sent[1]?.url ?? ''
    expect(second).toBe(`${BROWSE}?limit=20&cursor=a%26limit%3D1%26x%3Dy+z%2F..%2F%3F%23`)
    expect(new URL(second).host).toBe('himalayas.app')
    expect(new URL(second).searchParams.getAll('limit')).toEqual(['20'])
  })

  it('a repeated cursor stops the walk as a cycle: 2 requests, SUCCEEDED, not FULL', async () => {
    const same = { ...page1(), nextCursor: 'LOOP' }
    const { batch, f } = await run([body(same), body(same), body(same)])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
  })

  const walk = (n: number) =>
    Array.from({ length: n }, (_, i) => body({ ...page1(), nextCursor: `c${i + 1}` }))

  it('maxPages 10 (the ceiling) makes exactly 10 requests then reports PAGE_CAP, with no 11th', async () => {
    const { batch, f } = await run(walk(12), cfg({ maxPages: 10 }))
    expect(f.sent).toHaveLength(10)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
    expect(batch.requests).toHaveLength(11)
  })

  it('maxPages 1 makes exactly one request', async () => {
    const { f } = await run(walk(3), cfg({ maxPages: 1 }))
    expect(f.sent).toHaveLength(1)
  })

  it('maxPages defaults to 5', async () => {
    const { f } = await run(walk(8))
    expect(f.sent).toHaveLength(5)
  })

  it('pageSize is sent as limit', async () => {
    const { f } = await run([body({ jobs: [] })], cfg({ pageSize: 7 }))
    expect(f.sent[0]?.url).toBe(`${BROWSE}?limit=7`)
  })
})

describe('search pagination: page numbers, empty-page termination', () => {
  const s = (extra: Record<string, unknown> = {}) =>
    cfg({
      endpoint: 'search',
      search: { q: 'python', seniority: ['Senior'], sort: 'recent' },
      ...extra,
    })

  it('requests page=1,2 and stops at the first EMPTY page; a short non-empty page does not stop the walk', async () => {
    const { batch, f } = await run(
      [body(searchPage()), body(searchPage()), body({ jobs: [] })],
      s(),
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      `${SEARCH}?q=python&seniority=Senior&sort=recent&page=1`,
      `${SEARCH}?q=python&seniority=Senior&sort=recent&page=2`,
      `${SEARCH}?q=python&seniority=Senior&sort=recent&page=3`,
    ])
    expect(f.sent.map((r) => r.headers)).toEqual([
      { accept: 'application/json' },
      { accept: 'application/json' },
      { accept: 'application/json' },
    ])
    expect(f.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'page:2' })
    expect(f.saved[1]?.position).toEqual({ kind: 'CURSOR', page: 2, cursor: 'page:3' })
    expect(batch.counts.raw).toBe(8)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
  })

  it('the ceiling applies to search too: maxPages 2 stops after page 2 with PAGE_CAP', async () => {
    const { batch, f } = await run(
      [body(searchPage()), body(searchPage()), body(searchPage())],
      s({ maxPages: 2 }),
    )
    expect(f.sent).toHaveLength(2)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })

  it('scope.query is the canonical filter set, so two different searches never share a scope', async () => {
    const a = await run([body({ jobs: [] })], s())
    const b = await run([body({ jobs: [] })], cfg({ endpoint: 'search', search: { q: 'java' } }))
    expect(a.batch.scope.query).toBe('{"q":"python","seniority":["Senior"],"sort":"recent"}')
    expect(b.batch.scope.query).toBe('{"q":"java"}')
  })

  it('builds every documented filter into the URL (booleans only when true; lists comma-joined)', async () => {
    const full = cfg({
      endpoint: 'search',
      search: {
        q: 'react engineer',
        country: 'US',
        worldwide: true,
        excludeWorldwide: true,
        seniority: ['Senior', 'Mid-level'],
        employmentType: ['Full Time', 'Contractor'],
        company: ['linear', 'stripe'],
        timezone: 'UTC-5',
        sort: 'salaryDesc',
      },
    })
    const { f } = await run([body({ jobs: [] })], full)
    expect(f.sent[0]?.url).toBe(
      `${SEARCH}?q=react+engineer&country=US&worldwide=true&exclude_worldwide=true&seniority=Senior%2CMid-level&employment_type=Full+Time%2CContractor&company=linear%2Cstripe&timezone=UTC-5&sort=salaryDesc&page=1`,
    )
    const none = await run([body({ jobs: [] })], cfg({ endpoint: 'search' }))
    expect(none.f.sent[0]?.url).toBe(`${SEARCH}?page=1`)
    const off = await run(
      [body({ jobs: [] })],
      cfg({ endpoint: 'search', search: { worldwide: false, excludeWorldwide: false } }),
    )
    expect(off.f.sent[0]?.url).toBe(`${SEARCH}?page=1`)
  })
})

describe('partial runs, failures and reports', () => {
  it('page 2 failing (500) after page 1 landed: PARTIAL, page-1 jobs kept, both requests reported', async () => {
    const { batch, f } = await run([body(page1()), { status: 500, bodyText: '{}' }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(6)
    expect(batch.requests[0]).toMatchObject({ page: 1, status: 200, error: null })
    expect(batch.requests[1]).toMatchObject({ page: 2, status: 500, error: { code: 'UPSTREAM' } })
    expect(batch.checkpoint?.position).toMatchObject({ kind: 'CURSOR', page: 1 })
  })

  it('a rate limit on page 2 is RATE_LIMIT and keeps page 1', async () => {
    const { batch } = await run([body(page1()), { status: 429, bodyText: '{}' }])
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests[1]?.error?.code).toBe('RATE_LIMIT')
  })

  it('a network failure on page 2 keeps page 1 and reports no status', async () => {
    const { batch } = await run([body(page1()), { throws: new Error('ECONNRESET') }])
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests[1]?.status).toBeNull()
  })

  it('a rejected cursor (HTTP 400) is UPSTREAM on that page, not a success', async () => {
    const { batch } = await run([
      body(page1()),
      { status: 400, bodyText: '{"error":"bad cursor"}' },
    ])
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests[1]).toMatchObject({ status: 400, error: { code: 'UPSTREAM' } })
  })

  it('401 on the first page is ACCESS_POLICY and FAILED', async () => {
    const { batch } = await run([{ status: 401, bodyText: '{}' }])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('ACCESS_POLICY')
  })

  it('one malformed job is isolated; the page and the walk continue', async () => {
    const { batch } = await run([body({ jobs: [page1().jobs[0], { title: 1 }, page1().jobs[1]] })])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('a body without jobs is PARSE_DRIFT', async () => {
    const { batch } = await run([body({ totalCount: 1 })])
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.outcome).toBe('FAILED')
  })

  it('an empty nextCursor string is drift, not "no more pages"', async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: '' })])
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('declares no meter: a free, unmetered source makes no reservation', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [body({ jobs: [] })] })
    let reserved = 0
    const ctx = {
      ...f.ctx,
      meter: {
        ...f.ctx.meter,
        reserve: async () => {
          reserved += 1
          return null
        },
      },
    }
    const batch = await himalayasProvider.collectReport(cfg(), ctx)
    expect(reserved).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})

describe('config is refused before any network call', () => {
  const canonicalOf = (company: string[]) => JSON.stringify({ company })
  // {"company":["a","b"]} = 13 + sum(len) + 3 * (k - 1) + 3 characters.
  const slugsWithCanonicalLength = (target: number): string[] => {
    const k = 5
    const sum = target - 13 - 3 * k
    const lens = [95, 95, 95, 95, sum - 380]
    return lens.map((n, i) => String.fromCharCode(97 + i).repeat(n))
  }

  const bad: Array<[string, Record<string, unknown>]> = [
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 11 (past the ceiling)', { maxPages: 11 }],
    ['a fractional maxPages', { maxPages: 2.5 }],
    ['pageSize 0', { pageSize: 0 }],
    ['pageSize 21 (past the documented maximum)', { pageSize: 21 }],
    ['an unknown endpoint', { endpoint: 'rss' }],
    ['search filters on the browse endpoint', { search: { q: 'x' } }],
    [
      'pageSize on the search endpoint (search has no limit parameter)',
      { endpoint: 'search', pageSize: 5 },
    ],
    [
      'an undocumented seniority value (Junior)',
      { endpoint: 'search', search: { seniority: ['Junior'] } },
    ],
    [
      'an undocumented employment type',
      { endpoint: 'search', search: { employmentType: ['Full-time'] } },
    ],
    ['an undocumented sort', { endpoint: 'search', search: { sort: 'newest' } }],
    ['a q of 201 chars', { endpoint: 'search', search: { q: 'q'.repeat(201) } }],
    ['a company slug with a separator', { endpoint: 'search', search: { company: ['a,b'] } }],
    ['a company slug with a path escape', { endpoint: 'search', search: { company: ['../x'] } }],
    [
      '11 company slugs',
      { endpoint: 'search', search: { company: Array.from({ length: 11 }, (_, i) => `c${i}`) } },
    ],
    ['a malformed timezone', { endpoint: 'search', search: { timezone: 'Europe/Kyiv' } }],
    ['an unknown search key', { endpoint: 'search', search: { page: 3 } }],
    ['a base query (search text lives in search.q)', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['a namespace other than himalayas', { namespace: 'x' }],
    ['an unknown top-level key', { limit: 20 }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
    [
      'a canonical scope of 501 chars',
      { endpoint: 'search', search: { company: slugsWithCanonicalLength(501) } },
    ],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => himalayasProvider.parseConfig({ configVersion: 1, ...extra })).toThrow()
  })

  it('accepts the boundary values: maxPages 1 and 10, pageSize 1 and 20, q of 200, 10 slugs, timezone forms', () => {
    expect(cfg({ maxPages: 1 }).maxPages).toBe(1)
    expect(cfg({ maxPages: 10 }).maxPages).toBe(10)
    expect(cfg({ pageSize: 1 }).pageSize).toBe(1)
    expect(cfg({ pageSize: 20 }).pageSize).toBe(20)
    for (const timezone of ['UTC-5', 'UTC+05:30', '-5', '+5.5'.replace('.5', ':30'), '3']) {
      expect(() => cfg({ endpoint: 'search', search: { timezone } })).not.toThrow()
    }
    expect(() => cfg({ endpoint: 'search', search: { q: 'q'.repeat(200) } })).not.toThrow()
    expect(() =>
      cfg({
        endpoint: 'search',
        search: { company: Array.from({ length: 10 }, (_, i) => `c${i}`) },
      }),
    ).not.toThrow()
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('accepts a canonical scope of exactly 500 chars', () => {
    const slugs = slugsWithCanonicalLength(500)
    expect(canonicalOf(slugs)).toHaveLength(500)
    expect(() => cfg({ endpoint: 'search', search: { company: slugs } })).not.toThrow()
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [body({ jobs: [] })] })
    await expect(
      himalayasProvider.collectReport(
        {
          namespace: 'himalayas',
          configVersion: 1,
          endpoint: 'browse',
          maxPages: 5,
        } as unknown as ReturnType<typeof cfg>,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })
})

describe('canonical scope: one case per filter (CR-M-1)', () => {
  const scopeOf = async (search?: Record<string, unknown>) =>
    (
      await run(
        [body({ jobs: [] })],
        cfg({ endpoint: 'search', ...(search === undefined ? {} : { search }) }),
      )
    ).batch.scope.query

  it.each([
    ['q', { q: 'react engineer' }, '{"q":"react engineer"}'],
    ['country', { country: 'US' }, '{"country":"US"}'],
    ['worldwide', { worldwide: true }, '{"worldwide":true}'],
    ['excludeWorldwide', { excludeWorldwide: true }, '{"excludeWorldwide":true}'],
    ['seniority', { seniority: ['Senior', 'Mid-level'] }, '{"seniority":["Senior","Mid-level"]}'],
    [
      'employmentType',
      { employmentType: ['Full Time', 'Contractor'] },
      '{"employmentType":["Full Time","Contractor"]}',
    ],
    ['company', { company: ['linear', 'stripe'] }, '{"company":["linear","stripe"]}'],
    ['timezone', { timezone: 'UTC-5' }, '{"timezone":"UTC-5"}'],
    ['sort', { sort: 'recent' }, '{"sort":"recent"}'],
  ])('%s alone', async (_name, search, expected) => {
    expect(await scopeOf(search)).toBe(expected)
  })

  it('worldwide:false and excludeWorldwide:false equal absent', async () => {
    expect(await scopeOf({ worldwide: false })).toBe('{}')
    expect(await scopeOf({ excludeWorldwide: false })).toBe('{}')
    expect(await scopeOf({ worldwide: false, excludeWorldwide: false, q: 'x' })).toBe('{"q":"x"}')
  })

  it('no filters at all is the empty object, still a non-null scope (so WINDOW)', async () => {
    expect(await scopeOf()).toBe('{}')
    expect(await scopeOf({})).toBe('{}')
    const { batch } = await run([body({ jobs: [] })], cfg({ endpoint: 'search' }))
    expect(batch.coverage).toBe('WINDOW')
  })

  it('all nine together keep the fixed key order', async () => {
    expect(
      await scopeOf({
        sort: 'recent',
        timezone: 'UTC-5',
        company: ['linear'],
        employmentType: ['Intern'],
        seniority: ['Senior'],
        excludeWorldwide: true,
        worldwide: true,
        country: 'US',
        q: 'x',
      }),
    ).toBe(
      '{"q":"x","country":"US","worldwide":true,"excludeWorldwide":true,"seniority":["Senior"],"employmentType":["Intern"],"company":["linear"],"timezone":"UTC-5","sort":"recent"}',
    )
  })

  it('each filter alone also reaches the wire under its own parameter name', async () => {
    const url = async (search: Record<string, unknown>) =>
      (await run([body({ jobs: [] })], cfg({ endpoint: 'search', search }))).f.sent[0]?.url
    expect(await url({ country: 'US' })).toBe(`${SEARCH}?country=US&page=1`)
    expect(await url({ worldwide: true })).toBe(`${SEARCH}?worldwide=true&page=1`)
    expect(await url({ excludeWorldwide: true })).toBe(`${SEARCH}?exclude_worldwide=true&page=1`)
    expect(await url({ employmentType: ['Intern'] })).toBe(
      `${SEARCH}?employment_type=Intern&page=1`,
    )
    expect(await url({ company: ['linear'] })).toBe(`${SEARCH}?company=linear&page=1`)
    expect(await url({ timezone: '+5:30' })).toBe(`${SEARCH}?timezone=%2B5%3A30&page=1`)
    expect(await url({ sort: 'jobs' })).toBe(`${SEARCH}?sort=jobs&page=1`)
    expect(await url({ q: 'x' })).toBe(`${SEARCH}?q=x&page=1`)
    expect(await url({ seniority: ['Manager'] })).toBe(`${SEARCH}?seniority=Manager&page=1`)
  })
})

describe('refusal reasons are the intended ones', () => {
  const reason = (extra: Record<string, unknown>) => {
    try {
      himalayasProvider.parseConfig({ configVersion: 1, ...extra })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return ''
  }
  it.each([
    [{ query: 'x' }, 'search text lives in search.q'],
    [{ window: { from: '2026-10-01', to: '2026-10-02' } }, 'Himalayas has no date window'],
    [{ search: { q: 'x' } }, 'search filters need endpoint'],
    [{ endpoint: 'search', pageSize: 5 }, 'the search endpoint has no page size'],
    [
      {
        endpoint: 'search',
        search: {
          company: ['a'.repeat(95), 'b'.repeat(95), 'c'.repeat(95), 'd'.repeat(95), 'e'.repeat(94)],
        },
      },
      'longer than 500 characters',
    ],
  ])('%j -> %s', (extra, fragment) => {
    expect(reason(extra)).toContain(fragment)
  })
})

describe('identity, shapes and optional-field defaults', () => {
  const first = () => page1().jobs[0] as Record<string, unknown>
  it('an empty guid is an invalid item, not an id-less observation', async () => {
    const { batch } = await run([body({ jobs: [{ ...first(), guid: '' }] })])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })
  it.each([
    ['an object without a name', [{ alpha2: 'PH' }]],
    ['a number', [5]],
    ['null', [null]],
    ['a non-array', 'United States'],
  ])('a third locationRestrictions shape (%s) is loud: one invalid item', async (_l, shape) => {
    const { batch } = await run([body({ jobs: [{ ...first(), locationRestrictions: shape }] })])
    expect(batch.counts.invalid).toBe(1)
    expect(batch.coverage).toBe('PARTIAL')
  })
  it('an explicit null locationRestrictions is unknown geography', async () => {
    const { batch } = await run([body({ jobs: [{ ...first(), locationRestrictions: null }] })])
    expect(batch.observations[0]?.normalized.location).toBeNull()
  })
  it('a job with neither pubDate nor expiryDate has no dates, no publishedAt, no evidence', async () => {
    const { pubDate: _p, expiryDate: _e, ...noDates } = first()
    for (const j of [noDates, { ...noDates, pubDate: null, expiryDate: null }]) {
      const o = (await run([body({ jobs: [j] })])).batch.observations[0]
      expect(o?.normalized.dates).toEqual([])
      expect(o?.normalized.publishedAt).toBeNull()
      expect(o?.evidence).toEqual([])
    }
  })
  it('pubDate and expiryDate each stand alone', async () => {
    const { expiryDate: _e, ...onlyPub } = first()
    const a = (await run([body({ jobs: [onlyPub] })])).batch.observations[0]
    expect(a?.normalized.dates.map((d) => d.semantics)).toEqual(['UPDATED'])
    const { pubDate: _p, ...onlyExpiry } = first()
    const b = (await run([body({ jobs: [onlyExpiry] })])).batch.observations[0]
    expect(b?.normalized.dates.map((d) => d.semantics)).toEqual(['EXPIRY'])
  })
  it('a job with no categories, seniority, employmentType or description gets the empty defaults', async () => {
    const {
      categories: _c,
      parentCategories: _p,
      seniority: _s,
      employmentType: _t,
      description: _d,
      ...bare
    } = first()
    for (const j of [
      bare,
      {
        ...bare,
        categories: null,
        parentCategories: null,
        seniority: null,
        employmentType: null,
        description: null,
      },
    ]) {
      const o = (await run([body({ jobs: [j] })])).batch.observations[0]
      expect(o?.normalized.tags).toEqual([])
      expect(o?.normalized.seniorityHint).toBeNull()
      expect(o?.normalized.employmentType).toBeNull()
      expect(o?.normalized.descriptionMd).toBe('')
    }
  })
  it('parentCategories come first and categories follow in tags', async () => {
    const j = { ...first(), parentCategories: ['P1', 'P2'], categories: ['C1'] }
    const o = (await run([body({ jobs: [j] })])).batch.observations[0]
    expect(o?.normalized.tags).toEqual(['P1', 'P2', 'C1'])
  })
})

describe('timezone filter shape and explicit endpoint', () => {
  const tz = (timezone: string) => () => cfg({ endpoint: 'search', search: { timezone } })
  it.each(['UTC-5', 'UTC+05:30', '-5', '+5:30', '+0530', '3', '12'])('accepts %s', (v) => {
    expect(tz(v)).not.toThrow()
  })
  it.each(['xUTC-5', 'UTC-5x', 'UTC-', 'UTC-12345', '5:3', 'Europe/Kyiv', ''])(
    'refuses %j',
    (v) => {
      expect(tz(v)).toThrow()
    },
  )
  it('accepts the endpoint named explicitly, for both values', () => {
    expect(cfg({ endpoint: 'browse' }).endpoint).toBe('browse')
    expect(cfg({ endpoint: 'search' }).endpoint).toBe('search')
  })
})
