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
 * `__fixtures__/jsearch/doc-example.json` - a UNIT EXAMPLE written from public listings, not a
 * capture (see its provenance) - and written as literals, never produced by running the mapper.
 *
 * THE KEY is an obviously fake string; no real credential appears here.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const KEY = 'fake0000rapid0000key0000fake0000rapid0000key0000xyz'
const SEEDED = { query: 'senior backend developer remote' }
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const
const NOT_CONFIGURED = { configured: false, apiKey: null, secrets: [] } as const
const SEARCH =
  'https://jsearch.p.rapidapi.com/search?query=senior+backend+developer+remote&page=1&num_pages=1&date_posted=week&work_from_home=true'

const provider = (opts: Partial<Parameters<typeof createJSearchProvider>[0]> = {}) =>
  createJSearchProvider({ credential: READY, ...opts })
const cfg = (extra: Record<string, unknown> = {}, p = provider()) =>
  p.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { data: Record<string, unknown>[] } & Record<string, unknown>
const example = () => sourceFixture('jsearch', 'doc-example') as Envelope
const job = (id: string, over: Record<string, unknown> = {}) => ({
  ...example().data[0],
  job_id: id,
  job_apply_link: `https://careers.example-systems.test/jobs/${id}/apply`,
  ...over,
})
const body = (data: unknown[]): FakeResponse => ({
  bodyText: JSON.stringify({ status: 'OK', data }),
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

  it('ALWAYS sends num_pages=1, so one call is one page whatever the billing rule is', async () => {
    const p = provider()
    const { f } = await run([body([job('a')]), body([])], { p, config: cfg({ maxPages: 3 }, p) })
    expect(f.sent.map((r) => new URL(r.url).searchParams.get('num_pages'))).toEqual(['1', '1'])
    expect(f.sent.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2'])
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

describe('mapping the unit example', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const o = byId(batch, 'ExampleJobIdA1==')
    expect(o?.identity).toMatchObject({
      provider: 'JSEARCH_API',
      namespace: 'jsearch',
      nativeId: 'ExampleJobIdA1==',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://careers.example-systems.test/jobs/1001/apply')
    expect(o?.normalized.title).toBe('Senior Backend Engineer')
    expect(o?.normalized.companyName).toBe('Example Systems Inc')
    expect(o?.normalized.location).toBe('Warsaw, Mazowieckie, PL')
    expect(o?.normalized.employmentType).toBe('FULLTIME')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-21T09:30:00.000Z')
    expect(o?.adapterVersion).toBe('jsearch-1')
  })

  it('the native id and the apply URL are different facts', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const o = byId(batch, 'ExampleJobIdA1==')
    expect(o?.applicationUrl).toBe('https://careers.example-systems.test/jobs/1001/apply')
    expect(o?.identity.nativeId).not.toBe(o?.applicationUrl)
  })

  it('missing location parts are skipped, an explicit false is kept as false', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const second = byId(batch, 'ExampleJobIdB2==')
    expect(second?.normalized.location).toBe('DE')
    expect(second?.normalized.remote).toBe(false)
    expect(second?.normalized.employmentType).toBe('CONTRACTOR')
  })

  it('a posting with no location at all maps no location', async () => {
    const bare = job('c', { job_city: null, job_state: null, job_country: null })
    const { batch } = await run([body([bare])])
    expect(byId(batch, 'c')?.normalized.location).toBeNull()
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

  it('an envelope without `data` is drift', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify({ status: 'OK' }) }])
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

  it('two pages are two paid requests with a reservation each', async () => {
    const p = provider()
    const { m } = await run([body([job('a')]), body([job('b')]), body([])], {
      p,
      config: cfg({ maxPages: 2 }, p),
    })
    expect(m.reserved).toHaveLength(2)
    expect(m.settled.map((s) => s.id)).toEqual(['res-1', 'res-2'])
  })

  it('an empty page ends the walk and still cost the call that found it', async () => {
    const p = provider()
    const { m, f } = await run([body([job('a')]), body([])], { p, config: cfg({ maxPages: 5 }, p) })
    expect(f.sent).toHaveLength(2)
    expect(m.reserved).toHaveLength(2)
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

  it('maxPages bounds the walk even when pages keep coming (1 of many)', async () => {
    const { f, batch } = await run([body([job('a')])])
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })
})

describe('the key never reaches a report', () => {
  it('a network error that echoes the header is redacted, with no key registered by the worker', async () => {
    const { batch } = await run([{ throws: new Error(`refused x-rapidapi-key: ${KEY} for host`) }])
    expect(batch.requests[0]?.error?.message).toBe('refused x-rapidapi-key: [REDACTED] for host')
    expect(JSON.stringify(batch)).not.toContain(KEY)
  })

  it('the reported URL shows only the allowlisted parameters (query, page); the rest are marked', async () => {
    const { batch } = await run([body([])])
    expect(batch.requests[0]?.url).toBe(
      'https://jsearch.p.rapidapi.com/search?query=senior+backend+developer+remote&page=1&num_pages=[REDACTED]&date_posted=[REDACTED]&work_from_home=[REDACTED]',
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
    ['maxPages 6', { maxPages: 6 }],
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
    expect(provider().parseConfig({ configVersion: 1, query: 'q', maxPages: 5 }).maxPages).toBe(5)
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

describe('the BLOCKED state', () => {
  it('declares itself blocked with the key reason - and the provenance agrees', () => {
    expect(JSEARCH_SOURCE_STATUS.blocked).toBe(true)
    expect(JSEARCH_SOURCE_STATUS.permission).toBe('KEY_REQUIRED')
    expect(JSEARCH_SOURCE_STATUS.reason).toContain('controlled authenticated smoke')
    const prov = sourceProvenance('jsearch', 'doc-example') as { permission: string; notes: string }
    expect(prov.permission).toBe(JSEARCH_SOURCE_STATUS.permission)
    expect(prov.notes).toContain('UNIT EXAMPLE ONLY, NOT A CAPTURE')
    expect(prov.notes).toContain('num_pages')
  })
})
