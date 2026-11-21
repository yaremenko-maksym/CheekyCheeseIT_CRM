import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile } from '../../../test/source-fixtures'
import { extractJobPostings } from '../../structuring/json-ld'
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
import {
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
  const f = fakeCollectionContext({ now: NOW, responses })
  const asked: string[][] = []
  f.ctx.heldIdentityKeys = async (keys) => {
    asked.push([...keys])
    return held
  }
  const provider = factory(bounds, { sleep: async () => {}, random: () => 0 })
  const batch = await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
  return { batch, f, asked }
}

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
      'https://thehub.io/sitemap-jobs.xml',
      url(ID_SAR),
      url(ID_PEOPLE),
    ])
    expect(f.sent[0]?.maxBytes).toBe(2 * 1024 * 1024)
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
      'https://landing.jobs/sitemap.xml',
      url(ID_AWS),
      url(ID_DAMIA),
    ])
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
      'https://justjoin.it/sitemaps/active-jobs.xml',
      PART_URL,
      url(ID_RITS),
    ])
    expect(f.sent.slice(0, 2).map((r) => r.maxBytes)).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024])
    // One report per sitemap document and one per page: three requests, three reports.
    expect(batch.requests).toHaveLength(3)
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
    expect(f.sent.slice(2).map((r) => r.url)).toEqual([ID_RITS, ID_FIBER, ID_MARSKA].map(url))
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
    expect(f.sent).toHaveLength(1)
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
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.message).toBe('sitemap: root is <sitemapindex>')
  })

  it('parses a full-size part (11 054 URLs, as measured) within its byte and time limits', () => {
    const urls = Array.from(
      { length: 11_054 },
      (_, i) =>
        `<url><loc>https://justjoin.it/job-offer/company-${i}-senior-engineer-warszawa-java</loc><lastmod>2026-11-20T03:00:05+00:00</lastmod></url>`,
    )
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
    expect(xml.length).toBeLessThan(8 * 1024 * 1024)
    expect(jobsOf(JUSTJOIN_SITE, xml)).toHaveLength(11_054)
  })

  it('takes the applyUrl only when it names one ATS-hosted job', () => {
    const ashby = 'https://jobs.ashbyhq.com/acme/0b6f3c1e-1111-4222-8333-444455556666'
    const payload = (u: string) => `\\"applyUrl\\":\\"${u}\\"`
    // As captured (page of 2026-11-20): a traffit form is not an ATS job.
    expect(
      justJoinApplyUrl(payload('https://rits.traffit.com/public/an/2f138fd3a7631c889ef2')),
    ).toBeNull()
    // A URL never holds whitespace: a value that does is not read.
    expect(justJoinApplyUrl(payload(`${ashby} x`))).toBeNull()
    expect(justJoinApplyUrl(payload(ashby))).toBe(ashby)
    expect(justJoinApplyUrl(payload(ashby) + payload(ashby))).toBe(ashby)
    expect(
      justJoinApplyUrl(
        payload('https://boards.greenhouse.io/embed/job_app?for=acme\\u0026token=4012345'),
      ),
    ).toBe('https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345')
    expect(justJoinApplyUrl(payload('https://acme.example/careers/1'))).toBeNull()
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
  })
})
