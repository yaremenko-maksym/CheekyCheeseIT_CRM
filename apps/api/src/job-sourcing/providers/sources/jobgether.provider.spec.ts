import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { jobgetherProvider, JOBGETHER_SOURCE_STATUS } from './jobgether.provider'

/**
 * Jobgether through its public provider. Expected values are hand-read from
 * `__fixtures__/jobgether/page-1.json` (authentic capture, the whole 25-job page; see the
 * provenance file) and written as literals - never produced by running the mapper.
 */

const NOW = new Date('2026-10-24T03:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  jobgetherProvider.parseConfig({ configVersion: 1, ...extra })

type Envelope = {
  jobs: Record<string, unknown>[]
  pagination: { page: number; limit: number; hasMore: boolean }
} & Record<string, unknown>
const authentic = () => sourceFixture('jobgether', 'page-1') as Envelope
const jobs = () => authentic().jobs
/** The capture's page 1 says hasMore: true; a single-page test needs the end of a walk. */
const last = (): Envelope => ({
  ...authentic(),
  pagination: { ...authentic().pagination, hasMore: false },
})
const withJobs = (j: unknown[], hasMore = false): Envelope => ({
  ...authentic(),
  jobs: j as Record<string, unknown>[],
  pagination: { ...authentic().pagination, hasMore },
})

async function run(body: unknown, config = cfg(), status = 200) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }],
  })
  const batch = await jobgetherProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

const FIRST = '6adc0a6822c2644c03e6a821'
const CLOUDERA = '6adc0a6822c2644c03e6a819'
const INTERN = '6adc0a6822c2644c03e6a81f'
const FRICE_FREELANCE = '6adc0a6822c2644c03e6a80f'
const IPROSPECT = '6adc0a6822c2644c03e6a7f1'

describe('mapping the authentic capture', () => {
  it('turns the 25 jobs into 25 observations', async () => {
    const { batch } = await run(last())
    expect(batch.counts).toEqual({
      raw: 25,
      normalized: 25,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run(last())
    const o = byId(batch, FIRST)
    expect(o?.identity).toMatchObject({
      provider: 'JOBGETHER_API',
      namespace: 'jobgether',
      nativeId: FIRST,
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://jobgether.com/offer/6adc0a6822c2644c03e6a821-marketing-lead',
    )
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('Marketing Lead')
    expect(o?.normalized.companyName).toBe('Full Scale')
    expect(o?.normalized.location).toBe('Asia, APAC, Philippines')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.employmentType).toBe('Full time')
    expect(o?.normalized.tags).toEqual([])
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-24T01:31:20.956Z')
    expect(o?.adapterVersion).toBe('jobgether-1')
  })

  it('maps contract type, seniority hint and job functions of other jobs (hand-read)', async () => {
    const { batch } = await run(last())
    expect(byId(batch, INTERN)?.normalized.employmentType).toBe('Internships')
    expect(byId(batch, INTERN)?.normalized.tags).toEqual(['Industrial Engineer'])
    expect(byId(batch, FRICE_FREELANCE)?.normalized.employmentType).toBe('Freelance')
    expect(byId(batch, CLOUDERA)?.normalized.tags).toEqual(['Contract Manager'])
    expect(byId(batch, CLOUDERA)?.normalized.location).toBe('United States, Illinois (USA)')
  })

  it('trims the trailing space the provider sends in a company name', async () => {
    const { batch } = await run(last())
    expect(byId(batch, IPROSPECT)?.normalized.companyName).toBe('iProspect')
  })

  it('has no description: the listing carries none and none is invented', async () => {
    const { batch } = await run(last())
    for (const o of batch.observations) expect(o.normalized.descriptionMd).toBe('')
  })

  it('only Full Remote and Remote-first are remote; Hybrid and anything else is unknown, never false', async () => {
    const remote = async (value: unknown) =>
      (await run(withJobs([{ ...jobs()[0], remote: value }]))).batch.observations[0]?.normalized
        .remote
    expect(await remote('Full Remote')).toBe(true)
    expect(await remote('full remote')).toBe(true)
    expect(await remote('Remote-first')).toBe(true)
    expect(await remote('Remote first')).toBe(true)
    expect(await remote('  Full Remote  ')).toBe(true)
    expect(await remote('Not Full Remote')).toBeNull()
    expect(await remote('Full Remote!')).toBeNull()
    expect(await remote('Hybrid')).toBeNull()
    expect(await remote('Full Remote (maybe)')).toBeNull()
    expect(await remote('')).toBeNull()
    expect(await remote(null)).toBeNull()
  })

  it('identity survives a changed title, url and company', async () => {
    const a = await run(last())
    const { batch } = await run(
      withJobs([
        {
          ...jobs()[0],
          title: 'Renamed',
          company: 'Someone Else',
          url: 'https://jobgether.com/offer/6adc0a6822c2644c03e6a821-renamed',
        },
      ]),
    )
    expect(batch.observations[0]?.identity.identityKey).toBe(
      byId(a.batch, FIRST)?.identity.identityKey,
    )
  })
})

describe('pagination: hasMore decides', () => {
  const body = (n: number, hasMore: boolean) =>
    JSON.stringify({
      ...withJobs([{ ...jobs()[0], id: `job-${n}`, url: `https://jobgether.com/offer/job-${n}` }]),
      pagination: { page: n, limit: 25, hasMore },
    })

  it('hasMore true asks for the next page; hasMore false stops', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: body(1, true) },
        { bodyText: body(2, true) },
        { bodyText: body(3, false) },
      ],
    })
    const batch = await jobgetherProvider.collectReport(cfg(), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://jobgether.com/astroapi/ai/jobs.json?sort=date&limit=25&page=1',
      'https://jobgether.com/astroapi/ai/jobs.json?sort=date&limit=25&page=2',
      'https://jobgether.com/astroapi/ai/jobs.json?sort=date&limit=25&page=3',
    ])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['job-1', 'job-2', 'job-3'])
  })

  it('hasMore false on the first page is exactly one request', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: body(1, false) }, { bodyText: body(2, false) }],
    })
    await jobgetherProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
  })

  it('the authentic empty result (jobs [], hasMore false) is a valid, empty success', async () => {
    const { batch, f } = await run(sourceFixture('jobgether', 'no-results'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
    expect(f.sent).toHaveLength(1)
  })

  it('maxPages is a ceiling: with hasMore forever it stops after exactly maxPages requests', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [1, 2, 3, 4].map((n) => ({ bodyText: body(n, true) })),
    })
    const batch = await jobgetherProvider.collectReport(cfg({ maxPages: 2 }), f.ctx)
    expect(f.sent).toHaveLength(2)
    expect(batch.counts.normalized).toBe(2)
  })

  it('page 10 of the capture (the documented last page) still says hasMore: true - the cap ends the walk', async () => {
    const page10 = sourceFixture('jobgether', 'page-10') as Envelope
    expect(page10.pagination).toEqual({ page: 10, limit: 25, hasMore: true })
    const f = fakeCollectionContext({
      now: NOW,
      responses: Array.from({ length: 10 }, (_, i) => ({
        bodyText: JSON.stringify({
          ...withJobs([
            { ...jobs()[0], id: `job-${i}`, url: `https://jobgether.com/offer/job-${i}` },
          ]),
          pagination: { page: i + 1, limit: 25, hasMore: true },
        }),
      })),
    })
    await jobgetherProvider.collectReport(cfg({ maxPages: 10 }), f.ctx)
    expect(f.sent).toHaveLength(10)
    expect(f.sent.at(-1)?.url).toContain('page=10')
  })

  it('makes exactly one request per page and never a detail request', async () => {
    const { f } = await run(last())
    expect(f.sent).toHaveLength(1)
    expect(f.sent.every((r) => new URL(r.url).pathname === '/astroapi/ai/jobs.json')).toBe(true)
  })

  it('a missing pagination object is PARSE_DRIFT', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('the keyword and the request', () => {
  it('sends the keyword first, URL-encoded, with the date sort and the page size', async () => {
    const { f } = await run(last(), cfg({ keyword: 'react developer', pageSize: 10 }))
    expect(f.sent[0]?.url).toBe(
      'https://jobgether.com/astroapi/ai/jobs.json?keyword=react+developer&sort=date&limit=10&page=1',
    )
  })

  it('scope is a WINDOW and names the keyword', async () => {
    const a = await run(last())
    const b = await run(last(), cfg({ keyword: 'cobol' }))
    expect(a.batch.coverage).toBe('WINDOW')
    expect(a.batch.scope.query).toBe('{"sort":"date"}')
    expect(b.batch.scope.query).toBe('{"keyword":"cobol","sort":"date"}')
  })
})

describe('deprecation: ingest before the sunset, refuse from it (CR-M-5)', () => {
  const SUNSET = Date.parse('2026-09-28T00:00:00.000Z')
  const deprecated = () => sourceFixture('jobgether', 'deprecated-path') as Envelope
  /** The authentic body ends the walk (the capture said hasMore: true) so one response is enough. */
  const lastDeprecated = (extra: Record<string, unknown> = {}) => ({
    ...deprecated(),
    pagination: { page: 1, limit: 10, hasMore: false },
    ...extra,
  })
  async function runAt(body: unknown, now: Date) {
    const f = fakeCollectionContext({ now, responses: [{ bodyText: JSON.stringify(body) }] })
    const batch = await jobgetherProvider.collectReport(cfg(), f.ctx)
    return { batch, f }
  }

  it('before the sunset the authentic body is ingested in full, and every job carries the path-deprecated tag', async () => {
    const { batch } = await runAt(lastDeprecated(), new Date(SUNSET - 1))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.normalized.tags)).toEqual([
      ['Managing Director', 'path-deprecated'],
      ['eDiscovery Specialist', 'eDiscovery Manager', 'path-deprecated'],
      ['Cybersecurity Advisor', 'path-deprecated'],
    ])
  })

  it('at the sunset instant the same body is refused as PARSE_DRIFT naming the sunset and the successor', async () => {
    const { batch } = await runAt(lastDeprecated(), new Date(SUNSET))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests[0]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message:
        'envelope: Jobgether reports this path deprecated (sunset 2026-09-28, successor /api/v1/jobs)',
    })
  })

  it('long after the sunset (the capture day) it is refused too', async () => {
    const { batch } = await run(sourceFixture('jobgether', 'deprecated-path'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a retired notice with no successor names none', async () => {
    const { batch } = await runAt(
      { ...last(), deprecation: { deprecated: true, sunset: '2026-09-28' } },
      new Date(SUNSET),
    )
    expect(batch.requests[0]?.error?.message).toBe(
      'envelope: Jobgether reports this path deprecated (sunset 2026-09-28, successor unnamed)',
    )
  })

  it.each([
    ['no sunset', { deprecated: true }],
    ['a sunset that is not a date', { deprecated: true, sunset: 'soon' }],
  ])('a notice with %s is treated as not yet due: ingested and tagged', async (_label, d) => {
    const { batch } = await runAt({ ...last(), deprecation: d }, NOW)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.normalized).toBe(25)
    for (const o of batch.observations) expect(o.normalized.tags).toContain('path-deprecated')
  })

  it('deprecated: false is no signal: no tag, no failure', async () => {
    const { batch } = await runAt(
      { ...last(), deprecation: { deprecated: false, sunset: '2026-09-28' } },
      NOW,
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.flatMap((o) => o.normalized.tags ?? [])).not.toContain(
      'path-deprecated',
    )
  })

  it('a healthy page carries no deprecation tag', async () => {
    const { batch } = await run(last())
    expect(byId(batch, CLOUDERA)?.normalized.tags).toEqual(['Contract Manager'])
  })

  it('a null or primitive job on a deprecated page is an invalid item, never a crash', async () => {
    const { batch } = await runAt(
      { ...lastDeprecated(), jobs: [null, 5, ...deprecated().jobs.slice(0, 1)] },
      new Date(SUNSET - 1),
    )
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 1,
      invalid: 2,
      quarantined: 0,
      discarded: 0,
    })
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
    expect(await invalid({ company: 'C'.repeat(1000) })).toBe(0)
    expect(await invalid({ company: 'C'.repeat(1001) })).toBe(1)
  })
  it('id 100 ok / 101 invalid / empty invalid', async () => {
    expect(await invalid({ id: 'i'.repeat(100) })).toBe(0)
    expect(await invalid({ id: 'i'.repeat(101) })).toBe(1)
    expect(await invalid({ id: '' })).toBe(1)
  })
  it('location 2000 ok / 2001 invalid', async () => {
    expect(await invalid({ location: 'L'.repeat(2000) })).toBe(0)
    expect(await invalid({ location: 'L'.repeat(2001) })).toBe(1)
  })
  it('remote, contractType and experience 100 ok / 101 invalid', async () => {
    for (const key of ['remote', 'contractType', 'experience']) {
      expect(await invalid({ [key]: 'x'.repeat(100) })).toBe(0)
      expect(await invalid({ [key]: 'x'.repeat(101) })).toBe(1)
    }
  })
  it('jobFunctions: 200 ok / 201 invalid; one of 200 characters ok / 201 invalid', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`)
    expect(await invalid({ jobFunctions: many(200) })).toBe(0)
    expect(await invalid({ jobFunctions: many(201) })).toBe(1)
    expect(await invalid({ jobFunctions: ['f'.repeat(200)] })).toBe(0)
    expect(await invalid({ jobFunctions: ['f'.repeat(201)] })).toBe(1)
  })
  it('postedAt: 64 characters ok / 65 invalid', async () => {
    expect(await invalid({ postedAt: '1'.repeat(64) })).toBe(0)
    expect(await invalid({ postedAt: '1'.repeat(65) })).toBe(1)
  })
  it('25 items on a page of 25 are accepted, 26 is drift (the page fails)', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ id: `j-${i}` }))
    expect((await run(withJobs(many(25)))).batch.counts.raw).toBe(25)
    const bad = await run(withJobs(many(26)))
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
  })
  it('the page bound follows the configured size: 10 ok / 11 drift at pageSize 10', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ id: `j-${i}` }))
    expect((await run(withJobs(many(10)), cfg({ pageSize: 10 }))).batch.counts.raw).toBe(10)
    expect((await run(withJobs(many(11)), cfg({ pageSize: 10 }))).batch.outcome).toBe('FAILED')
  })
})

describe('missing data', () => {
  it('an empty employer is quarantined, not given a placeholder', async () => {
    const { batch } = await run(withJobs([{ ...jobs()[0], company: '' }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['6adc0a6822c2644c03e6a823'])
  })
  it('an absent id, url, title or company is an invalid item', async () => {
    for (const key of ['id', 'url', 'title', 'company']) {
      const { [key]: _gone, ...rest } = jobs()[0] as Record<string, unknown>
      expect((await run(withJobs([rest]))).batch.counts.invalid).toBe(1)
    }
  })
  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run(withJobs([jobs()[0], { id: 7 }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })
  it('a job with no location, remote, contract, seniority, functions or date gets the empty defaults', async () => {
    const o = (
      await run(
        withJobs([
          { id: 'x1', title: 'Bare', company: 'Co', url: 'https://jobgether.com/offer/x1' },
        ]),
      )
    ).batch.observations[0]
    expect(o?.normalized.location).toBeNull()
    expect(o?.normalized.remote).toBeNull()
    expect(o?.normalized.employmentType).toBeNull()
    expect(o?.normalized.tags).toEqual([])
    expect(o?.normalized.dates).toEqual([])
    expect(o?.normalized.publishedAt).toBeNull()
  })
})

describe('config errors fail before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['pageSize 26', { pageSize: 26 }],
    ['pageSize 0', { pageSize: 0 }],
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 11', { maxPages: 11 }],
    ['an empty keyword', { keyword: '' }],
    ['a keyword of 201 characters', { keyword: 'k'.repeat(201) }],
    ['a query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['another namespace', { namespace: 'other' }],
    ['an unknown key', { sort: 'relevance' }],
    ['configVersion past the integer ceiling', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s and no request is made', (_l, extra) => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    expect(() => jobgetherProvider.parseConfig({ configVersion: 1, ...extra })).toThrow()
    expect(f.sent).toHaveLength(0)
  })

  it('accepts a page size of 25 and 1, maxPages 1 and 10, a 200-character keyword', () => {
    expect(cfg({ pageSize: 25 }).pageSize).toBe(25)
    expect(cfg({ pageSize: 1 }).pageSize).toBe(1)
    expect(cfg({ maxPages: 1 }).maxPages).toBe(1)
    expect(cfg({ maxPages: 10 }).maxPages).toBe(10)
    expect(cfg({ keyword: 'k'.repeat(200) }).keyword).toBe('k'.repeat(200))
  })

  it('defaults to 25 per page and 5 pages', () => {
    expect(cfg().pageSize).toBe(25)
    expect(cfg().maxPages).toBe(5)
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    await expect(
      jobgetherProvider.collectReport(
        {
          namespace: 'jobgether',
          configVersion: 1,
          pageSize: 25,
          maxPages: 5,
        } as unknown as ReturnType<typeof cfg>,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })

  it('refusal reasons are the intended ones', () => {
    const reason = (extra: Record<string, unknown>) => {
      try {
        jobgetherProvider.parseConfig({ configVersion: 1, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ query: 'x' })).toContain('search text lives in keyword')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'Jobgether has no date window',
    )
  })
})

describe('the owner-accepted risk (decision of 2026-10-24): not blocked, still UNCLEAR', () => {
  it('declares the provider type', () => {
    expect(jobgetherProvider.type).toBe('JOBGETHER_API')
  })

  it('the provider declares itself not blocked but UNCLEAR, as an accepted risk - and the provenance still says UNCLEAR', () => {
    expect(JOBGETHER_SOURCE_STATUS.blocked).toBe(false)
    expect(JOBGETHER_SOURCE_STATUS.permission).toBe('UNCLEAR')
    expect(JOBGETHER_SOURCE_STATUS.reason).toContain('Terms of Use 4.5')
    expect(JOBGETHER_SOURCE_STATUS.reason).toContain('knowingly accepting the risk')
    expect(JOBGETHER_SOURCE_STATUS.reason).toContain('not a documented permission')
    for (const name of ['page-1', 'page-10', 'no-results', 'deprecated-path']) {
      const p = sourceProvenance('jobgether', name) as { permission: string; notes: string }
      expect(p.permission).toBe(JOBGETHER_SOURCE_STATUS.permission)
      expect(p.notes).toContain(
        'refrain from accessing the Platform or extracting its content by automated means (bots, scrapers, crawlers)',
      )
      expect(p.notes).toContain('intended for AI agents/assistants')
    }
  })
})

describe('checkpoint cursors', () => {
  it('saves a literal cursor after each page that has more', async () => {
    const page = (n: number, hasMore: boolean) =>
      JSON.stringify({
        ...withJobs([
          { ...jobs()[0], id: `job-${n}`, url: `https://jobgether.com/offer/job-${n}` },
        ]),
        pagination: { page: n, limit: 25, hasMore },
      })
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: page(1, true) },
        { bodyText: page(2, true) },
        { bodyText: page(3, false) },
      ],
    })
    await jobgetherProvider.collectReport(cfg(), f.ctx)
    expect(f.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'page:2' })
    expect(f.saved[1]?.position).toEqual({ kind: 'CURSOR', page: 2, cursor: 'page:3' })
  })
})
