import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile } from '../../../test/source-fixtures'
import { roleScopeGate } from '../../funnel/role-scope-gate'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import {
  identityUrlOf,
  parseSitemapOf,
  siteIdentityKey,
  type SitemapJob,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
} from './sitemap-jsonld'
import {
  createJobspressoProvider,
  JOBSPRESSO_BOUNDS,
  JOBSPRESSO_SITE,
  JOBSPRESSO_SOURCE_STATUS,
  jobspressoAllowedHosts,
} from './jobspresso.provider'
import {
  createReactJobsProvider,
  REACTJOBS_BOUNDS,
  REACTJOBS_SITE,
  REACTJOBS_SOURCE_STATUS,
  reactJobsAllowedHosts,
} from './reactjobs.provider'
import {
  createRelocateMeProvider,
  RELOCATEME_BOUNDS,
  RELOCATEME_SITE,
  RELOCATEME_SOURCE_STATUS,
  relocateMeAllowedHosts,
} from './relocateme.provider'
import {
  createRemoteFirstJobsProvider,
  REMOTEFIRSTJOBS_BOUNDS,
  REMOTEFIRSTJOBS_SITE,
  REMOTEFIRSTJOBS_SOURCE_STATUS,
  remoteFirstJobsAllowedHosts,
} from './remotefirstjobs.provider'
import {
  createRemoteIoProvider,
  REMOTEIO_BOUNDS,
  REMOTEIO_SITE,
  REMOTEIO_SOURCE_STATUS,
  remoteIoAllowedHosts,
} from './remoteio.provider'

/**
 * The five wave-3 sitemap + JSON-LD sites through their public providers. Every fixture is a capture
 * of 2026-11-24 (`__fixtures__/<site>/`, see the provenance files); the sitemaps are trimmed to a
 * few whole `<url>` elements and each job page keeps only its canonical link and JSON-LD.
 */
const NOW = new Date('2026-11-24T12:00:00Z')

/** Every run reads the site's robots.txt first: an allow-all one, so only the crawl itself is under test. */
const ROBOTS_OK: FakeResponse = { bodyText: 'User-agent: *\nAllow: /\n' }

type Factory = (
  bounds: SitemapJsonLdBounds,
  deps: SitemapJsonLdDeps,
) => ReturnType<typeof createRelocateMeProvider>

async function run(
  factory: Factory,
  bounds: SitemapJsonLdBounds,
  responses: FakeResponse[],
  site: SitemapJsonLdSite,
  heldIds: string[] = [],
) {
  const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, ...responses] })
  const held = new Set(heldIds.map((id) => siteIdentityKey(site, id)))
  f.ctx.heldIdentityKeys = async () => held
  const provider = factory(bounds, { sleep: async () => {}, random: () => 0 })
  const batch = await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
  return { batch, f }
}

/** Identity and URL only: the `lastmod` of each entry is not what these expectations pin. */
const jobsOf = (site: SitemapJsonLdSite, xml: string): Pick<SitemapJob, 'id' | 'url'>[] => {
  const parsed = parseSitemapOf(site, xml)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.jobs.map(({ id, url }) => ({ id, url }))
}

/** A valid, empty part: Jobspresso lists two job parts, and the collector reads both. */
const EMPTY_PART: FakeResponse = {
  bodyText:
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
}

describe('identityUrlOf', () => {
  // ReactJobs puts the id mid-URL (`/<id>-<slug>`): only the id's own span may change.
  it('keeps a mid-URL id and its slug as they are when the id is already lower-case', () => {
    const url =
      'https://reactjobs.io/react-jobs/lod-technologies-inc/8320-frontend-developer-typescript-react'
    expect(identityUrlOf(REACTJOBS_SITE, url)).toBe(url)
  })

  it('lower-cases the id where it sits, not the tail of the URL', () => {
    const site = { ...REACTJOBS_SITE, jobUrl: /^https:\/\/reactjobs\.io\/j\/([A-Z0-9]+)-[a-z-]+$/ }
    expect(identityUrlOf(site, 'https://reactjobs.io/j/AB12-front-end-react')).toBe(
      'https://reactjobs.io/j/ab12-front-end-react',
    )
  })

  it('does not throw on a jobUrl that already carries the `d` flag, and lower-cases the same span', () => {
    const site = {
      ...REACTJOBS_SITE,
      jobUrl: new RegExp('^https://reactjobs\\.io/j/([A-Z0-9]+)-[a-z-]+$', 'd'),
    }
    expect(identityUrlOf(site, 'https://reactjobs.io/j/AB12-front-end-react')).toBe(
      'https://reactjobs.io/j/ab12-front-end-react',
    )
  })

  it('leaves an already lower-case identity URL unchanged for each wave-3 site', () => {
    const cases: [SitemapJsonLdSite, string][] = [
      [RELOCATEME_SITE, 'https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-10310'],
      [
        REACTJOBS_SITE,
        'https://reactjobs.io/react-jobs/lod-technologies-inc/8320-frontend-developer',
      ],
      [REMOTEFIRSTJOBS_SITE, 'https://remotefirstjobs.com/companies/acme/jobs/backend-engineer-42'],
      [JOBSPRESSO_SITE, 'https://jobspresso.co/job/senior-python-developer/'],
    ]
    for (const [site, url] of cases) {
      expect(identityUrlOf(site, url)).toBe(url)
    }
  })
})

describe('Relocate.me', () => {
  const SITEMAP = sourceFixtureFile('relocateme', 'jobs-sitemap.trimmed.xml')
  const PAGE = sourceFixtureFile(
    'relocateme',
    'job-senior-manager-data-engineering-machine-learning-10310.jsonld.html.txt',
  )
  const url = (id: string) =>
    `https://relocate.me/netherlands/amsterdam/catawiki/${
      {
        '10310': 'senior-manager-data-engineering-machine-learning-10310',
        '10309': 'senior-product-manager-search-ranking-10309',
        '10303': 'lead-security-engineer-10303',
      }[id]
    }`

  it('lists the three job URLs of the fixture in document order', () => {
    expect(jobsOf(RELOCATEME_SITE, SITEMAP)).toEqual(
      ['10310', '10309', '10303'].map((id) => ({ id, url: url(id) })),
    )
  })

  it('fetches only the unseen page and maps its JSON-LD', async () => {
    const { batch, f } = await run(
      createRelocateMeProvider,
      RELOCATEME_BOUNDS,
      [{ bodyText: SITEMAP }, { bodyText: PAGE }],
      RELOCATEME_SITE,
      ['10309', '10303'],
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://relocate.me/robots.txt',
      'https://relocate.me/sitemap-jobs.xml',
      url('10310'),
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe('10310')
    expect(o.normalized.title).toBe('Senior Manager – Data Engineering & Machine Learning')
    expect(o.normalized.companyName).toBe('Catawiki')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    // No employer ATS link on the page: the board page is the posting URL, no application URL.
    expect(o.sourcePostingUrl).toBe(url('10310'))
    expect(o.applicationUrl).toBeNull()
    expect(o.originalFields.description.kind).toBe('html')
  })

  it('fetches exactly maxDetails (25) detail pages when the sitemap lists more unseen jobs', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => {
      const day = 10 + Math.floor(i / 10)
      return `<url><loc>https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-${10000 + i}</loc><lastmod>2026-11-${day}T0${i % 10}:00:00Z</lastmod></url>`
    })
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`
    const pages: FakeResponse[] = Array.from({ length: 25 }, () => ({ bodyText: PAGE }))
    const { f } = await run(
      createRelocateMeProvider,
      RELOCATEME_BOUNDS,
      [{ bodyText: sitemap }, ...pages],
      RELOCATEME_SITE,
    )
    const details = f.sent.filter((r) => r.url.startsWith('https://relocate.me/netherlands/'))
    expect(details).toHaveLength(RELOCATEME_BOUNDS.maxDetails)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://relocate.me/robots.txt',
      'https://relocate.me/sitemap-jobs.xml',
      ...details.map((r) => r.url),
    ])
  })

  it('skips a <loc> on another host: only the on-host job page is fetched', async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://evil.example/netherlands/amsterdam/catawiki/senior-manager-99999</loc></url><url><loc>${url('10310')}</loc></url></urlset>\n`
    expect(jobsOf(RELOCATEME_SITE, sitemap)).toEqual([{ id: '10310', url: url('10310') }])
    const { f } = await run(
      createRelocateMeProvider,
      RELOCATEME_BOUNDS,
      [{ bodyText: sitemap }, { bodyText: PAGE }],
      RELOCATEME_SITE,
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://relocate.me/robots.txt',
      'https://relocate.me/sitemap-jobs.xml',
      url('10310'),
    ])
  })

  it('pins its budget, hosts and readiness', () => {
    expect(RELOCATEME_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(relocateMeAllowedHosts()).toEqual(['relocate.me'])
    expect(RELOCATEME_SOURCE_STATUS.blocked).toBe(false)
    expect(RELOCATEME_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })
})

describe('ReactJobs', () => {
  const INDEX = sourceFixtureFile('reactjobs', 'sitemap-index.xml')
  const PART = sourceFixtureFile('reactjobs', 'sitemap3.trimmed.xml')
  const PAGE = sourceFixtureFile(
    'reactjobs',
    'job-frontend-developer-typescript-react.jsonld.html.txt',
  )
  const URL_8320 =
    'https://reactjobs.io/react-jobs/lod-technologies-inc/8320-frontend-developer-typescript-react'
  const URL_8341 = 'https://reactjobs.io/react-jobs/quartermaster/8341-front-end-software-engineer'

  it('lists the two job URLs of the part in document order', () => {
    expect(jobsOf(REACTJOBS_SITE, PART)).toEqual([
      { id: '8320', url: URL_8320 },
      { id: '8341', url: URL_8341 },
    ])
  })

  it('reads the index, then its job part, then only the unseen page', async () => {
    const { batch, f } = await run(
      createReactJobsProvider,
      REACTJOBS_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: PART }, { bodyText: PAGE }],
      REACTJOBS_SITE,
      ['8341'],
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://reactjobs.io/robots.txt',
      'https://reactjobs.io/sitemap.xml',
      'https://reactjobs.io/sitemap3.xml',
      URL_8320,
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe('8320')
    expect(o.normalized.title).toBe('Frontend Developer (Typescript / React)')
    expect(o.normalized.companyName).toBe('LOD Technologies Inc.')
    expect(o.sourcePostingUrl).toBe(URL_8320)
    expect(o.applicationUrl).toBeNull()
  })

  it('pins its budget, hosts and readiness', () => {
    expect(REACTJOBS_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(reactJobsAllowedHosts()).toEqual(['reactjobs.io'])
    expect(REACTJOBS_SOURCE_STATUS.blocked).toBe(false)
    expect(REACTJOBS_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })
})

describe('Remote.io', () => {
  const SITEMAP = sourceFixtureFile('remoteio', 'sitemap-active-jobs.trimmed.xml')
  const PAGE = sourceFixtureFile(
    'remoteio',
    'job-senior-software-engineer-partner-integrations-at-airbnb.jsonld.html.txt',
  )
  const AIRBNB =
    'https://remote.io/remote-jobs/software-development/senior-software-engineer-partner-integrations-at-airbnb-3491526'
  const CENSYS =
    'https://remote.io/remote-jobs/software-development/systems-engineer-at-censys-3041113'
  const SECURITY =
    'https://remote.io/remote-jobs/devops-sysadmin/staff-it-engineer-security-and-grc-at-securityscorecard-3396730'

  it('keeps only the IT categories of the sitemap, by URL, in document order', () => {
    // The trimmed file keeps the raw document order (censys, securityscorecard, airbnb); marketing is dropped.
    expect(jobsOf(REMOTEIO_SITE, SITEMAP)).toEqual([
      { id: '3041113', url: CENSYS },
      { id: '3396730', url: SECURITY },
      { id: '3491526', url: AIRBNB },
    ])
  })

  it('fetches only the unseen IT page and maps its JSON-LD', async () => {
    const { batch, f } = await run(
      createRemoteIoProvider,
      REMOTEIO_BOUNDS,
      [{ bodyText: SITEMAP }, { bodyText: PAGE }],
      REMOTEIO_SITE,
      ['3041113', '3396730'],
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://remote.io/robots.txt',
      'https://remote.io/sitemap-active-jobs.xml',
      AIRBNB,
    ])
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe('3491526')
    expect(o.normalized.title).toBe('Senior Software Engineer, Partner Integrations')
    expect(o.normalized.companyName).toBe('Airbnb')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    expect(o.normalized.remote).toBe(true)
    expect(o.sourcePostingUrl).toBe(AIRBNB)
    expect(o.applicationUrl).toBeNull()
  })

  it('pins its budget, hosts and readiness', () => {
    expect(REMOTEIO_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(remoteIoAllowedHosts()).toEqual(['remote.io'])
    expect(REMOTEIO_SOURCE_STATUS.blocked).toBe(false)
    expect(REMOTEIO_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })
})

describe('Remote First Jobs', () => {
  const SITEMAP = sourceFixtureFile('remotefirstjobs', 'sitemap-jobs.trimmed.xml')
  const PAGE = sourceFixtureFile(
    'remotefirstjobs',
    'job-director-performance-acceleration-emea-888098.jsonld.html.txt',
  )
  const SHARKNINJA =
    'https://remotefirstjobs.com/companies/sharkninja/jobs/director-performance-acceleration-emea-888098'
  const TITAN_IFA =
    'https://remotefirstjobs.com/companies/titan-wealth-holdings/jobs/senior-ifa-administrator-private-client-888084'
  const TITAN_PLANNER =
    'https://remotefirstjobs.com/companies/titan-wealth-holdings/jobs/associate-financial-planner-888082'

  it('lists the three job URLs of the fixture in document order, id being the slug', () => {
    expect(jobsOf(REMOTEFIRSTJOBS_SITE, SITEMAP)).toEqual([
      { id: 'director-performance-acceleration-emea-888098', url: SHARKNINJA },
      { id: 'senior-ifa-administrator-private-client-888084', url: TITAN_IFA },
      { id: 'associate-financial-planner-888082', url: TITAN_PLANNER },
    ])
  })

  it('fetches only the unseen page and selects it by the slug identifier', async () => {
    const { batch, f } = await run(
      createRemoteFirstJobsProvider,
      REMOTEFIRSTJOBS_BOUNDS,
      [{ bodyText: SITEMAP }, { bodyText: PAGE }],
      REMOTEFIRSTJOBS_SITE,
      ['senior-ifa-administrator-private-client-888084', 'associate-financial-planner-888082'],
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://remotefirstjobs.com/robots.txt',
      'https://remotefirstjobs.com/sitemap_jobs_0.xml',
      SHARKNINJA,
    ])
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe('director-performance-acceleration-emea-888098')
    expect(o.normalized.title).toBe('Director, Performance Acceleration, EMEA')
    expect(o.normalized.companyName).toBe('SharkNinja')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    expect(o.normalized.remote).toBe(true)
    expect(o.sourcePostingUrl).toBe(SHARKNINJA)
    expect(o.applicationUrl).toBeNull()
  })

  it('pins its budget, hosts and readiness', () => {
    expect(REMOTEFIRSTJOBS_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(remoteFirstJobsAllowedHosts()).toEqual(['remotefirstjobs.com'])
    expect(REMOTEFIRSTJOBS_SOURCE_STATUS.blocked).toBe(false)
    expect(REMOTEFIRSTJOBS_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })
})

describe('Jobspresso', () => {
  const INDEX = sourceFixtureFile('jobspresso', 'sitemap-index.xml')
  const PART = sourceFixtureFile('jobspresso', 'job-listing-sitemap1.trimmed.xml')
  const PAGE = sourceFixtureFile('jobspresso', 'job-jr-ui-developer.jsonld.html.txt')
  const JR = 'https://jobspresso.co/job/jr-ui-developer/'
  const BACKEND = 'https://jobspresso.co/job/backend-engineer-knowledge-graph/'

  it('drops the jobs archive page of the part: only the job URLs are kept, in document order', () => {
    expect(jobsOf(JOBSPRESSO_SITE, PART)).toEqual([
      { id: 'jr-ui-developer', url: JR },
      { id: 'backend-engineer-knowledge-graph', url: BACKEND },
    ])
  })

  it('reads the index, then its job part, then only the unseen page', async () => {
    const { batch, f } = await run(
      createJobspressoProvider,
      JOBSPRESSO_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: PART }, EMPTY_PART, { bodyText: PAGE }],
      JOBSPRESSO_SITE,
      ['backend-engineer-knowledge-graph'],
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://jobspresso.co/robots.txt',
      'https://jobspresso.co/sitemap_index.xml',
      'https://jobspresso.co/job_listing-sitemap1.xml',
      'https://jobspresso.co/job_listing-sitemap2.xml',
      JR,
    ])
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]!
    expect(o.identity.nativeId).toBe('jr-ui-developer')
    expect(o.normalized.title).toBe('Jr. UI Developer')
    expect(o.normalized.companyName).toBe('RainFocus')
    expect(o.normalized.employmentType).toBe('FULL_TIME')
    expect(o.normalized.remote).toBe(true)
    // The shared canonicalizer (canonicalizePostingUrl) drops the trailing slash of every posting URL.
    expect(o.sourcePostingUrl).toBe('https://jobspresso.co/job/jr-ui-developer')
    expect(o.applicationUrl).toBeNull()
  })

  it('a page whose canonical link is another job is invalid, not taken', async () => {
    const otherPage = PAGE.replace(JR, 'https://jobspresso.co/job/other-job/')
    const { batch } = await run(
      createJobspressoProvider,
      JOBSPRESSO_BOUNDS,
      [{ bodyText: INDEX }, { bodyText: PART }, EMPTY_PART, { bodyText: otherPage }],
      JOBSPRESSO_SITE,
      ['backend-engineer-knowledge-graph'],
    )
    expect(batch.counts.invalid).toBe(1)
    expect(batch.observations).toEqual([])
  })

  it('pins its budget, hosts and readiness', () => {
    expect(JOBSPRESSO_BOUNDS).toEqual({ maxDetails: 25, minGapMs: 3000 })
    expect(jobspressoAllowedHosts()).toEqual(['jobspresso.co'])
    expect(JOBSPRESSO_SOURCE_STATUS.blocked).toBe(false)
    expect(JOBSPRESSO_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })
})

/**
 * Round-2 finding 1: the four uncategorised sites rely on the recompute-path role-scope gate
 * (funnel/role-scope-gate.ts) to drop non-IT postings. Each case below runs the provider's own sitemap
 * and job page through its real `run()` path. Only the page's JSON-LD `title` is swapped, so the title
 * the gate judges is the one the provider's mapper delivered, not a string written into the spec.
 */
const withJsonLdTitle = (page: string, title: string): string =>
  page.replace(/"title":"(?:[^"\\]|\\.)*"/, `"title":${JSON.stringify(title)}`)

type MapTitle = (title: string) => Promise<string | undefined>

const mapRelocateMeTitle: MapTitle = async (title) => {
  const page = withJsonLdTitle(
    sourceFixtureFile(
      'relocateme',
      'job-senior-manager-data-engineering-machine-learning-10310.jsonld.html.txt',
    ),
    title,
  )
  const sitemap = sourceFixtureFile('relocateme', 'jobs-sitemap.trimmed.xml')
  const { batch } = await run(
    createRelocateMeProvider,
    RELOCATEME_BOUNDS,
    [{ bodyText: sitemap }, { bodyText: page }],
    RELOCATEME_SITE,
    ['10309', '10303'],
  )
  return batch.observations[0]?.normalized.title
}

const mapReactJobsTitle: MapTitle = async (title) => {
  const page = withJsonLdTitle(
    sourceFixtureFile('reactjobs', 'job-frontend-developer-typescript-react.jsonld.html.txt'),
    title,
  )
  const { batch } = await run(
    createReactJobsProvider,
    REACTJOBS_BOUNDS,
    [
      { bodyText: sourceFixtureFile('reactjobs', 'sitemap-index.xml') },
      { bodyText: sourceFixtureFile('reactjobs', 'sitemap3.trimmed.xml') },
      { bodyText: page },
    ],
    REACTJOBS_SITE,
    ['8341'],
  )
  return batch.observations[0]?.normalized.title
}

const mapRemoteFirstJobsTitle: MapTitle = async (title) => {
  const page = withJsonLdTitle(
    sourceFixtureFile(
      'remotefirstjobs',
      'job-director-performance-acceleration-emea-888098.jsonld.html.txt',
    ),
    title,
  )
  const sitemap = sourceFixtureFile('remotefirstjobs', 'sitemap-jobs.trimmed.xml')
  const { batch } = await run(
    createRemoteFirstJobsProvider,
    REMOTEFIRSTJOBS_BOUNDS,
    [{ bodyText: sitemap }, { bodyText: page }],
    REMOTEFIRSTJOBS_SITE,
    ['senior-ifa-administrator-private-client-888084', 'associate-financial-planner-888082'],
  )
  return batch.observations[0]?.normalized.title
}

const mapJobspressoTitle: MapTitle = async (title) => {
  const page = withJsonLdTitle(
    sourceFixtureFile('jobspresso', 'job-jr-ui-developer.jsonld.html.txt'),
    title,
  )
  const { batch } = await run(
    createJobspressoProvider,
    JOBSPRESSO_BOUNDS,
    [
      { bodyText: sourceFixtureFile('jobspresso', 'sitemap-index.xml') },
      { bodyText: sourceFixtureFile('jobspresso', 'job-listing-sitemap1.trimmed.xml') },
      EMPTY_PART,
      { bodyText: page },
    ],
    JOBSPRESSO_SITE,
    ['backend-engineer-knowledge-graph'],
  )
  return batch.observations[0]?.normalized.title
}

const SOFTWARE_ROSTER = new Set(['SOFTWARE_ENGINEER'] as const)
const gateOf = (title: string) =>
  roleScopeGate({ title, tags: [], layer1Rejected: false, reachable: SOFTWARE_ROSTER })

const WAVE3_MAPPERS: [string, MapTitle][] = [
  ['Relocate.me', mapRelocateMeTitle],
  ['ReactJobs', mapReactJobsTitle],
  ['Remote First Jobs', mapRemoteFirstJobsTitle],
  ['Jobspresso', mapJobspressoTitle],
]

describe('role-scope gate judges the title each uncategorised provider maps from its own job page', () => {
  it.each([
    ['Relocate.me', 'Senior Accountant'],
    ['ReactJobs', 'Sales Development Representative'],
    ['Remote First Jobs', 'Customer Success Manager'],
    ['Jobspresso', 'Marketing Manager'],
  ])('%s: a non-IT title is mapped as written and gated OUT_OF_SCOPE', async (name, title) => {
    const mapTitle = WAVE3_MAPPERS.find(([n]) => n === name)?.[1]
    expect(mapTitle).toBeDefined()
    const mapped = await mapTitle!(title)
    expect(mapped).toBe(title)
    expect(gateOf(mapped ?? '')).toBe('OUT_OF_SCOPE')
  })

  it.each(
    WAVE3_MAPPERS.flatMap(([name]) =>
      ['Senior Software Engineer', 'Full Stack Engineer (TypeScript)'].map((title) => [
        name,
        title,
      ]),
    ),
  )(
    '%s: an IT title %s is mapped as written and still reaches the AI as PENDING',
    async (name, title) => {
      const mapTitle = WAVE3_MAPPERS.find(([n]) => n === name)?.[1]
      expect(mapTitle).toBeDefined()
      const mapped = await mapTitle!(title)
      expect(mapped).toBe(title)
      expect(gateOf(mapped ?? '')).toBe('PENDING')
    },
  )

  // Known limit, stated rather than hidden: the Relocate.me fixture is a real data-engineering posting, and the
  // software-engineer roster treats "Data" as a non-software term, so the gate drops it as OUT_OF_SCOPE.
  it('Relocate.me fixture title (Data Engineering) is gated OUT_OF_SCOPE under the software roster', async () => {
    const mapped = await mapRelocateMeTitle('Senior Manager – Data Engineering & Machine Learning')
    expect(mapped).toBe('Senior Manager – Data Engineering & Machine Learning')
    expect(gateOf(mapped ?? '')).toBe('OUT_OF_SCOPE')
  })
})

/** A `<urlset>` of the given locs, in order. */
const urlsetOf = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join('')}</urlset>\n`

/** A `<sitemapindex>` of the given child sitemap locs, in order. */
const indexOf = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join('')}</sitemapindex>\n`

describe('wave-3 site records name what their mutants would change', () => {
  it.each([
    ['Relocate.me', RELOCATEME_SITE, 'RELOCATEME_HTML', 'relocateme'],
    ['ReactJobs', REACTJOBS_SITE, 'REACTJOBS_HTML', 'reactjobs'],
    ['Remote.io', REMOTEIO_SITE, 'REMOTEIO_HTML', 'remoteio'],
    ['Remote First Jobs', REMOTEFIRSTJOBS_SITE, 'REMOTEFIRSTJOBS_HTML', 'remotefirstjobs'],
    ['Jobspresso', JOBSPRESSO_SITE, 'JOBSPRESSO_HTML', 'jobspresso'],
  ])('%s: its type, namespace, LASTMOD order and HTML description', (_label, site, type, ns) => {
    expect(site.type).toBe(type)
    expect(site.namespace).toBe(ns)
    expect(site.order).toBe('LASTMOD')
    expect(site.descriptionKind).toBe('html')
  })

  it.each([
    ['Relocate.me', () => createRelocateMeProvider()],
    ['ReactJobs', () => createReactJobsProvider()],
    ['Remote.io', () => createRemoteIoProvider()],
    ['Remote First Jobs', () => createRemoteFirstJobsProvider()],
    ['Jobspresso', () => createJobspressoProvider()],
  ])('%s: a search parameter is refused under the provider’s own name', (name, make) => {
    expect(() => make().parseConfig({ configVersion: 1, query: 'x' })).toThrow(
      `${name} has no search parameter`,
    )
  })
})

describe('wave-3 job-URL patterns take their own URL and refuse junk around it', () => {
  // The junk before (a foreign host prefix) kills a dropped `^`; the junk after (a path tail) kills a dropped `$`.
  it.each([
    [
      'Relocate.me',
      RELOCATEME_SITE,
      'https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-10310',
      'https://evil.example/https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-10001',
      'https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-10002/extra',
    ],
    [
      'ReactJobs',
      REACTJOBS_SITE,
      'https://reactjobs.io/react-jobs/lod-technologies-inc/8320-frontend-developer',
      'https://evil.example/https://reactjobs.io/react-jobs/lod-technologies-inc/8321-frontend-developer',
      'https://reactjobs.io/react-jobs/lod-technologies-inc/8322-frontend-developer/extra',
    ],
    [
      'Remote.io',
      REMOTEIO_SITE,
      'https://remote.io/remote-jobs/software-development/systems-engineer-at-censys-3041113',
      'https://evil.example/https://remote.io/remote-jobs/data/junk-3041114',
      'https://remote.io/remote-jobs/data/junk-3041115/extra',
    ],
    [
      'Remote First Jobs',
      REMOTEFIRSTJOBS_SITE,
      'https://remotefirstjobs.com/companies/acme/jobs/backend-engineer-42',
      'https://evil.example/https://remotefirstjobs.com/companies/acme/jobs/junk-43',
      'https://remotefirstjobs.com/companies/acme/jobs/junk-44/extra',
    ],
    [
      'Jobspresso',
      JOBSPRESSO_SITE,
      'https://jobspresso.co/job/jr-ui-developer/',
      'https://evil.example/https://jobspresso.co/job/junk-a/',
      'https://jobspresso.co/job/junk-b/extra',
    ],
  ])('%s: only the job page itself is listed', (_label, site, valid, before, after) => {
    expect(jobsOf(site, urlsetOf([before, valid, after])).map((j) => j.url)).toEqual([valid])
  })
})

describe('wave-3 child sitemaps: only the site’s own part names are read', () => {
  it('Jobspresso reads its two job-listing parts and no look-alike sitemap', async () => {
    const index = indexOf([
      'https://evil.example/https://jobspresso.co/job_listing-sitemap1.xml',
      'https://jobspresso.co/job_listing-sitemap1.xml.bak',
      'https://jobspresso.co/job_listing-sitemap1.xml',
      'https://jobspresso.co/job_listing-sitemap2.xml',
    ])
    const { f } = await run(
      createJobspressoProvider,
      JOBSPRESSO_BOUNDS,
      [{ bodyText: index }, EMPTY_PART, EMPTY_PART],
      JOBSPRESSO_SITE,
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://jobspresso.co/robots.txt',
      'https://jobspresso.co/sitemap_index.xml',
      'https://jobspresso.co/job_listing-sitemap1.xml',
      'https://jobspresso.co/job_listing-sitemap2.xml',
    ])
  })

  it('ReactJobs reads its one sitemap3 part and no look-alike sitemap', async () => {
    const index = indexOf([
      'https://evil.example/https://reactjobs.io/sitemap3.xml',
      'https://reactjobs.io/sitemap3.xml.bak',
      'https://reactjobs.io/sitemap3.xml',
    ])
    const { f } = await run(
      createReactJobsProvider,
      REACTJOBS_BOUNDS,
      [{ bodyText: index }, EMPTY_PART],
      REACTJOBS_SITE,
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://reactjobs.io/robots.txt',
      'https://reactjobs.io/sitemap.xml',
      'https://reactjobs.io/sitemap3.xml',
    ])
  })
})

describe('Relocate.me detail order', () => {
  it('details the newest job first, not the first one listed in the sitemap', async () => {
    // Ids 10000..10029; lastmod rises with the id, so 10029 is the newest and listed last.
    const entries = Array.from({ length: 30 }, (_, i) => {
      const day = 10 + Math.floor(i / 10)
      return `<url><loc>https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-${10000 + i}</loc><lastmod>2026-11-${day}T0${i % 10}:00:00Z</lastmod></url>`
    })
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`
    const page = sourceFixtureFile(
      'relocateme',
      'job-senior-manager-data-engineering-machine-learning-10310.jsonld.html.txt',
    )
    const pages: FakeResponse[] = Array.from({ length: 25 }, () => ({ bodyText: page }))
    const { f } = await run(
      createRelocateMeProvider,
      RELOCATEME_BOUNDS,
      [{ bodyText: sitemap }, ...pages],
      RELOCATEME_SITE,
    )
    const details = f.sent
      .map((r) => r.url)
      .filter((u) => u.startsWith('https://relocate.me/netherlands/'))
    expect(details[0]).toBe(
      'https://relocate.me/netherlands/amsterdam/catawiki/senior-manager-10029',
    )
  })
})

describe('wave-3 manifest entries name exactly their captures', () => {
  it.each([
    [
      'RELOCATEME_HTML',
      [
        'jobs-sitemap.trimmed.xml',
        'job-senior-manager-data-engineering-machine-learning-10310.jsonld.html.txt',
      ],
    ],
    [
      'REACTJOBS_HTML',
      [
        'sitemap-index.xml',
        'sitemap3.trimmed.xml',
        'job-frontend-developer-typescript-react.jsonld.html.txt',
      ],
    ],
    [
      'REMOTEIO_HTML',
      [
        'sitemap-active-jobs.trimmed.xml',
        'job-senior-software-engineer-partner-integrations-at-airbnb.jsonld.html.txt',
      ],
    ],
    [
      'REMOTEFIRSTJOBS_HTML',
      [
        'sitemap-jobs.trimmed.xml',
        'job-director-performance-acceleration-emea-888098.jsonld.html.txt',
      ],
    ],
    [
      'JOBSPRESSO_HTML',
      [
        'sitemap-index.xml',
        'job-listing-sitemap1.trimmed.xml',
        'job-jr-ui-developer.jsonld.html.txt',
      ],
    ],
  ])('%s names exactly its captures', (type, fixtures) => {
    expect(MANIFEST_DEFINITIONS.find((d) => d.type === type)?.payloadFixtures).toEqual(fixtures)
  })
})
