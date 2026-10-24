import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { meteredContext } from '../../../test/quota-harness'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { createJoobleProvider, JOOBLE_SOURCE_STATUS, joobleNativeId } from './jooble.provider'
import { SourceNotReadyError } from './quota-provider'

/**
 * Jooble through its public provider. Expected values are hand-read from
 * `__fixtures__/jooble/doc-example.json` - a UNIT EXAMPLE written from public descriptions, not a
 * capture (see its provenance) - and written as literals, never produced by running the mapper.
 *
 * THE KEY under test is an obviously fake UUID-shaped string; no real credential appears here.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const KEY = 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708'
const SEEDED = { keywords: 'senior developer', location: 'remote' }
const URL_WITH_KEY = `https://jooble.org/api/${KEY}`
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const
const NOT_CONFIGURED = { configured: false, apiKey: null, secrets: [] } as const

const provider = (over: Parameters<typeof createJoobleProvider>[0] = { credential: READY }) =>
  createJoobleProvider(over)
const cfg = (extra: Record<string, unknown> = {}, p = provider()) =>
  p.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { totalCount: number; jobs: Record<string, unknown>[] }
const example = () => sourceFixture('jooble', 'doc-example') as Envelope
const body = (v: unknown): FakeResponse => ({ bodyText: JSON.stringify(v) })

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
const byUrl = (b: Batch, fragment: string) =>
  b.observations.find((o) => o.sourcePostingUrl?.includes(fragment))

describe('a missing key is a readiness error before the budget and before the network', () => {
  it.each([
    ['not configured', NOT_CONFIGURED],
    ['configured with no key', { configured: true, apiKey: null, secrets: [] }],
    ['configured with an empty key', { configured: true, apiKey: '', secrets: [] }],
  ])('%s: refuses, reserves nothing, sends nothing', async (_label, credential) => {
    const p = provider({ credential })
    const f = fakeCollectionContext({ now: NOW, responses: [body(example())] })
    const m = meteredContext(f)
    await expect(p.collectReport(cfg({}, p), m.ctx)).rejects.toThrow(SourceNotReadyError)
    expect(m.events).toEqual([])
    expect(m.reserved).toEqual([])
    expect(f.sent).toEqual([])
  })

  it('names the source and the variable, and never a value', async () => {
    const p = provider({ credential: NOT_CONFIGURED })
    const f = fakeCollectionContext({ now: NOW, responses: [] })
    const error = await p.collectReport(cfg({}, p), meteredContext(f).ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceNotReadyError)
    expect((error as Error).message).toBe('JOOBLE_API: JOOBLE_API_KEY is not configured')
    expect((error as SourceNotReadyError).envKey).toBe('JOOBLE_API_KEY')
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
  it('POSTs the search to the key-bearing path with a JSON body', async () => {
    const { f } = await run([body({ totalCount: 0, jobs: [] })])
    expect(f.sent).toHaveLength(1)
    const request = f.sent[0]
    expect(request?.url).toBe(URL_WITH_KEY)
    expect(request?.method).toBe('POST')
    expect(request?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(JSON.parse(request?.body ?? 'null')).toEqual({
      keywords: 'senior developer',
      location: 'remote',
      page: 1,
    })
  })

  it('omits the location when none is configured', async () => {
    const p = provider()
    const { f } = await run([body({ totalCount: 0, jobs: [] })], {
      p,
      config: p.parseConfig({ configVersion: 1, keywords: 'rust' }),
    })
    expect(JSON.parse(f.sent[0]?.body ?? 'null')).toEqual({ keywords: 'rust', page: 1 })
  })

  it('percent-encodes a key that holds a reserved character, so it cannot change the path', async () => {
    const odd = 'ab/cd?ef#gh'
    const p = provider({ credential: { configured: true, apiKey: odd, secrets: [odd] } })
    const { f } = await run([body({ totalCount: 0, jobs: [] })], { p })
    expect(f.sent[0]?.url).toBe('https://jooble.org/api/ab%2Fcd%3Fef%23gh')
  })

  it('never puts the key in the body or the headers', async () => {
    const { f } = await run([body({ totalCount: 0, jobs: [] })])
    expect(f.sent[0]?.body).not.toContain(KEY)
    expect(JSON.stringify(f.sent[0]?.headers)).not.toContain(KEY)
  })
})

describe('mapping the unit example', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([body({ ...example(), totalCount: 3 })])
    const o = byUrl(batch, '/desc/4821937')
    expect(o?.identity).toMatchObject({
      provider: 'JOOBLE_API',
      namespace: 'jooble',
      nativeId: '4821937',
      identityKind: 'NATIVE_ID',
    })
    // The tracking parameters (ckey, rgn, pos) are not identity parameters, so the observation's
    // canonical URL drops them: only the path names the posting.
    expect(o?.sourcePostingUrl).toBe('https://jooble.org/desc/4821937')
    expect(o?.normalized.title).toBe('Senior Backend Developer')
    expect(o?.normalized.companyName).toBe('Example Platform Ltd')
    expect(o?.normalized.location).toBe('Remote')
    expect(o?.normalized.employmentType).toBe('Full-time')
    expect(o?.adapterVersion).toBe('jooble-1')
  })

  it('native id and application URL are different facts: the id is not in the URL slot', async () => {
    const { batch } = await run([body({ ...example(), totalCount: 3 })])
    const o = byUrl(batch, '/desc/4821937')
    expect(o?.identity.nativeId).toBe('4821937')
    // The application URL is kept as received: it is what an applicant is sent to.
    expect(o?.applicationUrl).toBe(
      'https://jooble.org/desc/4821937?ckey=senior+developer&rgn=-1&pos=1',
    )
    expect(o?.identity.nativeId).not.toBe(o?.applicationUrl)
  })

  it('`updated` has no zone in the examples seen: kept raw, no instant guessed', async () => {
    const { batch } = await run([body({ ...example(), totalCount: 3 })])
    const o = byUrl(batch, '/desc/4821937')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'UPDATED',
        contract: 'ISO_ZONED',
        raw: '2026-10-20T08:00:00.0000000',
        status: 'MISSING_ZONE',
        value: null,
      },
    ])
  })

  it('an id past 2^53 is not an identity: that posting falls back to its link', async () => {
    const { batch } = await run([body({ ...example(), totalCount: 3 })])
    const o = byUrl(batch, '/desc/-6876573728492742391')
    expect(o?.identity.identityKind).toBe('URL_FALLBACK')
    expect(o?.identity.nativeId).toBeNull()
    expect(o?.normalized.title).toBe('Staff Engineer, Data')
  })

  it('a posting with no id and no employer is quarantined, not named', async () => {
    const { batch } = await run([body({ ...example(), totalCount: 3 })])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(byUrl(batch, 'anonymous-3')).toBeUndefined()
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([
      body({ totalCount: 3, jobs: [example().jobs[0], { title: 'no link' }, example().jobs[1]] }),
    ])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an empty result is a valid, empty success that still cost one request', async () => {
    const { batch, m } = await run([body({ totalCount: 0, jobs: [] })])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
    expect(m.reserved).toEqual([{ unit: 'REQUEST', amount: 1 }])
  })
})

describe('joobleNativeId', () => {
  it.each([
    [4821937, '4821937'],
    [-12, '-12'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [Number.MAX_SAFE_INTEGER + 1, null],
    [-6876573728492742391, null],
    [1.5, null],
    ['abc-1', 'abc-1'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ])('%s -> %s', (id, want) => {
    expect(joobleNativeId(id)).toBe(want)
  })
})

describe('the meter is a parameter', () => {
  it('defaults to one REQUEST per call: reserve, mark sent, fetch, settle, in that order', async () => {
    const { m } = await run([body({ totalCount: 0, jobs: [] })])
    expect(m.reserved).toEqual([{ unit: 'REQUEST', amount: 1 }])
    expect(m.events).toEqual(['reserve', 'markSent', 'fetch', 'reconcile:USED'])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'USED' }])
  })

  it('reserves what the configured agreement says, in its unit', async () => {
    const p = provider({
      credential: READY,
      meter: { unit: 'USD_MICROS', amountPerRequest: 2_500 },
    })
    const { m } = await run([body({ totalCount: 0, jobs: [] })], { p })
    expect(m.reserved).toEqual([{ unit: 'USD_MICROS', amount: 2_500 }])
  })

  it.each([
    ['a zero amount', { unit: 'REQUEST', amountPerRequest: 0 }],
    ['a fractional amount', { unit: 'REQUEST', amountPerRequest: 1.5 }],
    ['an unknown unit', { unit: 'CREDITS', amountPerRequest: 1 }],
  ])('refuses %s when the provider is built, not mid-run', (_label, meter) => {
    expect(() => provider({ credential: READY, meter: meter as never })).toThrow()
  })

  it('a refused reservation is a cost stop: nothing is sent', async () => {
    const { batch, f, m } = await run([body(example())], { refuse: 1 })
    expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
    expect(f.sent).toEqual([])
    expect(m.events).toEqual(['reserve'])
  })

  it('each paid request takes its own reservation: two pages, two reservations, two settlements', async () => {
    const page = (n: number) =>
      body({
        totalCount: 40,
        jobs: [{ ...example().jobs[0], id: 100 + n, link: `https://jooble.org/desc/${n}` }],
      })
    const p = provider()
    const { m, f } = await run([page(1), page(2), page(3)], {
      p,
      config: cfg({ maxPages: 2 }, p),
    })
    expect(f.sent).toHaveLength(2)
    expect(m.reserved).toEqual([
      { unit: 'REQUEST', amount: 1 },
      { unit: 'REQUEST', amount: 1 },
    ])
    expect(m.settled.map((s) => s.id)).toEqual(['res-1', 'res-2'])
    expect(m.events).toEqual([
      'reserve',
      'markSent',
      'fetch',
      'reconcile:USED',
      'reserve',
      'markSent',
      'fetch',
      'reconcile:USED',
    ])
  })

  it('a timeout after the request left holds the reservation UNCERTAIN, not USED or RELEASED', async () => {
    const { m, batch } = await run([{ throws: new Error('timeout') }])
    expect(m.settled).toEqual([{ id: 'res-1', resolution: 'UNCERTAIN' }])
    expect(batch.outcome).toBe('FAILED')
  })

  it('a partial run keeps page one when page two is refused', async () => {
    const p = provider()
    const { batch, m } = await run([body({ totalCount: 40, jobs: [example().jobs[0]] })], {
      p,
      config: cfg({ maxPages: 3 }, p),
      refuse: 2,
    })
    expect(batch.observations).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
    expect(m.reserved).toHaveLength(2)
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('paging', () => {
  it('stops when the page reaches the total (1 page of 3 of 3)', async () => {
    const { f } = await run([body({ ...example(), totalCount: 3 })])
    expect(f.sent).toHaveLength(1)
  })

  it('stops on an empty page', async () => {
    const p = provider()
    const { f } = await run(
      [body({ totalCount: 99, jobs: [example().jobs[0]] }), body({ totalCount: 99, jobs: [] })],
      { p, config: cfg({ maxPages: 5 }, p) },
    )
    expect(f.sent).toHaveLength(2)
    expect(JSON.parse(f.sent[1]?.body ?? 'null').page).toBe(2)
  })

  it('without a total, an empty page is the only end marker', async () => {
    const p = provider()
    const { f } = await run([body({ jobs: [example().jobs[0]] }), body({ jobs: [] })], {
      p,
      config: cfg({ maxPages: 5 }, p),
    })
    expect(f.sent).toHaveLength(2)
  })

  it('maxPages bounds the walk even when more results exist (1 of many)', async () => {
    const { f, batch } = await run([body({ totalCount: 999, jobs: [example().jobs[0]] })])
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })
})

/**
 * THE KEY IS IN THE URL, so every channel a URL can travel is checked. Each case registers NOTHING
 * on the worker's ctx (`meteredContext` defaults `secrets` to none): the adapter has to add the key
 * itself, because redaction cannot rest on a worker remembering to.
 */
describe('the key never reaches a report', () => {
  const KEY_FRAGMENT = 6
  /** Every 6-character window of the key that appears in `text`; empty means no trace of it. */
  const leakedFragments = (key: string, text: string) => {
    const leaked: string[] = []
    for (let i = 0; i + KEY_FRAGMENT <= key.length; i += 1) {
      const fragment = key.slice(i, i + KEY_FRAGMENT)
      if (text.includes(fragment)) leaked.push(fragment)
    }
    return leaked
  }

  it('the reported URL carries the marker where the key was', async () => {
    const { batch } = await run([body(example())])
    expect(batch.requests[0]?.url).toBe('https://jooble.org/api/[REDACTED]')
  })

  it('a failed page reports the marked URL too', async () => {
    const { batch } = await run([{ status: 500 }])
    expect(batch.requests[0]?.url).toBe('https://jooble.org/api/[REDACTED]')
    expect(batch.requests[0]?.error?.message).toBe('provider answered HTTP 500')
  })

  it('a network error that echoes the URL is redacted', async () => {
    const { batch } = await run([{ throws: new Error(`connect ECONNREFUSED ${URL_WITH_KEY}`) }])
    expect(batch.requests[0]?.error?.message).toBe(
      'connect ECONNREFUSED https://jooble.org/api/[REDACTED]',
    )
  })

  it('an error that quotes the bare key is redacted', async () => {
    const { batch } = await run([{ throws: new Error(`invalid key ${KEY} for account`) }])
    expect(batch.requests[0]?.error?.message).toBe('invalid key [REDACTED] for account')
  })

  /**
   * THE STRADDLE. The report cuts its error message at 500 characters. `pad` is chosen so that,
   * in the RAW message, the 500th character falls inside the key (pad 460: after its 16th
   * character), and in the redacted one inside the marker (pad 472). Truncating before redacting
   * would emit a prefix of the key that matches nothing registered. The expected message is
   * written out by hand: the redacted string, then cut.
   */
  it.each([460, 472, 476, 484])(
    'a key straddling the 500-character cut is redacted whole first (pad %s)',
    async (pad) => {
      const raw = `${'x'.repeat(pad)} ${URL_WITH_KEY} ECONNREFUSED`
      const { batch } = await run([{ throws: new Error(raw) }])
      const message = batch.requests[0]?.error?.message ?? ''
      const expected = `${'x'.repeat(pad)} https://jooble.org/api/[REDACTED] ECONNREFUSED`.slice(
        0,
        500,
      )
      expect(message).toBe(expected)
      expect(leakedFragments(KEY, message)).toEqual([])
    },
  )

  it('the straddle really straddles: the raw key begins before the cut and ends after it', () => {
    const raw = `${'x'.repeat(460)} ${URL_WITH_KEY} ECONNREFUSED`
    const start = raw.indexOf(KEY)
    expect(start).toBeLessThan(500)
    expect(start + KEY.length).toBeGreaterThan(500)
  })

  it('a key with reserved characters is redacted in its percent-encoded form too', async () => {
    const odd = 'ab/cd?ef#gh'
    const p = provider({ credential: { configured: true, apiKey: odd, secrets: [odd] } })
    const { batch } = await run(
      [{ throws: new Error('fail https://jooble.org/api/ab%2Fcd%3Fef%23gh') }],
      {
        p,
      },
    )
    expect(batch.requests[0]?.error?.message).toBe('fail https://jooble.org/api/[REDACTED]')
    expect(batch.requests[0]?.url).toBe('https://jooble.org/api/[REDACTED]')
  })

  it('nothing in the whole batch holds any fragment of the key', async () => {
    const { batch } = await run([{ throws: new Error(`boom ${URL_WITH_KEY}`) }])
    expect(leakedFragments(KEY, JSON.stringify(batch))).toEqual([])
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['no keywords', { keywords: undefined }],
    ['empty keywords', { keywords: '' }],
    ['keywords of 101 characters', { keywords: 'k'.repeat(101) }],
    ['an empty location', { location: '' }],
    ['a location of 101 characters', { location: 'l'.repeat(101) }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 6', { maxPages: 6 }],
    ['a fractional maxPages', { maxPages: 1.5 }],
    ['an unknown key', { radius: 10 }],
    ['a namespace other than jooble', { namespace: 'x' }],
    ['a base query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => provider().parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts the seeded config verbatim, and the boundary values', () => {
    const seeded = provider().parseConfig({
      configVersion: 1,
      keywords: 'senior developer',
      location: 'remote',
    })
    expect(seeded.namespace).toBe('jooble')
    expect(seeded.maxPages).toBe(1)
    expect(
      provider().parseConfig({ configVersion: 1, keywords: 'k'.repeat(100) }).keywords,
    ).toHaveLength(100)
    expect(provider().parseConfig({ configVersion: 1, keywords: 'k', maxPages: 5 }).maxPages).toBe(
      5,
    )
  })
})

describe('the BLOCKED state', () => {
  it('declares itself blocked with the key reason - and the provenance agrees', () => {
    expect(JOOBLE_SOURCE_STATUS.blocked).toBe(true)
    expect(JOOBLE_SOURCE_STATUS.permission).toBe('KEY_REQUIRED')
    expect(JOOBLE_SOURCE_STATUS.reason).toContain('controlled authenticated smoke')
    const prov = sourceProvenance('jooble', 'doc-example') as { permission: string; notes: string }
    expect(prov.permission).toBe(JOOBLE_SOURCE_STATUS.permission)
    expect(prov.notes).toContain('UNIT EXAMPLE ONLY, NOT A CAPTURE')
  })
})
