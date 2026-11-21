import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile } from '../../../test/source-fixtures'
import { extractJobPostings } from '../../structuring/json-ld'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import { itemCeiling, MAX_XML_ELEMENTS } from '../../xml/xml-limits'
import {
  createJustJoinProvider,
  JUSTJOIN_BOUNDS,
  JUSTJOIN_SITE,
  JUSTJOIN_SOURCE_STATUS,
  justJoinAllowedHosts,
  justJoinApplyUrl,
  justJoinProvider,
} from './justjoin.provider'
import {
  createLandingJobsProvider,
  LANDINGJOBS_BOUNDS,
  LANDINGJOBS_SITE,
  LANDINGJOBS_SOURCE_STATUS,
  landingJobsAllowedHosts,
  landingJobsProvider,
} from './landingjobs.provider'
import { NEXTLEVELJOBS_SITE } from './nextleveljobs.provider'
import {
  detailsToReadOf,
  identityUrlOf,
  mapSitePosting,
  parseSitemapOf,
  siteIdentityKey,
  type SitemapJob,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
} from './sitemap-jsonld'
import {
  createTheHubProvider,
  THEHUB_BOUNDS,
  THEHUB_SITE,
  THEHUB_SOURCE_STATUS,
  theHubAllowedHosts,
  theHubProvider,
} from './thehub.provider'

/**
 * The Hub, JustJoin.it and Landing.jobs through their public providers (task sources-13). Every
 * expected value is hand-read from the captures in `__fixtures__/<site>/` (2026-11-20, permitted by
 * the owner's decision of that day; see their provenance files) and written here as a literal.
 */
const NOW = new Date('2026-11-21T09:00:00Z')

/** Every run reads the site's robots.txt first (task sources-16, H-1): an allow-all one. */
const ROBOTS_OK: FakeResponse = { bodyText: 'User-agent: *\nAllow: /\n' }
/** JustJoin.it's sitemaps are requested where they live, its CDN (task sources-16, H-2). */
const JJ_CDN = 'https://public.justjoin.com/justjoinit/sitemaps/'

type Factory = (
  bounds: SitemapJsonLdBounds,
  deps: SitemapJsonLdDeps,
) => ReturnType<typeof createTheHubProvider>

async function run(
  factory: Factory,
  bounds: SitemapJsonLdBounds,
  responses: FakeResponse[],
  held: ReadonlySet<string> = new Set(),
) {
  const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, ...responses] })
  const asked: string[][] = []
  f.ctx.heldIdentityKeys = async (keys) => {
    asked.push([...keys])
    return held
  }
  const provider = factory(bounds, { sleep: async () => {}, random: () => 0 })
  const batch = await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
  return { batch, f, asked }
}

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`

const jobsOf = (site: SitemapJsonLdSite, xml: string): SitemapJob[] => {
  const parsed = parseSitemapOf(site, xml)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.jobs
}

describe('The Hub', () => {
  const SITEMAP = sourceFixtureFile('thehub', 'jobs-sitemap.trimmed.xml')
  const PEOPLE = sourceFixtureFile('thehub', 'job-people-operations-specialist.jsonld.html.txt')
  const SAR = sourceFixtureFile('thehub', 'job-sar-annotation-consultant.jsonld.html.txt')
  const ID_PEOPLE = '6aff948bc0b7b1e5e0d27bfb'
  const ID_SAR = '6aff96e8c0b7b1e5e0d281f1'
  const ID_OTHER = '6afec3d65d235286de8c0285'
  const ID_OLD = '62a7d017bb0f0ff068a8b929'
  const url = (id: string) => `https://thehub.io/jobs/${id}`
  const held = () => new Set([ID_OTHER, ID_OLD].map((id) => siteIdentityKey(THEHUB_SITE, id)))

  it('lists the four job URLs of the fixture in document order', () => {
    expect(jobsOf(THEHUB_SITE, SITEMAP)).toEqual(
      [ID_OTHER, ID_PEOPLE, ID_SAR, ID_OLD].map((id) => ({ id, url: url(id) })),
    )
  })

  it('fetches only the two unseen pages, highest id first, and maps their JSON-LD', async () => {
    const { batch, f } = await run(
      createTheHubProvider,
      THEHUB_BOUNDS,
      [{ bodyText: SITEMAP }, { bodyText: SAR }, { bodyText: PEOPLE }],
      held(),
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://thehub.io/robots.txt',
      'https://thehub.io/sitemap-jobs.xml',
      url(ID_SAR),
      url(ID_PEOPLE),
    ])
    expect(f.sent[1]?.maxBytes).toBe(2 * 1024 * 1024)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.normalized).toBe(2)
    const [sar, people] = batch.observations
    expect(sar?.identity.nativeId).toBe(ID_SAR)
    expect(sar?.normalized.title).toBe('SAR Image Annotation Consultant')
    expect(sar?.normalized.companyName).toBe('ICEYE')
    expect(sar?.normalized.employmentType).toBe('CONTRACTOR')
    expect(sar?.normalized.remote).toBe(true)
    // No employer ATS link on the page: the board page is the posting URL, no application URL.
    expect(sar?.sourcePostingUrl).toBe(url(ID_SAR))
    expect(sar?.applicationUrl).toBeNull()
    expect(sar?.originalFields.description.kind).toBe('html')
    expect(sar?.normalized.dates.map((d) => [d.semantics, d.raw])).toEqual([
      ['PUBLISHED', '2026-11-20T00:40:08.618Z'],
      ['EXPIRY', '2027-05-20'],
    ])
    expect(people?.normalized.title).toBe('People Operations Specialist')
    expect(people?.normalized.companyName).toBe('Veo Technologies')
    expect(people?.normalized.remote).toBeNull()
  })

  it('a page whose identifier names another job is invalid, not taken', async () => {
    const { batch } = await run(
      createTheHubProvider,
      THEHUB_BOUNDS,
      [{ bodyText: SITEMAP }, { bodyText: PEOPLE }, { bodyText: PEOPLE }],
      held(),
    )
    expect(batch.counts.invalid).toBe(1)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ID_PEOPLE])
  })

  it('pins its budget, hosts and readiness', () => {
    expect(THEHUB_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(theHubAllowedHosts()).toEqual(['thehub.io'])
    expect(THEHUB_SOURCE_STATUS.blocked).toBe(false)
    expect(THEHUB_SOURCE_STATUS.permission).toBe('PROHIBITED')
    expect(() => theHubProvider.parseConfig({ configVersion: 1, query: 'x' })).toThrow(
      'The Hub has no search parameter',
    )
  })
})

describe('Landing.jobs', () => {
  const SITEMAP = sourceFixtureFile('landingjobs', 'sitemap.trimmed.xml')
  const AWS = sourceFixtureFile('landingjobs', 'job-aws-cloud-solutions-architect.jsonld.html.txt')
  const DAMIA = sourceFixtureFile(
    'landingjobs',
    'job-application-integration-consultant.jsonld.html.txt',
  )
  const ID_AWS = 'volkswagen-group-digital-solutions-portugal/aws-cloud-solutions-architect'
  const ID_DAMIA = 'damia/application-integration-consultant'
  const url = (id: string) => `https://landing.jobs/at/${id}`

  it('keeps the two job URLs with their lastmod, and skips the listing and company pages', () => {
    expect(jobsOf(LANDINGJOBS_SITE, SITEMAP)).toEqual([
      { id: ID_AWS, url: url(ID_AWS), lastmod: Date.parse('2026-11-20') },
      { id: ID_DAMIA, url: url(ID_DAMIA), lastmod: Date.parse('2026-11-03') },
    ])
  })

  it('fetches newest lastmod first and selects the posting by the slug identifier', async () => {
    const { batch, f } = await run(createLandingJobsProvider, LANDINGJOBS_BOUNDS, [
      { bodyText: SITEMAP },
      { bodyText: AWS },
      { bodyText: DAMIA },
    ])
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://landing.jobs/robots.txt',
      'https://landing.jobs/sitemap.xml',
      url(ID_AWS),
      url(ID_DAMIA),
    ])
    expect(f.sent[1]?.maxBytes).toBe(2 * 1024 * 1024)
    expect(batch.outcome).toBe('SUCCEEDED')
    const [aws, damia] = batch.observations
    expect(aws?.identity.nativeId).toBe(ID_AWS)
    expect(aws?.normalized.title).toBe('AWS Cloud Solutions Architect')
    expect(aws?.normalized.companyName).toBe('Volkswagen Group Digital Solutions [Portugal]')
    expect(aws?.sourcePostingUrl).toBe(url(ID_AWS))
    expect(aws?.applicationUrl).toBeNull()
    expect(damia?.normalized.companyName).toBe('Damia')
    expect(damia?.normalized.dates.map((d) => [d.semantics, d.raw])).toEqual([
      ['PUBLISHED', '2026-09-21'],
      ['EXPIRY', '2027-05-12'],
    ])
  })

  it('pins its budget, hosts and readiness', () => {
    expect(LANDINGJOBS_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(landingJobsAllowedHosts()).toEqual(['landing.jobs'])
    expect(LANDINGJOBS_SOURCE_STATUS.permission).toBe('PROHIBITED')
    expect(() =>
      landingJobsProvider.parseConfig({
        configVersion: 1,
        window: { from: '2026-11-01', to: '2026-11-20' },
      }),
    ).toThrow('Landing.jobs has no date window')
  })
})

describe('JustJoin.it', () => {
  const INDEX = sourceFixtureFile('justjoin', 'active-jobs-index.xml')
  const PART = sourceFixtureFile('justjoin', 'active-jobs-part0.trimmed.xml')
  const PAGE = sourceFixtureFile('justjoin', 'job-fullstack-developer-java-angular.jsonld.html.txt')
  const ID_RITS = 'rits-fullstack-developer-java-angular--warszawa-java'
  const ID_FIBER = 'fibertide-senior-site-reliability-engineer-wroclaw-architecture-232b83ef'
  const ID_MARSKA = 'marska-qa-automation-engineer-krakow-testing'
  const url = (id: string) => `https://justjoin.it/job-offer/${id}`
  const PART_URL = 'https://justjoin.it/sitemaps/active-jobs/part0.xml'
  const held = () => new Set([ID_FIBER, ID_MARSKA].map((id) => siteIdentityKey(JUSTJOIN_SITE, id)))

  it('reads the index, then its one part, then only the unseen page', async () => {
    const { batch, f, asked } = await run(
      createJustJoinProvider,
      JUSTJOIN_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: PART }, { bodyText: PAGE }],
      held(),
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://justjoin.it/robots.txt',
      `${JJ_CDN}active-jobs.xml`,
      `${JJ_CDN}active-jobs/part0.xml`,
      url(ID_RITS),
    ])
    expect(f.sent.slice(1, 3).map((r) => r.maxBytes)).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024])
    // One report per request: robots.txt, each sitemap document and the page.
    expect(batch.requests).toHaveLength(4)
    expect(asked).toEqual([
      [ID_FIBER, ID_MARSKA, ID_RITS].map((id) => siteIdentityKey(JUSTJOIN_SITE, id)),
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe(ID_RITS)
    expect(o.normalized.title).toBe('Fullstack Developer (Java + Angular)')
    expect(o.normalized.companyName).toBe('RITS')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    // No ATS-hosted applyUrl (the live page names a recruiting-agency form): the board page stays.
    expect(o.sourcePostingUrl).toBe(url(ID_RITS))
    expect(o.applicationUrl).toBeNull()
  })

  it('orders unseen jobs by lastmod, newest first', async () => {
    const { f } = await run(createJustJoinProvider, { ...JUSTJOIN_BOUNDS, maxDetails: 3 }, [
      { bodyText: INDEX },
      { bodyText: PART },
      { status: 404 },
      { status: 404 },
      { status: 404 },
    ])
    expect(f.sent.slice(3).map((r) => r.url)).toEqual([ID_RITS, ID_FIBER, ID_MARSKA].map(url))
  })

  it('a page whose canonical link is another job is invalid, not taken', async () => {
    const moved = PAGE.replace(`href="${url(ID_RITS)}"`, `href="${url(ID_FIBER)}"`)
    expect(moved).not.toBe(PAGE)
    const { batch } = await run(
      createJustJoinProvider,
      JUSTJOIN_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: PART }, { bodyText: moved }],
      held(),
    )
    expect(batch.counts.invalid).toBe(1)
    expect(batch.invalidSamples[0]?.reason).toBe('json-ld: none')
  })

  it('an index naming no allowed part fails the run before any other request', async () => {
    const foreign = INDEX.replace(PART_URL, 'https://evil.example/part0.xml')
    const { batch, f } = await run(createJustJoinProvider, JUSTJOIN_BOUNDS, [{ bodyText: foreign }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'sitemap: the index names no allowed child sitemap',
    })
  })

  it('a part that is not a urlset fails the run', async () => {
    const { batch, f } = await run(createJustJoinProvider, JUSTJOIN_BOUNDS, [
      { bodyText: INDEX },
      { bodyText: INDEX },
    ])
    expect(f.sent).toHaveLength(3)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.message).toBe('sitemap: root is <sitemapindex>')
  })

  it('parses a full-size part (11 054 URLs of the real shape) within the caps, with about 1.8x headroom', () => {
    // The captured part's per-URL shape (`loc`, `lastmod`, `changefreq`, `priority`), indented as
    // captured: 5 elements a URL, so 55 271 elements and 55 272 items with the xmlns attribute.
    const urls = Array.from(
      { length: 11_054 },
      (_, i) =>
        `  <url>\n    <loc>https://justjoin.it/job-offer/company-${i}-senior-fullstack-engineer-warszawa-java</loc>\n    <lastmod>2026-11-20T03:00:05+00:00</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
    )
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
    const limits = JUSTJOIN_SITE.sitemapLimits
    const elements = 11_054 * 5 + 1
    // Both caps are the global XML limits or below them: the time budget is 1 000 ms = 100 000
    // items, and the element cap is the memory cap itself.
    expect(limits.maxWallClockMs).toBe(1000)
    expect(itemCeiling(limits)).toBe(100_000)
    expect(limits.maxElements).toBe(MAX_XML_ELEMENTS)
    expect(limits.maxElements).toBeLessThanOrEqual(MAX_XML_ELEMENTS)
    expect(elements).toBeLessThanOrEqual(limits.maxElements)
    expect(elements + 1).toBeLessThanOrEqual(itemCeiling(limits))
    // Measured headroom: about 1.8x, not 3x.
    expect(itemCeiling(limits) / (elements + 1)).toBeGreaterThan(1.8)
    // The captured part was 2 645 173 bytes; the cap stays under the 10 MiB ceiling.
    expect(2_645_173 * 3).toBeLessThanOrEqual(limits.maxBytes)
    expect(limits.maxBytes).toBeLessThan(10 * 1024 * 1024)
    expect(Buffer.byteLength(xml)).toBeLessThan(limits.maxBytes)
    expect(jobsOf(JUSTJOIN_SITE, xml)).toHaveLength(11_054)
  })

  describe("the offer's own applyUrl (CR-M-1, captures of 2026-11-21)", () => {
    const excerpt = (name: string) => sourceFixtureFile('justjoin', `payload-${name}.applyurl.txt`)
    const FIBER = excerpt('fibertide-senior-site-reliability-engineer')
    const MARSKA = excerpt('marska-qa-automation-engineer')
    const RITS = excerpt('rits-fullstack-developer-java-angular')
    const ashby = 'https://jobs.ashbyhq.com/acme/0b6f3c1e-1111-4222-8333-444455556666'
    const jobOf = (id: string): SitemapJob => ({ id, url: url(id) })
    // A captured excerpt with its applyUrl value swapped for `to` (an escaped `\"…\"` string).
    const withApply = (text: string, from: string, to: string) => {
      const out = text.replace(`\\"applyUrl\\":${from}`, `\\"applyUrl\\":\\"${to}\\"`)
      expect(out).not.toBe(text)
      return out
    }
    const FIBER_URL = '\\"https://fibertide.com/joinus-JJ/\\"'

    it('reads the captured links: none of them is an ATS-hosted job, and in-site is null', () => {
      expect(justJoinApplyUrl(FIBER, jobOf(ID_FIBER))).toBeNull()
      expect(justJoinApplyUrl(RITS, jobOf(ID_RITS))).toBeNull()
      expect(MARSKA).toContain('\\"applyUrl\\":null')
      expect(justJoinApplyUrl(MARSKA, jobOf(ID_MARSKA))).toBeNull()
    })

    it("takes this offer's ATS-hosted job, anchored by the slug in its cover image", () => {
      const page = withApply(FIBER, FIBER_URL, ashby)
      expect(justJoinApplyUrl(page, jobOf(ID_FIBER))).toBe(ashby)
      // Upper-case in the payload is the same slug.
      expect(
        justJoinApplyUrl(page.replace(ID_FIBER, ID_FIBER.toUpperCase()), jobOf(ID_FIBER)),
      ).toBe(ashby)
      const greenhouse = 'https://boards.greenhouse.io/embed/job_app?for=acme\\u0026token=4012345'
      expect(justJoinApplyUrl(withApply(FIBER, FIBER_URL, greenhouse), jobOf(ID_FIBER))).toBe(
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345',
      )
    })

    it("a foreign offer's applyUrl is never this offer's: in-site offer plus a foreign ATS link is null", () => {
      const foreign = withApply(FIBER, FIBER_URL, ashby)
      // This offer (MARSKA) applies in-site; the payload also holds another offer's ATS link.
      expect(justJoinApplyUrl(MARSKA + foreign, jobOf(ID_MARSKA))).toBeNull()
      expect(justJoinApplyUrl(foreign + MARSKA, jobOf(ID_MARSKA))).toBeNull()
      // The foreign object's own slug still reads it, so the anchor is what decides.
      expect(justJoinApplyUrl(MARSKA + foreign, jobOf(ID_FIBER))).toBe(ashby)
    })

    it('a bare applyUrl outside the anchored key order reads nothing', () => {
      expect(justJoinApplyUrl(`\\"applyUrl\\":\\"${ashby}\\"`, jobOf(ID_FIBER))).toBeNull()
      const reordered = withApply(FIBER, FIBER_URL, ashby).replace(
        '\\"publishedAt\\"',
        '\\"otherKey\\"',
      )
      expect(justJoinApplyUrl(reordered, jobOf(ID_FIBER))).toBeNull()
    })

    it('two anchored links of this offer: one ATS job is taken, two distinct jobs are null', () => {
      const one = withApply(FIBER, FIBER_URL, ashby)
      expect(justJoinApplyUrl(one + one, jobOf(ID_FIBER))).toBe(ashby)
      const other = withApply(FIBER, FIBER_URL, ashby.replace('acme', 'beta'))
      expect(justJoinApplyUrl(one + other, jobOf(ID_FIBER))).toBeNull()
      // A URL never holds whitespace: a value that does is not read.
      expect(
        justJoinApplyUrl(withApply(FIBER, FIBER_URL, `${ashby} x`), jobOf(ID_FIBER)),
      ).toBeNull()
    })
  })

  it('the captured baseSalary is not read: a mapped posting has no compensation field', () => {
    expect(PAGE).toContain('baseSalary')
    const posting = extractJobPostings(PAGE, { now: NOW }).postings[0]!
    const fields = mapSitePosting(JUSTJOIN_SITE, posting, { id: ID_RITS, url: url(ID_RITS) }, null)
    expect(Object.keys(fields).filter((k) => /salar|compens|pay/i.test(k))).toEqual([])
  })

  it('pins its budget, hosts and readiness', () => {
    expect(JUSTJOIN_BOUNDS).toEqual({ maxDetails: 20, minGapMs: 3000 })
    expect(justJoinAllowedHosts()).toEqual(['justjoin.it', 'public.justjoin.com'])
    expect(JUSTJOIN_SOURCE_STATUS.permission).toBe('PROHIBITED')
    expect(() => justJoinProvider.parseConfig({ configVersion: 1, namespace: 'x' })).toThrow()
    expect(() => justJoinProvider.parseConfig({ configVersion: 1, query: 'x' })).toThrow(
      'JustJoin.it has no search parameter',
    )
  })

  it('takes only a whole part URL of the site, with up to three digits', async () => {
    const xml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
      `https://evil.example/?u=${PART_URL}`,
      `${PART_URL}.bak`,
      'https://justjoin.it/sitemaps/active-jobs/part1234.xml',
      'https://justjoin.it/sitemaps/active-jobs/part12.xml',
    ]
      .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
      .join('')}</sitemapindex>`
    const { f } = await run(createJustJoinProvider, JUSTJOIN_BOUNDS, [
      { bodyText: xml },
      { bodyText: urlset() },
    ])
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://justjoin.it/robots.txt',
      `${JJ_CDN}active-jobs.xml`,
      `${JJ_CDN}active-jobs/part12.xml`,
    ])
  })
})

describe('every site configuration', () => {
  const POSTING = extractJobPostings(
    sourceFixtureFile('thehub', 'job-people-operations-specialist.jsonld.html.txt'),
    { now: NOW },
  ).postings[0]!
  const SITES: [string, SitemapJsonLdSite, string, 'html' | 'text'][] = [
    ['THEHUB_HTML', THEHUB_SITE, 'https://thehub.io/jobs/6aff948bc0b7b1e5e0d27bfb', 'html'],
    [
      'LANDINGJOBS_HTML',
      LANDINGJOBS_SITE,
      'https://landing.jobs/at/damia/application-integration-consultant',
      'html',
    ],
    [
      'JUSTJOIN_HTML',
      JUSTJOIN_SITE,
      'https://justjoin.it/job-offer/marska-qa-automation-engineer-krakow-testing',
      'html',
    ],
    ['NEXTLEVELJOBS_HTML', NEXTLEVELJOBS_SITE, '', 'text'],
  ]

  it.each(SITES)(
    '%s maps a posting as its own source, with its description kind',
    (type, site, _url, kind) => {
      const fields = mapSitePosting(site, POSTING, { id: 'x', url: 'https://x.example/' }, null)
      expect(fields.provider).toBe(type)
      expect(fields.descriptionKind).toBe(kind)
    },
  )

  it.each(SITES.filter(([, , u]) => u !== ''))(
    '%s takes only a whole job URL of the site',
    (_type, site, jobUrl) => {
      expect(jobsOf(site, urlset(jobUrl))).toHaveLength(1)
      expect(jobsOf(site, urlset(`https://evil.example/?u=${jobUrl}`, `${jobUrl}/apply`))).toEqual(
        [],
      )
    },
  )

  const FACTORIES: [string, (bounds: SitemapJsonLdBounds) => ReturnType<Factory>, string][] = [
    ['The Hub', createTheHubProvider, sourceFixtureFile('thehub', 'jobs-sitemap.trimmed.xml')],
    [
      'Landing.jobs',
      createLandingJobsProvider,
      sourceFixtureFile('landingjobs', 'sitemap.trimmed.xml'),
    ],
  ]

  it.each(FACTORIES)('%s waits through its default deps', async (_name, factory, sitemap) => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: sitemap }, { status: 404 }],
    })
    const provider = factory({ maxDetails: 1, minGapMs: 0 })
    await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
    // Without a working sleep the wait fails and the run ends CANCELLED before the sitemap request.
    expect(f.sent).toHaveLength(3)
  })

  it('JustJoin.it waits through its default deps', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        ROBOTS_OK,
        { bodyText: sourceFixtureFile('justjoin', 'active-jobs-index.xml') },
        { bodyText: urlset() },
      ],
    })
    const provider = createJustJoinProvider({ maxDetails: 1, minGapMs: 0 })
    await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
    expect(f.sent).toHaveLength(3)
  })
})

/**
 * PR #1443's second round, carried into the shared core so the trio gets it too (task sources-13
 * rebase r1): the turning offset drawn per run (D-1), the apply-button signal only where a site has
 * a button (D-3), the identity URL (D-4) and a future-dated job never counted toward drift.
 */
describe("the trio has PR #1443's second round", () => {
  const dated = (entries: [string, string | null][]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
      .map(
        ([loc, lastmod]) =>
          `<url><loc>${loc}</loc>${lastmod === null ? '' : `<lastmod>${lastmod}</lastmod>`}</url>`,
      )
      .join('')}</urlset>`
  const hub = (id: string) => `https://thehub.io/jobs/${id}`
  const lj = (n: number) => `https://landing.jobs/at/acme/job-${n}`
  const jj = (n: number) => `https://justjoin.it/job-offer/acme-job-${n}`
  const INDEX = sourceFixtureFile('justjoin', 'active-jobs-index.xml')
  const empty = { bodyText: '<html></html>' }
  const draws = (first: number) => {
    const left = [first]
    return () => left.shift() ?? 0
  }
  async function runWith(
    factory: Factory,
    bounds: SitemapJsonLdBounds,
    responses: FakeResponse[],
    random: () => number,
  ) {
    const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, ...responses] })
    f.ctx.heldIdentityKeys = async () => new Set()
    const provider = factory(bounds, { sleep: async () => {}, random })
    const batch = await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
    return { batch, f }
  }

  it.each([
    ['The Hub', THEHUB_SITE, (i: number) => ({ id: i.toString(16).padStart(24, '0'), url: '' })],
    [
      'Landing.jobs',
      LANDINGJOBS_SITE,
      (i: number) => ({ id: `acme/job-${i}`, url: '', lastmod: i * 1000 }),
    ],
  ] as const)(
    '%s reaches every older unseen job across runs, one draw each (D-1)',
    (_name, site, job) => {
      const jobs = Array.from({ length: 20 }, (_, i) => job(i))
      const picked = (turn: number) =>
        detailsToReadOf(site, jobs, new Set(), 10, turn).map((j) => jobs.indexOf(j))
      // 8 newest (19..12), then 2 of the 12 below from offset floor(turn * 12).
      expect(picked(0.5)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 5, 4])
      const reached = new Set([0, 1, 2, 3, 4, 5].flatMap((k) => picked(k / 6 + 0.01).slice(8)))
      expect([...reached].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    },
  )

  it("JustJoin.it's turning offset is the run's FIRST draw, taken before the part's gap (D-1)", async () => {
    // Six unseen jobs, newest lastmod first: 4 newest, then 1 turning slot among the 2 below.
    const part = dated(
      [6, 5, 4, 3, 2, 1].map((n) => [jj(n), `2026-11-${10 + n}T00:00:00Z`] as [string, string]),
    )
    const responses = (): FakeResponse[] => [
      { bodyText: INDEX },
      { bodyText: part },
      ...Array.from({ length: 5 }, () => ({ status: 404 })),
    ]
    const bounds = { ...JUSTJOIN_BOUNDS, maxDetails: 5 }
    const late = await runWith(createJustJoinProvider, bounds, responses(), draws(0.6))
    expect(late.f.sent.slice(3).map((r) => r.url)).toEqual([6, 5, 4, 3, 1].map(jj))
    const early = await runWith(createJustJoinProvider, bounds, responses(), draws(0))
    expect(early.f.sent.slice(3).map((r) => r.url)).toEqual([6, 5, 4, 3, 2].map(jj))
  })

  it('no trio site has an apply button to miss: a page read whole leaves no sample (D-3)', async () => {
    // The Hub and Landing.jobs link no employer job at all. JustJoin.it's `applyUrl` is `null`
    // whenever the offer applies through JustJoin's own form, so a missing link is no drift signal.
    expect(THEHUB_SITE.hasApplyButton).toBeUndefined()
    expect(LANDINGJOBS_SITE.hasApplyButton).toBeUndefined()
    expect(JUSTJOIN_SITE.hasApplyButton).toBeUndefined()
    expect(NEXTLEVELJOBS_SITE.hasApplyButton?.('<html></html>')).toBe(false)
    const page = sourceFixtureFile(
      'justjoin',
      'job-fullstack-developer-java-angular.jsonld.html.txt',
    )
    const { batch } = await runWith(
      createJustJoinProvider,
      JUSTJOIN_BOUNDS,
      [
        { bodyText: INDEX },
        { bodyText: sourceFixtureFile('justjoin', 'active-jobs-part0.trimmed.xml') },
        { bodyText: page },
        { status: 404 },
        { status: 404 },
      ],
      () => 0,
    )
    expect(batch.counts.normalized).toBe(1)
    expect(batch.invalidSamples).toEqual([])
  })

  it('the identity URL lower-cases the id; an upper-case trio loc is listed by its lower-case id (D-4, S-4)', () => {
    const nlj = 'https://nextleveljobs.eu/companies/a/jobs/6B00BBD80000000000000001'
    expect(identityUrlOf(NEXTLEVELJOBS_SITE, nlj)).toBe(
      'https://nextleveljobs.eu/companies/a/jobs/6b00bbd80000000000000001',
    )
    expect(identityUrlOf(NEXTLEVELJOBS_SITE, 'https://nextleveljobs.eu/companies/a')).toBe(
      'https://nextleveljobs.eu/companies/a',
    )
    for (const [site, listed] of [
      [THEHUB_SITE, hub('6aff948bc0b7b1e5e0d27bfb')],
      [LANDINGJOBS_SITE, lj(1)],
      [JUSTJOIN_SITE, jj(1)],
    ] as const) {
      expect(identityUrlOf(site, listed)).toBe(listed)
      // An upper-case spelling is the same job: listed under the lower-case id, fetched as listed.
      const upper = listed.replace(/[^/]+$/, (id) => id.toUpperCase())
      expect(identityUrlOf(site, upper)).toBe(listed)
      const id = site.jobUrl.exec(listed)![1]!
      expect(jobsOf(site, urlset(upper, listed))).toEqual([
        site.order === 'LASTMOD' ? { id, url: upper, lastmod: null } : { id, url: upper },
      ])
    }
  })

  const upperLoc = (loc: string) => loc.replace(/[^/]+$/, (id) => id.toUpperCase())

  it('The Hub: an upper-case loc and the lower-case JSON-LD identifier make one observation (S-4)', async () => {
    const id = '6aff948bc0b7b1e5e0d27bfb'
    const page = sourceFixtureFile('thehub', 'job-people-operations-specialist.jsonld.html.txt')
    const { batch, f } = await runWith(
      createTheHubProvider,
      THEHUB_BOUNDS,
      [{ bodyText: urlset(upperLoc(hub(id))) }, { bodyText: page }],
      () => 0,
    )
    expect(f.sent[2]?.url).toBe(upperLoc(hub(id)))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.identity.nativeId).toBe(id)
    expect(batch.observations[0]?.sourcePostingUrl).toBe(hub(id))
  })

  it('The Hub: an upper-case loc and an upper-case JSON-LD identifier make one observation with a lower-case nativeId (BP-L-1)', async () => {
    const id = '6aff948bc0b7b1e5e0d27bfb'
    const source = sourceFixtureFile('thehub', 'job-people-operations-specialist.jsonld.html.txt')
    const page = source.replace(`"value":"${id}"`, `"value":"${id.toUpperCase()}"`)
    expect(page).not.toBe(source)
    const { batch, f } = await runWith(
      createTheHubProvider,
      THEHUB_BOUNDS,
      [{ bodyText: urlset(upperLoc(hub(id))) }, { bodyText: page }],
      () => 0,
    )
    expect(f.sent[2]?.url).toBe(upperLoc(hub(id)))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.identity.nativeId).toBe(id)
  })

  it('The Hub select: a posting with no identifier is skipped; an upper-case identifier matches case-insensitively (BP-L-1)', () => {
    const id = '6aff948bc0b7b1e5e0d27bfb'
    const page = sourceFixtureFile('thehub', 'job-people-operations-specialist.jsonld.html.txt')
    const posting = extractJobPostings(page, { now: NOW }).postings[0]!
    const job = { id, url: hub(id) }
    const upper = { ...posting, identifier: id.toUpperCase() }
    const none = { ...posting, identifier: null }
    expect(THEHUB_SITE.select([none, upper], job, page)).toEqual({
      kind: 'match',
      posting: { ...upper, identifier: id },
    })
    expect(THEHUB_SITE.select([none], job, page)).toEqual({ kind: 'none' })
  })

  it('Landing.jobs: an upper-case loc and the lower-case JSON-LD identifier make one observation (S-4)', async () => {
    const id = 'damia/application-integration-consultant'
    const page = sourceFixtureFile(
      'landingjobs',
      'job-application-integration-consultant.jsonld.html.txt',
    )
    const listed = `https://landing.jobs/at/${id}`
    const { batch, f } = await runWith(
      createLandingJobsProvider,
      LANDINGJOBS_BOUNDS,
      [{ bodyText: urlset(upperLoc(listed)) }, { bodyText: page }],
      () => 0,
    )
    expect(f.sent[2]?.url).toBe(upperLoc(listed))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.identity.nativeId).toBe(id)
    expect(batch.observations[0]?.sourcePostingUrl).toBe(listed)
  })

  it('JustJoin.it: an upper-case loc and the lower-case canonical link make one observation (S-4)', async () => {
    const id = 'rits-fullstack-developer-java-angular--warszawa-java'
    const page = sourceFixtureFile(
      'justjoin',
      'job-fullstack-developer-java-angular.jsonld.html.txt',
    )
    const listed = `https://justjoin.it/job-offer/${id}`
    const { batch, f } = await runWith(
      createJustJoinProvider,
      JUSTJOIN_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: urlset(upperLoc(listed)) }, { bodyText: page }],
      () => 0,
    )
    expect(f.sent[3]?.url).toBe(upperLoc(listed))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.identity.nativeId).toBe(id)
    expect(batch.observations[0]?.sourcePostingUrl).toBe(listed)
  })

  it('The Hub: a bad page of an id dated in the future never counts toward drift; one dated now does', async () => {
    const future = [
      '6c00000000000000000000a3',
      '6c00000000000000000000a2',
      '6c00000000000000000000a1',
    ]
    const ahead = await runWith(
      createTheHubProvider,
      { ...THEHUB_BOUNDS, maxDetails: 3 },
      [{ bodyText: urlset(...future.map(hub)) }, empty, empty, empty],
      () => 0,
    )
    expect(ahead.batch.counts.invalid).toBe(3)
    expect(ahead.batch.outcome).toBe('SUCCEEDED')
    expect(ahead.batch.requests.some((r) => r.error?.code === 'PARSE_DRIFT')).toBe(false)
    // NOW is 0x6b015d90 Unix seconds (2026-11-21T09:00:00Z).
    const atNow = [
      '6b015d900000000000000003',
      '6b015d900000000000000002',
      '6b015d900000000000000001',
    ]
    const now = await runWith(
      createTheHubProvider,
      { ...THEHUB_BOUNDS, maxDetails: 3 },
      [{ bodyText: urlset(...atNow.map(hub)) }, empty, empty, empty],
      () => 0,
    )
    expect(now.batch.outcome).toBe('FAILED')
    expect(now.batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('Landing.jobs: a future lastmod never counts toward drift; today and an absent one do', async () => {
    const go = (lastmod: string | null) =>
      runWith(
        createLandingJobsProvider,
        { ...LANDINGJOBS_BOUNDS, maxDetails: 3 },
        [{ bodyText: dated([1, 2, 3].map((n) => [lj(n), lastmod])) }, empty, empty, empty],
        () => 0,
      )
    const ahead = await go('2026-11-23')
    expect(ahead.batch.counts.invalid).toBe(3)
    expect(ahead.batch.outcome).toBe('SUCCEEDED')
    expect((await go('2026-11-21')).batch.outcome).toBe('FAILED')
    expect((await go(null)).batch.outcome).toBe('FAILED')
  })

  it('JustJoin.it: a future lastmod never counts toward drift; one an hour old does', async () => {
    const go = (lastmod: string) =>
      runWith(
        createJustJoinProvider,
        { ...JUSTJOIN_BOUNDS, maxDetails: 3 },
        [
          { bodyText: INDEX },
          { bodyText: dated([1, 2, 3].map((n) => [jj(n), lastmod])) },
          empty,
          empty,
          empty,
        ],
        () => 0,
      )
    const ahead = await go('2026-11-21T09:00:01Z')
    expect(ahead.batch.counts.invalid).toBe(3)
    expect(ahead.batch.outcome).toBe('SUCCEEDED')
    const recent = await go('2026-11-21T08:00:00Z')
    expect(recent.batch.outcome).toBe('FAILED')
    expect(recent.batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('the fixtures the manifest names for each trio site', () => {
  it.each([
    [
      'THEHUB_HTML',
      [
        'jobs-sitemap.trimmed.xml',
        'job-sar-annotation-consultant.jsonld.html.txt',
        'job-people-operations-specialist.jsonld.html.txt',
      ],
    ],
    [
      'LANDINGJOBS_HTML',
      [
        'sitemap.trimmed.xml',
        'job-aws-cloud-solutions-architect.jsonld.html.txt',
        'job-application-integration-consultant.jsonld.html.txt',
      ],
    ],
    [
      'JUSTJOIN_HTML',
      [
        'active-jobs-index.xml',
        'active-jobs-part0.trimmed.xml',
        'job-fullstack-developer-java-angular.jsonld.html.txt',
      ],
    ],
  ])('%s names exactly its captures', (type, fixtures) => {
    expect(MANIFEST_DEFINITIONS.find((d) => d.type === type)?.payloadFixtures).toEqual(fixtures)
  })
})
