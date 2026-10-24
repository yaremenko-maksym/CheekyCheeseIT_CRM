import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { boardVerdictOf } from './ats-config'
import { decodeEscapedOnce, GREENHOUSE_LIMITS, greenhouseProvider } from './greenhouse.provider'

/**
 * Greenhouse through its public provider. Expected values are hand-read from the authentic
 * captures in `__fixtures__/greenhouse/` (see the provenance files) and written as literals;
 * none was produced by running the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const AIRBNB = { name: 'Airbnb', evidence: 'company_name is "Airbnb" on 191 of 191 jobs' }

const cfg = (board = 'airbnb', extra: Record<string, unknown> = {}) =>
  greenhouseProvider.parseConfig({ configVersion: 1, board, ...extra })

type Envelope = { jobs: Record<string, unknown>[]; meta: { total: number } }
const board = (name: string) => sourceFixture('greenhouse', name) as Envelope
const airbnb = () => board('airbnb-board')
const stripe = () => board('stripe-board')
const cloudflare = () => board('cloudflare-board')
const withJobs = (jobs: unknown[]) => ({ jobs, meta: { total: jobs.length } })

async function run(body: unknown, config = cfg(), status = 200) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }],
  })
  const batch = await greenhouseProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

/** A job with every field the schema requires and nothing else. */
const job = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Job ${id}`,
  absolute_url: `https://boards.example.test/jobs/${id}?gh_jid=${id}`,
  company_name: 'Acme',
  ...extra,
})

describe('the request', () => {
  it('asks the documented list endpoint with content=true, once, for JSON', async () => {
    const { f } = await run(airbnb())
    expect(f.sent).toEqual([
      {
        url: 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true',
        headers: { accept: 'application/json' },
      },
    ])
  })

  it('puts the configured board token in the path and nowhere else', async () => {
    const { f } = await run(stripe(), cfg('stripe'))
    expect(f.sent[0]?.url).toBe(
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true',
    )
  })

  it('is the GREENHOUSE_ATS provider', () => {
    expect(greenhouseProvider.type).toBe('GREENHOUSE_ATS')
  })
})

describe('the Airbnb capture', () => {
  it('turns the 3 jobs into 3 observations, a complete inventory', async () => {
    const { batch } = await run(airbnb(), cfg('airbnb', { employer: AIRBNB }))
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.scope).toEqual({
      namespace: 'greenhouse:airbnb',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field of the first job (hand-read from the capture)', async () => {
    const { batch } = await run(airbnb())
    const o = byId(batch, '8102684')
    expect(o?.identity).toMatchObject({
      provider: 'GREENHOUSE_ATS',
      namespace: 'greenhouse:airbnb',
      nativeId: '8102684',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://careers.airbnb.com/positions/8102684?gh_jid=8102684')
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('Tech Lead Manager, Oracle ERP')
    expect(o?.normalized.companyName).toBe('Airbnb')
    expect(o?.normalized.location).toBe('Bangalore, India')
    expect(o?.normalized.tags).toEqual(['Software Engineering'])
    expect(o?.adapterVersion).toBe('greenhouse-1')
  })

  it('does not infer remote-ness from a location string', async () => {
    const { batch } = await run(airbnb())
    expect(byId(batch, '8102684')?.normalized.remote ?? null).toBeNull()
  })

  it('trims the trailing space Greenhouse sends in a location name', async () => {
    const { batch } = await run(airbnb())
    expect(byId(batch, '8303135')?.normalized.location).toBe('Paris, France')
  })

  it('keeps the departments of a job as its tags, in order, and skips a nameless one', async () => {
    const { batch } = await run(
      withJobs([job(1, { departments: [{ name: 'Legal' }, { name: null }, { name: 'Ops' }, {}] })]),
    )
    expect(batch.observations[0]?.normalized.tags).toEqual(['Legal', 'Ops'])
  })
})

describe('publication versus update', () => {
  it('first_published is PUBLISHED and updated_at is UPDATED: two dates, two meanings', async () => {
    const { batch } = await run(airbnb())
    const o = byId(batch, '8102684')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-08-03T15:56:35.000Z')
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-08-03T11:56:35-04:00',
        status: 'OK',
        value: new Date('2026-08-03T15:56:35.000Z'),
      },
      {
        semantics: 'UPDATED',
        contract: 'ISO_ZONED',
        raw: '2026-10-22T09:26:06-04:00',
        status: 'OK',
        value: new Date('2026-10-22T13:26:06.000Z'),
      },
    ])
  })

  it('a job edited months after it was published is NOT dated by its edit (Tokyo job: 2026-04-13 vs 2026-09-29)', async () => {
    const { batch } = await run(airbnb())
    const o = byId(batch, '7789554')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-04-13T08:49:05.000Z')
    expect(o?.normalized.dates.map((d) => d.value?.toISOString())).toEqual([
      '2026-04-13T08:49:05.000Z',
      '2026-09-30T00:00:54.000Z',
    ])
  })

  it('a job never edited (first_published equals updated_at) carries both, with their own meanings', async () => {
    const { batch } = await run(airbnb())
    const o = byId(batch, '8303135')
    expect(o?.normalized.dates.map((d) => [d.semantics, d.value?.toISOString()])).toEqual([
      ['PUBLISHED', '2026-10-20T16:01:26.000Z'],
      ['UPDATED', '2026-10-20T16:01:26.000Z'],
    ])
  })

  it('with no first_published there is no publication date, and the update is still recorded', async () => {
    const { first_published: _gone, ...rest } = airbnb().jobs[0] as Record<string, unknown>
    const { batch } = await run(withJobs([rest]))
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.normalized.dates.map((d) => d.semantics)).toEqual(['UPDATED'])
  })

  it('with no updated_at only the publication is recorded', async () => {
    const { updated_at: _gone, ...rest } = airbnb().jobs[0] as Record<string, unknown>
    const { batch } = await run(withJobs([rest]))
    expect(batch.observations[0]?.normalized.dates.map((d) => d.semantics)).toEqual(['PUBLISHED'])
  })

  it('a date with no zone is kept raw and flagged, not guessed', async () => {
    const { batch } = await run(withJobs([job(1, { first_published: '2026-10-20T12:01:26' })]))
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'MISSING_ZONE',
    })
  })
})

describe('native identity: gh_jid in the URL (Stripe hosts its own pages)', () => {
  it('keeps gh_jid on a company-hosted URL, so four Stripe jobs keep four different URLs', async () => {
    const { batch } = await run(stripe(), cfg('stripe'))
    expect(batch.observations.map((o) => o.sourcePostingUrl)).toEqual([
      'https://stripe.com/jobs/search?gh_jid=7984866',
      'https://stripe.com/jobs/search?gh_jid=7994330',
      'https://stripe.com/jobs/search?gh_jid=7557403',
      'https://stripe.com/jobs/search?gh_jid=8260980',
    ])
  })

  it('drops tracking parameters but keeps gh_jid', async () => {
    const { batch } = await run(
      withJobs([
        job(5, { absolute_url: 'https://stripe.com/jobs/search?utm_source=x&gh_jid=5&gh_src=abc' }),
      ]),
    )
    expect(batch.observations[0]?.sourcePostingUrl).toBe('https://stripe.com/jobs/search?gh_jid=5')
  })

  it('identity is the board plus the job id: a changed title and URL is still the same posting', async () => {
    const a = await run(stripe(), cfg('stripe'))
    const renamed = await run(
      withJobs([
        {
          ...stripe().jobs[0],
          title: 'Renamed',
          absolute_url: 'https://stripe.com/careers/new-home?gh_jid=7984866',
        },
      ]),
      cfg('stripe'),
    )
    expect(renamed.batch.observations[0]?.identity.identityKey).toBe(
      byId(a.batch, '7984866')?.identity.identityKey,
    )
  })

  it('the same job id on a different board is a different posting', async () => {
    const a = await run(withJobs([job(9)]), cfg('one'))
    const b = await run(withJobs([job(9)]), cfg('two'))
    expect(a.batch.observations[0]?.identity.identityKey).not.toBe(
      b.batch.observations[0]?.identity.identityKey,
    )
  })

  it('two jobs sharing one URL but with different ids stay two postings', async () => {
    const same = 'https://stripe.com/jobs/search'
    const { batch } = await run(
      withJobs([job(1, { absolute_url: same }), job(2, { absolute_url: same })]),
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(new Set(batch.observations.map((o) => o.identity.identityKey)).size).toBe(2)
  })
})

describe('multiple locations', () => {
  it('keeps a multi-location string whole (Stripe sends them comma-joined in location.name)', async () => {
    const { batch } = await run(stripe(), cfg('stripe'))
    expect(byId(batch, '7994330')?.normalized.location).toBe('US-Chicago, US-New York')
    expect(byId(batch, '8260980')?.normalized.location).toBe('Seattle, New York, San Francisco')
    expect(byId(batch, '7557403')?.normalized.location).toBe('San Francisco, Seattle')
  })

  it('keeps "Hybrid" as the location Cloudflare sent, and does not read it as remote or as a place', async () => {
    const { batch } = await run(cloudflare(), cfg('cloudflare'))
    const o = byId(batch, '8288769')
    expect(o?.normalized.location).toBe('Hybrid')
    expect(o?.normalized.remote ?? null).toBeNull()
  })

  it('a missing or empty location is no location', async () => {
    for (const location of [undefined, null, {}, { name: null }, { name: '' }]) {
      const { batch } = await run(withJobs([job(1, { location })]))
      expect(batch.observations[0]?.normalized.location ?? null).toBeNull()
    }
  })
})

describe('the HTML is decoded once', () => {
  it('decodes the five entities Greenhouse emits', () => {
    expect(decodeEscapedOnce('&lt;p&gt;Fish &amp; chips&lt;/p&gt;')).toBe('<p>Fish & chips</p>')
    expect(decodeEscapedOnce('&quot;a&#39;b&quot;')).toBe('"a\'b"')
  })

  it.each([
    ['&amp;lt;p&amp;gt;', '&lt;p&gt;'],
    ['&amp;amp;', '&amp;'],
    ['&amp;quot;', '&quot;'],
    ['&amp;#39;', '&#39;'],
    ['&amp;nbsp;', '&nbsp;'],
    ['&amp;lt; 60% travel', '&lt; 60% travel'],
  ])('a double-escaped %s comes out single-decoded as %s', (input, expected) => {
    expect(decodeEscapedOnce(input)).toBe(expected)
  })

  it('leaves an entity it does not emit alone', () => {
    expect(decodeEscapedOnce('a&nbsp;b &copy; &#x27;')).toBe('a&nbsp;b &copy; &#x27;')
  })

  it('the Airbnb body arrives as readable text, not as escaped markup', async () => {
    const { batch } = await run(airbnb())
    const md = byId(batch, '8102684')?.normalized.descriptionMd ?? ''
    expect(md.startsWith('Airbnb was born in 2007')).toBe(true)
    for (const leak of ['&lt;', '&gt;', '&quot;', '<div', 'content-intro']) {
      expect(md).not.toContain(leak)
    }
  })

  it('the real double-escaped Cloudflare job keeps the author\'s "&" and "< 60%" as visible text', async () => {
    const { batch } = await run(cloudflare(), cfg('cloudflare'))
    const md = byId(batch, '7421718')?.normalized.descriptionMd ?? ''
    expect(md).toContain('extend reach & drive adoption')
    expect(md).toContain('\\< 60% travel')
    expect(md).not.toContain('&amp;')
  })

  it('markup that was escaped twice stays text: it is shown, never executed or dropped as a tag', async () => {
    const body =
      '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;&lt;p&gt;Real paragraph&lt;/p&gt;'
    const { batch } = await run(withJobs([job(1, { content: body })]))
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    // Visible text with the markdown-significant characters backslash-escaped (the converter's
    // documented escape rule), not a tag the converter would have dropped together with its body.
    expect(md.startsWith('\\<script\\>alert(1)\\</script\\>')).toBe(true)
    expect(md).toContain('Real paragraph')
  })

  it('a job with no content has no description', async () => {
    const { batch } = await run(withJobs([job(1)]))
    expect(batch.observations[0]?.normalized.descriptionMd).toBe('')
  })
})

describe('the employer is evidence, never a guess', () => {
  it('uses the name the payload gives on each job', async () => {
    const { batch } = await run(airbnb())
    expect(batch.observations.map((o) => o.normalized.companyName)).toEqual([
      'Airbnb',
      'Airbnb',
      'Airbnb',
    ])
  })

  it('a job with no employer name and no verified config is QUARANTINED, not named after the slug', async () => {
    const { company_name: _gone, ...rest } = airbnb().jobs[0] as Record<string, unknown>
    const { batch } = await run(withJobs([rest]), cfg('airbnb'))
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations).toEqual([])
    expect(batch.invalidSamples[0]?.reason).toBe('QUARANTINED: MISSING_COMPANY')
  })

  it('falls back to the verified config employer when the payload names none', async () => {
    const { company_name: _gone, ...rest } = airbnb().jobs[0] as Record<string, unknown>
    const { batch } = await run(
      withJobs([rest]),
      cfg('airbnb', { employer: { name: 'Airbnb, Inc.', evidence: 'verified by hand' } }),
    )
    expect(batch.observations[0]?.normalized.companyName).toBe('Airbnb, Inc.')
  })

  it('a blank payload name counts as none', async () => {
    for (const blank of ['', '   ', null]) {
      const { batch } = await run(
        withJobs([job(1, { company_name: blank })]),
        cfg('x', { employer: { name: 'Verified Co', evidence: 'e' } }),
      )
      expect(batch.observations[0]?.normalized.companyName).toBe('Verified Co')
    }
  })

  it('when both exist the payload wins (it is the per-job fact)', async () => {
    const { batch } = await run(
      withJobs([job(1, { company_name: 'Payload Co' })]),
      cfg('x', { employer: { name: 'Config Co', evidence: 'e' } }),
    )
    expect(batch.observations[0]?.normalized.companyName).toBe('Payload Co')
  })
})

describe('an empty and a dead board', () => {
  it('an empty board is a valid, complete, empty success', async () => {
    const { batch } = await run({ jobs: [], meta: { total: 0 } })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts.raw).toBe(0)
    expect(batch.observations).toEqual([])
  })

  it('a token that does not exist (the real 404 body) is a BOARD error: FAILED, status 404, no jobs read', async () => {
    const { batch, f } = await run(
      sourceFixtureText('greenhouse', 'board-not-found'),
      cfg('x'),
      404,
    )
    expect(f.sent).toHaveLength(1)
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
})

describe('envelope and item isolation', () => {
  it('a body without a jobs array is PARSE_DRIFT', async () => {
    const { batch } = await run({ meta: { total: 0 } })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a body that is not JSON is PARSE_DRIFT', async () => {
    const { batch } = await run('<html>maintenance</html>')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('one malformed job is isolated with a sample; its neighbours are kept', async () => {
    const { batch } = await run(withJobs([job(1), { id: 'nope', title: 'x' }, job(3)]))
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.invalidSamples).toHaveLength(1)
    expect(batch.invalidSamples[0]?.reason.startsWith('ITEM_SCHEMA')).toBe(true)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['1', '3'])
  })

  it.each([
    ['a missing id', { ...job(1), id: undefined }],
    ['id 0', job(0)],
    ['a fractional id', job(1.5)],
    ['a string id', job(1, { id: '7' })],
    ['a missing title', { ...job(1), title: undefined }],
    ['a missing url', { ...job(1), absolute_url: undefined }],
  ])('refuses %s as an invalid item', async (_why, bad) => {
    const { batch } = await run(withJobs([bad]))
    expect(batch.counts.invalid).toBe(1)
    expect(batch.counts.normalized).toBe(0)
  })

  it('accepts id 1 (the smallest positive id)', async () => {
    const { batch } = await run(withJobs([job(1)]))
    expect(batch.counts.normalized).toBe(1)
  })

  it.each([
    ['title', 'title', ORIGINAL_LIMITS.title],
    ['company_name', 'company_name', ORIGINAL_LIMITS.companyName],
    ['location.name', 'location', 200],
  ])('%s: exactly at its bound is accepted, one past is an invalid item', async (_n, key, max) => {
    const value = (n: number) => (key === 'location' ? { name: 'x'.repeat(n) } : 'x'.repeat(n))
    const at = await run(withJobs([job(1, { [key]: value(max) })]))
    expect(at.batch.counts.invalid).toBe(0)
    const past = await run(withJobs([job(1, { [key]: value(max + 1) })]))
    expect(past.batch.counts.invalid).toBe(1)
  })

  it('departments: 50 are accepted, 51 make the item invalid; a department name stops at 200', async () => {
    const depts = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `d${i}` }))
    expect((await run(withJobs([job(1, { departments: depts(50) })]))).batch.counts.invalid).toBe(0)
    expect((await run(withJobs([job(1, { departments: depts(51) })]))).batch.counts.invalid).toBe(1)
    const name = (n: number) => [{ name: 'x'.repeat(n) }]
    expect((await run(withJobs([job(1, { departments: name(200) })]))).batch.counts.invalid).toBe(0)
    expect((await run(withJobs([job(1, { departments: name(201) })]))).batch.counts.invalid).toBe(1)
  })

  it('content: exactly at the retention bound is accepted, one past is an invalid item', async () => {
    const at = await run(withJobs([job(1, { content: 'x'.repeat(ORIGINAL_LIMITS.description) })]))
    expect(at.batch.counts.invalid).toBe(0)
    const past = await run(
      withJobs([job(1, { content: 'x'.repeat(ORIGINAL_LIMITS.description + 1) })]),
    )
    expect(past.batch.counts.invalid).toBe(1)
  })

  it('an unsafe link (credentials in the URL) is quarantined by the observation builder, not mapped', async () => {
    const { batch } = await run(
      withJobs([job(1, { absolute_url: 'https://user:pw@evil.example/jobs/1?gh_jid=1' })]),
    )
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 0, quarantined: 1 })
  })
})

describe('size bounds: measured, not assumed', () => {
  const padded = (bytes: number) => {
    const shell = '{"jobs":[],"pad":""}'
    return `{"jobs":[],"pad":"${'x'.repeat(bytes - shell.length)}"}`
  }

  it('the response cap is 10 MiB and the item cap 2,000 (the plan ceiling, from three measured boards)', () => {
    expect(GREENHOUSE_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxItemsPerPage: 2_000,
      maxPages: 1,
    })
  })

  it("a 3 MiB body, which the 2 MiB default would refuse, is read (Airbnb's real board is 2.7 MB)", async () => {
    const { batch } = await run(padded(3 * 1024 * 1024))
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a body of exactly 10 MiB is read; one byte more is PAYLOAD_TOO_LARGE for this board', async () => {
    const at = await run(padded(10 * 1024 * 1024))
    expect(at.batch.outcome).toBe('SUCCEEDED')
    const past = await run(padded(10 * 1024 * 1024 + 1))
    expect(past.batch.outcome).toBe('FAILED')
    expect(past.batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('2,000 jobs are read in the single request; 2,001 are PAYLOAD_TOO_LARGE', async () => {
    const many = (n: number) => withJobs(Array.from({ length: n }, (_, i) => job(i + 1)))
    const at = await run(many(2_000))
    expect(at.batch.counts.normalized).toBe(2_000)
    expect(at.f.sent).toHaveLength(1)
    const past = await run(many(2_001))
    expect(past.batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })
})
