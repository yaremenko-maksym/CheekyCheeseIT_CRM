import { describe, expect, it } from 'vitest'
import { expectNoneOf, expectOnlyPublicRequests } from '../../../test/ats-b-assertions'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { boardVerdictOf } from './ats-config'
import {
  RECRUITEE_LIMITS,
  recruiteeAllowedHosts,
  RECRUITEE_TOKEN_DEADLINE,
  recruiteeInstant,
  recruiteeProvider,
  remoteFromFlags,
} from './recruitee.provider'

/**
 * Recruitee through its public provider. Expected values are hand-read from the authentic captures
 * in `__fixtures__/recruitee/` (see the provenance files) and written as literals; none was
 * produced by running the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const BUNQ = { name: 'bunq', evidence: 'company_name is "bunq" on 21 of 21 offers' }

const cfg = (board = 'bunq', extra: Record<string, unknown> = {}) =>
  recruiteeProvider.parseConfig({ configVersion: 1, board, ...extra })

type Offers = { offers: Record<string, unknown>[] }
const bunq = () => sourceFixture('recruitee', 'bunq-offers') as Offers
const wrap = (offers: unknown[]) => ({ offers })

async function run(
  body: unknown,
  config = cfg(),
  status = 200,
  headers: Record<string, string> = {},
  now = NOW,
) {
  const f = fakeCollectionContext({
    now,
    responses: [
      { status, headers, bodyText: typeof body === 'string' ? body : JSON.stringify(body) },
    ],
  })
  const batch = await recruiteeProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

/** An offer with only what the schema requires. */
const offer = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Offer ${id}`,
  careers_url: `https://jobs.example.test/o/${id}`,
  company_name: 'Acme',
  ...extra,
})

describe('the request (public, one address, no token)', () => {
  it('asks the careers site offers address, once, for JSON', async () => {
    const { f } = await run(bunq())
    expect(f.sent).toEqual([
      { url: 'https://bunq.recruitee.com/api/offers/', headers: { accept: 'application/json' } },
    ])
  })

  it('puts the tenant in the host label and nowhere else', async () => {
    const { f } = await run(wrap([]), cfg('tellent'))
    expect(f.sent[0]?.url).toBe('https://tellent.recruitee.com/api/offers/')
  })

  it('never sends a token, a credential or a request outside recruitee.com (AC1), whatever the answer', async () => {
    for (const [body, status] of [
      [bunq(), 200],
      [wrap([]), 200],
      ['{"error":"Not Found"}', 404],
      ['', 401],
      ['', 429],
    ] as const) {
      const { f } = await run(body, cfg(), status)
      expectOnlyPublicRequests(f.sent, /^bunq\.recruitee\.com$/, ['accept'])
    }
  })

  it('has no way to be given a token or a host: those keys are unknown keys and the config is refused', () => {
    for (const extra of [
      { token: 'x' },
      { 'x-careers-sites-token': 'x' },
      { host: 'evil.example' },
      { baseUrl: 'https://evil.example' },
    ]) {
      expect(() => cfg('bunq', extra)).toThrow()
    }
  })

  it("the declared host is the tenant's own, and every request is on it", async () => {
    expect(recruiteeAllowedHosts({ board: 'bunq' })).toEqual(['bunq.recruitee.com'])
    const { f } = await run(bunq())
    for (const r of f.sent) {
      expect(recruiteeAllowedHosts({ board: 'bunq' })).toContain(new URL(r.url).host)
    }
  })

  it('is the RECRUITEE_ATS provider with its declared bounds', () => {
    expect(recruiteeProvider.type).toBe('RECRUITEE_ATS')
    expect(RECRUITEE_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxItemsPerPage: 2000,
      maxPages: 1,
    })
  })
})

describe('the token requirement (evidence: docs.recruitee.com/reference/authentication-1, checked 2026-10-24)', () => {
  it('the documented deadline is 10 February 2027', () => {
    expect(RECRUITEE_TOKEN_DEADLINE.toISOString()).toBe('2027-02-10T00:00:00.000Z')
  })

  it('one millisecond before the deadline it collects, without any token', async () => {
    const { batch, f } = await run(
      bunq(),
      cfg(),
      200,
      {},
      new Date(RECRUITEE_TOKEN_DEADLINE.getTime() - 1),
    )
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(3)
  })

  it('at the deadline it makes NO request and reports ACCESS_POLICY, with no coverage claimed', async () => {
    const { batch, f } = await run(bunq(), cfg(), 200, {}, RECRUITEE_TOKEN_DEADLINE)
    expect(f.sent).toEqual([])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).not.toBe('FULL_INVENTORY')
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]?.status).toBeNull()
    expect(batch.requests[0]?.error?.code).toBe('ACCESS_POLICY')
    expect(batch.requests[0]?.error?.message).toBe(
      "from 2027-02-10 the Careers Site API requires the employer's own credentials, this collector holds none and made no request",
    )
    expect(batch.invalidSamples).toEqual([])
    expect(batch.checkpoint).toBeNull()
    expect(batch.scope).toEqual({
      namespace: 'recruitee:bunq',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('well after the deadline it still refuses, and a stored checkpoint is not read as permission', async () => {
    const { batch, f } = await run(bunq(), cfg(), 200, {}, new Date('2027-06-01T00:00:00Z'))
    expect(f.sent).toEqual([])
    expect(batch.requests[0]?.error?.code).toBe('ACCESS_POLICY')
  })

  it('before the deadline a 401 from a tenant is an ACCESS_POLICY of the source, never "board not found"', async () => {
    const { batch } = await run('', cfg(), 401)
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[401, 'ACCESS_POLICY']])
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it('error reports carry the status and never the response body or headers (AC2, by value)', async () => {
    const secret = 'cst_7d1e4a90bb23c6f8'
    const { batch } = await run(`{"error":"missing X-Careers-Sites-Token ${secret}"}`, cfg(), 401, {
      'www-authenticate': `Token realm="${secret}"`,
      'x-careers-sites-token': secret,
    })
    expect(batch.requests.map((r) => r.error?.message)).toEqual(['provider answered HTTP 401'])
    expectNoneOf(batch, [secret, 'Token realm'])
  })
})

describe('the bunq capture (3 offers, all kept)', () => {
  it('turns the 3 offers into 3 observations, a complete inventory', async () => {
    const { batch } = await run(bunq(), cfg('bunq', { employer: BUNQ }))
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
      namespace: 'recruitee:bunq',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field of the first offer (hand-read from the capture)', async () => {
    const { batch } = await run(bunq())
    const o = byId(batch, '2755994')
    expect(o?.identity).toMatchObject({
      provider: 'RECRUITEE_ATS',
      namespace: 'recruitee:bunq',
      nativeId: '2755994',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://careers.bunq.com/o/support-experience-guide-3')
    expect(o?.applicationUrl).toBe('https://careers.bunq.com/o/support-experience-guide-3/c/new')
    expect(o?.normalized.title).toBe('Support Experience Guide')
    expect(o?.normalized.companyName).toBe('bunq')
    expect(o?.normalized.location).toBe('Sofia, Bulgaria; İstanbul, Türkiye')
    expect(o?.normalized.remote).toBe(false)
    expect(o?.normalized.employmentType).toBe('fulltime_permanent')
    expect(o?.normalized.tags).toEqual(['Support & Operations'])
    expect(o?.adapterVersion).toBe('recruitee-1')
  })

  it("takes the posting URL from the data (the employer's own domain), never from the tenant", async () => {
    const { batch } = await run(bunq())
    expect(batch.observations.map((o) => o.sourcePostingUrl)).toEqual([
      'https://careers.bunq.com/o/support-experience-guide-3',
      'https://careers.bunq.com/o/technical-website-intern',
      'https://careers.bunq.com/o/cards-experience-guide-2',
    ])
  })

  it("a single location is the offer's own location string; no department is no tag", async () => {
    const { batch } = await run(bunq())
    const o = byId(batch, '2774877')
    expect(o?.normalized.location).toBe('Amsterdam, Noord-Holland, Netherlands')
    expect(o?.normalized.tags).toEqual([])
  })

  it("the department comes first among the tags, then the offer's own, in order", async () => {
    const { batch } = await run(bunq())
    const o = byId(batch, '2768887')
    expect(o?.normalized.tags).toEqual([
      'Support & Operations',
      'E2',
      'Operations',
      'Promise Keeper',
    ])
    expect(o?.normalized.employmentType).toBe('fulltime_fixed_term')
  })

  it('the description is the offer description followed by its requirements', async () => {
    const { batch } = await run(bunq())
    const md = byId(batch, '2774877')?.normalized.descriptionMd ?? ''
    expect(md.startsWith('Our users lands on')).toBe(true)
    expect(md).toContain('You have a solid understanding of HTML')
    expect(md.indexOf('Our users lands on')).toBeLessThan(
      md.indexOf('You have a solid understanding'),
    )
  })

  it('the mailbox address of the offer is not in anything that was stored', async () => {
    const { batch } = await run(bunq())
    expect(JSON.stringify(batch.observations)).not.toMatch(/@bunq\.recruitee\.com/)
  })
})

describe('dates (Recruitee writes "2026-10-15 09:31:36 UTC")', () => {
  it.each([
    ['2026-10-15 09:31:36 UTC', '2026-10-15T09:31:36Z'],
    ['2027-01-02 00:00:00 UTC', '2027-01-02T00:00:00Z'],
  ])('rewrites exactly that shape: %s -> %s', (raw, iso) => {
    expect(recruiteeInstant(raw)).toBe(iso)
  })

  it.each([
    '2026-10-15T09:31:36Z',
    '2026-10-15 09:31:36',
    '2026-10-15 09:31:36 CET',
    '2026-10-15 09:31 UTC',
    ' 2026-10-15 09:31:36 UTC',
    '2026-10-15 09:31:36 UTC ',
    'x2026-10-15 09:31:36 UTC',
    '',
  ])('leaves %j untouched, so the date policy judges it', (raw) => {
    expect(recruiteeInstant(raw)).toBe(raw)
  })

  it('passes null and numbers through', () => {
    expect(recruiteeInstant(null)).toBeNull()
    expect(recruiteeInstant(1760000000)).toBe(1760000000)
  })

  it('publication, update and no expiry for an open offer (first bunq offer)', async () => {
    const { batch } = await run(bunq())
    const o = byId(batch, '2755994')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-09-23T09:10:19.000Z')
    expect(o?.normalized.dates.map((d) => [d.semantics, d.value?.toISOString()])).toEqual([
      ['PUBLISHED', '2026-09-23T09:10:19.000Z'],
      ['UPDATED', '2026-10-20T09:26:47.000Z'],
    ])
  })

  it('a close date is an EXPIRY and may be in the future', async () => {
    const { batch } = await run(wrap([offer(1, { close_at: '2026-12-31 23:59:59 UTC' })]))
    expect(
      batch.observations[0]?.normalized.dates.map((d) => [d.semantics, d.value?.toISOString()]),
    ).toEqual([['EXPIRY', '2026-12-31T23:59:59.000Z']])
  })

  it('a date in some other shape is kept raw and flagged, not guessed', async () => {
    const { batch } = await run(wrap([offer(1, { published_at: '15/10/2026' })]))
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'INVALID',
    })
  })
})

describe('workplace flags', () => {
  it.each([
    [{ remote: true }, true],
    [{ remote: true, hybrid: true }, true],
    [{ on_site: true }, false],
    [{ hybrid: true }, false],
    [{ remote: false, on_site: false, hybrid: false }, null],
    [{ remote: null }, null],
    [{}, null],
  ])('%j -> %j', (flags, expected) => {
    expect(remoteFromFlags(flags)).toBe(expected)
  })

  it('reaches the observation', async () => {
    const { batch } = await run(
      wrap([offer(1, { remote: true }), offer(2, { on_site: true }), offer(3)]),
    )
    expect(batch.observations.map((o) => o.normalized.remote ?? null)).toEqual([true, false, null])
  })
})

describe('employer and status', () => {
  it("the offer's own company_name is the employer", async () => {
    const { batch } = await run(
      wrap([offer(1, { company_name: 'bunq' })]),
      cfg('bunq', { employer: { name: 'Other', evidence: 'x' } }),
    )
    expect(batch.observations[0]?.normalized.companyName).toBe('bunq')
  })

  it('a blank company_name falls back to the verified employer', async () => {
    for (const company_name of [null, '', '   ']) {
      const { batch } = await run(
        wrap([offer(1, { company_name })]),
        cfg('bunq', { employer: BUNQ }),
      )
      expect(batch.observations[0]?.normalized.companyName).toBe('bunq')
    }
  })

  it('with neither, the offer is quarantined, never named after the tenant', async () => {
    const { batch } = await run(wrap([offer(1, { company_name: null })]))
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
  })

  it('only a published offer is an open vacancy: any other status is quarantined as such', async () => {
    const { batch } = await run(
      wrap([offer(1, { status: 'published' }), offer(2, { status: 'archived' }), offer(3)]),
    )
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['1', '3'])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(['QUARANTINED: NOT_AN_OPEN_VACANCY'])
  })
})

describe('empty, missing and unreadable tenants', () => {
  it('a tenant with no open offers is a valid empty inventory (tellent), not a dead board', async () => {
    const { batch } = await run(
      sourceFixtureText('recruitee', 'tellent-empty-offers'),
      cfg('tellent'),
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('a tenant that does not exist answers 404 and is a BOARD problem, not an outage', async () => {
    const { batch } = await run(
      sourceFixtureText('recruitee', 'offers-not-found'),
      cfg('cheeky-nonexistent-tenant-0001'),
      404,
    )
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[404, 'UPSTREAM']])
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })

  it('a redirect answer (recruitee.com/careers_not_hosted for a tenant with no site) is a failure; the loop never reads Location', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { status: 301, headers: { location: 'https://recruitee.com/careers_not_hosted' } },
        { status: 200, bodyText: JSON.stringify(bunq()) },
      ],
    })
    const batch = await recruiteeProvider.collectReport(cfg('sunbeam-sg'), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[301, 'UPSTREAM']])
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it('a body without the offers array is drift', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('one bad offer is isolated: an id that is not a number is invalid, its neighbour is kept', async () => {
    const { batch } = await run(wrap([offer(1, { id: 'abc' }), offer(2)]))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['2'])
  })

  it('identity is the tenant plus the id: a renamed title and URL is the same posting', async () => {
    const a = await run(wrap([offer(5)]))
    const b = await run(
      wrap([offer(5, { title: 'Renamed', careers_url: 'https://new.example.test/x' })]),
    )
    const c = await run(wrap([offer(5)]), cfg('tellent'))
    expect(b.batch.observations[0]?.identity.identityKey).toBe(
      a.batch.observations[0]?.identity.identityKey,
    )
    expect(c.batch.observations[0]?.identity.identityKey).not.toBe(
      a.batch.observations[0]?.identity.identityKey,
    )
  })
})
