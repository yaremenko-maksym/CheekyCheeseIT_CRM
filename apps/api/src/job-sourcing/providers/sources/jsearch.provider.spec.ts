import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { meteredContext } from '../../../test/quota-harness'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { createJSearchProvider, JSEARCH_SOURCE_STATUS } from './jsearch.provider'
import { SourceNotReadyError } from './quota-provider'

/**
 * JSearch (RapidAPI) through its public provider. Expected values are hand-read from
 * `__fixtures__/jsearch/search-v2-smoke.json` - a real CAPTURE of the owner's controlled smoke
 * (see its provenance) - and written as literals, never produced by running the mapper.
 *
 * THE KEY is an obviously fake string; no real credential appears here.
 */

const NOW = new Date('2026-11-17T04:00:00Z')
const KEY = 'fake0000rapid0000key0000fake0000rapid0000key0000xyz'
const SEEDED = { query: 'senior backend developer remote' }
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const
const NOT_CONFIGURED = { configured: false, apiKey: null, secrets: [] } as const
const SEARCH =
  'https://jsearch.p.rapidapi.com/search-v2?query=senior+backend+developer+remote&num_pages=1&country=us&date_posted=week&work_from_home=true'

const provider = (opts: Partial<Parameters<typeof createJSearchProvider>[0]> = {}) =>
  createJSearchProvider({ credential: READY, ...opts })
const cfg = (extra: Record<string, unknown> = {}, p = provider()) =>
  p.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { data: { jobs: Record<string, unknown>[] } } & Record<string, unknown>
const capture = () => sourceFixture('jsearch', 'search-v2-smoke') as Envelope
const job = (id: string, over: Record<string, unknown> = {}) => ({
  ...capture().data.jobs[0],
  job_id: id,
  job_apply_link: `https://careers.example-systems.test/jobs/${id}/apply`,
  ...over,
})
const body = (data: unknown[]): FakeResponse => ({
  bodyText: JSON.stringify({ status: 'OK', data: { jobs: data, cursor: 'next' } }),
})

async function run(
  responses: FakeResponse[],
  opts: { config?: ReturnType<typeof cfg>; p?: ReturnType<typeof provider>; refuse?: number } = {},
) {
  const p = opts.p ?? provider()
  const f = fakeCollectionContext({ now: NOW, responses })
  const m = meteredContext(f, opts.refuse === undefined ? {} : { refuseOnReserve: opts.refuse })
  const batch = await p.collectReport(opts.config ?? cfg({}, p), m.ctx)
  return { batch, f, m }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (b: Batch, id: string) => b.observations.find((o) => o.identity.nativeId === id)

describe('a missing key is a readiness error before the budget and before the network', () => {
  it.each([
    ['not configured', NOT_CONFIGURED],
    ['configured with no key', { configured: true, apiKey: null, secrets: [] }],
    ['configured with an empty key', { configured: true, apiKey: '', secrets: [] }],
  ])('%s: refuses, reserves nothing, sends nothing', async (_label, credential) => {
    const p = provider({ credential })
    const f = fakeCollectionContext({ now: NOW, responses: [body([job('a')])] })
    const m = meteredContext(f)
    await expect(p.collectReport(cfg({}, p), m.ctx)).rejects.toThrow(SourceNotReadyError)
    expect(m.events).toEqual([])
    expect(f.sent).toEqual([])
  })

  it('names the source and the variable', async () => {
    const p = provider({ credential: NOT_CONFIGURED })
    const f = fakeCollectionContext({ now: NOW, responses: [] })
    const error = await p.collectReport(cfg({}, p), meteredContext(f).ctx).catch((e: unknown) => e)
    expect((error as Error).message).toBe('JSEARCH_API: RAPIDAPI_KEY is not configured')
  })

  it('an unvalidated config is still refused first', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [] })
    await expect(
      provider().collectReport({ configVersion: 1, ...SEEDED } as never, meteredContext(f).ctx),
    ).rejects.toThrow(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })
})

describe('the request', () => {
  it('GETs the seeded search, one page, with the key in a header', async () => {
    const { f } = await run([body([])])
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe(SEARCH)
    expect(f.sent[0]?.method ?? 'GET').toBe('GET')
    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/json',
      'x-rapidapi-key': KEY,
      'x-rapidapi-host': 'jsearch.p.rapidapi.com',
    })
  })

  it('keeps the key out of the URL', async () => {
    const { f } = await run([body([])])
    expect(f.sent[0]?.url).not.toContain(KEY)
  })

  it('sends exactly the parameter set the smoke proved: num_pages=1, country=us, no page', async () => {
    const { f } = await run([body([job('a')])])
    const url = new URL(f.sent[0]?.url ?? '')
    expect([...url.searchParams.keys()]).toEqual([
      'query',
      'num_pages',
      'country',
      'date_posted',
      'work_from_home',
    ])
    expect(url.searchParams.get('num_pages')).toBe('1')
    expect(url.searchParams.get('country')).toBe('us')
  })

  it('reads ONE page per run, even when the response carries a cursor', async () => {
    const { f, batch } = await run([body([job('a')]), body([job('b')])])
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.at(-1)?.error ?? null).toBeNull()
  })

  it('CR-M-4: one page of a search is a capped run: SUCCEEDED, but PARTIAL, never WINDOW', async () => {
    const { batch } = await run([body([job('a')])])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('honours the configured filters; remoteOnly false sends no work_from_home', async () => {
    const p = provider()
    const { f } = await run([body([])], {
      p,
      config: cfg({ datePosted: 'today', remoteOnly: false }, p),
    })
    const url = new URL(f.sent[0]?.url ?? '')
    expect(url.searchParams.get('date_posted')).toBe('today')
    expect(url.searchParams.has('work_from_home')).toBe(false)
  })
})

describe('mapping the capture', () => {
  // The provider's opaque id, 414 characters in every job of the capture.
  const FIRST_ID = capture().data.jobs[0]!['job_id'] as string
  const FIRST_APPLY =
    'https://www.jobleads.com/us/job/senior-backend-engineer-remote-integrations-architecture--united-states--e202d10032d8dc154d405fc199ae526d1'

  it('maps every job of the capture, none invalid', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(capture()) }])
    expect(batch.counts).toMatchObject({ raw: 3, normalized: 3, invalid: 0 })
  })

  const first = (b: Batch) => b.observations.find((o) => o.sourcePostingUrl === FIRST_APPLY)

  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(capture()) }])
    // A 414-character id is past the identity seam's 256: identity is the sha256 of the full id
    // (round 2, CR-M-3), never the apply URL (which collides for Indeed `viewjob?jk=` postings).
    expect(FIRST_ID).toHaveLength(414)
    const o = first(batch)
    expect(o?.identity).toMatchObject({
      provider: 'JSEARCH_API',
      namespace: 'jsearch',
      nativeId: 'sha256:cf36a38f11a7382b09687f4a1c26796ced52be13e9470958238d1cad34804b66',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(FIRST_APPLY)
    expect(o?.normalized.title).toBe(
      'Senior Backend Engineer - Remote, Integrations & Architecture',
    )
    expect(o?.normalized.companyName).toBe('Atlassian Corp.')
    // job_city / job_state / job_country are null for a remote posting: job_location is all there is.
    expect(o?.normalized.location).toBe('Anywhere')
    expect(o?.normalized.employmentType).toBe('Full-time')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z')
    expect(o?.adapterVersion).toBe('jsearch-2')
  })

  it('a short job id is still the identity; the apply URL is a separate fact', async () => {
    const { batch } = await run([body([job('short-id')])])
    const o = byId(batch, 'short-id')
    expect(o?.identity.identityKind).toBe('NATIVE_ID')
    expect(o?.applicationUrl).toBe('https://careers.example-systems.test/jobs/short-id/apply')
  })

  it('padding around a job id does not change its identity (round 3)', async () => {
    const { batch } = await run([
      body([job('  pad-id\n'), job(`${'j'.repeat(300)}`), job(` ${'j'.repeat(300)} `)]),
    ])
    expect(byId(batch, 'pad-id')?.identity.nativeId).toBe('pad-id')
    const hashed = batch.observations.filter((o) => o.identity.nativeId.startsWith('sha256:'))
    expect(hashed).toHaveLength(2)
    expect(hashed[0]?.identity.nativeId).toBe(hashed[1]?.identity.nativeId)
  })

  it('two long ids differing only at the end, on one apply URL, are two identities', async () => {
    const stem = 'j'.repeat(413)
    const url = 'https://www.indeed.com/viewjob?jk=same'
    const { batch } = await run([
      body([job(`${stem}a`, { job_apply_link: url }), job(`${stem}b`, { job_apply_link: url })]),
    ])
    const ids = batch.observations.map((o) => o.identity.identityKey)
    expect(batch.observations).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(batch.observations.every((o) => o.identity.identityKind === 'NATIVE_ID')).toBe(true)
  })

  it('an id of exactly 256 characters is kept as is; 257 is hashed', async () => {
    const { batch } = await run([body([job('w'.repeat(256)), job('z'.repeat(257))])])
    expect(byId(batch, 'w'.repeat(256))?.identity.identityKind).toBe('NATIVE_ID')
    expect(
      byId(batch, 'sha256:16c04de4670e399ba23109c0d04a5426d75fe696be2ea988c4b7b1aeecc8efdc'),
    ).toBeDefined()
  })

  it('a job id past 600 characters is invalid, at 600 it is kept', async () => {
    const { batch } = await run([body([job('x'.repeat(601)), job('y'.repeat(600))])])
    expect(batch.counts).toMatchObject({ normalized: 1, invalid: 1 })
  })

  it('the city/state/country parts win over job_location when present', async () => {
    const placed = job('p', { job_city: 'Warsaw', job_state: null, job_country: 'PL' })
    const { batch } = await run([body([placed])])
    expect(byId(batch, 'p')?.normalized.location).toBe('Warsaw, PL')
  })

  it('an explicit false is kept as false', async () => {
    const { batch } = await run([body([job('f', { job_is_remote: false })])])
    expect(byId(batch, 'f')?.normalized.remote).toBe(false)
  })

  it('a posting with no location at all maps no location', async () => {
    const bare = job('c', {
      job_city: null,
      job_state: null,
      job_country: null,
      job_location: null,
    })
    const { batch } = await run([body([bare])])
    expect(byId(batch, 'c')?.normalized.location).toBeNull()
  })

  it('a blank job_location is no location either', async () => {
    const { batch } = await run([body([job('e', { job_location: '' })])])
    expect(byId(batch, 'e')?.normalized.location).toBeNull()
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([body([job('a'), { job_id: 'x' }, job('b')])])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it.each([
    ['no `data`', { status: 'OK' }],
    ['the v1 shape (`data` is the list)', { status: 'OK', data: [] }],
    ['`data` without `jobs`', { status: 'OK', data: { cursor: 'x' } }],
  ])('an envelope with %s is drift', async (_l, envelope) => {
    const { batch } = await run([{ bodyText: JSON.stringify(envelope) }])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('metering: one call is one REQUEST', () => {
  it('reserves 1 REQUEST, marks it sent, fetches, settles USED - in that order', async () => {
    const { m } = await run([body([job('a')])])
    expect(m.reserved).toEqual([{ unit: 'REQUEST', amount: 1 }])
    expect(m.events).toEqual(['reserve', 'markSent', 'fetch', 'reconcile:USED'])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('the meter is a parameter: another agreement reserves its own unit and amount', async () => {
    const p = provider({ meter: { unit: 'REQUEST', amountPerRequest: 3 } })
    const { m } = await run([body([])], { p })
    expect(m.reserved).toEqual([{ unit: 'REQUEST', amount: 3 }])
  })

  it('refuses a bad meter when the provider is built', () => {
    expect(() => provider({ meter: { unit: 'REQUEST', amountPerRequest: 0 } })).toThrow()
  })

  it('a run is ONE paid request with one reservation, whatever the response says', async () => {
    const { m } = await run([body([job('a')]), body([job('b')]), body([])])
    expect(m.reserved).toHaveLength(1)
    expect(m.settled.map((s) => s.id)).toEqual(['res-1'])
  })

  it('an empty page still cost the call that found it', async () => {
    const { m, f } = await run([body([])])
    expect(f.sent).toHaveLength(1)
    expect(m.reserved).toHaveLength(1)
  })

  it('a timeout after the request left holds the reservation UNCERTAIN', async () => {
    const { m } = await run([{ throws: new Error('timeout') }])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'UNCERTAIN' }])
  })

  it('a quota answer (429) is a rate-limit failure, charged as a response that arrived', async () => {
    const { m, batch } = await run([{ status: 429 }])
    expect(batch.requests.at(-1)?.error?.code).toBe('RATE_LIMIT')
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('a refused reservation is a cost stop: nothing is sent', async () => {
    const { batch, f, m } = await run([body([job('a')])], { refuse: 1 })
    expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
    expect(f.sent).toEqual([])
    expect(m.events).toEqual(['reserve'])
  })
})

describe('the key never reaches a report', () => {
  it('a network error that echoes the header is redacted, with no key registered by the worker', async () => {
    const { batch } = await run([{ throws: new Error(`refused x-rapidapi-key: ${KEY} for host`) }])
    expect(batch.requests[0]?.error?.message).toBe('refused x-rapidapi-key: [REDACTED] for host')
    expect(JSON.stringify(batch)).not.toContain(KEY)
  })

  it('the reported URL shows only the allowlisted parameters (query); the rest are marked', async () => {
    const { batch } = await run([body([])])
    expect(batch.requests[0]?.url).toBe(
      'https://jsearch.p.rapidapi.com/search-v2?query=senior+backend+developer+remote&num_pages=[REDACTED]&country=[REDACTED]&date_posted=[REDACTED]&work_from_home=[REDACTED]',
    )
    expect(batch.requests[0]?.url).not.toContain(KEY)
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['no query', { query: undefined }],
    ['an empty query', { query: '' }],
    ['a query of 121 characters', { query: 'q'.repeat(121) }],
    ['an unknown datePosted', { datePosted: 'year' }],
    ['a non-boolean remoteOnly', { remoteOnly: 'yes' }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 2 (one page per run)', { maxPages: 2 }],
    ['an unknown key', { num_pages: 5 }],
    ['a namespace other than jsearch', { namespace: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => provider().parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts all three seeded queries, defaults, and the boundary values', () => {
    for (const query of [
      'senior backend developer remote',
      'senior frontend developer remote',
      'senior ai engineer remote',
    ]) {
      expect(provider().parseConfig({ configVersion: 1, query }).query).toBe(query)
    }
    const seeded = provider().parseConfig({ configVersion: 1, ...SEEDED })
    expect(seeded).toMatchObject({
      namespace: 'jsearch',
      datePosted: 'week',
      remoteOnly: true,
      maxPages: 1,
    })
    expect(provider().parseConfig({ configVersion: 1, query: 'q'.repeat(120) }).query).toHaveLength(
      120,
    )
    expect(provider().parseConfig({ configVersion: 1, query: 'q', maxPages: 1 }).maxPages).toBe(1)
  })

  it('the three seeded queries are three different scopes on one account', async () => {
    const p = provider()
    const a = await run([body([])], {
      p,
      config: cfg({ query: 'senior backend developer remote' }, p),
    })
    const b = await run([body([])], {
      p,
      config: cfg({ query: 'senior frontend developer remote' }, p),
    })
    expect(a.batch.scope.query).not.toBe(b.batch.scope.query)
    expect(a.batch.scope.namespace).toBe('jsearch')
  })
})

describe('the key-gated state', () => {
  it('is not blocked once the smoke succeeded; the key stays required - and the provenance agrees', () => {
    expect(JSEARCH_SOURCE_STATUS.blocked).toBe(false)
    expect(JSEARCH_SOURCE_STATUS.permission).toBe('KEY_REQUIRED')
    const prov = sourceProvenance('jsearch', 'search-v2-smoke') as {
      permission: string
      httpStatus: number
      notes: string
    }
    expect(prov.permission).toBe(JSEARCH_SOURCE_STATUS.permission)
    expect(prov.httpStatus).toBe(200)
    expect(prov.notes).toContain('controlled authenticated smoke')
  })
})

/** Survivors of the mutation gate, each turned into the assertion that kills it. */
describe('what a reviewer would otherwise have to take on trust', () => {
  it('declares its source type', () => {
    expect(provider().type).toBe('JSEARCH_API')
  })

  it('scopes the run by its search, date filter and remote flag', async () => {
    const { batch } = await run([body([])])
    expect(batch.scope).toEqual({
      namespace: 'jsearch',
      query: '{"query":"senior backend developer remote","datePosted":"week","remoteOnly":true}',
      configVersion: 1,
      window: null,
    })
  })

  it('a run leaves no cursor to resume from: the next run starts over', async () => {
    const { batch } = await run([body([job('a')])])
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 1 })
  })

  it('empty and missing location parts are skipped, in order: a blank country leaves the state', async () => {
    const blank = job('a', { job_city: null, job_state: 'Mazowieckie', job_country: '' })
    const { batch } = await run([body([blank])])
    expect(byId(batch, 'a')?.normalized.location).toBe('Mazowieckie')
    const empties = job('b', { job_city: '', job_state: 'Silesia', job_country: 'PL' })
    const two = await run([body([empties])])
    expect(byId(two.batch, 'b')?.normalized.location).toBe('Silesia, PL')
  })

  it('the description is TEXT, not HTML: markup in it is kept as written', async () => {
    const withMarkup = job('a', { job_description: 'Line one <b>not html</b>' })
    const { batch } = await run([body([withMarkup])])
    const markdown = batch.observations[0]?.normalized.descriptionMd ?? ''
    // As HTML the <b> would become bold markdown (**); as text it is just characters.
    expect(markdown).toContain('not html')
    expect(markdown).not.toContain('**')
  })

  it('refusal reasons are the intended ones', () => {
    const reason = (extra: Record<string, unknown>) => {
      try {
        provider().parseConfig({ configVersion: 1, ...SEEDED, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'JSearch takes datePosted, not a window',
    )
  })
})
