import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { ASHBY_LIMITS, ashbyProvider, remoteFromAshbyWorkplace } from './ashby.provider'
import { boardVerdictOf } from './ats-config'

/**
 * Ashby through its public provider. Expected values are hand-read from the authentic captures in
 * `__fixtures__/ashby/` (see the provenance files) and written as literals; none was produced by
 * running the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const LINEAR = { name: 'Linear', evidence: 'descriptionPlain names Linear in 34 of 34 jobs' }
const SUPABASE = { name: 'Supabase', evidence: 'descriptionPlain names Supabase in 59 of 59 jobs' }

const cfg = (board = 'linear', extra: Record<string, unknown> = {}) =>
  ashbyProvider.parseConfig({ configVersion: 1, board, ...extra })
const linearCfg = () => cfg('linear', { employer: LINEAR })
const supabaseCfg = () => cfg('supabase', { employer: SUPABASE })

type Envelope = { jobs: Record<string, unknown>[]; apiVersion: string }
const board = (name: string) => sourceFixture('ashby', name) as Envelope
const linear = () => board('linear-board')
const supabase = () => board('supabase-board')
const withJobs = (jobs: unknown[]) => ({ jobs, apiVersion: '1' })

async function run(body: unknown, config = linearCfg(), status = 200) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }],
  })
  const batch = await ashbyProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

/** The smallest job the schema accepts. */
const job = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Job ${n}`,
  jobUrl: `https://jobs.ashbyhq.com/linear/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ...extra,
})

describe('the request', () => {
  it('asks the documented endpoint with includeCompensation=true, once, for JSON', async () => {
    const { f } = await run(linear())
    expect(f.sent).toEqual([
      {
        url: 'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true',
        headers: { accept: 'application/json' },
      },
    ])
  })

  it('puts the configured board name in the path and nowhere else', async () => {
    const { f } = await run(supabase(), supabaseCfg())
    expect(f.sent[0]?.url).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/supabase?includeCompensation=true',
    )
  })

  it('is the ASHBY_ATS provider', () => {
    expect(ashbyProvider.type).toBe('ASHBY_ATS')
  })
})

describe('the Linear capture', () => {
  it('turns the 4 jobs into 4 observations, a complete inventory', async () => {
    const { batch } = await run(linear())
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 4,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.scope).toEqual({
      namespace: 'ashby:linear',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field of the first job (hand-read from the capture)', async () => {
    const { batch } = await run(linear())
    const o = byId(batch, 'c97e034e-19a8-4ec7-89a5-c81987451da8')
    expect(o?.identity).toMatchObject({
      provider: 'ASHBY_ATS',
      namespace: 'ashby:linear',
      nativeId: 'c97e034e-19a8-4ec7-89a5-c81987451da8',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://jobs.ashbyhq.com/linear/c97e034e-19a8-4ec7-89a5-c81987451da8',
    )
    expect(o?.applicationUrl).toBe(
      'https://jobs.ashbyhq.com/linear/c97e034e-19a8-4ec7-89a5-c81987451da8/application',
    )
    expect(o?.normalized.title).toBe('Creative Producer')
    expect(o?.normalized.companyName).toBe('Linear')
    expect(o?.normalized.location).toBe('Europe')
    expect(o?.normalized.employmentType).toBe('FullTime')
    expect(o?.normalized.tags).toEqual(['GTM', 'Creative Studio'])
    expect(o?.normalized.remote).toBe(true)
    expect(o?.adapterVersion).toBe('ashby-1')
  })

  it('publishedAt is the PUBLISHED date: 2026-10-21T23:21:02.828+00:00', async () => {
    const { batch } = await run(linear())
    const o = byId(batch, 'c97e034e-19a8-4ec7-89a5-c81987451da8')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-21T23:21:02.828Z')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-10-21T23:21:02.828+00:00',
        status: 'OK',
        value: new Date('2026-10-21T23:21:02.828Z'),
      },
    ])
  })

  it('a date with no zone is kept raw and flagged, not guessed', async () => {
    const { batch } = await run(withJobs([job(1, { publishedAt: '2026-10-21T23:21:02' })]))
    expect(batch.observations[0]?.normalized.publishedAt).toBeNull()
    expect(batch.observations[0]?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'MISSING_ZONE',
    })
  })

  it('a job with no publishedAt has no dates', async () => {
    const { batch } = await run(withJobs([job(1)]))
    expect(batch.observations[0]?.normalized.dates).toEqual([])
  })

  it('the real description arrives as readable text', async () => {
    const { batch } = await run(linear())
    const md = byId(batch, 'c97e034e-19a8-4ec7-89a5-c81987451da8')?.normalized.descriptionMd ?? ''
    expect(md.startsWith("At Linear, we're building the product development system")).toBe(true)
    expect(md).not.toContain('<p')
  })

  it('trims the trailing space in a real title', async () => {
    const { batch } = await run(linear())
    expect(byId(batch, 'cb8e77a6-4316-45c6-ac8d-7ade980cd65e')?.normalized.title).toBe(
      'Account Executive, Growth',
    )
  })
})

describe('locations', () => {
  it('a primary and a secondary location are joined, primary first', async () => {
    const { batch } = await run(linear())
    expect(byId(batch, 'f16dd5e9-ed10-4b8e-b5d7-1b8b5e3f002f')?.normalized.location).toBe(
      'North America; Europe',
    )
    expect(byId(batch, 'aa0673c5-9e06-42f8-a720-6c2e43930c5a')?.normalized.location).toBe(
      'Australia; Singapore',
    )
  })

  it('three locations (one primary, two secondary) are all kept', async () => {
    const { batch } = await run(supabase(), supabaseCfg())
    expect(byId(batch, 'cb04ae3a-3a47-4e21-928f-c2456b7b214e')?.normalized.location).toBe(
      'Remote, Bay Area, CA; Remote, San Francisco, CA; Remote, AMER',
    )
  })

  it('a secondary location equal to the primary is not repeated', async () => {
    const { batch } = await run(
      withJobs([
        job(1, {
          location: 'Paris',
          secondaryLocations: [{ location: 'Paris' }, { location: 'Lyon' }],
        }),
      ]),
    )
    expect(batch.observations[0]?.normalized.location).toBe('Paris; Lyon')
  })

  it('no primary location but a secondary one still has a location; neither is no location', async () => {
    const a = await run(withJobs([job(1, { secondaryLocations: [{ location: 'Oslo' }] })]))
    expect(a.batch.observations[0]?.normalized.location).toBe('Oslo')
    const b = await run(withJobs([job(2, { location: null, secondaryLocations: null })]))
    expect(b.batch.observations[0]?.normalized.location ?? null).toBeNull()
  })

  it('a primary location alone is that location exactly, whether secondaryLocations is null, absent or empty', async () => {
    for (const secondaryLocations of [null, undefined, []]) {
      const { batch } = await run(withJobs([job(1, { location: 'Paris', secondaryLocations })]))
      expect(batch.observations[0]?.normalized.location).toBe('Paris')
    }
  })

  it('department and team are the tags, whichever of them exists', async () => {
    const both = await run(withJobs([job(1, { department: 'GTM', team: 'Sales' })]))
    expect(both.batch.observations[0]?.normalized.tags).toEqual(['GTM', 'Sales'])
    const dept = await run(withJobs([job(2, { department: 'GTM' })]))
    expect(dept.batch.observations[0]?.normalized.tags).toEqual(['GTM'])
    const team = await run(withJobs([job(3, { team: 'Sales' })]))
    expect(team.batch.observations[0]?.normalized.tags).toEqual(['Sales'])
    const none = await run(withJobs([job(4)]))
    expect(none.batch.observations[0]?.normalized.tags).toEqual([])
  })

  it('a secondary entry with no location text is skipped', async () => {
    const { batch } = await run(
      withJobs([job(1, { location: 'Rome', secondaryLocations: [{ location: null }, {}] })]),
    )
    expect(batch.observations[0]?.normalized.location).toBe('Rome')
  })
})

describe('workplaceType: documented values only', () => {
  it.each([
    ['Remote', true],
    ['OnSite', false],
    ['Hybrid', false],
  ])('%s maps to remote=%s', (value, expected) => {
    expect(remoteFromAshbyWorkplace(value)).toBe(expected)
  })

  it.each([null, '', 'remote', 'onsite', 'On-site', 'Flexible'])(
    '%j is unknown, not guessed',
    (value) => {
      expect(remoteFromAshbyWorkplace(value)).toBeNull()
    },
  )

  it("Hybrid is NOT remote even though Ashby's own isRemote flag says true for it (documented)", async () => {
    const { batch } = await run(linear())
    expect(byId(batch, 'cb8e77a6-4316-45c6-ac8d-7ade980cd65e')?.normalized.remote).toBe(false)
  })

  it('a null workplaceType (real, Supabase) is unknown even when isRemote is null too', async () => {
    const { batch } = await run(supabase(), supabaseCfg())
    expect(
      byId(batch, 'a069c886-1107-408e-88b4-e1aa8d33d4bc')?.normalized.remote ?? null,
    ).toBeNull()
    expect(byId(batch, 'e4e3ccb7-7b7d-42a2-be0f-26cbb5ae4abd')?.normalized.remote).toBe(true)
  })

  it('isRemote alone does not make a job remote', async () => {
    const { batch } = await run(withJobs([job(1, { isRemote: true })]))
    expect(batch.observations[0]?.normalized.remote ?? null).toBeNull()
  })

  it('the leading space of a real title is trimmed too', async () => {
    const { batch } = await run(supabase(), supabaseCfg())
    expect(byId(batch, 'a069c886-1107-408e-88b4-e1aa8d33d4bc')?.normalized.title).toBe(
      'Account Executive (EMEA)',
    )
  })
})

describe('compensation is never invented', () => {
  const id = '68a397e7-8a1a-4566-ae41-e8c61dd6ed93'
  const stripCompensation = (j: Record<string, unknown>) => {
    const { compensation: _c, shouldDisplayCompensationOnJobPostings: _s, ...rest } = j
    return rest
  }

  it('a job that published a tier ("$200K – $270K") maps exactly like the same job without compensation', async () => {
    const real = supabase().jobs.find((j) => j.id === id)
    if (real === undefined) throw new Error('fixture job missing')
    const withComp = await run(withJobs([real]), supabaseCfg())
    const without = await run(withJobs([stripCompensation(real)]), supabaseCfg())
    expect(withComp.batch.observations).toHaveLength(1)
    expect(withComp.batch.observations[0]?.normalized).toEqual(
      without.batch.observations[0]?.normalized,
    )
    expect(withComp.batch.observations[0]?.contentHash).toBe(
      without.batch.observations[0]?.contentHash,
    )
  })

  it('the compensation summary text is not copied into any tag, location or type', async () => {
    const { batch } = await run(supabase(), supabaseCfg())
    const o = byId(batch, id)
    const fields = [o?.normalized.tags, o?.normalized.location, o?.normalized.employmentType]
    expect(JSON.stringify(fields)).not.toContain('200K')
  })

  it('a job with no compensation object at all maps without error', async () => {
    const { batch } = await run(withJobs([job(1)]))
    expect(batch.counts.normalized).toBe(1)
  })
})

describe('unlisted postings (isListed=false): documented, never observed on a real board', () => {
  const real = () => linear().jobs[0] as Record<string, unknown>

  it('are QUARANTINED with the reason NOT_AN_OPEN_VACANCY, while listed neighbours are kept', async () => {
    const { batch } = await run(
      withJobs([
        real(),
        { ...real(), id: 'unlisted-1', isListed: false },
        { ...real(), id: 'listed-2' },
      ]),
    )
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      'c97e034e-19a8-4ec7-89a5-c81987451da8',
      'listed-2',
    ])
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(['QUARANTINED: NOT_AN_OPEN_VACANCY'])
  })

  it('the consequence is recorded, not accidental: the run SUCCEEDED but its coverage is PARTIAL, so a board with one unlisted posting cannot claim FULL_INVENTORY', async () => {
    const clean = await run(withJobs([real()]))
    expect([clean.batch.outcome, clean.batch.coverage]).toEqual(['SUCCEEDED', 'FULL_INVENTORY'])
    const { batch } = await run(
      withJobs([real(), { ...real(), id: 'unlisted-1', isListed: false }]),
    )
    expect([batch.outcome, batch.coverage]).toEqual(['SUCCEEDED', 'PARTIAL'])
  })

  it('an unlisted posting with no employer is still named for what it is, not for the gap', async () => {
    const { batch } = await run(withJobs([{ ...real(), isListed: false }]), cfg('linear'))
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(['QUARANTINED: NOT_AN_OPEN_VACANCY'])
  })

  it.each([true, null, undefined])('isListed=%s is an open vacancy', async (isListed) => {
    const { batch } = await run(withJobs([{ ...real(), isListed }]))
    expect(batch.counts.normalized).toBe(1)
  })

  it('every posting in the committed captures is listed (the provenance records 1,612 read, none unlisted)', () => {
    const all = [...linear().jobs, ...supabase().jobs]
    expect(all.every((j) => j.isListed === true)).toBe(true)
  })
})

describe('unknown employer', () => {
  it('without verified employer evidence every job is QUARANTINED: the slug is not a company name', async () => {
    const { batch } = await run(linear(), cfg('linear'))
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 0,
      invalid: 0,
      quarantined: 4,
      discarded: 0,
    })
    expect(batch.observations).toEqual([])
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(
      Array(4).fill('QUARANTINED: MISSING_COMPANY'),
    )
  })

  it('with evidence the job carries the verified employer name', async () => {
    const { batch } = await run(supabase(), supabaseCfg())
    expect(new Set(batch.observations.map((o) => o.normalized.companyName))).toEqual(
      new Set(['Supabase']),
    )
  })
})

describe('empty and dead boards', () => {
  it('the real empty board (jobs: []) is a valid, complete, empty success', async () => {
    const { batch } = await run(sourceFixtureText('ashby', 'deel-empty-board'), cfg('deel'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts.raw).toBe(0)
  })

  it('the real 404 body (plain text "Not Found") is a BOARD error, not a parse failure', async () => {
    const body = readFileSync(
      join(__dirname, '__fixtures__', 'ashby', 'board-not-found.txt'),
      'utf8',
    )
    expect(body).toBe('Not Found')
    const { batch } = await run(body, cfg('nope'), 404)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[404, 'UPSTREAM']])
    expect(batch.counts.raw).toBe(0)
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })

  it('a rate limit is not a dead board', async () => {
    const { batch } = await run('{}', cfg('x'), 429)
    expect(batch.requests[0]?.error?.code).toBe('RATE_LIMIT')
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it('a 200 whose body has no jobs array is PARSE_DRIFT, a source problem', async () => {
    const { batch } = await run({ apiVersion: '1' })
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it('a 200 whose body is plain text is PARSE_DRIFT', async () => {
    const { batch } = await run('Not Found')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('item isolation and bounds', () => {
  it('one malformed job is isolated with a sample; its neighbours are kept', async () => {
    const { batch } = await run(withJobs([job(1), { id: 5, title: 'x' }, job(3)]))
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
    ['a missing id', { ...job(1), id: undefined }],
    ['a numeric id', job(1, { id: 7 })],
    ['a missing title', { ...job(1), title: undefined }],
    ['a missing jobUrl', { ...job(1), jobUrl: undefined }],
  ])('refuses %s as an invalid item', async (_why, bad) => {
    const { batch } = await run(withJobs([bad]))
    expect(batch.counts.invalid).toBe(1)
  })

  it.each([
    ['title', ORIGINAL_LIMITS.title],
    ['id', 200],
    ['department', 200],
    ['team', 200],
    ['employmentType', 100],
    ['workplaceType', 50],
    ['location', ORIGINAL_LIMITS.location],
  ])('%s: exactly at its bound is accepted, one past is an invalid item', async (key, max) => {
    const at = await run(withJobs([job(1, { [key]: 'x'.repeat(max) })]))
    expect(at.batch.counts.invalid).toBe(0)
    const past = await run(withJobs([job(1, { [key]: 'x'.repeat(max + 1) })]))
    expect(past.batch.counts.invalid).toBe(1)
  })

  it('secondaryLocations: 100 are accepted, 101 make the item invalid', async () => {
    const secondary = (n: number) => Array.from({ length: n }, (_, i) => ({ location: `L${i}` }))
    expect(
      (await run(withJobs([job(1, { secondaryLocations: secondary(100) })]))).batch.counts.invalid,
    ).toBe(0)
    expect(
      (await run(withJobs([job(1, { secondaryLocations: secondary(101) })]))).batch.counts.invalid,
    ).toBe(1)
  })

  it('descriptionHtml: exactly at the retention bound is accepted, one past is an invalid item', async () => {
    const at = await run(
      withJobs([job(1, { descriptionHtml: 'x'.repeat(ORIGINAL_LIMITS.description) })]),
    )
    expect(at.batch.counts.invalid).toBe(0)
    const past = await run(
      withJobs([job(1, { descriptionHtml: 'x'.repeat(ORIGINAL_LIMITS.description + 1) })]),
    )
    expect(past.batch.counts.invalid).toBe(1)
  })

  it('an unsafe job URL is quarantined by the observation builder', async () => {
    const { batch } = await run(withJobs([job(1, { jobUrl: 'https://u:p@evil.example/x' })]))
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 0, quarantined: 1 })
  })

  it('an unsafe apply URL is dropped with evidence while the job is kept', async () => {
    const { batch } = await run(withJobs([job(1, { applyUrl: 'javascript:alert(1)' })]))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.applicationUrl).toBeNull()
  })
})

describe('size bounds: measured, not assumed', () => {
  const padded = (bytes: number) => {
    const shell = '{"jobs":[],"pad":""}'
    return `{"jobs":[],"pad":"${'x'.repeat(bytes - shell.length)}"}`
  }

  it('the response cap is 10 MiB and the item cap 2,000, from four measured boards', () => {
    expect(ASHBY_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxItemsPerPage: 2_000,
      maxPages: 1,
    })
  })

  it("a 3 MiB body, which the 2 MiB default would refuse, is read (Ramp's real board is 3.0 MB)", async () => {
    expect((await run(padded(3 * 1024 * 1024))).batch.outcome).toBe('SUCCEEDED')
  })

  it("exactly 10 MiB is read; one byte more is PAYLOAD_TOO_LARGE for this board (OpenAI's real board is 13.9 MB)", async () => {
    expect((await run(padded(10 * 1024 * 1024))).batch.outcome).toBe('SUCCEEDED')
    const past = await run(padded(10 * 1024 * 1024 + 1))
    expect(past.batch.outcome).toBe('FAILED')
    expect(past.batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(boardVerdictOf(past.batch)).toBe('SOURCE_FAILED')
  })

  it('2,000 jobs are read in the single request; 2,001 are PAYLOAD_TOO_LARGE', async () => {
    const many = (n: number) => withJobs(Array.from({ length: n }, (_, i) => job(i + 1)))
    const at = await run(many(2_000))
    expect(at.batch.counts.normalized).toBe(2_000)
    expect(at.f.sent).toHaveLength(1)
    expect((await run(many(2_001))).batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('conditional requests: a big board is not downloaded twice', () => {
  it('stores the ETag under the board slot, and a 304 replays the stored body with the validator sent', async () => {
    const first = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(linear()), etag: 'W/"abc"' }],
    })
    await ashbyProvider.collectReport(linearCfg(), first.ctx)
    expect([...first.cache.keys()].map((k) => (JSON.parse(k) as string[])[0])).toEqual(['board'])

    const second = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: Object.fromEntries(first.cache),
    })
    const batch = await ashbyProvider.collectReport(linearCfg(), second.ctx)
    expect(second.sent[0]?.headers).toEqual({
      accept: 'application/json',
      'if-none-match': 'W/"abc"',
    })
    expect(batch.counts.raw).toBe(4)
  })
})
