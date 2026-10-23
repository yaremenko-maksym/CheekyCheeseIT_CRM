import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { remoteokProvider } from './remoteok.provider'

/**
 * RemoteOK through its public provider. Expected values are hand-read from
 * `__fixtures__/remoteok/feed.json` (an authentic capture, see its provenance file) and written
 * here as literals - never produced by running the mapper.
 */

const NOW = new Date('2026-10-23T20:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  remoteokProvider.parseConfig({ configVersion: 1, ...extra })

const feed = () => sourceFixture('remoteok', 'feed') as Record<string, unknown>[]
const legal = () => feed()[0]
const jobs = () => feed().slice(1)

async function run(body: unknown, opts: { status?: number } = {}) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [
      {
        status: opts.status ?? 200,
        bodyText: typeof body === 'string' ? body : JSON.stringify(body),
      },
    ],
  })
  const batch = await remoteokProvider.collectReport(cfg(), f.ctx)
  return { batch, f }
}

const byId = (batch: Awaited<ReturnType<typeof run>>['batch'], id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

describe('mapping the authentic capture', () => {
  it('turns the 6 jobs into 6 observations and does not count the legal object as an item', async () => {
    const { batch } = await run(feed())
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first job (hand-read from the capture)', async () => {
    const { batch } = await run(feed())
    const o = byId(batch, '1137557')
    expect(o).toBeDefined()
    expect(o?.identity).toMatchObject({
      provider: 'REMOTEOK_API',
      namespace: 'remoteok',
      nativeId: '1137557',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://remoteok.com/remote-jobs/remote-senior-devops-engineer-lemon-io-1137557',
    )
    expect(o?.applicationUrl).toBe(
      'https://remoteok.com/remote-jobs/remote-senior-devops-engineer-lemon-io-1137557',
    )
    expect(o?.normalized.title).toBe('Senior DevOps Engineer')
    expect(o?.normalized.companyName).toBe('Lemon.io')
    expect(o?.normalized.location).toBeNull()
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.tags).toEqual([
      'devops',
      'engineer',
      'dev',
      'python',
      'golang',
      'aws',
      'gcp',
      'kubernetes',
      'sql',
      'linux',
      'ansible',
      'ai',
      'full time',
      'full stack',
      'remote',
      'remote work',
    ])
    expect(o?.adapterVersion).toBe('remoteok-1')
  })

  it('keeps a stated location and treats an empty one as missing geography', async () => {
    const { batch } = await run(feed())
    expect(byId(batch, '1137550')?.normalized.location).toBe('Your Remote US Home Office')
    expect(byId(batch, '1137553')?.normalized.location).toBeNull()
  })

  it('reads the publication date from `date` (2026-10-22T12:58:28+00:00 for the first job)', async () => {
    const { batch } = await run(feed())
    const o = byId(batch, '1137557')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-22T12:58:28.000Z')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-10-22T12:58:28+00:00',
        status: 'OK',
        value: new Date('2026-10-22T12:58:28.000Z'),
      },
    ])
    expect(byId(batch, '1137542')?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-17T08:00:50.000Z',
    )
  })

  it('uses the native id for identity, so a changed title or url does not change the key', async () => {
    const a = await run(feed())
    const moved = jobs().map((j) =>
      j.id === '1137557'
        ? { ...j, position: 'Renamed', url: 'https://remoteok.com/remote-jobs/other-slug-1137557' }
        : j,
    )
    const b = await run([legal(), ...moved])
    expect(byId(b.batch, '1137557')?.identity.identityKey).toBe(
      byId(a.batch, '1137557')?.identity.identityKey,
    )
    expect(byId(b.batch, '1137557')?.normalized.title).toBe('Renamed')
  })
})

describe('the legal / metadata object is recognised by shape, not position', () => {
  it('is dropped at index 0, at index 3 and at the end, with identical results', async () => {
    const baseline = (await run(feed())).batch
    const j = jobs()
    for (const arr of [
      [legal(), ...j],
      [...j.slice(0, 3), legal(), ...j.slice(3)],
      [...j, legal()],
    ]) {
      const { batch } = await run(arr)
      expect(batch.counts).toEqual(baseline.counts)
      expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(
        baseline.observations.map((o) => o.identity.nativeId),
      )
    }
  })

  it('is optional: a feed without it maps the same 6 jobs', async () => {
    const { batch } = await run(jobs())
    expect(batch.counts.raw).toBe(6)
    expect(batch.counts.invalid).toBe(0)
  })

  it('does NOT swallow a job that merely has a `legal` field - it has an id, so it is a job', async () => {
    const withLegalField = { ...jobs()[0], legal: 'note' }
    const { batch } = await run([legal(), withLegalField])
    expect(batch.counts.raw).toBe(1)
    expect(batch.counts.normalized).toBe(1)
  })

  it('does NOT swallow other non-job junk: an element that is not legal-shaped is an invalid item', async () => {
    const { batch } = await run([legal(), { foo: 1 }, ...jobs()])
    expect(batch.counts).toEqual({
      raw: 7,
      normalized: 6,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('item bounds, at the limit and past it', () => {
  const job = (over: Record<string, unknown>) => ({ ...jobs()[0], ...over })

  it('title 2000 chars is valid, 2001 is invalid', async () => {
    const ok = await run([job({ position: 'T'.repeat(2000) })])
    expect(ok.batch.counts.invalid).toBe(0)
    const bad = await run([job({ position: 'T'.repeat(2001) })])
    expect(bad.batch.counts.invalid).toBe(1)
  })

  it('company 1000 chars is valid, 1001 is invalid', async () => {
    expect((await run([job({ company: 'C'.repeat(1000) })])).batch.counts.invalid).toBe(0)
    expect((await run([job({ company: 'C'.repeat(1001) })])).batch.counts.invalid).toBe(1)
  })

  it('200 tags of 200 chars are valid; 201 tags or a 201-char tag are invalid', async () => {
    const tag = 't'.repeat(200)
    expect(
      (await run([job({ tags: Array.from({ length: 200 }, () => tag) })])).batch.counts.invalid,
    ).toBe(0)
    expect(
      (await run([job({ tags: Array.from({ length: 201 }, () => 't') })])).batch.counts.invalid,
    ).toBe(1)
    expect((await run([job({ tags: ['t'.repeat(201)] })])).batch.counts.invalid).toBe(1)
  })

  it('a link of 2048 chars is accepted by the schema, 2049 is invalid', async () => {
    const link = (n: number) =>
      'https://remoteok.com/' + 'a'.repeat(n - 'https://remoteok.com/'.length)
    expect((await run([job({ url: link(2049) })])).batch.counts.invalid).toBe(1)
    expect((await run([job({ url: link(2048) })])).batch.counts.invalid).toBe(0)
  })

  it('more than 250 items on the page is drift: the whole page fails', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ id: String(i + 1) }))
    const ok = await run(many(250))
    expect(ok.batch.counts.raw).toBe(250)
    const bad = await run(many(251))
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
  })
})

describe('missing data', () => {
  it('an empty employer is quarantined as MISSING_COMPANY, not mapped to a placeholder', async () => {
    const { batch } = await run([{ ...jobs()[0], company: '' }, jobs()[1]])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['1137550'])
  })

  it('an absent employer key is an invalid item', async () => {
    const { company: _omitted, ...noCompany } = jobs()[0] as Record<string, unknown>
    const { batch } = await run([noCompany])
    expect(batch.counts.invalid).toBe(1)
    expect(batch.counts.normalized).toBe(0)
  })

  it('an unparseable date does not drop the job: it is kept with a DATE_UNCERTAIN note and no publishedAt', async () => {
    const { batch } = await run([{ ...jobs()[0], date: 'last tuesday' }])
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'INVALID',
    })
  })

  it('an empty feed is a valid, empty success', async () => {
    const { batch } = await run([legal()])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })
})

describe('what the feed claims to cover', () => {
  it('a clean single-request run is WINDOW coverage - never FULL_INVENTORY (the API serves only the latest jobs)', async () => {
    const { batch } = await run(feed())
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope).toMatchObject({
      namespace: 'remoteok',
      query: 'latest-feed',
      configVersion: 1,
    })
  })
})

describe('request and failure reporting', () => {
  it('makes exactly one GET to https://remoteok.com/api and reports it', async () => {
    const { batch, f } = await run(feed())
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe('https://remoteok.com/api')
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({
      attempt: 1,
      page: 1,
      url: 'https://remoteok.com/api',
      status: 200,
      error: null,
    })
  })

  it('stops after one request even though the payload is valid (single page)', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: sourceFixtureText('remoteok', 'feed') }, { bodyText: '[]' }],
    })
    await remoteokProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
  })

  it.each([
    [429, 'RATE_LIMIT'],
    [403, 'ACCESS_POLICY'],
    [500, 'UPSTREAM'],
  ])('HTTP %i fails the run as %s and claims nothing', async (status, code) => {
    const { batch } = await run('[]', { status })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.requests[0]).toMatchObject({ status, error: { code } })
  })

  it('a network failure is a failed run with no status', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ throws: new Error('ECONNRESET') }] })
    const batch = await remoteokProvider.collectReport(cfg(), f.ctx)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.status).toBeNull()
  })

  it('an HTML block page is PARSE_DRIFT', async () => {
    const { batch } = await run('<html>blocked</html>')
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a JSON object instead of the array is PARSE_DRIFT', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['an unknown key', { categoryy: 'x' }],
    ['a namespace other than remoteok (one global board)', { namespace: 'eu' }],
    ['an empty namespace', { namespace: '' }],
    ['a search query (the API has none)', { query: 'rust' }],
    ['a window (the API has none)', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_label, extra) => {
    expect(() => remoteokProvider.parseConfig({ configVersion: 1, ...extra })).toThrow()
  })

  it('accepts configVersion at the column limit', () => {
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('collectReport refuses a hand-built config without touching the network', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '[]' }] })
    await expect(
      remoteokProvider.collectReport(
        { namespace: 'remoteok', configVersion: 1 } as unknown as ReturnType<typeof cfg>,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })
})

describe('refusal reasons are the intended ones', () => {
  const reason = (extra: Record<string, unknown>) => {
    try {
      remoteokProvider.parseConfig({ configVersion: 1, ...extra })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return ''
  }
  it('a search query is refused for having no search parameter', () => {
    expect(reason({ query: 'rust' })).toContain('RemoteOK has no search parameter')
  })
  it('a window is refused for having no date window', () => {
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'RemoteOK has no date window',
    )
  })
})

describe('feed-shape guards (a bad element is one invalid item, never a failed page)', () => {
  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'x'],
    ['a boolean', true],
    ['an array', [1]],
  ])('%s among the jobs: the other 6 survive and it counts as 1 invalid', async (_l, junk) => {
    const { batch } = await run([legal(), junk, ...jobs()])
    expect(batch.counts).toEqual({
      raw: 7,
      normalized: 6,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('an object whose legal field is not a string is not the legal notice', async () => {
    const { batch } = await run([{ legal: 5 }, ...jobs()])
    expect(batch.counts.invalid).toBe(1)
  })
})

describe('identity and link fields', () => {
  it('an empty id is an invalid item, not an id-less observation', async () => {
    const { batch } = await run([{ ...jobs()[0], id: '' }])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })
  it('a missing id is an invalid item', async () => {
    const { id: _id, ...noId } = jobs()[0] as Record<string, unknown>
    expect((await run([noId])).batch.counts.invalid).toBe(1)
  })
  it('an id of 100 chars is valid, 101 is invalid', async () => {
    expect((await run([{ ...jobs()[0], id: 'i'.repeat(100) }])).batch.counts.invalid).toBe(0)
    expect((await run([{ ...jobs()[0], id: 'i'.repeat(101) }])).batch.counts.invalid).toBe(1)
  })
  it('url is the posting URL and apply_url is the application URL when they differ', async () => {
    const j = { ...jobs()[0], apply_url: 'https://employer.example/apply?job=7' }
    const { batch } = await run([j])
    expect(batch.observations[0]?.sourcePostingUrl).toBe(
      'https://remoteok.com/remote-jobs/remote-senior-devops-engineer-lemon-io-1137557',
    )
    expect(batch.observations[0]?.applicationUrl).toBe('https://employer.example/apply?job=7')
  })
  it('an absent apply_url leaves no application URL', async () => {
    const { apply_url: _a, ...rest } = jobs()[0] as Record<string, unknown>
    expect((await run([rest])).batch.observations[0]?.applicationUrl).toBeNull()
  })
})

describe('optional-field defaults', () => {
  it('a job with no date: no dates, no publishedAt and no date evidence', async () => {
    const { date: _d, ...noDate } = jobs()[0] as Record<string, unknown>
    for (const j of [noDate, { ...noDate, date: null }]) {
      const o = (await run([j])).batch.observations[0]
      expect(o?.normalized.dates).toEqual([])
      expect(o?.normalized.publishedAt).toBeNull()
      expect(o?.evidence).toEqual([])
    }
  })
  it('a job with no tags, location or description: empty tags, null location, empty description', async () => {
    const {
      tags: _t,
      location: _l,
      description: _d,
      ...bare
    } = jobs()[0] as Record<string, unknown>
    for (const j of [bare, { ...bare, tags: null, location: null, description: null }]) {
      const o = (await run([j])).batch.observations[0]
      expect(o?.normalized.tags).toEqual([])
      expect(o?.normalized.location).toBeNull()
      expect(o?.normalized.descriptionMd).toBe('')
    }
  })
})
