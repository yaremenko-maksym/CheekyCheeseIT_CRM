import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { MUSE_SOURCE_STATUS, museProvider } from './muse.provider'

/**
 * The Muse through its public provider. Expected values are hand-read from the two live captures in
 * `__fixtures__/muse/` (the seeded query, page 0, and a page past the end) and from the developer
 * page; they are written as literals, never produced by running the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const SEEDED = { category: 'Software Engineering', level: 'Senior Level', maxPages: 5 }
const API = 'https://www.themuse.com/api/public/jobs'
const SEEDED_QUERY = 'category=Software+Engineering&level=Senior+Level'

const cfg = (extra: Record<string, unknown> = {}) =>
  museProvider.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { results: Record<string, unknown>[] } & Record<string, unknown>
const page0 = () => sourceFixture('muse', 'seeded-page0') as Envelope
const body = (v: unknown): FakeResponse => ({ bodyText: JSON.stringify(v) })
/** The captured page re-labelled as page `n` of `count`, so paging can be driven without a capture per page. */
const asPage = (n: number, count: number, results = page0().results) =>
  body({ ...page0(), page: n, page_count: count, results })

async function run(responses: FakeResponse[], config = cfg()) {
  const f = fakeCollectionContext({ now: NOW, responses })
  const batch = await museProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (b: Batch, id: string) => b.observations.find((o) => o.identity.nativeId === id)

describe('mapping the authentic capture', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1 })])
    const o = byId(batch, '18540547')
    expect(o?.identity).toMatchObject({
      provider: 'MUSE_API',
      namespace: 'themuse',
      nativeId: '18540547',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://www.themuse.com/jobs/exadel/seniorlead-software-engineer-angular',
    )
    expect(o?.normalized.title).toBe('Senior/Lead Software Engineer (Angular)')
    expect(o?.normalized.companyName).toBe('Exadel')
    expect(o?.normalized.location).toBe(
      'Dabas, Hungary; Făgăraș, Romania; Kėdainiai, Lithuania; Ozorków, Poland; Sofia, Bulgaria',
    )
    expect(o?.normalized.seniorityHint).toBe('Senior Level')
    expect(o?.normalized.tags).toEqual(['Software Engineering'])
    expect(o?.adapterVersion).toBe('muse-1')
  })

  it('the response has no apply URL: the posting URL is the only link', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1 })])
    expect(byId(batch, '18540547')?.applicationUrl).toBeNull()
  })

  it('publication_date is the PUBLICATION instant, read as a zoned ISO date', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1 })])
    expect(byId(batch, '18540547')?.normalized.publishedAt?.toISOString()).toBe(
      '2025-04-15T23:36:38.000Z',
    )
    expect(byId(batch, '22171959')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-01T22:29:21.000Z',
    )
    expect(byId(batch, '18540547')?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2025-04-15T23:36:38Z',
        status: 'OK',
        value: new Date('2025-04-15T23:36:38.000Z'),
      },
    ])
  })

  it('all six captured jobs are kept, none invalid, and the description is HTML', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1 })])
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      '18540547',
      '22039277',
      '20406944',
      '18400118',
      '22123640',
      '22171959',
    ])
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('a job located nowhere in particular is NOT marked remote: absence is not evidence', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1 })])
    expect(byId(batch, '18540547')?.normalized.remote).toBeNull()
    expect(byId(batch, '22039277')?.normalized.remote).toBeNull()
  })

  it("a location named exactly 'Flexible / Remote' marks the job remote", async () => {
    const job = {
      ...page0().results[1],
      locations: [{ name: 'New York, NY' }, { name: 'Flexible / Remote' }],
    }
    const { batch } = await run([body({ ...page0(), page_count: 1, results: [job] })])
    expect(batch.observations[0]?.normalized.remote).toBe(true)
    expect(batch.observations[0]?.normalized.location).toBe('New York, NY; Flexible / Remote')
  })

  it('a location that merely CONTAINS the word remote does not', async () => {
    const job = { ...page0().results[1], locations: [{ name: 'Remote Control Rd, OH' }] }
    const { batch } = await run([body({ ...page0(), page_count: 1, results: [job] })])
    expect(batch.observations[0]?.normalized.remote).toBeNull()
  })

  it('a job with no locations, levels or categories maps empty values, not a failure', async () => {
    const {
      locations: _l,
      levels: _v,
      categories: _c,
      ...bare
    } = page0().results[1] as Record<string, unknown>
    const { batch } = await run([body({ ...page0(), page_count: 1, results: [bare] })])
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.normalized.location).toBeNull()
    expect(batch.observations[0]?.normalized.seniorityHint).toBeNull()
    expect(batch.observations[0]?.normalized.tags).toEqual([])
  })

  it('identity is the native id: a changed slug does not move it', async () => {
    const a = await run([body({ ...page0(), page_count: 1 })])
    const edited = {
      ...page0().results[0],
      name: 'Renamed',
      refs: { landing_page: 'https://www.themuse.com/jobs/exadel/new-slug' },
    }
    const b = await run([body({ ...page0(), page_count: 1, results: [edited] })])
    expect(byId(b.batch, '18540547')?.identity.identityKey).toBe(
      byId(a.batch, '18540547')?.identity.identityKey,
    )
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([
      body({
        ...page0(),
        page_count: 1,
        results: [page0().results[0], { id: 'x' }, page0().results[1]],
      }),
    ])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an empty page is a valid, empty success', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1, results: [] })])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })
})

describe('the request and the paging', () => {
  it('asks for page 0 first: the wire is 0-based, the loop is 1-based', async () => {
    const { f } = await run([body({ ...page0(), page_count: 1 })])
    expect(f.sent.map((r) => r.url)).toEqual([`${API}?page=0&${SEEDED_QUERY}`])
  })

  it('sends no credential of any kind', async () => {
    const { f } = await run([body({ ...page0(), page_count: 1 })])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(f.sent[0]?.method ?? 'GET').toBe('GET')
  })

  it('sends only the filters that are configured', async () => {
    const bare = museProvider.parseConfig({ configVersion: 1 })
    const { f } = await run([body({ ...page0(), page_count: 1 })], bare)
    expect(f.sent[0]?.url).toBe(`${API}?page=0`)
    const located = museProvider.parseConfig({
      configVersion: 1,
      location: 'Flexible / Remote',
    })
    const r = await run([body({ ...page0(), page_count: 1 })], located)
    expect(r.f.sent[0]?.url).toBe(`${API}?page=0&location=Flexible+%2F+Remote`)
  })

  it('walks page 0, 1, 2 and stops when page_count pages have been read (3 of 3)', async () => {
    const { f, batch } = await run([asPage(0, 3), asPage(1, 3), asPage(2, 3)])
    expect(f.sent.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['0', '1', '2'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('does not ask for page_count itself: 3 pages exist, so index 3 is never requested', async () => {
    const { f } = await run([asPage(0, 3), asPage(1, 3), asPage(2, 3), asPage(3, 3)])
    expect(f.sent).toHaveLength(3)
  })

  it('a single-page result is one request', async () => {
    const { f } = await run([asPage(0, 1)])
    expect(f.sent).toHaveLength(1)
  })

  it('stops at maxPages while more pages exist, and says the run was capped (2 of 5 read)', async () => {
    const { f, batch } = await run([asPage(0, 5), asPage(1, 5)], cfg({ maxPages: 2 }))
    expect(f.sent).toHaveLength(2)
    // A capped SEARCH scope is a WINDOW: the cap is a bound we chose, reported as PAGE_CAP.
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
    expect(batch.checkpoint?.position).toEqual({ kind: 'CURSOR', page: 2, cursor: 'page:3' })
  })

  it('reads maxPages exactly when it equals the page count (2 of 2): nothing is left behind', async () => {
    const { f, batch } = await run([asPage(0, 2), asPage(1, 2)], cfg({ maxPages: 2 }))
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.some((r) => r.error?.code === 'PAGE_CAP')).toBe(false)
  })

  it('a page past the end is HTTP 400 (live-measured) and is reported as an upstream failure', async () => {
    const tooHigh = sourceFixture('muse', 'page-too-high')
    expect(tooHigh).toEqual({ code: 400, error: 'Value `page` is too high' })
    const { batch } = await run([{ status: 400, bodyText: JSON.stringify(tooHigh) }])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('UPSTREAM')
    expect(batch.requests.at(-1)?.status).toBe(400)
  })

  it('a server-side timeout (timed_out true) is drift, not a short page', async () => {
    const { batch } = await run([body({ ...page0(), page_count: 1, timed_out: true })])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it.each([
    ['a missing page_count', { page: 0, results: [] }],
    ['a negative page_count', { page: 0, page_count: -1, results: [] }],
    ['a fractional page', { page: 0.5, page_count: 1, results: [] }],
    ['results that are not a list', { page: 0, page_count: 1, results: 'x' }],
  ])('%s is envelope drift', async (_label, envelope) => {
    const { batch } = await run([body(envelope)])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('makes no metered reservation: the public API is unmetered', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [asPage(0, 1)] })
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
    const batch = await museProvider.collectReport(cfg(), ctx)
    expect(reserved).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('scopes the run by its filters: a different level is a different scope', async () => {
    const a = await run([asPage(0, 1)])
    const b = await run([asPage(0, 1)], cfg({ level: 'Entry Level' }))
    expect(a.batch.scope.query).toBe('{"category":"Software Engineering","level":"Senior Level"}')
    expect(b.batch.scope.query).toBe('{"category":"Software Engineering","level":"Entry Level"}')
    expect(a.batch.scope.namespace).toBe('themuse')
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 6 (past the unauthenticated rate budget)', { maxPages: 6 }],
    ['a fractional maxPages', { maxPages: 2.5 }],
    ['a level that is not documented', { level: 'Senior' }],
    ['a category of 81 characters', { category: 'a'.repeat(81) }],
    ['an empty category', { category: '' }],
    ['a category with an injected parameter', { category: 'x&page=9' }],
    ['a category with a control character', { category: 'x\ny' }],
    ['an empty location', { location: '' }],
    ['an unknown key', { cursor: 'abc' }],
    ['a namespace other than themuse', { namespace: 'x' }],
    ['a base query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => museProvider.parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts the seeded config verbatim, and the boundary values', () => {
    const seeded = museProvider.parseConfig({
      configVersion: 1,
      category: 'Software Engineering',
      level: 'Senior Level',
      maxPages: 5,
    })
    expect(seeded.namespace).toBe('themuse')
    expect(seeded.maxPages).toBe(5)
    expect(museProvider.parseConfig({ configVersion: 1, maxPages: 1 }).maxPages).toBe(1)
    expect(museProvider.parseConfig({ configVersion: 1 }).maxPages).toBe(5)
    expect(
      museProvider.parseConfig({ configVersion: 1, category: 'a'.repeat(80) }).category,
    ).toHaveLength(80)
    expect(
      museProvider.parseConfig({ configVersion: 1, location: 'Flexible / Remote' }).location,
    ).toBe('Flexible / Remote')
    for (const level of ['Entry Level', 'Mid Level', 'Senior Level', 'management', 'Internship']) {
      expect(museProvider.parseConfig({ configVersion: 1, level }).level).toBe(level)
    }
  })

  it('refuses a config that parseConfig never saw, before any network call', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [] })
    await expect(
      museProvider.collectReport(
        { ...SEEDED, configVersion: 1, namespace: 'themuse' } as never,
        f.ctx,
      ),
    ).rejects.toThrow(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })

  it('refusal reasons are the intended ones', () => {
    const reason = (extra: Record<string, unknown>) => {
      try {
        museProvider.parseConfig({ configVersion: 1, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ query: 'x' })).toContain('The Muse filters live in category / level / location')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'The Muse has no date parameters',
    )
  })
})

describe('the BLOCKED state', () => {
  it('declares itself blocked, UNCLEAR, for the terms reason - and the provenance agrees', () => {
    expect(MUSE_SOURCE_STATUS.blocked).toBe(true)
    expect(MUSE_SOURCE_STATUS.permission).toBe('UNCLEAR')
    expect(MUSE_SOURCE_STATUS.reason).toContain('section 2.2 requires a registered app')
    expect(MUSE_SOURCE_STATUS.reason).toContain('owner decision')
    for (const name of ['seeded-page0', 'page-too-high']) {
      expect((sourceProvenance('muse', name) as { permission: string }).permission).toBe(
        MUSE_SOURCE_STATUS.permission,
      )
    }
  })

  it('the provenance records the live findings a reader would otherwise get wrong', () => {
    const notes = (sourceProvenance('muse', 'seeded-page0') as { notes: string }).notes
    expect(notes).toContain('PAGES ARE 0-BASED')
    expect(notes).toContain('section 2.2 requires the app to be REGISTERED')
    const high = sourceProvenance('muse', 'page-too-high') as { notes: string; httpStatus: number }
    expect(high.httpStatus).toBe(400)
    expect(high.notes).toContain('NOT an empty result list')
  })
})

/** Survivors of the mutation gate, each turned into the assertion that kills it. */
describe('lists the posting carries', () => {
  it('several levels are joined with a comma and a space', async () => {
    const job = { ...page0().results[0], levels: [{ name: 'Mid Level' }, { name: 'Senior Level' }] }
    const { batch } = await run([body({ ...page0(), page_count: 1, results: [job] })])
    expect(batch.observations[0]?.normalized.seniorityHint).toBe('Mid Level, Senior Level')
  })

  it.each([
    ['levels', 'seniorityHint', null],
    ['locations', 'location', null],
    ['categories', 'tags', []],
  ] as const)(
    'a posting whose %s is null maps %s to its empty value',
    async (key, field, empty) => {
      const job = { ...page0().results[0], [key]: null }
      const { batch } = await run([body({ ...page0(), page_count: 1, results: [job] })])
      expect(batch.observations[0]?.normalized[field]).toEqual(empty)
    },
  )
})
