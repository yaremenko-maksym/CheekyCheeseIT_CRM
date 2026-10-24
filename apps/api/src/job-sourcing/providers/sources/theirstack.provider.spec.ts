import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { meteredContext } from '../../../test/quota-harness'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { SourceNotReadyError } from './quota-provider'
import {
  createTheirStackProvider,
  billingProvenBy,
  THEIRSTACK_SOURCE_STATUS,
  theirstackIncurredCredits,
} from './theirstack.provider'

/**
 * TheirStack through its public provider. Expected values are hand-read from
 * `__fixtures__/theirstack/doc-example.json` - a UNIT EXAMPLE written from the published API
 * reference, not a capture (see its provenance) - and from the reference's own billing sentence
 * ("1 API credit for each job returned"). Literals, never produced by running the mapper.
 *
 * THE KEY is an obviously fake string; no real credential appears here.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const KEY = 'tsk_0000fake0000fake0000fake0000fake'
const SEEDED = { limit: 25, seniority: ['senior'] }
/**
 * An observation that PROVES per-record billing, hand-written: asked for 25, got 7, and the balance
 * fell from 1000 to 993. (Invented for this unit test; the real one is the owner's smoke.)
 */
const PROVEN = {
  observedAt: '2026-10-24T09:00:00.000Z',
  requestedLimit: 25,
  jobsReturned: 7,
  creditBalanceBefore: 1000,
  creditBalanceAfter: 993,
}
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const
const NOT_CONFIGURED = { configured: false, apiKey: null, secrets: [] } as const

const provider = (
  credential: Parameters<typeof createTheirStackProvider>[0]['credential'] = READY,
  observation: unknown = PROVEN,
) => createTheirStackProvider({ credential, billingObservation: observation })
const cfg = (extra: Record<string, unknown> = {}, p = provider()) =>
  p.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { metadata: Record<string, unknown>; data: Record<string, unknown>[] }
const example = () => sourceFixture('theirstack', 'doc-example') as Envelope
const job = (id: number, over: Record<string, unknown> = {}) => ({
  ...example().data[0],
  id,
  url: `https://boards.example-ats.test/example-co/${id}`,
  ...over,
})
/** A page holding `n` jobs, ids counting up from `from`. */
const jobs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => job(from + i))
const body = (data: unknown[]): FakeResponse => ({ bodyText: JSON.stringify({ data }) })

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
    const p = provider(credential)
    const f = fakeCollectionContext({ now: NOW, responses: [body(jobs(1))] })
    const m = meteredContext(f)
    await expect(p.collectReport(cfg({}, p), m.ctx)).rejects.toThrow(SourceNotReadyError)
    expect(m.events).toEqual([])
    expect(f.sent).toEqual([])
  })

  it('names the source and the variable', async () => {
    const p = provider(NOT_CONFIGURED)
    const f = fakeCollectionContext({ now: NOW, responses: [] })
    const error = await p.collectReport(cfg({}, p), meteredContext(f).ctx).catch((e: unknown) => e)
    expect((error as Error).message).toBe('THEIRSTACK_API: THEIRSTACK_API_KEY is not configured')
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
  it('POSTs the seeded search with a Bearer key and a JSON body (page 0 first)', async () => {
    const { f } = await run([body([])])
    const request = f.sent[0]
    expect(request?.url).toBe('https://api.theirstack.com/v1/jobs/search')
    expect(request?.method).toBe('POST')
    expect(request?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    })
    expect(JSON.parse(request?.body ?? 'null')).toEqual({
      page: 0,
      limit: 25,
      posted_at_max_age_days: 7,
      workplace_types_or: ['remote'],
      job_seniority_or: ['senior'],
    })
  })

  it('always sends a posted-date filter, which the API requires', async () => {
    const p = provider()
    const { f } = await run([body([])], {
      p,
      config: p.parseConfig({ configVersion: 1, maxAgeDays: 3 }),
    })
    expect(JSON.parse(f.sent[0]?.body ?? 'null').posted_at_max_age_days).toBe(3)
  })

  it('omits the seniority filter when none is configured, and passes the workplace types', async () => {
    const p = provider()
    const { f } = await run([body([])], {
      p,
      config: p.parseConfig({ configVersion: 1, workplaceTypes: ['remote', 'hybrid'] }),
    })
    const sent = JSON.parse(f.sent[0]?.body ?? 'null')
    expect(sent.job_seniority_or).toBeUndefined()
    expect(sent.workplace_types_or).toEqual(['remote', 'hybrid'])
    expect(sent.limit).toBe(25)
  })

  it('never asks for the total (it slows responses): include_total_results is absent', async () => {
    const { f } = await run([body([])])
    expect(Object.keys(JSON.parse(f.sent[0]?.body ?? 'null')).sort()).toEqual([
      'job_seniority_or',
      'limit',
      'page',
      'posted_at_max_age_days',
      'workplace_types_or',
    ])
  })

  it('keeps the key out of the URL', async () => {
    const { f } = await run([body([])])
    expect(f.sent[0]?.url).not.toContain(KEY)
    expect(f.sent[0]?.body).not.toContain(KEY)
  })
})

describe('mapping the unit example', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const o = byId(batch, '7001001')
    expect(o?.identity).toMatchObject({
      provider: 'THEIRSTACK_API',
      namespace: 'theirstack',
      nativeId: '7001001',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://boards.example-ats.test/example-co/7001001')
    expect(o?.normalized.title).toBe('Senior Platform Engineer')
    expect(o?.normalized.companyName).toBe('Example Co')
    expect(o?.normalized.location).toBe('Berlin, Germany')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.seniorityHint).toBe('senior')
    expect(o?.adapterVersion).toBe('theirstack-1')
  })

  it('the native id and the application URL are different facts', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const first = byId(batch, '7001001')
    expect(first?.applicationUrl).toBe('https://example-co.test/careers/platform-engineer')
    expect(first?.identity.nativeId).not.toBe(first?.applicationUrl)
    // The second job has no final_url: no application URL is invented from the posting URL.
    expect(byId(batch, '7001002')?.applicationUrl).toBeNull()
  })

  it('date_posted (a plain date) is the PUBLICATION date at UTC midnight', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    expect(byId(batch, '7001001')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    )
    expect(byId(batch, '7001002')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    )
  })

  it('unknown remote / location stay unknown, not false or empty', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const second = byId(batch, '7001002')
    expect(second?.normalized.remote).toBeNull()
    expect(second?.normalized.location).toBeNull()
    expect(second?.normalized.descriptionMd).toBe('')
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([body([job(1), { id: 'x' }, job(2)])])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an envelope without `data` is drift', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify({ metadata: {} }) }])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

/**
 * RECORDS, NOT CALLS. The documented rule is one credit per job RETURNED, so a call is reserved at
 * its worst case (`limit`) and settled at what came back. Every figure is hand-counted from the
 * pages built above.
 */
describe('billing is per returned record', () => {
  it('reserves the worst case (limit credits) in RECORD units before anything is sent', async () => {
    const { m } = await run([body(jobs(2))])
    expect(m.reserved).toEqual([{ unit: 'RECORD', amount: 25 }])
    expect(m.events.slice(0, 3)).toEqual(['reserve', 'markSent', 'fetch'])
  })

  it('the reservation follows the configured limit (limit 7 -> 7 credits)', async () => {
    const p = provider()
    const { m } = await run([body([])], { p, config: cfg({ limit: 7 }, p) })
    expect(m.reserved).toEqual([{ unit: 'RECORD', amount: 7 }])
  })

  it('settles at the number of jobs returned: 2 of 25', async () => {
    const { m, batch } = await run([body(jobs(2))])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED', incurred: 2 }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 2 })
  })

  it('a full page costs the limit exactly (25 of 25)', async () => {
    const { m } = await run([body(jobs(25))])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED', incurred: 25 }])
  })

  it('a page past the limit (26 of 25) exceeds the page bound, and is charged the whole reservation', async () => {
    const { m, batch } = await run([body(jobs(26))])
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('an empty page settles at 1, the smallest cost the store can record (it cannot record 0)', async () => {
    const { m, batch } = await run([body([])])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED', incurred: 1 }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 1 })
  })

  it('two pages are two calls and 28 credits: 25 returned, then 3', async () => {
    const { m, f } = await run([body(jobs(25)), body(jobs(3, 100))], {
      config: cfg({ maxPages: 2 }),
    })
    expect(f.sent.map((r) => JSON.parse(r.body ?? 'null').page)).toEqual([0, 1])
    expect(m.reserved).toEqual([
      { unit: 'RECORD', amount: 25 },
      { unit: 'RECORD', amount: 25 },
    ])
    expect(m.settled).toEqual([
      { id: 'res-1', resolution: 'USED', incurred: 25 },
      { id: 'res-2', resolution: 'USED', incurred: 3 },
    ])
  })

  it('a short page ends the walk: 24 of 25 is the last page', async () => {
    const { f } = await run([body(jobs(24)), body(jobs(1, 100))], { config: cfg({ maxPages: 3 }) })
    expect(f.sent).toHaveLength(1)
  })

  it('a full page continues; maxPages stops it (1 of 3 read, capped)', async () => {
    const { f, batch } = await run([body(jobs(25))])
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })

  it('a timeout after the request left holds the whole reservation UNCERTAIN, with no amount', async () => {
    const { m, batch } = await run([{ throws: new Error('timeout') }])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'UNCERTAIN' }])
    expect(batch.outcome).toBe('FAILED')
  })

  it('a refused response is charged the whole reservation: it cannot be known to be free', async () => {
    const { m } = await run([{ status: 403 }])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('a refused reservation is a cost stop: nothing is sent', async () => {
    const { batch, f, m } = await run([body(jobs(1))], { refuse: 1 })
    expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
    expect(f.sent).toEqual([])
    expect(m.events).toEqual(['reserve'])
  })

  it('a repeated paid request (a second run) reserves again from the start', async () => {
    const first = await run([body(jobs(1))])
    const second = await run([body(jobs(1))])
    expect(first.m.reserved).toEqual([{ unit: 'RECORD', amount: 25 }])
    expect(second.m.reserved).toEqual([{ unit: 'RECORD', amount: 25 }])
  })
})

describe('theirstackIncurredCredits', () => {
  it.each([
    [JSON.stringify({ data: [] }), 0],
    [JSON.stringify({ data: [{}, {}, {}] }), 3],
    [JSON.stringify({ metadata: {}, data: [{ a: 1 }] }), 1],
    [JSON.stringify({ data: 'x' }), null],
    [JSON.stringify({ data: null }), null],
    [JSON.stringify({}), null],
    [JSON.stringify(null), null],
    [JSON.stringify([]), null],
    ['not json', null],
    ['', null],
  ])('%s -> %s', (text, want) => {
    expect(theirstackIncurredCredits(text)).toBe(want)
  })
})

describe('the key never reaches a report', () => {
  it('a network error that echoes the Authorization header is redacted, with no key registered by the worker', async () => {
    const { batch } = await run([
      { throws: new Error(`request failed: authorization: Bearer ${KEY} was refused`) },
    ])
    const message = batch.requests[0]?.error?.message ?? ''
    expect(message).toBe('request failed: authorization: Bearer [REDACTED] was refused')
    expect(JSON.stringify(batch)).not.toContain(KEY)
  })

  it('an error that quotes the bare key is redacted', async () => {
    const { batch } = await run([{ throws: new Error(`bad token ${KEY}`) }])
    expect(batch.requests[0]?.error?.message).toBe('bad token [REDACTED]')
  })

  it('the reported URL is the endpoint, with nothing to hide', async () => {
    const { batch } = await run([body([])])
    expect(batch.requests[0]?.url).toBe('https://api.theirstack.com/v1/jobs/search')
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['limit 0', { limit: 0 }],
    ['limit 51 (past the plan bound)', { limit: 51 }],
    ['a fractional limit', { limit: 2.5 }],
    ['an unknown seniority', { seniority: ['principal'] }],
    ['an empty seniority list', { seniority: [] }],
    ['an unknown workplace type', { workplaceTypes: ['hybrid-remote'] }],
    ['an empty workplace list', { workplaceTypes: [] }],
    ['maxAgeDays 0', { maxAgeDays: 0 }],
    ['maxAgeDays 31', { maxAgeDays: 31 }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 6', { maxPages: 6 }],
    ['an unknown key', { include_total_results: true }],
    ['a namespace other than theirstack', { namespace: 'x' }],
    ['a base query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => provider().parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts the seeded config verbatim, and both limit bounds', () => {
    const seeded = provider().parseConfig({ configVersion: 1, limit: 25, seniority: ['senior'] })
    expect(seeded).toMatchObject({
      namespace: 'theirstack',
      limit: 25,
      workplaceTypes: ['remote'],
      maxAgeDays: 7,
      maxPages: 1,
    })
    expect(provider().parseConfig({ configVersion: 1, limit: 1 }).limit).toBe(1)
    expect(provider().parseConfig({ configVersion: 1, limit: 50 }).limit).toBe(50)
    expect(provider().parseConfig({ configVersion: 1 }).limit).toBe(25)
    expect(provider().parseConfig({ configVersion: 1, maxAgeDays: 30 }).maxAgeDays).toBe(30)
  })
})

describe('the BLOCKED state', () => {
  it('declares itself blocked with the key reason - and the provenance agrees', () => {
    expect(THEIRSTACK_SOURCE_STATUS.blocked).toBe(true)
    expect(THEIRSTACK_SOURCE_STATUS.permission).toBe('KEY_REQUIRED')
    expect(THEIRSTACK_SOURCE_STATUS.reason).toContain('controlled authenticated smoke')
    const prov = sourceProvenance('theirstack', 'doc-example') as {
      permission: string
      notes: string
    }
    expect(prov.permission).toBe(THEIRSTACK_SOURCE_STATUS.permission)
    expect(prov.notes).toContain('UNIT EXAMPLE ONLY, NOT A CAPTURE')
    expect(prov.notes).toContain('1 API credit for each job returned')
  })
})

/** Survivors of the mutation gate, each turned into the assertion that kills it. */
describe('what a reviewer would otherwise have to take on trust', () => {
  it('declares its source type', () => {
    expect(provider().type).toBe('THEIRSTACK_API')
  })

  it('scopes the run: its filters and the posted-date window it asked for (7 days to now)', async () => {
    const { batch } = await run([body([])])
    expect(batch.scope).toEqual({
      namespace: 'theirstack',
      query: '{"seniority":["senior"],"workplaceTypes":["remote"]}',
      configVersion: 1,
      window: {
        from: new Date('2026-10-17T04:00:00.000Z'),
        to: new Date('2026-10-24T04:00:00.000Z'),
      },
    })
  })

  it('a longer age is a longer window (30 days back)', async () => {
    const p = provider()
    const { batch } = await run([body([])], { p, config: cfg({ maxAgeDays: 30 }, p) })
    expect(batch.scope.window?.from).toEqual(new Date('2026-09-24T04:00:00.000Z'))
  })

  it('the next page cursor names the next page (a full page capped at 1: resume at page 2)', async () => {
    const { batch } = await run([body(jobs(25))])
    expect(batch.checkpoint?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'page:2' })
  })

  it('the description is TEXT, not HTML: markup in it is kept as written', async () => {
    const withMarkup = job(1, { description: 'Line one <b>not html</b>' })
    const { batch } = await run([body([withMarkup])])
    const markdown = batch.observations[0]?.normalized.descriptionMd ?? ''
    // As HTML the <b> would become bold markdown (**); as text it is just characters.
    expect(markdown).toContain('not html')
    expect(markdown).not.toContain('**')
  })

  it('refusal reasons are the intended ones', () => {
    const reason = (extra: Record<string, unknown>) => {
      try {
        provider().parseConfig({ configVersion: 1, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ query: 'x' })).toContain(
      'TheirStack filters live in seniority / workplaceTypes',
    )
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'TheirStack takes maxAgeDays, not a window',
    )
  })

  it('an error that quotes the bare key (no scheme word near it) is redacted by the adapter alone', async () => {
    const { batch } = await run([{ throws: new Error(`credential ${KEY} rejected`) }])
    expect(batch.requests[0]?.error?.message).toBe('credential [REDACTED] rejected')
  })

  it('a body too deep to read is no cost reading: the whole reservation is charged', () => {
    // Depth 101 INSIDE `data`: unbounded, this parses and counts 1 job; bounded, it is refused.
    const deep = `{"data":[${'['.repeat(100)}${']'.repeat(100)}]}`
    expect(theirstackIncurredCredits(deep)).toBeNull()
    expect(theirstackIncurredCredits('{"data":[[]]}')).toBe(1)
  })
})

/**
 * SR-M-1. Settling BELOW the reservation frees the difference for re-reservation, which overspends
 * the external account if the reading is wrong (measured by the review: limit 100, reserve 10,
 * settle 1 permitted 91 pages). So the reading is attached only once the billing basis is observed.
 * The wide-limit counter arithmetic is in the integration spec; here, what the adapter asks for.
 */
describe('billing is not trusted until it has been observed (SR-M-1)', () => {
  const unverified = () => createTheirStackProvider({ credential: READY })

  async function runWith(p: ReturnType<typeof unverified>) {
    const f = fakeCollectionContext({ now: NOW, responses: [body(jobs(2))] })
    const m = meteredContext(f)
    const batch = await p.collectReport(p.parseConfig({ configVersion: 1, ...SEEDED }), m.ctx)
    return { m, batch }
  }

  it('by default every page is charged its WORST CASE: 2 jobs back, 25 charged', async () => {
    const { m, batch } = await runWith(unverified())
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'RECORD', amount: 25 })
  })

  it('only PROVEN evidence attaches the reading: 2 jobs back, 2 charged', async () => {
    const { m } = await runWith(
      createTheirStackProvider({ credential: READY, billingObservation: PROVEN }),
    )
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED', incurred: 2 }])
  })

  it('there is no flag: a `billingVerified` option, whatever its value, changes nothing', async () => {
    for (const flag of [true, 'true', 1, {}]) {
      const { m } = await runWith(
        createTheirStackProvider({ credential: READY, billingVerified: flag } as never),
      )
      expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
    }
  })

  it('evidence that does not prove per-record billing leaves the worst case in force', async () => {
    const disproving = { ...PROVEN, creditBalanceAfter: 975 } // balance fell by the whole limit
    const { m } = await runWith(
      createTheirStackProvider({ credential: READY, billingObservation: disproving }),
    )
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('a malformed observation fails when the provider is built, not mid-run', () => {
    expect(() =>
      createTheirStackProvider({ credential: READY, billingObservation: { jobsReturned: 7 } }),
    ).toThrow()
    expect(() =>
      createTheirStackProvider({ credential: READY, billingObservation: 'verified' }),
    ).toThrow()
  })

  it('no observation is committed today: the source is unverified until one is', () => {
    expect(readdirSync(join(__dirname, '__fixtures__', 'theirstack')).sort()).toEqual([
      'doc-example.json',
      'doc-example.provenance.json',
    ])
  })

  it('the cost reader admits a body past the 2 MiB default (the transport already admitted it)', () => {
    const big = JSON.stringify({ data: [{ pad: 'x'.repeat(2_200_000) }, {}] })
    expect(big.length).toBeGreaterThan(2_097_152)
    expect(theirstackIncurredCredits(big)).toBe(2)
  })
})

/** R2-SR-M-2: what an observation must show before the per-record reading is believed. */
describe('billingProvenBy', () => {
  const obs = (over: Record<string, unknown>) => ({ ...PROVEN, ...over })

  it('proves per-record billing: 7 of 25 returned, balance fell by exactly 7', () => {
    expect(billingProvenBy(PROVEN)).toBe(true)
  })

  it('AT the edges: 1 returned of 2 asked proves; the whole limit (2 of 2) cannot tell per-record from per-limit', () => {
    expect(
      billingProvenBy(obs({ requestedLimit: 2, jobsReturned: 1, creditBalanceAfter: 999 })),
    ).toBe(true)
    expect(
      billingProvenBy(obs({ requestedLimit: 2, jobsReturned: 2, creditBalanceAfter: 998 })),
    ).toBe(false)
    // one past: more returned than asked is not a billing observation either
    expect(
      billingProvenBy(obs({ requestedLimit: 2, jobsReturned: 3, creditBalanceAfter: 997 })),
    ).toBe(false)
  })

  it('nothing returned proves nothing, even with an unchanged balance', () => {
    expect(billingProvenBy(obs({ jobsReturned: 0, creditBalanceAfter: 1000 }))).toBe(false)
  })

  it.each([
    ['one credit too many', 992],
    ['one credit too few', 994],
    ['the balance went UP', 1001],
    ['the whole limit was charged', 975],
    ['a flat per-request charge of 1', 999],
  ])('does not prove it when %s', (_label, after) => {
    expect(billingProvenBy(obs({ creditBalanceAfter: after }))).toBe(false)
  })

  it.each([
    ['a missing field', { ...PROVEN, observedAt: undefined }],
    ['an unknown field', { ...PROVEN, note: 'x' }],
    ['a date without milliseconds', { ...PROVEN, observedAt: '2026-10-24T09:00:00Z' }],
    ['a date with text before it', { ...PROVEN, observedAt: 'on 2026-10-24T09:00:00.000Z' }],
    ['a date with text after it', { ...PROVEN, observedAt: '2026-10-24T09:00:00.000Z!' }],
    ['a limit of 0', { ...PROVEN, requestedLimit: 0 }],
    ['a limit of 51', { ...PROVEN, requestedLimit: 51 }],
    ['a fractional balance', { ...PROVEN, creditBalanceBefore: 1000.5 }],
    ['a negative balance', { ...PROVEN, creditBalanceAfter: -1 }],
    ['a string', 'proven'],
    ['null', null],
  ])('refuses %s', (_label, raw) => {
    expect(() => billingProvenBy(raw)).toThrow()
  })
})
