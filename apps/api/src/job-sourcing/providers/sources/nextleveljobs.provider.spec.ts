import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile, sourceProvenance } from '../../../test/source-fixtures'
import {
  createNextLevelJobsProvider,
  employerAtsUrl,
  identityKeyOf,
  mapPosting,
  NEXTLEVELJOBS_ADAPTER_VERSION,
  NEXTLEVELJOBS_BOUNDS,
  NEXTLEVELJOBS_SITEMAP_URL,
  NEXTLEVELJOBS_SOURCE_STATUS,
  nextLevelJobsAllowedHosts,
  nextLevelJobsProvider,
  parseSitemap,
  type SitemapJob,
  unseenNewestFirst,
} from './nextleveljobs.provider'
import { extractJobPostings } from '../../structuring/json-ld'

/**
 * Next Level Jobs through its public provider. Every expected value is hand-read from the captures
 * in `__fixtures__/nextleveljobs/` (2026-11-20, permitted by the owner's decision of that day; see
 * their provenance files) and written here as a literal, never produced by running the mapper.
 *
 * The sitemap fixture keeps five whole `<url>` elements of the 2 840 captured: two GetYourGuide
 * jobs (the two pages captured), the newest id of another company, the oldest id of the capture,
 * and one with a `<lastmod>` other than the capture day.
 */
const NOW = new Date('2026-11-20T21:30:00Z')
const SITEMAP = sourceFixtureFile('nextleveljobs', 'jobs-sitemap.trimmed.xml')
const SECURITY = sourceFixtureFile('nextleveljobs', 'job-security-engineer.html.txt')
const MANAGER = sourceFixtureFile('nextleveljobs', 'job-engineering-manager.html.txt')

const ID_SECURITY = '6b00b2d9022782031e2a0d81'
const ID_MANAGER = '6b00b2d9022782031e2a0d72'
const ID_OLDMISSION = '6b00b2bf022782031e2a0d70'
const ID_DATADOG = '6685c10fc2a07efe59396198'
const ID_CITI = '6af4b2756ec1b91985bdd40c'
const URL_SECURITY = `https://nextleveljobs.eu/companies/getyourguide/jobs/${ID_SECURITY}`
const URL_MANAGER = `https://nextleveljobs.eu/companies/getyourguide/jobs/${ID_MANAGER}`
const ASHBY_SECURITY =
  'https://jobs.ashbyhq.com/5dcfe507-5c82-4b61-a84e-47020a17f7dc/a6881808-615e-4e66-99a5-b51794b38785'
const ASHBY_MANAGER =
  'https://jobs.ashbyhq.com/5dcfe507-5c82-4b61-a84e-47020a17f7dc/1d19b8bd-48ee-4b0a-b596-ec06fa25b755'

/** The three sitemap jobs whose pages were not captured, as already held. */
const HELD_OTHERS = new Set([ID_OLDMISSION, ID_DATADOG, ID_CITI].map(identityKeyOf))

const cfg = (extra: Record<string, unknown> = {}) =>
  nextLevelJobsProvider.parseConfig({ configVersion: 1, ...extra })

const sitemapXml = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`

async function run(
  responses: FakeResponse[],
  opts: {
    held?: ReadonlySet<string> | 'throws' | 'absent'
    maxDetails?: number
    random?: () => number
  } = {},
) {
  const f = fakeCollectionContext({ now: NOW, responses })
  const asked: string[][] = []
  const held = opts.held ?? HELD_OTHERS
  if (held !== 'absent') {
    f.ctx.heldIdentityKeys = async (keys) => {
      asked.push([...keys])
      if (held === 'throws') throw new Error('connection reset')
      return held
    }
  }
  const sleeps: number[] = []
  const provider = createNextLevelJobsProvider(
    { ...NEXTLEVELJOBS_BOUNDS, maxDetails: opts.maxDetails ?? NEXTLEVELJOBS_BOUNDS.maxDetails },
    {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: opts.random ?? (() => 0),
    },
  )
  const batch = await provider.collectReport(cfg(), f.ctx)
  return { batch, f, asked, sleeps }
}

describe('the sitemap', () => {
  it('lists the five job URLs of the fixture, in document order', () => {
    const parsed = parseSitemap(SITEMAP)
    expect(parsed).toEqual({
      ok: true,
      jobs: [
        { id: ID_MANAGER, url: URL_MANAGER },
        { id: ID_SECURITY, url: URL_SECURITY },
        {
          id: ID_OLDMISSION,
          url: `https://nextleveljobs.eu/companies/oldmission/jobs/${ID_OLDMISSION}`,
        },
        { id: ID_DATADOG, url: `https://nextleveljobs.eu/companies/datadog/jobs/${ID_DATADOG}` },
        { id: ID_CITI, url: `https://nextleveljobs.eu/companies/citi/jobs/${ID_CITI}` },
      ],
    })
  })

  it('skips a <loc> that is not a job page, and a repeated job once', () => {
    const parsed = parseSitemap(
      sitemapXml([
        'https://nextleveljobs.eu/companies/getyourguide',
        'https://nextleveljobs.eu/companies/a/jobs/0123456789abcdef01234567/apply',
        'http://nextleveljobs.eu/companies/a/jobs/0123456789abcdef01234567',
        'https://evil.example/companies/a/jobs/0123456789abcdef01234567',
        `  ${URL_SECURITY}  `,
        URL_SECURITY,
      ]),
    )
    expect(parsed).toEqual({ ok: true, jobs: [{ id: ID_SECURITY, url: URL_SECURITY }] })
  })

  it('refuses a document that is not a <urlset>, and one that is not XML', () => {
    expect(parseSitemap('<sitemapindex><sitemap/></sitemapindex>')).toEqual({
      ok: false,
      message: 'root is <sitemapindex>',
    })
    expect(parseSitemap('<html><body>blocked').ok).toBe(false)
  })
})

describe('unseen only, newest first, capped', () => {
  const jobs: SitemapJob[] = (parseSitemap(SITEMAP) as { jobs: SitemapJob[] }).jobs

  it('drops every held posting and orders the rest by id, newest first', () => {
    expect(
      unseenNewestFirst(jobs, new Set([identityKeyOf(ID_SECURITY)]), 25).map((j) => j.id),
    ).toEqual([ID_MANAGER, ID_OLDMISSION, ID_CITI, ID_DATADOG])
  })

  it('keeps at most the cap, taking the newest', () => {
    expect(unseenNewestFirst(jobs, new Set(), 2).map((j) => j.id)).toEqual([
      ID_SECURITY,
      ID_MANAGER,
    ])
    expect(unseenNewestFirst(jobs, new Set(), 0)).toEqual([])
  })

  it('keys a posting the way the store does: one key per id, different ids differ', () => {
    expect(identityKeyOf(ID_SECURITY)).toBe(identityKeyOf(ID_SECURITY))
    expect(identityKeyOf(ID_SECURITY)).not.toBe(identityKeyOf(ID_MANAGER))
  })
})

describe('the employer posting the page links (AC3 dedup)', () => {
  it('is the one Ashby job the captured page links', () => {
    expect(employerAtsUrl(SECURITY)).toBe(ASHBY_SECURITY)
    expect(employerAtsUrl(MANAGER)).toBe(ASHBY_MANAGER)
  })

  it('is null without an ATS job link, or with two distinct ones', () => {
    expect(employerAtsUrl('<a href="https://www.getyourguide.careers/">careers</a>')).toBeNull()
    expect(
      employerAtsUrl(`<a href="${ASHBY_SECURITY}">x</a><a href="${ASHBY_MANAGER}">y</a>`),
    ).toBeNull()
  })

  it('is that one when the same job is linked twice, and decodes &amp; in the query', () => {
    expect(
      employerAtsUrl(
        `<a href="${ASHBY_SECURITY}">x</a><a href="${ASHBY_SECURITY}/application">y</a>`,
      ),
    ).toBe(ASHBY_SECURITY)
    expect(
      employerAtsUrl(
        '<a href="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=4012345">a</a>',
      ),
    ).toBe('https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345')
  })

  it('ignores a board link that is not one job', () => {
    expect(employerAtsUrl('<a href="https://boards.greenhouse.io/acme">board</a>')).toBeNull()
  })
})

describe('a run', () => {
  it('reads the sitemap, asks which postings are held, and fetches only the two unseen pages, newest first', async () => {
    const { batch, f, asked } = await run([
      { bodyText: SITEMAP },
      { bodyText: SECURITY },
      { bodyText: MANAGER },
    ])
    expect(f.sent.map((r) => r.url)).toEqual([NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY, URL_MANAGER])
    expect(asked).toEqual([
      [ID_MANAGER, ID_SECURITY, ID_OLDMISSION, ID_DATADOG, ID_CITI].map(identityKeyOf),
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(f.saved).toHaveLength(2)
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 3 })
  })

  it('maps the JSON-LD fields of the Security Engineer page', async () => {
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: SECURITY },
      { bodyText: MANAGER },
    ])
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe(ID_SECURITY)
    expect(o.identity.identityKey).toBe(identityKeyOf(ID_SECURITY))
    expect(o.adapterVersion).toBe(NEXTLEVELJOBS_ADAPTER_VERSION)
    expect(o.sourcePostingUrl).toBe(ASHBY_SECURITY)
    expect(o.applicationUrl).toBe(ASHBY_SECURITY)
    expect(o.normalized.title).toBe('Working Student, Security Engineer')
    expect(o.normalized.companyName).toBe('GetYourGuide')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    expect(o.originalFields.description.kind).toBe('text')
    expect(o.normalized.dates.map((d) => [d.semantics, d.raw])).toEqual([
      ['PUBLISHED', '2026-11-15'],
      ['EXPIRY', '2027-02-18'],
    ])
  })

  it('waits a jittered 3 to 4.5 s before every request after the sitemap', async () => {
    const low = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }])
    expect(low.sleeps).toEqual([3000, 3000])
    const high = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }], {
      random: () => 0.999,
    })
    expect(high.sleeps.every((ms) => ms > 4400 && ms <= 4500)).toBe(true)
  })

  it('never fetches more detail pages than the cap: 1 sitemap + maxDetails requests', async () => {
    const { f, batch } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }], {
      held: new Set(),
      maxDetails: 1,
    })
    expect(f.sent.map((r) => r.url)).toEqual([NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('pins the production budget: 25 details, a 3 s floor', () => {
    expect(NEXTLEVELJOBS_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
  })

  it('with nothing unseen sends ONE request and succeeds with no records', async () => {
    const all = new Set(
      [ID_SECURITY, ID_MANAGER, ID_OLDMISSION, ID_DATADOG, ID_CITI].map(identityKeyOf),
    )
    const { f, batch, sleeps } = await run([{ bodyText: SITEMAP }], { held: all })
    expect(f.sent).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toEqual([])
  })

  it('without the held-postings port treats every posting as unseen', async () => {
    const { f } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }], {
      held: 'absent',
      maxDetails: 1,
    })
    expect(f.sent.map((r) => r.url)).toEqual([NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY])
  })

  it('fails without any detail request when the held postings cannot be read', async () => {
    const { f, batch } = await run([{ bodyText: SITEMAP }], { held: 'throws' })
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toContain('connection reset')
  })

  it('fails on a sitemap that is not a urlset, before any detail request', async () => {
    const { f, batch } = await run([{ bodyText: '<html>maintenance</html>' }])
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('counts a 404 detail as an answer and goes on', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { status: 404 }, { bodyText: MANAGER }])
    expect(f.sent).toHaveLength(3)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('counts a page without a matching JSON-LD posting as invalid, with a sample', async () => {
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: '<html></html>' },
      { bodyText: MANAGER },
    ])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.invalidSamples[0]?.reason).toBe('json-ld: none')
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a page whose posting names ANOTHER job is not taken for this one', async () => {
    // The Manager page served at the Security URL: its JSON-LD url is the Manager's.
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: MANAGER },
      { bodyText: MANAGER },
    ])
    expect(batch.counts.invalid).toBe(1)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ID_MANAGER])
  })

  it('stops ERROR on parse drift: three pages and most of them unparseable', async () => {
    const empty = { bodyText: '<html></html>' }
    const { batch, f } = await run([{ bodyText: SITEMAP }, empty, empty, empty], {
      held: new Set(),
      maxDetails: 3,
    })
    expect(f.sent).toHaveLength(4)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '3 of 3 job pages had no matching JSON-LD JobPosting',
    })
  })

  it('two bad pages alone is not drift, and two of three with one good is', async () => {
    const empty = { bodyText: '<html></html>' }
    const two = await run([{ bodyText: SITEMAP }, empty, empty], { held: new Set(), maxDetails: 2 })
    expect(two.batch.outcome).toBe('SUCCEEDED')
    expect(two.batch.counts.invalid).toBe(2)
    // invalid 3 > normalized 1: drift. The good page is still recorded, so the run is PARTIAL.
    const mixed = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, empty, empty, empty], {
      held: new Set(),
      maxDetails: 4,
    })
    expect(mixed.batch.counts).toEqual({
      raw: 4,
      normalized: 1,
      invalid: 3,
      quarantined: 0,
      discarded: 0,
    })
    expect(mixed.batch.outcome).toBe('PARTIAL')
    // Two good, three bad: still drift (3 > 2).
    const most = await run(
      [{ bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }, empty, empty, empty],
      { held: new Set(), maxDetails: 5 },
    )
    expect(most.batch.counts).toEqual({
      raw: 5,
      normalized: 2,
      invalid: 3,
      quarantined: 0,
      discarded: 0,
    })
    expect(most.batch.outcome).toBe('PARTIAL')
  })

  it('a 403 on a detail page ends the run there: no retry, no further request', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { status: 403 }, { bodyText: MANAGER }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('a 429 after one good page ends the run PARTIAL', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { status: 429 }])
    expect(f.sent).toHaveLength(3)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
  })

  it('a 403 on the sitemap fails the run with that one request', async () => {
    const { batch, f } = await run([{ status: 403 }])
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
  })

  it('a cancelled wait ends the run CANCELLED before the next request', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: SITEMAP }] })
    const provider = createNextLevelJobsProvider(NEXTLEVELJOBS_BOUNDS, {
      sleep: async () => {
        throw new Error('aborted')
      },
      random: () => 0,
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('CANCELLED')
  })
})

describe('salary (AC2: missing salary handled)', () => {
  it('the captured pages carry no baseSalary, and a mapped posting has no compensation field at all', () => {
    expect(SECURITY).not.toContain('baseSalary')
    const posting = extractJobPostings(SECURITY, { now: NOW }).postings[0]!
    const job = { id: ID_SECURITY, url: URL_SECURITY }
    const fields = mapPosting(posting, job, SECURITY)
    expect(Object.keys(fields).filter((k) => /salar|compens|pay/i.test(k))).toEqual([])
  })

  it('a page WITH a baseSalary maps to exactly the same fields: nothing is read from it', () => {
    const withSalary = SECURITY.replace(
      '"employmentType":"FULL_TIME"',
      '"employmentType":"FULL_TIME","baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue","minValue":90000,"maxValue":120000}}',
    )
    expect(withSalary).toContain('baseSalary')
    const job = { id: ID_SECURITY, url: URL_SECURITY }
    const plain = mapPosting(extractJobPostings(SECURITY, { now: NOW }).postings[0]!, job, SECURITY)
    const paid = mapPosting(
      extractJobPostings(withSalary, { now: NOW }).postings[0]!,
      job,
      withSalary,
    )
    expect(paid).toEqual(plain)
  })
})

describe('config, hosts and status', () => {
  it('refuses a query and a window: the sitemap takes neither', () => {
    expect(() => cfg({ query: 'react' })).toThrow('Next Level Jobs has no search parameter')
    expect(() => cfg({ window: { from: '2026-11-01', to: '2026-11-20' } })).toThrow(
      'Next Level Jobs has no date window',
    )
    expect(() => cfg({ namespace: 'other' })).toThrow()
  })

  it('reaches nextleveljobs.eu only', () => {
    expect(nextLevelJobsAllowedHosts()).toEqual(['nextleveljobs.eu'])
  })

  it('is permitted on the owner decision, with the permission still UNCLEAR', () => {
    expect(NEXTLEVELJOBS_SOURCE_STATUS.blocked).toBe(false)
    expect(NEXTLEVELJOBS_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })

  it('every fixture has a provenance file naming its URL', () => {
    for (const name of [
      'jobs-sitemap.trimmed',
      'job-security-engineer.html',
      'job-engineering-manager.html',
    ]) {
      const p = sourceProvenance('nextleveljobs', name) as { url: string; permission: string }
      expect(p.url).toMatch(/^https:\/\/nextleveljobs\.eu\//)
      expect(p.permission).toBe('UNCLEAR')
    }
  })
})
