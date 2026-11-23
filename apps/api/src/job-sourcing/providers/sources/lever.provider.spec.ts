import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { readProvenance } from '../../../test/fixture-provenance'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { ownershipCountOf } from '../manifest.ownership'
import { boardVerdictOf } from './ats-config'
import { LEVER_HOSTS, LEVER_LIMITS, leverProvider, remoteFromWorkplaceType } from './lever.provider'

/**
 * Lever through its public provider. Expected values are hand-read from the authentic captures in
 * `__fixtures__/lever/` (see the provenance files) and written as literals; none was produced by
 * running the mapper. Epoch milliseconds were converted to instants with `new Date(ms)` outside
 * the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
/**
 * The ownership figures are READ from the provenance files, not kept here: all three of these had
 * drifted once as free text (Spotify 71 vs 87 of 90, Siteimprove 11 vs 12, QuantCo 11 vs 14) and
 * were corrected only because somebody grepped. The manifest reads the same sentence, so the two
 * cannot disagree.
 */
const ownership = (name: string, file: string) => {
  const count = ownershipCountOf(readProvenance('lever', `${file}.provenance.json`).notes)
  if (count === null) throw new Error(`${file}: no ownership count in the provenance notes`)
  return { name, evidence: `posting text names ${name} (${count.matched} of ${count.total})` }
}
const SPOTIFY = ownership('Spotify', 'spotify-page1')
const SITEIMPROVE = ownership('Siteimprove', 'siteimprove-eu-board')
const QUANTCO = ownership('QuantCo', 'quantco-trailing-hyphen-board')

const cfg = (board = 'spotify', extra: Record<string, unknown> = {}) =>
  leverProvider.parseConfig({ configVersion: 1, board, ...extra })
const spotifyCfg = () => cfg('spotify', { employer: SPOTIFY })

type Posting = Record<string, unknown>
const page = (name: string) => sourceFixture('lever', name) as Posting[]
const json = (body: unknown): FakeResponse => ({ status: 200, bodyText: JSON.stringify(body) })

async function runAll(responses: FakeResponse[], config = spotifyCfg()) {
  const f = fakeCollectionContext({ now: NOW, responses })
  const batch = await leverProvider.collectReport(config, f.ctx)
  return { batch, f }
}
const run = (body: unknown, config = spotifyCfg(), status = 200) =>
  runAll([{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }], config)
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

/** The smallest posting the schema accepts. */
const posting = (n: number, extra: Posting = {}): Posting => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  text: `Posting ${n}`,
  hostedUrl: `https://jobs.lever.co/spotify/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ...extra,
})
const fullPage = (from: number) => Array.from({ length: 50 }, (_, i) => posting(from + i))

describe('the requests', () => {
  it('asks the global host with mode=json for the whole board, under the raised 10 MiB cap', async () => {
    const { f } = await run(page('spotify-page1'))
    // EXACT on purpose (see the Greenhouse spec): no extra header on a keyless public board.
    expect(f.sent).toEqual([
      {
        url: 'https://api.lever.co/v0/postings/spotify?mode=json',
        headers: { accept: 'application/json' },
        maxBytes: 10_485_760,
        timeoutMs: 30_000,
      },
    ])
  })

  it('asks the EU host for an EU board', async () => {
    const { f } = await run(
      page('siteimprove-eu-board'),
      cfg('siteimprove', { region: 'eu', employer: SITEIMPROVE }),
    )
    expect(f.sent[0]?.url).toBe('https://api.eu.lever.co/v0/postings/siteimprove?mode=json')
  })

  it("knows exactly two hosts, both Lever's", () => {
    expect(LEVER_HOSTS).toEqual({ global: 'api.lever.co', eu: 'api.eu.lever.co' })
    expect(LEVER_LIMITS).toEqual({ maxBytes: 10_485_760, maxItemsPerPage: 2_000, maxPages: 1 })
  })

  it('is the LEVER_ATS provider', () => {
    expect(leverProvider.type).toBe('LEVER_ATS')
  })
})

describe('the Spotify capture (global host)', () => {
  it('turns the 6 postings into 6 observations, a complete inventory', async () => {
    const { batch } = await run(page('spotify-page1'))
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.scope).toEqual({
      namespace: 'lever:global:spotify',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field of the first posting (hand-read from the capture)', async () => {
    const { batch } = await run(page('spotify-page1'))
    const o = byId(batch, 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae')
    expect(o?.identity).toMatchObject({
      provider: 'LEVER_ATS',
      namespace: 'lever:global:spotify',
      nativeId: 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.normalized.title).toBe('Head of Product Management - Artist Products')
    expect(o?.normalized.companyName).toBe('Spotify')
    expect(o?.normalized.location).toBe('New York, NY')
    expect(o?.normalized.employmentType).toBe('Permanent')
    expect(o?.normalized.tags).toEqual(['Product', 'Music'])
    expect(o?.normalized.remote).toBe(true)
    expect(o?.adapterVersion).toBe('lever-2')
  })

  it('keeps the hosted posting URL and the apply URL distinct', async () => {
    const { batch } = await run(page('spotify-page1'))
    const o = byId(batch, 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae')
    expect(o?.sourcePostingUrl).toBe(
      'https://jobs.lever.co/spotify/e2c7bbb8-f873-42c7-811f-0bd45bf452ae',
    )
    expect(o?.applicationUrl).toBe(
      'https://jobs.lever.co/spotify/e2c7bbb8-f873-42c7-811f-0bd45bf452ae/apply',
    )
  })

  it('a posting with no applyUrl has no application URL (it is not copied from the hosted one)', async () => {
    const { batch } = await run([posting(1)])
    expect(batch.observations[0]?.applicationUrl).toBeNull()
  })

  it('createdAt (epoch milliseconds) is the publication date proxy: 1789657909614 is 2026-09-17T15:11:49.614Z', async () => {
    const { batch } = await run(page('spotify-page1'))
    const o = byId(batch, 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-09-17T15:11:49.614Z')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'UNIX_MILLISECONDS',
        raw: '1789657909614',
        status: 'OK',
        value: new Date('2026-09-17T15:11:49.614Z'),
      },
    ])
  })

  it('a posting with no createdAt has no dates at all', async () => {
    const { batch } = await run([posting(1)])
    expect(batch.observations[0]?.normalized.dates).toEqual([])
    expect(batch.observations[0]?.normalized.publishedAt).toBeNull()
  })

  it('assembles the body from the intro, each list under its heading, and the closing text', async () => {
    const { batch } = await run([
      posting(1, {
        description: '<div>Intro text</div>',
        lists: [
          { text: 'What you will do', content: '<li>Build</li><li>Ship</li>' },
          { text: 'Who you are', content: '<li>Curious</li>' },
        ],
        additional: '<div>Closing words</div>',
      }),
    ])
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    const at = (needle: string) => md.indexOf(needle)
    expect(
      [
        at('Intro text'),
        at('What you will do'),
        at('Build'),
        at('Who you are'),
        at('Closing words'),
      ].every((i) => i >= 0),
    ).toBe(true)
    expect(at('Intro text')).toBeLessThan(at('What you will do'))
    expect(at('What you will do')).toBeLessThan(at('Build'))
    expect(at('Build')).toBeLessThan(at('Who you are'))
    expect(at('Who you are')).toBeLessThan(at('Closing words'))
  })

  it('the real Spotify body arrives as readable text', async () => {
    const { batch } = await run(page('spotify-page1'))
    const md = byId(batch, 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae')?.normalized.descriptionMd ?? ''
    expect(md).toContain('The Music Mission team owns Spotify')
    expect(md).not.toContain('<div')
  })

  it('maps the structured salaryRange (sources-17): per-year-salary is a yearly salary', async () => {
    const eu = await run(
      page('siteimprove-eu-board'),
      cfg('siteimprove', { region: 'eu', employer: SITEIMPROVE }),
    )
    expect(byId(eu.batch, '13ff0a37-3059-45b1-8017-8310b620ec5d')?.normalized.salary).toEqual({
      min: 37800,
      max: 47250,
      currency: 'USD',
      period: 'YEAR',
    })
    const { batch } = await run(page('spotify-page1'))
    expect(batch.observations.map((o) => o.normalized.salary ?? null)).toEqual(
      batch.observations.map(() => null),
    )
  })
})

describe('locations', () => {
  it('joins every allLocations entry when there is more than one', async () => {
    const { batch } = await run(page('spotify-page1'))
    expect(byId(batch, '080868dd-fc8c-4648-b6ab-6780d8ca3d63')?.normalized.location).toBe(
      'Stockholm; London',
    )
    expect(byId(batch, 'cf13d272-92ac-407d-89bf-7f20d20f7961')?.normalized.location).toBe(
      'New York, NY; San Francisco, CA',
    )
  })

  it('uses the single location when allLocations has one entry', async () => {
    const { batch } = await run(page('spotify-page1'))
    expect(byId(batch, '4e4ab485-06f1-46b1-88e0-44f3fda4b62a')?.normalized.location).toBe('Tokyo')
  })

  it('falls back to categories.location when allLocations is empty or absent', async () => {
    for (const all of [[], undefined, null]) {
      const { batch } = await run([
        posting(1, { categories: { location: 'Lisbon', allLocations: all } }),
      ])
      expect(batch.observations[0]?.normalized.location).toBe('Lisbon')
    }
  })

  it('no categories at all is no location, no type and no tags', async () => {
    const { batch } = await run([posting(1)])
    const n = batch.observations[0]?.normalized
    expect([n?.location ?? null, n?.employmentType ?? null, n?.tags ?? []]).toEqual([
      null,
      null,
      [],
    ])
  })

  it('keeps a free-text location like "Munich or Karlsruhe" whole', async () => {
    const { batch } = await run(
      page('quantco-trailing-hyphen-board'),
      cfg('quantco-', { employer: QUANTCO }),
    )
    expect(byId(batch, 'f41c0733-033e-431e-8feb-3b044874308d')?.normalized.location).toBe(
      'Munich or Karlsruhe',
    )
  })
})

describe('workplaceType: documented values plus the owner-aliased onsite', () => {
  it.each([
    ['remote', true],
    ['on-site', false],
    ['onsite', false],
    ['hybrid', false],
    ['unspecified', null],
  ])('%s maps to remote=%s', (value, expected) => {
    expect(remoteFromWorkplaceType(value)).toBe(expected)
  })

  it.each(['ONSITE', 'Onsite', 'Remote', 'office', '', 'remote ', ' onsite', 'on site'])(
    'the undocumented value %j is unknown, not guessed',
    (value) => {
      expect(remoteFromWorkplaceType(value)).toBeNull()
    },
  )

  it('an absent workplaceType is unknown', () => {
    expect(remoteFromWorkplaceType(null)).toBeNull()
  })

  it('through the mapper: remote and hybrid postings of the capture, and the aliased live "onsite"', async () => {
    const { batch } = await run(page('spotify-page1'))
    expect(byId(batch, 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae')?.normalized.remote).toBe(true) // remote
    expect(byId(batch, '47aeb6ee-f8c9-4f1e-9197-25c4c5676e5d')?.normalized.remote).toBe(false) // hybrid
    // The live API sends "onsite" where the README says "on-site": aliased by the owner (2026-10-24),
    // so it is `false` (not remote), not unknown.
    expect(byId(batch, 'c152d042-642d-4a48-862b-8be8d6cdc819')?.normalized.remote).toBe(false)
  })
})

describe('unknown employer', () => {
  it('without verified employer evidence every posting is QUARANTINED: the slug is not a company name', async () => {
    const { batch } = await run(page('spotify-page1'), cfg('spotify'))
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 0,
      invalid: 0,
      quarantined: 6,
      discarded: 0,
    })
    expect(batch.observations).toEqual([])
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(
      Array(5).fill('QUARANTINED: MISSING_COMPANY'),
    )
  })

  it('with evidence the posting carries the verified employer name, nothing from the slug', async () => {
    const { batch } = await run(
      page('spotify-page1'),
      cfg('spotify', { employer: { name: 'Spotify AB', evidence: 'e' } }),
    )
    expect(new Set(batch.observations.map((o) => o.normalized.companyName))).toEqual(
      new Set(['Spotify AB']),
    )
  })
})

describe('the EU variant', () => {
  const euCfg = () => cfg('siteimprove', { region: 'eu', employer: SITEIMPROVE })

  it('maps the EU capture into the EU namespace with EU hosted URLs', async () => {
    const { batch } = await run(page('siteimprove-eu-board'), euCfg())
    expect(batch.counts.normalized).toBe(3)
    const o = byId(batch, '13ff0a37-3059-45b1-8017-8310b620ec5d')
    expect(o?.identity.namespace).toBe('lever:eu:siteimprove')
    expect(o?.sourcePostingUrl).toBe(
      'https://jobs.eu.lever.co/siteimprove/13ff0a37-3059-45b1-8017-8310b620ec5d',
    )
    expect(o?.applicationUrl).toBe(
      'https://jobs.eu.lever.co/siteimprove/13ff0a37-3059-45b1-8017-8310b620ec5d/apply',
    )
    expect(o?.normalized.title).toBe('Customer Success Executive')
    expect(o?.normalized.employmentType).toBe('Full-Time')
    expect(o?.normalized.remote).toBe(false) // hybrid
    expect(byId(batch, '0e1585af-dc06-4cc7-93a9-cae389ace737')?.normalized.remote).toBe(true)
  })

  it('the same slug and id on the two hosts are two different postings', async () => {
    const body = [posting(1)]
    const global = await run(body, cfg('siteimprove', { employer: SITEIMPROVE }))
    const eu = await run(body, euCfg())
    expect(global.batch.observations[0]?.identity.identityKey).not.toBe(
      eu.batch.observations[0]?.identity.identityKey,
    )
  })

  it('a board that exists only on the EU host is a dead board when asked of the global one (real 404)', async () => {
    const { batch, f } = await run(
      sourceFixtureText('lever', 'board-not-found'),
      cfg('siteimprove', { employer: SITEIMPROVE }),
      404,
    )
    expect(f.sent[0]?.url).toBe('https://api.lever.co/v0/postings/siteimprove?mode=json')
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })
})

describe('a site whose name ends in a hyphen (quantco-)', () => {
  it('is asked for by its exact name and maps like any other', async () => {
    const { batch, f } = await run(
      page('quantco-trailing-hyphen-board'),
      cfg('quantco-', { employer: QUANTCO }),
    )
    expect(f.sent[0]?.url).toBe('https://api.lever.co/v0/postings/quantco-?mode=json')
    expect(batch.observations.map((o) => o.identity.namespace)).toEqual([
      'lever:global:quantco-',
      'lever:global:quantco-',
    ])
    expect(byId(batch, '3e18574e-ab5a-46a2-8714-a0221fb937e7')?.normalized.employmentType).toBe(
      'Full-Time or Part-Time',
    )
  })
})

describe('the whole board in one request (the run ceiling is 1, SR-H-1b)', () => {
  it('a board larger than one old page (50 + 3 postings) is collected fully in ONE request', async () => {
    const { batch, f } = await runAll([json([...fullPage(0), ...page('spotify-page2')])])
    expect(f.sent.map((r) => r.url)).toEqual(['https://api.lever.co/v0/postings/spotify?mode=json'])
    expect(batch.counts).toEqual({
      raw: 53,
      normalized: 53,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
  })

  it('a board of exactly 50 is one request, not a second past-the-end one', async () => {
    const { batch, f } = await runAll([json(fullPage(0))])
    expect(f.sent).toHaveLength(1)
    expect(batch.counts.normalized).toBe(50)
    expect(batch.coverage).toBe('FULL_INVENTORY')
  })

  it('2 000 postings fit; 2 001 is drift (PAYLOAD_TOO_LARGE), not a silent truncation', async () => {
    const board = Array.from({ length: 2_000 }, (_, i) => posting(i))
    const at = await runAll([json(board)])
    expect(at.batch.counts.normalized).toBe(2_000)
    const over = await runAll([json([...board, posting(2_000)])])
    expect(over.batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(over.batch.outcome).toBe('FAILED')
  })

  it('a stored cursor from the old paged runs is ignored: the board is asked whole', async () => {
    const first = await runAll([json(fullPage(0))], spotifyCfg())
    const stored = first.f.saved.at(-1)
    if (stored === undefined) throw new Error('no checkpoint')
    const f = fakeCollectionContext({
      now: NOW,
      responses: [json([posting(1)])],
      stored: { ...stored, position: { kind: 'CURSOR', page: 1, cursor: '1000' } },
    })
    const batch = await leverProvider.collectReport(spotifyCfg(), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual(['https://api.lever.co/v0/postings/spotify?mode=json'])
    // The loop counts a resumed walk as started mid-board, so this one run is PARTIAL (it closes
    // nothing it did not see); the checkpoint it leaves starts the next run from the top, FULL.
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    const left = f.saved.at(-1)
    const next = fakeCollectionContext({
      now: NOW,
      responses: [json([posting(1)])],
      ...(left === undefined ? {} : { stored: left }),
    })
    const healed = await leverProvider.collectReport(spotifyCfg(), next.ctx)
    expect(next.sent.map((r) => r.url)).toEqual([
      'https://api.lever.co/v0/postings/spotify?mode=json',
    ])
    expect(healed.coverage).toBe('FULL_INVENTORY')
  })
})

describe('empty and dead boards', () => {
  it('the real empty page ([]) is a valid, complete, empty success', async () => {
    const { batch } = await run(page('spotify-page3-empty'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })

  it('the real 404 body is a BOARD error: FAILED, status 404, nothing read', async () => {
    const { batch } = await run(sourceFixtureText('lever', 'board-not-found'), cfg('nope'), 404)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[404, 'UPSTREAM']])
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })

  it('a rate limit is not a dead board', async () => {
    const { batch } = await run('[]', cfg('x'), 429)
    expect(batch.requests[0]?.error?.code).toBe('RATE_LIMIT')
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it('an object where the array should be is PARSE_DRIFT', async () => {
    const { batch } = await run({ ok: false, error: 'Document not found' })
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('salary (sources-17)', () => {
  const salaryOfPosting = async (salaryRange: unknown) => {
    const { batch } = await run([posting(1, { salaryRange } as Posting)])
    expect(batch.counts.normalized).toBe(1)
    return byId(batch, posting(1).id as string)?.normalized.salary ?? null
  }

  it('maps the three Lever intervals, case-insensitively', async () => {
    const range = { min: 10, max: 20, currency: 'eur' }
    expect(await salaryOfPosting({ ...range, interval: 'per-month-salary' })).toEqual({
      min: 10,
      max: 20,
      currency: 'EUR',
      period: 'MONTH',
    })
    expect((await salaryOfPosting({ ...range, interval: 'Per-Hour-Wage' }))?.period).toBe('HOUR')
    expect((await salaryOfPosting({ ...range, interval: 'per-year-salary' }))?.period).toBe('YEAR')
  })

  it('another interval, a missing currency or a malformed range is no salary, and the posting stays', async () => {
    expect(await salaryOfPosting({ min: 1, max: 2, currency: 'USD', interval: 'one-time' })).toBe(
      null,
    )
    expect(await salaryOfPosting({ min: 1, max: 2, interval: 'per-year-salary' })).toBe(null)
    expect(await salaryOfPosting('100k')).toBe(null)
    expect(
      await salaryOfPosting({ min: '1', max: 2, currency: 'USD', interval: 'per-year-salary' }),
    ).toEqual({ min: null, max: 2, currency: 'USD', period: 'YEAR' })
  })
})

describe('item isolation and bounds', () => {
  it('one malformed posting is isolated with a sample; its neighbours are kept', async () => {
    const { batch } = await run([posting(1), { id: 5, text: 'x' }, posting(3)])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.invalidSamples[0]?.reason.startsWith('ITEM_SCHEMA')).toBe(true)
  })

  it.each([
    ['a missing id', { ...posting(1), id: undefined }],
    ['a numeric id', posting(1, { id: 7 })],
    ['a missing title', { ...posting(1), text: undefined }],
    ['a missing hostedUrl', { ...posting(1), hostedUrl: undefined }],
  ])('refuses %s as an invalid item', async (_why, bad) => {
    const { batch } = await run([bad])
    expect(batch.counts.invalid).toBe(1)
  })

  it.each([
    ['text', 'text', ORIGINAL_LIMITS.title],
    ['id', 'id', 200],
    ['commitment', 'categories', 200],
    ['department', 'categories', 200],
  ])(
    '%s: exactly at its bound is accepted, one past is an invalid item',
    async (name, key, max) => {
      const make = (n: number) =>
        key === 'categories' ? { categories: { [name]: 'x'.repeat(n) } } : { [key]: 'x'.repeat(n) }
      const at = await run([{ ...posting(1), ...make(max) }])
      expect(at.batch.counts.invalid).toBe(0)
      const past = await run([{ ...posting(1), ...make(max + 1) }])
      expect(past.batch.counts.invalid).toBe(1)
    },
  )

  it('allLocations: 100 entries are accepted, 101 make the item invalid', async () => {
    const locs = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`)
    const ok = await run([posting(1, { categories: { allLocations: locs(100) } })])
    expect(ok.batch.counts.invalid).toBe(0)
    const bad = await run([posting(1, { categories: { allLocations: locs(101) } })])
    expect(bad.batch.counts.invalid).toBe(1)
  })

  it('lists: 50 are accepted, 51 make the item invalid', async () => {
    const lists = (n: number) =>
      Array.from({ length: n }, () => ({ text: 't', content: '<li>x</li>' }))
    expect((await run([posting(1, { lists: lists(50) })])).batch.counts.invalid).toBe(0)
    expect((await run([posting(1, { lists: lists(51) })])).batch.counts.invalid).toBe(1)
  })

  it('an unsafe hosted URL is quarantined by the observation builder', async () => {
    const { batch } = await run([
      posting(1, { hostedUrl: 'https://user:pw@evil.example/spotify/x' }),
    ])
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 0, quarantined: 1 })
  })

  it('an unsafe apply URL is dropped with evidence while the posting is kept', async () => {
    const { batch } = await run([posting(1, { applyUrl: 'javascript:alert(1)' })])
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.applicationUrl).toBeNull()
    expect(batch.observations[0]?.evidence.map((e) => e.field)).toContain('applicationUrl')
  })
})

describe('partial categories and bodies', () => {
  it('a posting with only a department has just that tag; with only a team, just that one', async () => {
    const a = await run([posting(1, { categories: { department: 'Eng' } })])
    expect(a.batch.observations[0]?.normalized.tags).toEqual(['Eng'])
    const b = await run([posting(2, { categories: { team: 'Platform' } })])
    expect(b.batch.observations[0]?.normalized.tags).toEqual(['Platform'])
  })

  it('a list with no heading or no items contributes nothing invented, and an absent intro/closing is empty', async () => {
    const { batch } = await run([
      posting(1, {
        description: null,
        additional: null,
        lists: [
          { text: null, content: '<li>Only item</li>' },
          { text: 'Heading only', content: null },
        ],
      }),
    ])
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    expect(md.replace(/[\s#*\-\\]+/g, ' ').trim()).toBe('Only item Heading only')
  })

  it('a posting with nothing but the required fields has an empty description', async () => {
    const { batch } = await run([posting(1)])
    expect(batch.observations[0]?.normalized.descriptionMd).toBe('')
  })
})

describe('conditional requests: the board is revalidated on its one slot', () => {
  it('stores one entry for the board, and a 304 replays it with its validator', async () => {
    const first = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(fullPage(0)), etag: 'W/"b1"' }],
    })
    await leverProvider.collectReport(spotifyCfg(), first.ctx)
    expect([...first.cache.keys()].map((k) => (JSON.parse(k) as string[])[0])).toEqual(['board'])

    const second = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: Object.fromEntries(first.cache),
    })
    const batch = await leverProvider.collectReport(spotifyCfg(), second.ctx)
    expect(second.sent.map((r) => r.headers?.['if-none-match'])).toEqual(['W/"b1"'])
    expect(batch.counts.raw).toBe(50)
  })
})
