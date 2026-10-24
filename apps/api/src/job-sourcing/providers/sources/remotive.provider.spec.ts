import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { remotiveProvider, REMOTIVE_SOURCE_STATUS } from './remotive.provider'

/**
 * Remotive through its public provider. Expected values are hand-read from
 * `__fixtures__/remotive/software-dev.json` (authentic capture; see the provenance file) and
 * written as literals - never produced by running the mapper.
 */

const NOW = new Date('2026-10-23T20:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  remotiveProvider.parseConfig({ configVersion: 1, category: 'software-dev', ...extra })

type Envelope = { jobs: Record<string, unknown>[] } & Record<string, unknown>
const envelope = () => sourceFixture('remotive', 'software-dev') as Envelope
const jobs = () => envelope().jobs
const withJobs = (j: unknown[]) => ({ ...envelope(), jobs: j })

async function run(body: unknown, config = cfg(), status = 200) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }],
  })
  const batch = await remotiveProvider.collectReport(config, f.ctx)
  return { batch, f }
}

type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

describe('mapping the authentic capture', () => {
  it('turns the 6 jobs into 6 observations', async () => {
    const { batch } = await run(envelope())
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run(envelope())
    const o = byId(batch, '2091158')
    expect(o?.identity).toMatchObject({
      provider: 'REMOTIVE_API',
      namespace: 'remotive',
      nativeId: '2091158',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://remotive.com/remote-jobs/software-development/software-engineer-ai-coding-tasks-2091158',
    )
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('Software Engineer, AI Coding Tasks')
    expect(o?.normalized.companyName).toBe('Askable')
    expect(o?.normalized.employmentType).toBe('contract')
    expect(o?.normalized.tags?.slice(0, 4)).toEqual(['C++', 'docker', 'git', 'go'])
    expect(o?.normalized.tags).toContain('Typescript')
    expect(o?.adapterVersion).toBe('remotive-1')
  })

  it('trims the trailing space the provider sends in a company name', async () => {
    const { batch } = await run(envelope())
    expect(byId(batch, '1749306')?.normalized.companyName).toBe('Coalition Technologies')
  })

  it('keeps geography (candidate_required_location) as the location, separate from remote', async () => {
    const { batch } = await run(envelope())
    expect(byId(batch, '2091158')?.normalized.location).toBe('Worldwide')
    expect(byId(batch, '2091133')?.normalized.location).toBe('Europe, USA, Canada, APAC')
    expect(byId(batch, '2091132')?.normalized.location).toBe(
      'Europe, USA, UK, Canada, Australia, Ireland, Switzerland, Singapore, Mexico, Iceland, Norway',
    )
    // A region-restricted job is still remote: the two facts are not one field.
    expect(byId(batch, '2091133')?.normalized.remote).toBe(true)
  })

  it('a missing or empty geography is no location, and the job stays remote', async () => {
    for (const missing of [
      { candidate_required_location: '' },
      { candidate_required_location: null },
    ]) {
      const { batch } = await run(withJobs([{ ...jobs()[0], ...missing }]))
      expect(batch.observations[0]?.normalized.location).toBeNull()
      expect(batch.observations[0]?.normalized.remote).toBe(true)
    }
    const { candidate_required_location: _gone, ...noKey } = jobs()[0] as Record<string, unknown>
    const { batch } = await run(withJobs([noKey]))
    expect(batch.observations[0]?.normalized.location).toBeNull()
  })

  it('does not guess a zone for the zoneless publication_date: raw kept, publishedAt null, uncertainty noted', async () => {
    const { batch } = await run(envelope())
    const o = byId(batch, '2091158')
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-10-17T16:04:29',
        status: 'MISSING_ZONE',
        value: null,
      },
    ])
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'MISSING_ZONE',
    })
  })

  it('a zoned publication_date (should the provider add one) is used', async () => {
    const { batch } = await run(
      withJobs([{ ...jobs()[0], publication_date: '2026-10-17T16:04:29+00:00' }]),
    )
    expect(batch.observations[0]?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-17T16:04:29.000Z',
    )
  })

  it('the same posting seen under two categories has ONE identity (category is not part of it)', async () => {
    const a = await run(envelope(), cfg({ category: 'software-dev' }))
    const b = await run(envelope(), cfg({ category: 'devops' }))
    expect(byId(b.batch, '2091158')?.identity.identityKey).toBe(
      byId(a.batch, '2091158')?.identity.identityKey,
    )
    expect(a.batch.scope.query).toBe('category:software-dev')
    expect(b.batch.scope.query).toBe('category:devops')
  })

  it('identity survives a changed title and url', async () => {
    const a = await run(envelope())
    const { batch } = await run(
      withJobs([
        { ...jobs()[0], title: 'Renamed', url: 'https://remotive.com/remote-jobs/x/new-2091158' },
      ]),
    )
    expect(batch.observations[0]?.identity.identityKey).toBe(
      byId(a.batch, '2091158')?.identity.identityKey,
    )
  })
})

describe('envelope', () => {
  it('ignores the legal-notice and count fields around jobs', async () => {
    const { batch } = await run({ jobs: [jobs()[0]] })
    expect(batch.counts.normalized).toBe(1)
  })

  it('a body without a jobs array is PARSE_DRIFT', async () => {
    const { batch } = await run({ 'job-count': 0 })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('an empty jobs array is a valid, empty success', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
  })
})

describe('item bounds, at the limit and past it', () => {
  const job = (over: Record<string, unknown>) => ({ ...jobs()[0], ...over })
  const invalid = async (over: Record<string, unknown>) =>
    (await run(withJobs([job(over)]))).batch.counts.invalid

  it('title 2000 ok / 2001 invalid', async () => {
    expect(await invalid({ title: 'T'.repeat(2000) })).toBe(0)
    expect(await invalid({ title: 'T'.repeat(2001) })).toBe(1)
  })
  it('company 1000 ok / 1001 invalid', async () => {
    expect(await invalid({ company_name: 'C'.repeat(1000) })).toBe(0)
    expect(await invalid({ company_name: 'C'.repeat(1001) })).toBe(1)
  })
  it('geography 2000 ok / 2001 invalid', async () => {
    expect(await invalid({ candidate_required_location: 'G'.repeat(2000) })).toBe(0)
    expect(await invalid({ candidate_required_location: 'G'.repeat(2001) })).toBe(1)
  })
  it('tags: 200 ok / 201 invalid; a tag of 200 chars ok / 201 invalid', async () => {
    expect(await invalid({ tags: Array.from({ length: 200 }, () => 't') })).toBe(0)
    expect(await invalid({ tags: Array.from({ length: 201 }, () => 't') })).toBe(1)
    expect(await invalid({ tags: ['t'.repeat(200)] })).toBe(0)
    expect(await invalid({ tags: ['t'.repeat(201)] })).toBe(1)
  })
  it('id 1 and MAX_SAFE_INTEGER are valid; 0, a fraction and a string are invalid', async () => {
    expect(await invalid({ id: 1 })).toBe(0)
    expect(await invalid({ id: Number.MAX_SAFE_INTEGER })).toBe(0)
    expect(await invalid({ id: 0 })).toBe(1)
    expect(await invalid({ id: 1.5 })).toBe(1)
    expect(await invalid({ id: '12' })).toBe(1)
  })
  it('job_type 100 ok / 101 invalid', async () => {
    expect(await invalid({ job_type: 'j'.repeat(100) })).toBe(0)
    expect(await invalid({ job_type: 'j'.repeat(101) })).toBe(1)
  })
  it('500 items on the page are accepted, 501 is drift (page fails)', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ id: i + 1 }))
    expect((await run(withJobs(many(500)))).batch.counts.raw).toBe(500)
    const bad = await run(withJobs(many(501)))
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
  })
})

describe('missing data', () => {
  it('an empty employer is quarantined, not given a placeholder', async () => {
    const { batch } = await run(withJobs([{ ...jobs()[0], company_name: '' }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['1185979'])
  })
  it('an absent employer key is an invalid item', async () => {
    const { company_name: _x, ...noCompany } = jobs()[0] as Record<string, unknown>
    expect((await run(withJobs([noCompany]))).batch.counts.invalid).toBe(1)
  })
  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run(withJobs([jobs()[0], { id: 'x' }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })
})

describe('coverage, requests and failures', () => {
  it('a clean run is WINDOW (the category filter was observed not to partition the inventory)', async () => {
    const { batch } = await run(envelope())
    expect(batch.coverage).toBe('WINDOW')
  })

  it('makes exactly one GET with the category in the query, URL-encoded by the builder', async () => {
    const { batch, f } = await run(envelope())
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe('https://remotive.com/api/remote-jobs?category=software-dev')
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({
      page: 1,
      status: 200,
      url: 'https://remotive.com/api/remote-jobs?category=software-dev',
    })
  })

  it('sends the seeded devops and data categories verbatim', async () => {
    expect((await run(envelope(), cfg({ category: 'devops' }))).f.sent[0]?.url).toBe(
      'https://remotive.com/api/remote-jobs?category=devops',
    )
    expect((await run(envelope(), cfg({ category: 'data' }))).f.sent[0]?.url).toBe(
      'https://remotive.com/api/remote-jobs?category=data',
    )
  })

  it.each([
    [429, 'RATE_LIMIT'],
    [403, 'ACCESS_POLICY'],
    [503, 'UPSTREAM'],
  ])('HTTP %i fails the run as %s', async (status, code) => {
    const { batch } = await run('{}', cfg(), status)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.requests[0]).toMatchObject({ status, error: { code } })
  })

  it('a network failure is a failed run', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ throws: new Error('ETIMEDOUT') }] })
    const batch = await remotiveProvider.collectReport(cfg(), f.ctx)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.status).toBeNull()
  })

  it('an HTML block page is PARSE_DRIFT', async () => {
    const { batch } = await run('<html>no</html>')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('config is refused before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['a missing category', { category: undefined }],
    ['an empty category', { category: '' }],
    ['a 51-character category', { category: 'a'.repeat(51) }],
    ['a category with a query separator', { category: 'dev&limit=1' }],
    ['a category with a path escape', { category: '../x' }],
    ['an uppercase category', { category: 'Software-Dev' }],
    ['an unknown key', { limit: 5 }],
    ['a namespace other than remotive', { namespace: 'other' }],
    ['a search query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer column', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s', (_l, extra) => {
    expect(() =>
      remotiveProvider.parseConfig({ configVersion: 1, category: 'software-dev', ...extra }),
    ).toThrow()
  })

  it('accepts a 50-character category and the largest configVersion', () => {
    expect(cfg({ category: 'a'.repeat(50) }).category).toBe('a'.repeat(50))
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    await expect(
      remotiveProvider.collectReport(
        { namespace: 'remotive', configVersion: 1, category: 'devops' } as unknown as ReturnType<
          typeof cfg
        >,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })
})

describe('the owner-accepted risk (decision of 2026-10-24): not blocked, still UNCLEAR', () => {
  it('the provider declares itself not blocked but UNCLEAR, with the robots.txt reason - and the provenance still says UNCLEAR', () => {
    expect(REMOTIVE_SOURCE_STATUS.blocked).toBe(false)
    expect(REMOTIVE_SOURCE_STATUS.permission).toBe('UNCLEAR')
    expect(REMOTIVE_SOURCE_STATUS.reason).toContain('robots.txt Disallow: /api/*')
    expect(REMOTIVE_SOURCE_STATUS.reason).toContain('documented API takes priority')
    expect(REMOTIVE_SOURCE_STATUS.reason).toContain('not a documented permission')
    expect(
      (sourceProvenance('remotive', 'software-dev') as { permission: string }).permission,
    ).toBe(REMOTIVE_SOURCE_STATUS.permission)
  })
  it('the provenance notes carry the unverified byte-cap risk and the robots conflict', () => {
    const notes = (sourceProvenance('remotive', 'software-dev') as { notes: string }).notes
    expect(notes).toContain('2 MiB')
    expect(notes).toContain('Disallow: /api/*')
  })
})

describe('refusal reasons are the intended ones', () => {
  const reason = (extra: Record<string, unknown>) => {
    try {
      remotiveProvider.parseConfig({ configVersion: 1, category: 'software-dev', ...extra })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return ''
  }
  it('query and window are refused with their own wording', () => {
    expect(reason({ query: 'x' })).toContain('the category is the scope')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'Remotive has no date window',
    )
  })
})

describe('identity, links and optional-field defaults', () => {
  const first = () => jobs()[0] as Record<string, unknown>
  it('an empty or absent url is an invalid item or quarantined, never mapped', async () => {
    const { url: _u, ...noUrl } = first()
    expect((await run(withJobs([noUrl]))).batch.counts.invalid).toBe(1)
    const empty = await run(withJobs([{ ...first(), url: '' }]))
    expect(empty.batch.counts.normalized).toBe(0)
  })
  it('an absent id is an invalid item', async () => {
    const { id: _i, ...noId } = first()
    expect((await run(withJobs([noId]))).batch.counts.invalid).toBe(1)
  })
  it('a job with no date: no dates, no publishedAt, no date evidence', async () => {
    const { publication_date: _p, ...noDate } = first()
    for (const j of [noDate, { ...noDate, publication_date: null }]) {
      const o = (await run(withJobs([j]))).batch.observations[0]
      expect(o?.normalized.dates).toEqual([])
      expect(o?.normalized.publishedAt).toBeNull()
      expect(o?.evidence).toEqual([])
    }
  })
  it('a job with no tags, job_type, geography or description gets the empty defaults', async () => {
    const {
      tags: _t,
      job_type: _j,
      candidate_required_location: _c,
      description: _d,
      ...bare
    } = first()
    for (const j of [bare, { ...bare, tags: null, job_type: null, description: null }]) {
      const o = (await run(withJobs([j]))).batch.observations[0]
      expect(o?.normalized.tags).toEqual([])
      expect(o?.normalized.employmentType).toBeNull()
      expect(o?.normalized.location).toBeNull()
      expect(o?.normalized.descriptionMd).toBe('')
    }
  })
})

describe('conditional-request cache', () => {
  const body = () => JSON.stringify(envelope())

  it('stores the validator under the "category" slot', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: body(), etag: '"v1"' }] })
    await remotiveProvider.collectReport(cfg(), f.ctx)
    const keys = [...f.cache.keys()].map((k) => JSON.parse(k) as [string, string])
    expect(keys).toHaveLength(1)
    expect(keys[0]?.[0]).toBe('category')
    expect(f.cache.get(JSON.stringify(keys[0]))?.etag).toBe('"v1"')
  })

  it('a 304 replays the cached body: same observations, no re-download', async () => {
    const first = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: body(), etag: '"v1"' }],
    })
    const a = await remotiveProvider.collectReport(cfg(), first.ctx)
    const second = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304, bodyText: '' }],
      cacheSeed: Object.fromEntries(first.cache),
    })
    const b = await remotiveProvider.collectReport(cfg(), second.ctx)
    expect(second.sent[0]?.headers).toMatchObject({ 'if-none-match': '"v1"' })
    expect(b.observations.map((o) => o.identity.identityKey)).toEqual(
      a.observations.map((o) => o.identity.identityKey),
    )
    expect(b.outcome).toBe('SUCCEEDED')
  })
})
