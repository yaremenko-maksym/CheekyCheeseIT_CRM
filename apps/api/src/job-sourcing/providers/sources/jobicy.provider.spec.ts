import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { jobicyProvider, jobicySpec } from './jobicy.provider'

/**
 * Jobicy through its public provider. Expected values are hand-read from the two authentic
 * captures in `__fixtures__/jobicy/` (the seeded query: count=100, industry=engineering,
 * geo=europe) and from the provider's documentation (7-day window, 3-hour delay, cursor valid 24 h).
 */

const NOW = new Date('2026-10-23T20:00:00Z')
const HOUR = 3_600_000
const SEEDED = { count: 100, industry: 'engineering', geo: 'europe' }
const API = 'https://jobicy.com/api/jobs'

const cfg = (extra: Record<string, unknown> = {}) =>
  jobicyProvider.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Page = { jobs: Record<string, unknown>[]; nextCursor: string | null } & Record<string, unknown>
const page1 = () => sourceFixture('jobicy', 'seeded-page1') as Page
const page2 = () => sourceFixture('jobicy', 'seeded-page2') as Page
const body = (v: unknown): FakeResponse => ({ bodyText: JSON.stringify(v) })

async function run(responses: FakeResponse[], config = cfg(), now = NOW) {
  const f = fakeCollectionContext({ now, responses })
  const batch = await jobicyProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (b: Batch, id: string) => b.observations.find((o) => o.identity.nativeId === id)

describe('mapping the authentic capture', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: null })])
    const o = byId(batch, '156602')
    expect(o?.identity).toMatchObject({
      provider: 'JOBICY_API',
      namespace: 'jobicy',
      nativeId: '156602',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://jobicy.com/jobs/156602-forward-deployed-engineer-8')
    // The terms send every Apply to the feed's own url, so the two links coincide on purpose.
    expect(o?.applicationUrl).toBe('https://jobicy.com/jobs/156602-forward-deployed-engineer-8')
    expect(o?.normalized.title).toBe('Forward Deployed Engineer')
    expect(o?.normalized.companyName).toBe('Banyan Software')
    expect(o?.normalized.location).toBe('Belgium, Germany, Netherlands, UK')
    expect(o?.normalized.employmentType).toBe('Full-Time')
    expect(o?.normalized.seniorityHint).toBe('Senior')
    expect(o?.normalized.tags).toEqual(['Software Engineering'])
    expect(o?.normalized.remote).toBe(true)
    expect(o?.adapterVersion).toBe('jobicy-1')
  })

  it('pubDate is the PUBLICATION instant', async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: null })])
    const o = byId(batch, '156602')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-23T13:48:16.000Z')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-10-23T13:48:16+00:00',
        status: 'OK',
        value: new Date('2026-10-23T13:48:16.000Z'),
      },
    ])
    expect(byId(batch, '156544')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-23T09:12:15.000Z',
    )
  })

  it("'Any' level means unspecified (no seniority hint); a stated level is kept", async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: null })])
    expect(byId(batch, '156581')?.normalized.seniorityHint).toBeNull()
    expect(byId(batch, '156558')?.normalized.seniorityHint).toBe('Director')
  })

  it("geography: 'Anywhere' is kept as stated, doubled spaces after commas are normalised, empty is missing", async () => {
    const both = await run([body({ ...page2(), nextCursor: null })])
    expect(byId(both.batch, '150933')?.normalized.location).toBe('Europe, UK')
    const { batch } = await run([body({ ...page1(), nextCursor: null })])
    expect(byId(batch, '156581')?.normalized.location).toBe('Anywhere')
    for (const jobGeo of ['', '   ', undefined, null]) {
      const j = { ...page1().jobs[0], jobGeo }
      const r = await run([body({ ...page1(), nextCursor: null, jobs: [j] })])
      expect(r.batch.observations[0]?.normalized.location).toBeNull()
    }
  })

  it('empty and blank parts of a multi-region string are dropped', async () => {
    const j = { ...page1().jobs[0], jobGeo: 'Poland,, ,  Spain ,' }
    const r = await run([body({ jobs: [j], nextCursor: null })])
    expect(r.batch.observations[0]?.normalized.location).toBe('Poland, Spain')
  })

  it('a contract role keeps its type; several types are joined', async () => {
    const { batch } = await run([body({ ...page2(), nextCursor: null })])
    expect(byId(batch, '155656')?.normalized.employmentType).toBe('Contract')
    const multi = { ...page2().jobs[0], jobType: ['Full-Time', 'Contract'] }
    const r = await run([body({ jobs: [multi], nextCursor: null })])
    expect(r.batch.observations[0]?.normalized.employmentType).toBe('Full-Time, Contract')
  })

  it('identity is the native id: a changed slug/title does not move it', async () => {
    const a = await run([body({ ...page1(), nextCursor: null })])
    const edited = {
      ...page1().jobs[0],
      jobTitle: 'Renamed',
      url: 'https://jobicy.com/jobs/156602-new-slug',
    }
    const b = await run([body({ jobs: [edited], nextCursor: null })])
    expect(byId(b.batch, '156602')?.identity.identityKey).toBe(
      byId(a.batch, '156602')?.identity.identityKey,
    )
  })

  it('a missing employer (empty companyName, which the docs allow) is quarantined, not named', async () => {
    const j = { ...page1().jobs[0], companyName: '' }
    const { batch } = await run([body({ jobs: [j, page1().jobs[1]], nextCursor: null })])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
  })

  it('an absent employer key and an absent id are invalid items', async () => {
    const { companyName: _c, ...noCompany } = page1().jobs[0] as Record<string, unknown>
    const { id: _i, ...noId } = page1().jobs[1] as Record<string, unknown>
    const { batch } = await run([body({ jobs: [noCompany, noId], nextCursor: null })])
    expect(batch.counts.invalid).toBe(2)
  })

  it('a logo of `false` (documented for no image) does not matter', async () => {
    const j = { ...page1().jobs[0], companyLogo: false }
    const { batch } = await run([body({ jobs: [j], nextCursor: null })])
    expect(batch.counts.normalized).toBe(1)
  })
})

describe('bounds, at the limit and past it', () => {
  const job = (over: Record<string, unknown>) => ({ ...page1().jobs[0], ...over })
  const invalid = async (over: Record<string, unknown>) =>
    (await run([body({ jobs: [job(over)], nextCursor: null })])).batch.counts.invalid

  it('jobTitle 2000 / 2001', async () => {
    expect(await invalid({ jobTitle: 'T'.repeat(2000) })).toBe(0)
    expect(await invalid({ jobTitle: 'T'.repeat(2001) })).toBe(1)
  })
  it('companyName 1000 / 1001', async () => {
    expect(await invalid({ companyName: 'C'.repeat(1000) })).toBe(0)
    expect(await invalid({ companyName: 'C'.repeat(1001) })).toBe(1)
  })
  it('jobGeo 2000 / 2001', async () => {
    expect(await invalid({ jobGeo: 'G'.repeat(2000) })).toBe(0)
    expect(await invalid({ jobGeo: 'G'.repeat(2001) })).toBe(1)
  })
  it('jobIndustry: 200 items ok / 201 invalid; an item of 200 chars ok / 201 invalid', async () => {
    expect(await invalid({ jobIndustry: Array.from({ length: 200 }, () => 'i') })).toBe(0)
    expect(await invalid({ jobIndustry: Array.from({ length: 201 }, () => 'i') })).toBe(1)
    expect(await invalid({ jobIndustry: ['i'.repeat(200)] })).toBe(0)
    expect(await invalid({ jobIndustry: ['i'.repeat(201)] })).toBe(1)
  })
  it('jobType: 20 entries of 50 chars ok / 21 entries or a 51-char entry invalid', async () => {
    expect(await invalid({ jobType: Array.from({ length: 20 }, () => 't'.repeat(50)) })).toBe(0)
    expect(await invalid({ jobType: Array.from({ length: 21 }, () => 't') })).toBe(1)
    expect(await invalid({ jobType: ['t'.repeat(51)] })).toBe(1)
  })
  it('id: 1 and MAX_SAFE_INTEGER valid; 0, a fraction, a string invalid', async () => {
    expect(await invalid({ id: 1 })).toBe(0)
    expect(await invalid({ id: Number.MAX_SAFE_INTEGER })).toBe(0)
    expect(await invalid({ id: 0 })).toBe(1)
    expect(await invalid({ id: 2.5 })).toBe(1)
    expect(await invalid({ id: '7' })).toBe(1)
  })
  it('count is the page bound: count 3 with 3 jobs ok, with 4 jobs the page is drift', async () => {
    const c = cfg({ count: 3 })
    const three = { ...page1(), nextCursor: null, jobs: page1().jobs.slice(0, 3) }
    expect((await run([body(three)], c)).batch.counts.raw).toBe(3)
    const four = { ...page1(), nextCursor: null, jobs: page1().jobs.slice(0, 4) }
    const bad = await run([body(four)], c)
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
  })
  it('200 items under count 200 are accepted, 201 are drift', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ id: i + 1 }))
    const c = cfg({ count: 200 })
    expect((await run([body({ jobs: many(200), nextCursor: null })], c)).batch.counts.raw).toBe(200)
    expect((await run([body({ jobs: many(201), nextCursor: null })], c)).batch.outcome).toBe(
      'FAILED',
    )
  })
})

describe('what a Jobicy run covers', () => {
  it('claims WINDOW: the last 7 days minus the 3-hour publication delay, never FULL_INVENTORY', async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: null })])
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({
      from: new Date('2026-10-16T20:00:00.000Z'),
      to: new Date('2026-10-23T17:00:00.000Z'),
    })
    expect(batch.scope.namespace).toBe('jobicy')
    expect(batch.scope.query).toBe('{"geo":"europe","industry":"engineering"}')
  })

  it('a run with no filters has a null query but still a window', async () => {
    const { batch } = await run(
      [body({ jobs: [], nextCursor: null })],
      jobicyProvider.parseConfig({ configVersion: 1 }),
    )
    expect(batch.scope.query).toBeNull()
    expect(batch.coverage).toBe('WINDOW')
  })

  it('the tag keyword is part of the scope', async () => {
    const { batch } = await run([body({ jobs: [], nextCursor: null })], cfg({ tag: 'python' }))
    expect(batch.scope.query).toBe('{"geo":"europe","industry":"engineering","tag":"python"}')
  })
})

describe('cursor pagination', () => {
  it('follows nextCursor to the final page (nextCursor null) and sends the provider cursor unchanged', async () => {
    const { batch, f } = await run([body(page1()), body(page2())])
    const cursor = String(page1().nextCursor)
    expect(f.sent.map((r) => r.url)).toEqual([
      `${API}?count=100&geo=europe&industry=engineering`,
      `${API}?count=100&geo=europe&industry=engineering&cursor=${cursor}`,
    ])
    expect(batch.counts).toEqual({
      raw: 7,
      normalized: 7,
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
    // The stored cursor is ours: v1.<traversal start = now - 3h in ms>.<provider cursor>.
    expect(f.saved[0]?.position).toEqual({
      kind: 'CURSOR',
      page: 1,
      cursor: `v1.${NOW.getTime() - 3 * HOUR}.${cursor}`,
    })
  })

  it('reserved characters in a cursor are encoded: no extra parameter, no host change', async () => {
    const evil = 'x&count=1&y=z w#'
    const first = { ...page1(), nextCursor: evil }
    const { f } = await run([body(first), body({ jobs: [], nextCursor: null })])
    const second = f.sent[1]?.url ?? ''
    expect(new URL(second).host).toBe('jobicy.com')
    expect(new URL(second).searchParams.getAll('count')).toEqual(['100'])
    expect(new URL(second).searchParams.get('cursor')).toBe(evil)
  })

  it('the presence of hasMore:false alone does not stop a walk that still has a cursor (the cursor is authoritative)', async () => {
    const { f } = await run([body({ ...page1(), hasMore: false }), body({ ...page2() })])
    expect(f.sent).toHaveLength(2)
  })

  it('maxPages caps the walk with a reported PAGE_CAP (1 and 10 exact)', async () => {
    const pages = (n: number) =>
      Array.from({ length: n }, (_, i) => body({ ...page1(), nextCursor: `c${i}` }))
    const one = await run(pages(3), cfg({ maxPages: 1 }))
    expect(one.f.sent).toHaveLength(1)
    expect(one.batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
    const ten = await run(pages(12), cfg({ maxPages: 10 }))
    expect(ten.f.sent).toHaveLength(10)
    const dflt = await run(pages(8))
    expect(dflt.f.sent).toHaveLength(5)
  })

  it('a repeated cursor stops the walk as a cycle', async () => {
    const same = { ...page1(), nextCursor: 'LOOP' }
    const { f, batch } = await run([body(same), body(same), body(same)])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('an empty nextCursor string is drift', async () => {
    const { batch } = await run([body({ ...page1(), nextCursor: '' })])
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('a stored cursor is only good for 24 hours (documented); we stop trusting it at 23', () => {
  async function capped() {
    const first = await run([body(page1())], cfg({ maxPages: 1 }))
    const checkpoint = first.f.saved.at(-1)
    if (checkpoint === undefined) throw new Error('the capped run left no checkpoint')
    return checkpoint
  }
  async function resume(checkpoint: Awaited<ReturnType<typeof capped>>, laterMs: number) {
    const f = fakeCollectionContext({
      now: new Date(NOW.getTime() + laterMs),
      responses: [body({ ...page2() })],
      stored: checkpoint,
    })
    const batch = await jobicyProvider.collectReport(cfg({ maxPages: 1 }), f.ctx)
    return { batch, f }
  }
  const providerCursor = () => String(page1().nextCursor)

  it('within the lifetime the provider cursor is sent and the run resumes at page 2', async () => {
    const cp = await capped()
    const { f, batch } = await resume(cp, 23 * HOUR - 1)
    expect(f.sent[0]?.url).toBe(
      `${API}?count=100&geo=europe&industry=engineering&cursor=${providerCursor()}`,
    )
    expect(batch.requests[0]?.page).toBe(2)
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('at 23 hours the cursor is dropped and the walk restarts from the first page instead of wedging on an HTTP 400', async () => {
    const cp = await capped()
    const { f } = await resume(cp, 23 * HOUR)
    expect(f.sent[0]?.url).toBe(`${API}?count=100&geo=europe&industry=engineering`)
  })

  it('a cursor that claims to start in the future (clock moved back) is not forwarded', async () => {
    const cp = await capped()
    const { f } = await resume(cp, -HOUR)
    expect(f.sent[0]?.url).toBe(`${API}?count=100&geo=europe&industry=engineering`)
  })

  it('a checkpoint cursor this adapter did not write is not forwarded', async () => {
    const cp = await capped()
    const foreign = {
      ...cp,
      position: { kind: 'CURSOR' as const, page: 1, cursor: 'someone-elses' },
    }
    const { f } = await resume(foreign, HOUR)
    expect(f.sent[0]?.url).toBe(`${API}?count=100&geo=europe&industry=engineering`)
  })

  it('a config-version change restarts without widening the window past what the API can serve', async () => {
    const cp = await capped()
    const f = fakeCollectionContext({ now: NOW, responses: [body({ ...page2() })], stored: cp })
    const batch = await jobicyProvider.collectReport(cfg({ configVersion: 2 }), f.ctx)
    expect(batch.scope.window?.from.toISOString()).toBe('2026-10-16T20:00:00.000Z')
    expect(f.sent[0]?.url).toBe(`${API}?count=100&geo=europe&industry=engineering`)
  })
})

describe('partial runs, failures and reports', () => {
  it('page 2 failing (500): PARTIAL, page-1 jobs kept, both requests reported, checkpoint at page 1', async () => {
    const { batch, f } = await run([body(page1()), { status: 500, bodyText: '{}' }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(4)
    expect(batch.requests[0]).toMatchObject({ page: 1, status: 200, error: null })
    expect(batch.requests[1]).toMatchObject({ page: 2, status: 500, error: { code: 'UPSTREAM' } })
    expect(batch.checkpoint?.position).toMatchObject({ kind: 'CURSOR', page: 1 })
  })

  it('HTTP 400 for a cursor the provider refuses is UPSTREAM on that page', async () => {
    const { batch } = await run([
      body(page1()),
      { status: 400, bodyText: '{"success":false,"error":"cursor expired"}' },
    ])
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests[1]).toMatchObject({ status: 400, error: { code: 'UPSTREAM' } })
  })

  it('429 on page 2 is RATE_LIMIT and keeps page 1', async () => {
    const { batch } = await run([body(page1()), { status: 429, bodyText: '{}' }])
    expect(batch.requests[1]?.error?.code).toBe('RATE_LIMIT')
    expect(batch.observations).toHaveLength(4)
  })

  it('a network failure on page 2 reports no status and keeps page 1', async () => {
    const { batch } = await run([body(page1()), { throws: new Error('ECONNRESET') }])
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests[1]?.status).toBeNull()
  })

  it('a 200 whose body says success:false is drift, not an empty success', async () => {
    const { batch } = await run([body({ success: false, statusCode: 200, error: 'x', jobs: [] })])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a body without jobs is PARSE_DRIFT; an HTML page too', async () => {
    expect((await run([body({ hasMore: false })])).batch.requests[0]?.error?.code).toBe(
      'PARSE_DRIFT',
    )
    expect((await run([{ bodyText: '<html>' }])).batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('an empty window is a valid, empty success', async () => {
    const { batch } = await run([body({ jobs: [], nextCursor: null, hasMore: false })])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([
      body({ jobs: [page1().jobs[0], { id: 'x' }, page1().jobs[1]], nextCursor: null }),
    ])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('makes no metered reservation: this adapter never calls the metered status endpoint', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [body({ jobs: [], nextCursor: null })] })
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
    const batch = await jobicyProvider.collectReport(cfg(), ctx)
    expect(reserved).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(f.sent.every((r) => !r.url.includes('/status'))).toBe(true)
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['count 0', { count: 0 }],
    ['count 201 (past the documented maximum)', { count: 201 }],
    ['a fractional count', { count: 10.5 }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 11', { maxPages: 11 }],
    ['an industry with an injected parameter', { industry: 'engineering&count=1' }],
    ['an uppercase geo', { geo: 'Europe' }],
    ['a geo of 51 characters', { geo: 'a'.repeat(51) }],
    ['an empty industry', { industry: '' }],
    ['a tag of 101 characters', { tag: 't'.repeat(101) }],
    ['an empty tag', { tag: '' }],
    ['an unknown key', { cursor: 'abc' }],
    ['a namespace other than jobicy', { namespace: 'x' }],
    ['a base query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => jobicyProvider.parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts the seeded config verbatim, and the boundary values', () => {
    const seeded = jobicyProvider.parseConfig({
      configVersion: 1,
      count: 100,
      industry: 'engineering',
      geo: 'europe',
    })
    expect(seeded).toMatchObject({
      count: 100,
      industry: 'engineering',
      geo: 'europe',
      maxPages: 5,
    })
    expect(cfg({ count: 1 }).count).toBe(1)
    expect(cfg({ count: 200 }).count).toBe(200)
    expect(cfg({ maxPages: 10 }).maxPages).toBe(10)
    expect(cfg({ geo: 'a'.repeat(50) }).geo).toBe('a'.repeat(50))
    expect(cfg({ tag: 't'.repeat(100) }).tag).toBe('t'.repeat(100))
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('count defaults to 100 when omitted', () => {
    expect(jobicyProvider.parseConfig({ configVersion: 1 })).toMatchObject({ count: 100 })
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [body({ jobs: [], nextCursor: null })] })
    await expect(
      jobicyProvider.collectReport(
        { namespace: 'jobicy', configVersion: 1, count: 100, maxPages: 5 } as unknown as ReturnType<
          typeof cfg
        >,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })
})

describe('the request carries each filter, and only the ones configured (CR-M-2)', () => {
  const url = async (config: Record<string, unknown>) =>
    (
      await run(
        [body({ jobs: [], nextCursor: null })],
        jobicyProvider.parseConfig({ configVersion: 1, ...config }),
      )
    ).f.sent[0]?.url
  it('no filters: count only', async () => {
    expect(await url({})).toBe(`${API}?count=100`)
  })
  it('geo alone, industry alone, tag alone', async () => {
    expect(await url({ geo: 'usa' })).toBe(`${API}?count=100&geo=usa`)
    expect(await url({ industry: 'data-science' })).toBe(`${API}?count=100&industry=data-science`)
    expect(await url({ tag: 'python' })).toBe(`${API}?count=100&tag=python`)
  })
  it('a tag with reserved characters is encoded as one parameter', async () => {
    const u = (await url({ tag: 'c++ & rust=1' })) ?? ''
    expect(new URL(u).searchParams.get('tag')).toBe('c++ & rust=1')
    expect(new URL(u).searchParams.getAll('count')).toEqual(['100'])
  })
  it('all three together, count as configured', async () => {
    expect(await url({ count: 7, geo: 'usa', industry: 'marketing', tag: 'seo' })).toBe(
      `${API}?count=7&geo=usa&industry=marketing&tag=seo`,
    )
  })
  it('every request asks for JSON', async () => {
    const { f } = await run([body({ jobs: [], nextCursor: null })])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
  })
})

describe('a stored cursor must have exactly our shape (CR-M-2)', () => {
  const trusted = NOW.getTime() - 3 * HOUR
  it.each([
    ['a prefix before v1', `zv1.${trusted}.abc`],
    ['a non-numeric stamp', 'v1.abc.def'],
    ['an empty stamp', 'v1..abc'],
    ['an empty provider cursor', `v1.${trusted}.`],
    ['a different version tag', `v2.${trusted}.abc`],
    ['a bare provider cursor', 'AgAAAABq27zH'],
  ])('%s is not forwarded', async (_l, cursor) => {
    const first = await run([body(page1())], cfg({ maxPages: 1 }))
    const cp = first.f.saved.at(-1)
    if (cp === undefined) throw new Error('no checkpoint')
    const f = fakeCollectionContext({
      now: NOW,
      responses: [body({ ...page2() })],
      stored: { ...cp, position: { kind: 'CURSOR', page: 1, cursor } },
    })
    await jobicyProvider.collectReport(cfg({ maxPages: 1 }), f.ctx)
    expect(f.sent[0]?.url).toBe(`${API}?count=100&geo=europe&industry=engineering`)
  })

  it('a well-formed cursor that CONTAINS dots in the provider part is forwarded whole', async () => {
    const first = await run([body(page1())], cfg({ maxPages: 1 }))
    const cp = first.f.saved.at(-1)
    if (cp === undefined) throw new Error('no checkpoint')
    const f = fakeCollectionContext({
      now: NOW,
      responses: [body({ ...page2() })],
      stored: { ...cp, position: { kind: 'CURSOR', page: 1, cursor: `v1.${trusted}.a.b.c` } },
    })
    await jobicyProvider.collectReport(cfg({ maxPages: 1 }), f.ctx)
    expect(new URL(f.sent[0]?.url ?? '').searchParams.get('cursor')).toBe('a.b.c')
  })
})

describe('optional-field defaults and the window contract', () => {
  const first = () => page1().jobs[0] as Record<string, unknown>
  it('a job with no pubDate: no dates, no publishedAt, no evidence', async () => {
    const { pubDate: _p, ...rest } = first()
    for (const j of [rest, { ...rest, pubDate: null }]) {
      const o = (await run([body({ jobs: [j], nextCursor: null })])).batch.observations[0]
      expect(o?.normalized.dates).toEqual([])
      expect(o?.normalized.publishedAt).toBeNull()
      expect(o?.evidence).toEqual([])
    }
  })
  it('a job with no industry, type, level or description gets the empty defaults', async () => {
    const { jobIndustry: _i, jobType: _t, jobLevel: _l, jobDescription: _d, ...bare } = first()
    for (const j of [
      bare,
      { ...bare, jobIndustry: null, jobType: null, jobLevel: null, jobDescription: null },
    ]) {
      const o = (await run([body({ jobs: [j], nextCursor: null })])).batch.observations[0]
      expect(o?.normalized.tags).toEqual([])
      expect(o?.normalized.employmentType).toBeNull()
      expect(o?.normalized.seniorityHint).toBeNull()
      expect(o?.normalized.descriptionMd).toBe('')
    }
  })
  it.each([
    ['', null],
    ['   ', null],
    ['Any', null],
    [' Any ', null],
    ['Senior', 'Senior'],
    [' Senior ', 'Senior'],
  ])('jobLevel %j -> hint %j', async (jobLevel, hint) => {
    const o = (await run([body({ jobs: [{ ...first(), jobLevel }], nextCursor: null })])).batch
      .observations[0]
    expect(o?.normalized.seniorityHint).toBe(hint)
  })
  it('an empty jobType list gives no employment type, not an empty string', async () => {
    const o = (await run([body({ jobs: [{ ...first(), jobType: [] }], nextCursor: null })])).batch
      .observations[0]
    expect(o?.normalized.employmentType).toBeNull()
  })
  it('a page target with no window is refused with a clear message (the loop always supplies one)', () => {
    expect(() => jobicySpec.pageRequest(cfg(), { page: 1, cursor: null, window: null })).toThrow(
      'Jobicy requires a window on every page target',
    )
  })
})

describe('refusal reasons are the intended ones', () => {
  const reason = (extra: Record<string, unknown>) => {
    try {
      jobicyProvider.parseConfig({ configVersion: 1, ...extra })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return ''
  }
  it('query and window are refused with their own wording', () => {
    expect(reason({ query: 'x' })).toContain('Jobicy filters live in industry / geo / tag')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'Jobicy has no date parameters',
    )
  })
})
