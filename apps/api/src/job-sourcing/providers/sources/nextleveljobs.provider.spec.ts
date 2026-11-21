import { afterEach, describe, expect, it, vi } from 'vitest'
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
  SITEMAP_MAX_BYTES,
  type SitemapJob,
  detailsToRead,
} from './nextleveljobs.provider'
import { extractJobPostings } from '../../structuring/json-ld'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'

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
// Built per call, never at collection time: a mutant that throws while the spec file loads stops
// the whole file from collecting, which the mutation gate reads as a survivor.
const heldOthers = () => new Set([ID_OLDMISSION, ID_DATADOG, ID_CITI].map(identityKeyOf))

const cfg = (extra: Record<string, unknown> = {}) =>
  nextLevelJobsProvider.parseConfig({ configVersion: 1, ...extra })

/** Three ids created minutes before NOW (0x6b00b2d0 s is 20:51:28Z), newest first. */
const FRESH = ['6b00b2d00000000000000003', '6b00b2d00000000000000002', '6b00b2d00000000000000001']
const jobUrl = (id: string) => `https://nextleveljobs.eu/companies/a/jobs/${id}`

const sitemapXml = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`

/** Every run reads robots.txt first (task sources-16, H-1): an allow-all one. */
const ROBOTS_URL = 'https://nextleveljobs.eu/robots.txt'
const ROBOTS_OK: FakeResponse = { bodyText: 'User-agent: *\nAllow: /\n' }

async function run(
  responses: FakeResponse[],
  opts: {
    held?: ReadonlySet<string> | 'throws' | 'absent'
    maxDetails?: number
    random?: () => number
  } = {},
) {
  const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, ...responses] })
  const asked: string[][] = []
  const held = opts.held ?? heldOthers()
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

  it('reads an upper-case hex id as its lower-case form, so the two spellings are one posting', () => {
    const upper = `https://nextleveljobs.eu/companies/getyourguide/jobs/${ID_SECURITY.toUpperCase()}`
    expect(parseSitemap(sitemapXml([upper, URL_SECURITY]))).toEqual({
      ok: true,
      jobs: [{ id: ID_SECURITY, url: upper }],
    })
    expect(identityKeyOf(ID_SECURITY)).toBe(
      identityKeyOf((parseSitemap(sitemapXml([upper])) as { jobs: SitemapJob[] }).jobs[0]!.id),
    )
  })

  it('caps the sitemap at about 8.5 times the size captured (CR-L-3)', () => {
    const notes = (sourceProvenance('nextleveljobs', 'jobs-sitemap.trimmed') as { notes: string })
      .notes
    const captured = Number(/(\d+) bytes/.exec(notes)?.[1])
    expect(captured).toBe(493_815)
    expect(SITEMAP_MAX_BYTES / captured).toBeCloseTo(8.49, 2)
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
  const jobs = (): SitemapJob[] => (parseSitemap(SITEMAP) as { jobs: SitemapJob[] }).jobs

  it('drops every held posting and orders the rest by id, newest first', () => {
    expect(
      detailsToRead(jobs(), new Set([identityKeyOf(ID_SECURITY)]), 25, 0).map((j) => j.id),
    ).toEqual([ID_MANAGER, ID_OLDMISSION, ID_CITI, ID_DATADOG])
  })

  it('keeps at most the cap, taking the newest', () => {
    expect(detailsToRead(jobs(), new Set(), 2, 0).map((j) => j.id)).toEqual([
      ID_SECURITY,
      ID_MANAGER,
    ])
    expect(detailsToRead(jobs(), new Set(), 0, 0)).toEqual([])
  })
})

describe('a page that keeps failing cannot pin the run (CR-L-1)', () => {
  // `n` unseen ids, 0..n-1; newest first that is n-1 down to 0.
  const ids = (n: number): SitemapJob[] =>
    Array.from({ length: n }, (_, i) => {
      const id = i.toString(16).padStart(24, '0')
      return { id, url: `https://nextleveljobs.eu/companies/a/jobs/${id}` }
    })
  const picked = (n: number, max: number, turn: number) =>
    detailsToRead(ids(n), new Set(), max, turn).map((j) => parseInt(j.id, 16))

  it('gives one slot in five to the ids below the newest, at an offset the run draws', () => {
    // cap 10: 8 newest (19..12), then 2 of the 12 below (11..0) from offset floor(0.5 * 12) = 6.
    expect(picked(20, 10, 0.5)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 5, 4])
    // Another run, another draw: offset floor(0.7 * 12) = 8.
    expect(picked(20, 10, 0.7)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 3, 2])
    expect(picked(20, 10, 0)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10])
  })

  it('wraps around the end of the ids below the newest', () => {
    // 19 ids: 8 newest (18..11), 11 below (10..0); offset floor(0.95 * 11) = 10.
    expect(picked(19, 10, 0.95)).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 0, 10])
  })

  it('reaches every older unseen id across consecutive runs, whatever their spacing in time (D-1)', () => {
    // The hourly offset aliased with a 2 h / 6 h schedule: some ids below were never reached.
    // Six runs with six draws spread over [0, 1) give the 2 slots six distinct offsets of 12.
    const reached = new Set(
      [0, 1, 2, 3, 4, 5].flatMap((k) => picked(20, 10, k / 6 + 0.01).slice(8)),
    )
    expect([...reached].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('takes every id once when fewer are unseen than the turning slots, and never exceeds the cap', () => {
    expect(picked(9, 10, 0.5)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(picked(4, 5, 0.5)).toEqual([3, 2, 1, 0])
    expect(picked(100, 25, 0.5)).toHaveLength(25)
    expect(new Set(picked(100, 25, 0.5)).size).toBe(25)
  })

  it('below five slots every slot goes to the newest', () => {
    expect(picked(20, 4, 0.5)).toEqual([19, 18, 17, 16])
  })

  it('keys a posting the way the store does: one key per id, different ids differ', () => {
    expect(identityKeyOf(ID_SECURITY)).toBe(identityKeyOf(ID_SECURITY))
    expect(identityKeyOf(ID_SECURITY)).not.toBe(identityKeyOf(ID_MANAGER))
  })

  it('refuses an id that has no identity, naming the id and the reason (CR-L-4)', () => {
    expect(() => identityKeyOf('')).toThrow(new Error('no identity for : NO_IDENTITY'))
  })
})

describe('the employer posting the apply button links (AC3 dedup)', () => {
  const button = (href: string) =>
    `<a class="bg-lime-500 rounded-lg" href="${href}" target="_blank">Apply here</a>`

  it('is the one Ashby job both apply buttons of the captured page link', () => {
    expect(employerAtsUrl(SECURITY)).toBe(ASHBY_SECURITY)
    expect(employerAtsUrl(MANAGER)).toBe(ASHBY_MANAGER)
  })

  it('ignores an ATS job link that is not an apply button (a description link cannot poison dedup)', () => {
    expect(employerAtsUrl(`<p><a href="${ASHBY_MANAGER}">our other role</a></p>`)).toBeNull()
    expect(employerAtsUrl(`<a href="${ASHBY_MANAGER}">x</a>${button(ASHBY_SECURITY)}`)).toBe(
      ASHBY_SECURITY,
    )
  })

  it('a description anchor that ALSO reads "Apply here" is not a button: the real buttons still decide', () => {
    // The page renders the employer's description links as `<a target="_blank" href>`, no class.
    const page = SECURITY.replace(
      '</body>',
      `<p><a target="_blank" href="${ASHBY_MANAGER}">Apply here</a></p></body>`,
    )
    expect(page).not.toBe(SECURITY)
    expect(employerAtsUrl(page)).toBe(ASHBY_SECURITY)
  })

  it('no button and a description link reading "Apply here": no employer ATS url', () => {
    expect(
      employerAtsUrl(
        `<div class="prose"><p><a target="_blank" href="${ASHBY_MANAGER}">Apply here</a></p></div>`,
      ),
    ).toBeNull()
  })

  it('reads the href attribute only, never data-href', () => {
    expect(
      employerAtsUrl(
        `<a class="bg-lime-500" href="${ASHBY_SECURITY}" data-href="${ASHBY_MANAGER}">Apply here</a>`,
      ),
    ).toBe(ASHBY_SECURITY)
    expect(
      employerAtsUrl(`<a class="bg-lime-500" data-href="${ASHBY_MANAGER}">Apply here</a>`),
    ).toBeNull()
  })

  it('needs bg-lime-500 as a whole class token, before or after the href, on an <a> only', () => {
    expect(
      employerAtsUrl(`<a href="${ASHBY_SECURITY}" class="flex-1 bg-lime-500">Apply here</a>`),
    ).toBe(ASHBY_SECURITY)
    expect(
      employerAtsUrl(`<a\n  class="bg-lime-500"\n  href="${ASHBY_SECURITY}">Apply here</a>`),
    ).toBe(ASHBY_SECURITY)
    expect(
      employerAtsUrl(`<a class="hover:bg-lime-500" href="${ASHBY_SECURITY}">Apply here</a>`),
    ).toBeNull()
    expect(
      employerAtsUrl(`<a class="bg-lime-5000" href="${ASHBY_SECURITY}">Apply here</a>`),
    ).toBeNull()
    expect(
      employerAtsUrl(`<a data-class="bg-lime-500" href="${ASHBY_SECURITY}">Apply here</a>`),
    ).toBeNull()
    expect(
      employerAtsUrl(`<abbr class="bg-lime-500" href="${ASHBY_SECURITY}">Apply here</a>`),
    ).toBeNull()
  })

  it('is null without a button, with a non-ATS button, or with buttons naming two jobs', () => {
    expect(employerAtsUrl('<a href="https://www.getyourguide.careers/">careers</a>')).toBeNull()
    expect(employerAtsUrl(button('https://www.getyourguide.careers/jobs/1'))).toBeNull()
    expect(
      employerAtsUrl(button(ASHBY_SECURITY) + button('https://www.getyourguide.careers/')),
    ).toBeNull()
    expect(employerAtsUrl(button(ASHBY_SECURITY) + button(ASHBY_MANAGER))).toBeNull()
    expect(employerAtsUrl(button('https://boards.greenhouse.io/acme'))).toBeNull()
  })

  it('is that one when two buttons name the same job, and decodes &amp; in the query', () => {
    expect(employerAtsUrl(button(ASHBY_SECURITY) + button(`${ASHBY_SECURITY}/application`))).toBe(
      ASHBY_SECURITY,
    )
    expect(
      employerAtsUrl(
        button('https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=4012345'),
      ),
    ).toBe('https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345')
  })
})

describe('a run', () => {
  it('reads the sitemap, asks which postings are held, and fetches only the two unseen pages, newest first', async () => {
    const { batch, f, asked } = await run([
      { bodyText: SITEMAP },
      { bodyText: SECURITY },
      { bodyText: MANAGER },
    ])
    expect(f.sent.map((r) => r.url)).toEqual([
      ROBOTS_URL,
      NEXTLEVELJOBS_SITEMAP_URL,
      URL_SECURITY,
      URL_MANAGER,
    ])
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

  it('waits a jittered 3 to 4.5 s before every request after robots.txt', async () => {
    const low = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }])
    expect(low.sleeps).toEqual([3000, 3000, 3000])
    const high = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }], {
      random: () => 0.999,
    })
    expect(high.sleeps.every((ms) => ms > 4400 && ms <= 4500)).toBe(true)
  })

  it('never fetches more detail pages than the cap: robots.txt, the sitemap + maxDetails requests', async () => {
    const { f, batch } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }], {
      held: new Set(),
      maxDetails: 1,
    })
    expect(f.sent.map((r) => r.url)).toEqual([ROBOTS_URL, NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('pins the production budget: 25 details, a 3 s floor', () => {
    expect(NEXTLEVELJOBS_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
  })

  it('with nothing unseen sends only robots.txt and the sitemap, and succeeds with no records', async () => {
    const all = new Set(
      [ID_SECURITY, ID_MANAGER, ID_OLDMISSION, ID_DATADOG, ID_CITI].map(identityKeyOf),
    )
    const { f, batch, sleeps } = await run([{ bodyText: SITEMAP }], { held: all })
    expect(f.sent).toHaveLength(2)
    // The one gap is the one before the sitemap.
    expect(sleeps).toEqual([3000])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toEqual([])
  })

  it('without the held-postings port treats every posting as unseen', async () => {
    const { f } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }], {
      held: 'absent',
      maxDetails: 1,
    })
    expect(f.sent.map((r) => r.url)).toEqual([ROBOTS_URL, NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY])
  })

  it('fails without any detail request when the held postings cannot be read', async () => {
    const { f, batch } = await run([{ bodyText: SITEMAP }], { held: 'throws' })
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toContain('connection reset')
  })

  it('fails on a sitemap that is not a urlset, before any detail request', async () => {
    const { f, batch } = await run([{ bodyText: '<html>maintenance</html>' }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('counts a 404 detail as an answer and goes on', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { status: 404 }, { bodyText: MANAGER }])
    expect(f.sent).toHaveLength(4)
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
    expect(f.sent).toHaveLength(5)
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
    // The bad pages are of ids created minutes ago (see FRESH): they count toward drift.
    const fresh = sitemapXml([URL_SECURITY, URL_MANAGER, ...FRESH.map(jobUrl)])
    const mixed = await run(
      [
        { bodyText: sitemapXml([URL_SECURITY, ...FRESH.map(jobUrl)]) },
        { bodyText: SECURITY },
        empty,
        empty,
        empty,
      ],
      { held: new Set(), maxDetails: 4 },
    )
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
      [{ bodyText: fresh }, { bodyText: SECURITY }, { bodyText: MANAGER }, empty, empty, empty],
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
    // Three good, three bad: not drift (3 > 3 is false). The third good page is the Manager page
    // re-served under a fresh id of its own, so its JSON-LD names that id's URL.
    const ID_THIRD = '6b00b2d80000000000000001'
    const URL_THIRD = `https://nextleveljobs.eu/companies/getyourguide/jobs/${ID_THIRD}`
    const even = await run(
      [
        { bodyText: sitemapXml([URL_SECURITY, URL_MANAGER, URL_THIRD, ...FRESH.map(jobUrl)]) },
        { bodyText: SECURITY },
        { bodyText: MANAGER },
        { bodyText: MANAGER.replaceAll(ID_MANAGER, ID_THIRD) },
        empty,
        empty,
        empty,
      ],
      { held: new Set(), maxDetails: 6 },
    )
    expect(even.batch.counts).toMatchObject({ normalized: 3, invalid: 3 })
    expect(even.batch.outcome).toBe('SUCCEEDED')
  })

  it('a bad page of an id created a day ago or more is an invalid sample, never drift (CR-L-1)', async () => {
    const empty = { bodyText: '<html></html>' }
    // NOW - 24 h is 0x6aff6a58 seconds (hand-computed: 1 795 210 200 - 86 400).
    const DAY_OLD = '6aff6a580000000000000001'
    const DAY_OLD_LESS_1S = '6aff6a590000000000000001'
    const olds = [DAY_OLD, ID_CITI, ID_DATADOG]
    const stuck = await run([{ bodyText: sitemapXml(olds.map(jobUrl)) }, empty, empty, empty], {
      held: new Set(),
      maxDetails: 3,
    })
    expect(stuck.batch.counts.invalid).toBe(3)
    expect(stuck.batch.invalidSamples).toHaveLength(3)
    expect(stuck.batch.outcome).toBe('SUCCEEDED')
    expect(stuck.batch.requests.some((r) => r.error?.code === 'PARSE_DRIFT')).toBe(false)
    // Exactly a day old is out of the window; a second younger is in it.
    const twoFresh = FRESH.slice(1)
    const edge = await run(
      [{ bodyText: sitemapXml([...twoFresh, DAY_OLD].map(jobUrl)) }, empty, empty, empty],
      { held: new Set(), maxDetails: 3 },
    )
    expect(edge.batch.outcome).toBe('SUCCEEDED')
    const inside = await run(
      [{ bodyText: sitemapXml([...twoFresh, DAY_OLD_LESS_1S].map(jobUrl)) }, empty, empty, empty],
      { held: new Set(), maxDetails: 3 },
    )
    expect(inside.batch.outcome).toBe('FAILED')
    expect(inside.batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '3 of 3 job pages had no matching JSON-LD JobPosting',
    })
  })

  it('a sitemap whose newest ids 404 still reads a fresh one below them, with no drift (CR-L-1)', async () => {
    // Seven ids newer than both captured pages, every one of them gone.
    const gone = [7, 6, 5, 4, 3, 2, 1].map((n) => `6b00b300${n.toString(16).padStart(16, '0')}`)
    const sitemap = sitemapXml([...gone.map(jobUrl), URL_SECURITY, URL_MANAGER])
    const notFound = { status: 404 }
    // The run's FIRST draw is its turning offset; every later draw is a jittered gap.
    const draws = (first: number) => {
      const left = [first]
      return () => left.shift() ?? 0
    }
    const { batch, f } = await run(
      [{ bodyText: sitemap }, notFound, notFound, notFound, notFound, { bodyText: MANAGER }],
      { held: new Set(), maxDetails: 5, random: draws(0.9) },
    )
    // 4 newest, then the turning slot: ids below are [3, 2, 1, Security, Manager], offset
    // floor(0.9 * 5) = 4 -> Manager. Without that slot all five requests would go to gone ids.
    expect(f.sent.map((r) => r.url)).toEqual([
      ROBOTS_URL,
      NEXTLEVELJOBS_SITEMAP_URL,
      ...gone.slice(0, 4).map(jobUrl),
      URL_MANAGER,
    ])
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ID_MANAGER])
    expect(batch.counts.invalid).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.some((r) => r.error?.code === 'PARSE_DRIFT')).toBe(false)
    // Same clock, another run, another draw (D-1): floor(0.7 * 5) = 3 -> Security.
    const next = await run(
      [{ bodyText: sitemap }, notFound, notFound, notFound, notFound, { bodyText: SECURITY }],
      { held: new Set(), maxDetails: 5, random: draws(0.7) },
    )
    expect(next.f.sent.at(-1)?.url).toBe(URL_SECURITY)
    expect(next.batch.observations.map((o) => o.identity.nativeId)).toEqual([ID_SECURITY])
  })

  it('an upper-case sitemap URL and the lower-case JSON-LD URL are one posting, fetched as listed (D-4)', async () => {
    const upper = `https://nextleveljobs.eu/companies/getyourguide/jobs/${ID_SECURITY.toUpperCase()}`
    const { batch, f } = await run([{ bodyText: sitemapXml([upper]) }, { bodyText: SECURITY }], {
      held: new Set(),
    })
    expect(f.sent.map((r) => r.url)).toEqual([ROBOTS_URL, NEXTLEVELJOBS_SITEMAP_URL, upper])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ID_SECURITY])
  })

  it('a lower-case sitemap URL and an upper-case JSON-LD URL are one posting, under the lower-case URL (D-4)', async () => {
    // No apply button either, so the observation's URL is the posting's own, normalised.
    const page = SECURITY.replaceAll(ID_SECURITY, ID_SECURITY.toUpperCase()).replaceAll(
      'bg-lime-500',
      'bg-red-500',
    )
    const { batch, f } = await run([{ bodyText: sitemapXml([URL_SECURITY]) }, { bodyText: page }], {
      held: new Set(),
    })
    expect(f.sent.map((r) => r.url)).toEqual([ROBOTS_URL, NEXTLEVELJOBS_SITEMAP_URL, URL_SECURITY])
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.sourcePostingUrl).toBe(URL_SECURITY)
    expect(batch.observations[0]?.applicationUrl).toBeNull()
  })

  it('a JSON-LD URL that is not a job page is no match, and never throws', async () => {
    const page = SECURITY.replaceAll(
      URL_SECURITY,
      'https://nextleveljobs.eu/companies/getyourguide',
    )
    const { batch } = await run([{ bodyText: sitemapXml([URL_SECURITY]) }, { bodyText: page }], {
      held: new Set(),
    })
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual(['json-ld: none'])
  })

  it('a posting read whole but with no apply button leaves a sample, and is still recorded (D-3)', async () => {
    const noButton = SECURITY.replaceAll('bg-lime-500', 'bg-red-500')
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: noButton },
      { bodyText: MANAGER },
    ])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.invalidSamples).toHaveLength(1)
    expect(batch.invalidSamples[0]).toMatchObject({ page: 2, reason: 'apply-button: none' })
    expect(batch.invalidSamples[0]?.sample).toContain(URL_SECURITY)
  })

  it('a non-ATS apply button is a button: no sample, only no dedup (D-3)', async () => {
    const own = SECURITY.replaceAll(ASHBY_SECURITY, 'https://getyourguide.careers/jobs/1')
    const { batch } = await run([{ bodyText: SITEMAP }, { bodyText: own }, { bodyText: MANAGER }])
    expect(batch.counts.normalized).toBe(2)
    expect(batch.observations[0]?.applicationUrl).toBeNull()
    expect(batch.invalidSamples).toEqual([])
  })

  it('a bad page of an id dated in the future never counts toward drift; one dated now does', async () => {
    const empty = { bodyText: '<html></html>' }
    // NOW is 0x6b00bbd8 Unix seconds (hand-computed: 1 795 210 200).
    const future = [
      '6b00bbd90000000000000003',
      '6b00bbd90000000000000002',
      '6c0000000000000000000001',
    ]
    const ahead = await run([{ bodyText: sitemapXml(future.map(jobUrl)) }, empty, empty, empty], {
      held: new Set(),
      maxDetails: 3,
    })
    expect(ahead.batch.counts.invalid).toBe(3)
    expect(ahead.batch.outcome).toBe('SUCCEEDED')
    expect(ahead.batch.requests.some((r) => r.error?.code === 'PARSE_DRIFT')).toBe(false)
    const atNow = [
      '6b00bbd80000000000000003',
      '6b00bbd80000000000000002',
      '6b00bbd80000000000000001',
    ]
    const now = await run([{ bodyText: sitemapXml(atNow.map(jobUrl)) }, empty, empty, empty], {
      held: new Set(),
      maxDetails: 3,
    })
    expect(now.batch.outcome).toBe('FAILED')
    expect(now.batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a 403 on a detail page ends the run there: no retry, no further request', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { status: 403 }, { bodyText: MANAGER }])
    expect(f.sent).toHaveLength(3)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('a 429 after one good page ends the run PARTIAL', async () => {
    const { batch, f } = await run([{ bodyText: SITEMAP }, { bodyText: SECURITY }, { status: 429 }])
    expect(f.sent).toHaveLength(4)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
  })

  it('a 403 on the sitemap fails the run with that request, after robots.txt', async () => {
    const { batch, f } = await run([{ status: 403 }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
  })

  it('a cancelled wait ends the run CANCELLED before the next request', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, { bodyText: SITEMAP }] })
    const provider = createNextLevelJobsProvider(NEXTLEVELJOBS_BOUNDS, {
      sleep: async () => {
        throw new Error('aborted')
      },
      random: () => 0,
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    // Only robots.txt went out: the gap before the sitemap was cancelled.
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('CANCELLED')
  })
})

describe('salary (AC2: missing salary handled)', () => {
  it('the captured pages carry no baseSalary, so a mapped posting has no salary', () => {
    expect(SECURITY).not.toContain('baseSalary')
    const posting = extractJobPostings(SECURITY, { now: NOW }).postings[0]!
    const job = { id: ID_SECURITY, url: URL_SECURITY }
    expect(mapPosting(posting, job, SECURITY).salary).toBe(null)
  })

  it('a baseSalary is read by the shared JSON-LD mapping (sources-17); without a unit it is none', () => {
    const withSalary = (unit: string) =>
      SECURITY.replace(
        '"employmentType":"FULL_TIME"',
        `"employmentType":"FULL_TIME","baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue",${unit}"minValue":90000,"maxValue":120000}}`,
      )
    const job = { id: ID_SECURITY, url: URL_SECURITY }
    const salaryOn = (html: string) =>
      mapPosting(extractJobPostings(html, { now: NOW }).postings[0]!, job, html).salary
    expect(withSalary('')).toContain('baseSalary')
    expect(salaryOn(withSalary(''))).toBe(null)
    expect(salaryOn(withSalary('"unitText":"YEAR",'))).toEqual({
      min: 90000,
      max: 120000,
      currency: 'EUR',
      period: 'YEAR',
    })
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

/**
 * Mutation-gate pins (sources-12): each case below fails on one change the gate made to the adapter
 * that the cases above still accepted.
 */
const ID_A = '0123456789abcdef01234567'
const URL_A = `https://nextleveljobs.eu/companies/a/jobs/${ID_A}`
const urlset = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${inner}</urlset>`

describe('the sitemap, element by element', () => {
  it('reads the <loc> of a <url>, wherever it sits among the other children', () => {
    expect(
      parseSitemap(urlset(`<url><lastmod>2026-11-20</lastmod><loc>${URL_A}</loc></url>`)),
    ).toEqual({ ok: true, jobs: [{ id: ID_A, url: URL_A }] })
  })

  it('skips a <url> with no <loc>, and a job URL embedded in another URL', () => {
    expect(
      parseSitemap(
        urlset(
          `<url></url><url><lastmod>2026-11-20</lastmod></url><url><loc>https://evil.example/r?u=${URL_A}</loc></url>`,
        ),
      ),
    ).toEqual({ ok: true, jobs: [] })
  })

  it('accepts a sitemap above the 2 MiB XML default and under its own 4 MiB cap', () => {
    const body = urlset(`<url><loc>${URL_A}</loc></url>${' '.repeat(3 * 1024 * 1024)}`)
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(body.length).toBeLessThan(SITEMAP_MAX_BYTES)
    expect(parseSitemap(body)).toEqual({ ok: true, jobs: [{ id: ID_A, url: URL_A }] })
  })

  it('reads a <loc> wrapped in whitespace', () => {
    expect(parseSitemap(urlset(`<url><loc>\n    ${URL_A}\n  </loc></url>`))).toEqual({
      ok: true,
      jobs: [{ id: ID_A, url: URL_A }],
    })
  })

  it('refuses a sitemap above its own 4 MiB cap', () => {
    const body = urlset(`<url><loc>${URL_A}</loc></url>${' '.repeat(SITEMAP_MAX_BYTES)}`)
    expect(parseSitemap(body).ok).toBe(false)
  })

  it('orders unseen ids newest first whatever order the sitemap lists them in', () => {
    const ids = ['0000000000000000000000aa', '0000000000000000000000ff', '000000000000000000000001']
    const listed = ids.map((id) => ({ id, url: `https://nextleveljobs.eu/companies/a/jobs/${id}` }))
    expect(detailsToRead(listed, new Set(), 25, 0).map((j) => j.id)).toEqual([
      '0000000000000000000000ff',
      '0000000000000000000000aa',
      '000000000000000000000001',
    ])
  })
})

describe('the apply button, exactly', () => {
  it('reads a button whose label is wrapped in whitespace', () => {
    expect(
      employerAtsUrl(
        `<a class="btn bg-lime-500" href="${ASHBY_SECURITY}">\n    Apply here\n  </a>`,
      ),
    ).toBe(ASHBY_SECURITY)
  })

  it('an employer-hosted Greenhouse link is not an ATS-hosted job: no dedup from it', () => {
    expect(
      employerAtsUrl(
        `<a class="bg-lime-500" href="https://www.acme-careers.com/jobs?gh_jid=4012345">Apply here</a>`,
      ),
    ).toBeNull()
  })
})

describe('mapPosting, field by field', () => {
  const job = { id: ID_SECURITY, url: URL_SECURITY }
  const base = () => extractJobPostings(SECURITY, { now: NOW }).postings[0]!

  it('maps the captured location and leaves remote unknown off TELECOMMUTE', () => {
    const fields = mapPosting(base(), job, SECURITY)
    expect(fields.location).toBe('Zurich, Zurich, Switzerland')
    expect(fields.remote).toBeNull()
    expect(fields.tags).toEqual([])
  })

  it('joins several locations, and has none for an empty list', () => {
    expect(
      mapPosting({ ...base(), jobLocations: ['Berlin', 'Remote, EU'] }, job, SECURITY).location,
    ).toBe('Berlin; Remote, EU')
    expect(mapPosting({ ...base(), jobLocations: [] }, job, SECURITY).location).toBeNull()
  })

  it('a TELECOMMUTE posting is remote', () => {
    expect(mapPosting({ ...base(), jobLocationType: 'TELECOMMUTE' }, job, SECURITY).remote).toBe(
      true,
    )
  })

  it('a missing date is left out, the other one kept', () => {
    const noPosted = mapPosting({ ...base(), datePosted: null }, job, SECURITY)
    expect(noPosted.dates.map((d) => d.semantics)).toEqual(['EXPIRY'])
    const noExpiry = mapPosting({ ...base(), validThrough: null }, job, SECURITY)
    expect(noExpiry.dates.map((d) => d.semantics)).toEqual(['PUBLISHED'])
  })
})

describe('a run, request by request', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for XML once and for HTML per page, and reports each request with its status', async () => {
    const { batch, f } = await run([
      { bodyText: SITEMAP },
      { bodyText: SECURITY },
      { bodyText: MANAGER },
    ])
    expect(f.sent.map((r) => r.headers)).toEqual([
      { accept: 'text/plain' },
      { accept: 'application/xml' },
      { accept: 'text/html' },
      { accept: 'text/html' },
    ])
    expect(f.sent[1]?.maxBytes).toBe(SITEMAP_MAX_BYTES)
    expect(SITEMAP_MAX_BYTES).toBe(4 * 1024 * 1024)
    // robots.txt shares page 1 with the sitemap.
    expect(batch.requests.map((r) => [r.page, r.url, r.status, r.error])).toEqual([
      [1, ROBOTS_URL, 200, null],
      [1, NEXTLEVELJOBS_SITEMAP_URL, 200, null],
      [2, URL_SECURITY, 200, null],
      [3, URL_MANAGER, 200, null],
    ])
    expect(f.saved.map((c) => c.position)).toEqual([
      { kind: 'RESTART', page: 2 },
      { kind: 'RESTART', page: 3 },
    ])
  })

  it('saves each observation with its own checkpoint', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: SITEMAP }, { bodyText: SECURITY }],
    })
    f.ctx.heldIdentityKeys = async () => heldOthers()
    const pages: { ids: string[]; page: unknown }[] = []
    f.ctx.checkpoints.savePage = async ({ observations, checkpoint }) => {
      pages.push({ ids: observations.map((o) => o.identity.nativeId), page: checkpoint.position })
    }
    const provider = createNextLevelJobsProvider(
      { ...NEXTLEVELJOBS_BOUNDS, maxDetails: 1 },
      { sleep: async () => {}, random: () => 0 },
    )
    await provider.collectReport(cfg(), f.ctx)
    expect(pages).toEqual([{ ids: [ID_SECURITY], page: { kind: 'RESTART', page: 2 } }])
  })

  it('a page that cannot be saved ends the run on PERSISTENCE, counted as discarded', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }],
    })
    f.ctx.heldIdentityKeys = async () => heldOthers()
    f.ctx.checkpoints.savePage = async () => {
      throw new Error('disk full')
    }
    const provider = createNextLevelJobsProvider(NEXTLEVELJOBS_BOUNDS, {
      sleep: async () => {},
      random: () => 0,
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(3)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.counts.discarded).toBe(1)
    expect(batch.requests.at(-1)?.error).toEqual({ code: 'PERSISTENCE', message: 'disk full' })
  })

  it('a store failure on save that is not an Error still names what failed', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: SITEMAP }, { bodyText: SECURITY }],
    })
    f.ctx.heldIdentityKeys = async () => heldOthers()
    f.ctx.checkpoints.savePage = async () => {
      throw 'disk full'
    }
    const provider = createNextLevelJobsProvider(NEXTLEVELJOBS_BOUNDS, {
      sleep: async () => {},
      random: () => 0,
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the page could not be persisted',
    })
  })

  it('a posting the record builder refuses is quarantined with a sample, and the run goes on', async () => {
    const noCompany = SECURITY.replace('"hiringOrganization"', '"x-hiringOrganization"')
    expect(noCompany).not.toBe(SECURITY)
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: noCompany },
      { bodyText: MANAGER },
    ])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.invalidSamples.map((x) => x.reason)).toEqual(['MISSING_COMPANY'])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(URL_SECURITY)
  })

  it('an invalid page sample names the page URL', async () => {
    const { batch } = await run([
      { bodyText: SITEMAP },
      { bodyText: '<html></html>' },
      { bodyText: MANAGER },
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(URL_SECURITY)
  })

  it('a store failure that is not an Error still names what failed', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, { bodyText: SITEMAP }] })
    f.ctx.heldIdentityKeys = async () => {
      throw 'boom'
    }
    vi.useFakeTimers()
    const pending = createNextLevelJobsProvider().collectReport(cfg(), f.ctx)
    await vi.advanceTimersByTimeAsync(5000)
    const batch = await pending
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PERSISTENCE',
      message: 'the held postings could not be read: the store failed',
    })
  })

  it('a refused sitemap is the only failed request reported, with its own code', async () => {
    const { batch } = await run([{ status: 403 }])
    expect(batch.requests.map((r) => r.error?.code)).toEqual([undefined, 'ACCESS_POLICY'])
  })

  it('a sitemap 404 is a failure, not an answer', async () => {
    const { batch, f } = await run([{ status: 404 }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => r.error?.code)).toEqual([undefined, 'UPSTREAM'])
  })

  it('a sitemap that is not a urlset names why in the report', async () => {
    const { batch } = await run([{ bodyText: '<html>maintenance</html>' }])
    expect(batch.requests.at(-1)?.error?.message).toBe('sitemap: root is <html>')
  })

  it('a cancelled wait reports the request it did not send', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, { bodyText: SITEMAP }] })
    f.ctx.heldIdentityKeys = async () => heldOthers()
    let waits = 0
    const provider = createNextLevelJobsProvider(NEXTLEVELJOBS_BOUNDS, {
      // The gap before the sitemap passes; the one before the first page is cancelled.
      sleep: async () => {
        waits += 1
        if (waits > 1) throw new Error('aborted')
      },
      random: () => 0,
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(batch.requests.at(-1)).toMatchObject({
      page: 2,
      url: URL_SECURITY,
      error: { code: 'CANCELLED', message: 'the run was cancelled before this request' },
    })
  })

  it('three bad pages beside three good ones is not drift', async () => {
    const empty = { bodyText: '<html></html>' }
    const ids = ['0000000000000000000000a1', '0000000000000000000000a2', '0000000000000000000000a3']
    const goodPage = (id: string) =>
      SECURITY.replaceAll(ID_SECURITY, id).replaceAll('/getyourguide/', '/getyourguide/')
    const sitemap = sitemapXml([
      ...ids.map((id) => `https://nextleveljobs.eu/companies/getyourguide/jobs/${id}`),
      URL_SECURITY,
      URL_MANAGER,
      `https://nextleveljobs.eu/companies/a/jobs/${ID_A}`,
    ])
    const { batch } = await run(
      [
        { bodyText: sitemap },
        { bodyText: SECURITY },
        { bodyText: MANAGER },
        empty,
        empty,
        empty,
        { bodyText: goodPage(ids[0]!) },
      ],
      { held: new Set(), maxDetails: 6 },
    )
    expect(batch.counts.invalid).toBe(3)
    expect(batch.counts.normalized).toBe(3)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a refusal after three bad pages stays a refusal, never drift', async () => {
    const empty = { bodyText: '<html></html>' }
    const { batch } = await run([{ bodyText: SITEMAP }, empty, empty, empty, { status: 403 }], {
      held: new Set(),
      maxDetails: 5,
    })
    expect(batch.counts.invalid).toBe(3)
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('the default provider really waits between requests (the production sleep and random)', async () => {
    vi.useFakeTimers()
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: SITEMAP }, { bodyText: SECURITY }, { bodyText: MANAGER }],
    })
    f.ctx.heldIdentityKeys = async () => heldOthers()
    const pending = createNextLevelJobsProvider().collectReport(cfg(), f.ctx)
    await vi.advanceTimersByTimeAsync(2999)
    // robots.txt only: the sitemap waits its 3 s gap too.
    expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    const batch = await pending
    expect(f.sent).toHaveLength(4)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('dates are judged against the run clock, not the wall clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const future = SECURITY.replace('"datePosted":"2026-11-15"', '"datePosted":"2028-06-01"')
    expect(future).not.toBe(SECURITY)
    const { batch } = await run([{ bodyText: sitemapXml([URL_SECURITY]) }, { bodyText: future }], {
      held: new Set(),
    })
    // The run clock is 2026-11-20, so a 2028 publication date is in the future; the wall clock
    // (2030 here) would accept it.
    expect(batch.observations[0]?.normalized.publishedAt).toBeNull()
    expect(batch.observations[0]?.normalized.dates[0]).toMatchObject({
      semantics: 'PUBLISHED',
      status: 'FUTURE',
    })
  })

  it('pins the fixtures the manifest names for this source', () => {
    expect(
      MANIFEST_DEFINITIONS.find((d) => d.type === 'NEXTLEVELJOBS_HTML')?.payloadFixtures,
    ).toEqual([
      'jobs-sitemap.trimmed.xml',
      'job-security-engineer.html.txt',
      'job-engineering-manager.html.txt',
    ])
  })
})
