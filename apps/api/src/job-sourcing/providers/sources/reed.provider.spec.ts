import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { meteredContext } from '../../../test/quota-harness'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { SourceNotReadyError } from './quota-provider'
import {
  createReedProvider,
  reedBasicAuth,
  reedLocation,
  REED_SOURCE_STATUS,
} from './reed.provider'

/**
 * Reed through its public provider. Expected values are hand-read from
 * `__fixtures__/reed/doc-example.json` - a UNIT EXAMPLE written from Reed's developer page and the
 * API's published shape, not a capture (see its provenance) - and written as literals, never
 * produced by running the mapper.
 *
 * THE KEY is an obviously fake string; no real credential appears here.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const KEY = '00000000-fake-0000-fake-reedkey00000'
// base64 of "<KEY>:" and of "<KEY>", computed once with `Buffer.from(..).toString('base64')` and
// written here as literals so the expected header does not come from the code under test.
const BASIC_OF_KEY_AND_COLON = 'MDAwMDAwMDAtZmFrZS0wMDAwLWZha2UtcmVlZGtleTAwMDAwOg=='
const BASIC_OF_KEY_ONLY = 'MDAwMDAwMDAtZmFrZS0wMDAwLWZha2UtcmVlZGtleTAwMDAw'
const SEEDED = { keywords: 'senior developer', locationName: 'remote' }
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const
const NOT_CONFIGURED = { configured: false, apiKey: null, secrets: [] } as const
const SEARCH =
  'https://www.reed.co.uk/api/1.0/search?keywords=senior+developer&locationName=remote&resultsToTake=100&resultsToSkip=0'

const provider = (credential: Parameters<typeof createReedProvider>[0]['credential'] = READY) =>
  createReedProvider({ credential })
const cfg = (extra: Record<string, unknown> = {}, p = provider()) =>
  p.parseConfig({ configVersion: 1, ...SEEDED, ...extra })

type Envelope = { results: Record<string, unknown>[]; totalResults: number }
const example = () => sourceFixture('reed', 'doc-example') as Envelope
const job = (id: number, over: Record<string, unknown> = {}) => ({
  ...example().results[0],
  jobId: id,
  jobUrl: `https://www.reed.co.uk/jobs/example/${id}`,
  ...over,
})
const jobs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => job(from + i))
const body = (results: unknown[], totalResults?: number): FakeResponse => ({
  bodyText: JSON.stringify(totalResults === undefined ? { results } : { results, totalResults }),
})

async function run(
  responses: FakeResponse[],
  opts: { config?: ReturnType<typeof cfg>; p?: ReturnType<typeof provider> } = {},
) {
  const p = opts.p ?? provider()
  const f = fakeCollectionContext({ now: NOW, responses })
  const m = meteredContext(f)
  const batch = await p.collectReport(opts.config ?? cfg({}, p), m.ctx)
  return { batch, f, m }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (b: Batch, id: string) => b.observations.find((o) => o.identity.nativeId === id)

describe('a missing key is a readiness error before the network', () => {
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
    expect((error as Error).message).toBe('REED_API: REED_API_KEY is not configured')
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
  it('GETs the seeded search with Basic auth: the key as the username, an empty password', async () => {
    const { f } = await run([body([], 0)])
    expect(f.sent[0]?.url).toBe(SEARCH)
    expect(f.sent[0]?.method ?? 'GET').toBe('GET')
    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/json',
      authorization: `Basic ${BASIC_OF_KEY_AND_COLON}`,
    })
  })

  it('the credential is base64("<key>:") - NOT base64("<key>"), which is a different string', () => {
    expect(reedBasicAuth(KEY)).toBe(`Basic ${BASIC_OF_KEY_AND_COLON}`)
    expect(BASIC_OF_KEY_AND_COLON).not.toBe(BASIC_OF_KEY_ONLY)
  })

  it('keeps the key out of the URL', async () => {
    const { f } = await run([body([], 0)])
    expect(f.sent[0]?.url).not.toContain(KEY)
  })

  it('omits locationName when none is configured, and skips whole pages', async () => {
    const p = provider()
    const { f } = await run([body(jobs(2), 4), body(jobs(2, 10), 4)], {
      p,
      config: p.parseConfig({
        configVersion: 1,
        keywords: 'rust',
        resultsToTake: 2,
        maxPages: 2,
      }),
    })
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://www.reed.co.uk/api/1.0/search?keywords=rust&resultsToTake=2&resultsToSkip=0',
      'https://www.reed.co.uk/api/1.0/search?keywords=rust&resultsToTake=2&resultsToSkip=2',
    ])
  })
})

describe('mapping the unit example', () => {
  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const o = byId(batch, '50123001')
    expect(o?.identity).toMatchObject({
      provider: 'REED_API',
      namespace: 'reed',
      nativeId: '50123001',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://www.reed.co.uk/jobs/senior-developer/50123001')
    expect(o?.normalized.title).toBe('Senior Developer')
    expect(o?.normalized.companyName).toBe('Example Software Ltd')
    expect(o?.normalized.location).toBe('London, United Kingdom')
    expect(o?.adapterVersion).toBe('reed-1')
  })

  it('the native id and the application URL are different facts', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const o = byId(batch, '50123001')
    expect(o?.applicationUrl).toBe('https://www.reed.co.uk/jobs/senior-developer/50123001')
    expect(o?.identity.nativeId).not.toBe(o?.applicationUrl)
  })

  it('dates are dd/MM/yyyy, day first: 20/10/2026 is 20 October', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const dates = byId(batch, '50123001')?.normalized.dates
    expect(dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'REED_DMY',
        raw: '20/10/2026',
        status: 'OK',
        value: new Date('2026-10-20T00:00:00.000Z'),
      },
      {
        semantics: 'EXPIRY',
        contract: 'REED_DMY',
        raw: '20/11/2026',
        status: 'OK',
        value: new Date('2026-11-20T00:00:00.000Z'),
      },
    ])
    expect(byId(batch, '50123001')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    )
  })

  it('a day that does not exist (31/02/2026) is refused with its raw text kept - never rolled into March', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify(example()) }])
    const second = byId(batch, '50123002')
    expect(second?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'REED_DMY',
        raw: '31/02/2026',
        status: 'INVALID',
        value: null,
      },
      {
        semantics: 'EXPIRY',
        contract: 'REED_DMY',
        raw: '31/02/2026',
        status: 'INVALID',
        value: null,
      },
    ])
    expect(second?.normalized.publishedAt).toBeNull()
    // The posting itself is kept: a bad date costs the date, not the job.
    expect(second?.normalized.title).toBe('Lead Engineer')
  })

  it.each([
    ['04/13/2026', 'a month-first date (13 is not a month)'],
    ['2026-10-20', 'an ISO date'],
    ['20/10/26', 'a two-digit year'],
    ['30/02/2026', '30 February'],
    ['29/02/2025', '29 February in a common year'],
  ])('%s (%s) is INVALID', async (raw) => {
    const { batch } = await run([body([job(1, { date: raw })], 1)])
    expect(byId(batch, '1')?.normalized.dates?.[0]).toMatchObject({ raw, status: 'INVALID' })
  })

  it('29/02/2024 is a real day (a leap year, in the past)', async () => {
    const { batch } = await run([body([job(1, { date: '29/02/2024' })], 1)])
    expect(byId(batch, '1')?.normalized.dates?.[0]).toMatchObject({ status: 'OK' })
  })

  it('every posting is located in the United Kingdom, named or not', () => {
    expect(reedLocation('London')).toBe('London, United Kingdom')
    expect(reedLocation('  Leeds ')).toBe('Leeds, United Kingdom')
    expect(reedLocation('')).toBe('United Kingdom')
    expect(reedLocation('   ')).toBe('United Kingdom')
    expect(reedLocation(null)).toBe('United Kingdom')
  })

  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run([body([job(1), { jobId: 'x' }, job(2)], 3)])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an empty result is a valid, empty success', async () => {
    const { batch } = await run([body([], 0)])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })

  it('an envelope without `results` is drift', async () => {
    const { batch } = await run([{ bodyText: JSON.stringify({ totalResults: 1 }) }])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('paging', () => {
  const take2 = (p = provider(), extra: Record<string, unknown> = {}) =>
    p.parseConfig({ configVersion: 1, ...SEEDED, resultsToTake: 2, maxPages: 5, ...extra })

  it('stops on a short page: 1 of 2 is the last', async () => {
    const p = provider()
    const { f } = await run([body(jobs(2), 99), body(jobs(1, 10), 99)], { p, config: take2(p) })
    expect(f.sent).toHaveLength(2)
  })

  it('stops when the total is reached on a full page (4 of 4 after two full pages)', async () => {
    const p = provider()
    const { f } = await run([body(jobs(2), 4), body(jobs(2, 10), 4), body(jobs(2, 20), 4)], {
      p,
      config: take2(p),
    })
    expect(f.sent).toHaveLength(2)
  })

  it('continues on a full page while the total is not reached (2 of 5)', async () => {
    const p = provider()
    const { f } = await run([body(jobs(2), 5), body(jobs(1, 10), 5)], { p, config: take2(p) })
    expect(f.sent).toHaveLength(2)
  })

  it('without a total, a full page continues and an empty one stops', async () => {
    const p = provider()
    const { f } = await run([body(jobs(2)), body([])], { p, config: take2(p) })
    expect(f.sent).toHaveLength(2)
  })

  it('maxPages bounds the walk (1 of many)', async () => {
    const { f, batch } = await run([body(jobs(100), 999)])
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })

  it('more results than were asked for exceeds the page bound (3 of 2)', async () => {
    const p = provider()
    const { batch } = await run([body(jobs(3), 3)], { p, config: take2(p) })
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('metering: Reed has no documented quota, so there is no reservation', () => {
  it('makes no reservation and marks nothing sent', async () => {
    const { m, batch } = await run([body(jobs(1), 1)])
    expect(m.events).toEqual(['fetch'])
    expect(batch.requests[0]?.cost).toBeNull()
  })
})

describe('the key never reaches a report', () => {
  it('an error that echoes the Basic header is redacted, with no key registered by the worker', async () => {
    const { batch } = await run([
      { throws: new Error(`refused: authorization: Basic ${BASIC_OF_KEY_AND_COLON} end`) },
    ])
    expect(batch.requests[0]?.error?.message).toBe('refused: authorization: Basic [REDACTED] end')
    expect(JSON.stringify(batch)).not.toContain(BASIC_OF_KEY_AND_COLON)
    expect(JSON.stringify(batch)).not.toContain(KEY)
  })

  it('an error that quotes the bare key is redacted', async () => {
    const { batch } = await run([{ throws: new Error(`bad key ${KEY}`) }])
    expect(batch.requests[0]?.error?.message).toBe('bad key [REDACTED]')
  })

  it('an error that quotes `key:` (the username form) is redacted whole', async () => {
    const { batch } = await run([{ throws: new Error(`user ${KEY}: rejected`) }])
    expect(batch.requests[0]?.error?.message).toBe('user [REDACTED] rejected')
  })

  it('a key whose length is not a multiple of three leaves no base64 tail either', async () => {
    const odd = 'reed-key-of-37-characters-fake-0000zz'
    const p = provider({ configured: true, apiKey: odd, secrets: [odd] })
    const header = reedBasicAuth(odd)
    const { batch } = await run([{ throws: new Error(`echo ${header}`) }], { p })
    expect(batch.requests[0]?.error?.message).toBe('echo Basic [REDACTED]')
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['no keywords', { keywords: undefined }],
    ['empty keywords', { keywords: '' }],
    ['keywords of 101 characters', { keywords: 'k'.repeat(101) }],
    ['an empty locationName', { locationName: '' }],
    ['resultsToTake 0', { resultsToTake: 0 }],
    ['resultsToTake 101 (past the documented limit)', { resultsToTake: 101 }],
    ['a fractional resultsToTake', { resultsToTake: 1.5 }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 6', { maxPages: 6 }],
    ['an unknown key', { distanceFromLocation: 10 }],
    ['a namespace other than reed', { namespace: 'x' }],
    ['a base query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() => provider().parseConfig({ configVersion: 1, ...SEEDED, ...extra })).toThrow()
  })

  it('accepts the seeded config verbatim, defaults, and both resultsToTake bounds', () => {
    const seeded = provider().parseConfig({
      configVersion: 1,
      keywords: 'senior developer',
      locationName: 'remote',
    })
    expect(seeded).toMatchObject({ namespace: 'reed', resultsToTake: 100, maxPages: 1 })
    expect(
      provider().parseConfig({ configVersion: 1, keywords: 'k', resultsToTake: 1 }).resultsToTake,
    ).toBe(1)
    expect(
      provider().parseConfig({ configVersion: 1, keywords: 'k', resultsToTake: 100 }).resultsToTake,
    ).toBe(100)
  })
})

describe('the BLOCKED state', () => {
  it('declares itself blocked with the key reason - and the provenance agrees', () => {
    expect(REED_SOURCE_STATUS.blocked).toBe(true)
    expect(REED_SOURCE_STATUS.permission).toBe('KEY_REQUIRED')
    expect(REED_SOURCE_STATUS.reason).toContain('controlled authenticated smoke')
    const prov = sourceProvenance('reed', 'doc-example') as { permission: string; notes: string }
    expect(prov.permission).toBe(REED_SOURCE_STATUS.permission)
    expect(prov.notes).toContain('UNIT EXAMPLE ONLY, NOT A CAPTURE')
    expect(prov.notes).toContain('31/02/2026')
  })
})
