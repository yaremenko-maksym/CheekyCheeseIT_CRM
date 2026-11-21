import { describe, expect, it, vi } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile, sourceProvenance } from '../../../test/source-fixtures'
import { extractJobPostings } from '../../structuring/json-ld'
import { RobotsPolicy } from '../../structuring/robots-policy'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import { ROBOTS_PRODUCT_TOKEN } from './listing-detail.collector'
import { siteIdentityKey } from './sitemap-jsonld'
import {
  createNofluffProvider,
  mapNofluffPosting,
  NOFLUFF_BOUNDS,
  NOFLUFF_LISTING_URLS,
  NOFLUFF_REQUESTS_PER_RUN,
  NOFLUFF_SOURCE,
  NOFLUFF_SOURCE_STATUS,
  nofluffAllowedHosts,
  nofluffProvider,
  type NofluffItem,
  parseNofluffListing,
  serverStateOf,
  selectNofluffPosting,
} from './nofluff.provider'

/**
 * No Fluff Jobs through its public provider. Every expected value is hand-read from the captures
 * in `__fixtures__/nofluff/` (2026-11-21, permitted by the owner's decision of 2026-11-20; see
 * their provenance files) and written here as a literal, never produced by running the mapper.
 *
 * The listing fixture keeps `USER_COUNTRY` and the one postings container of `/pl/backend?page=2`,
 * cut to its first 3 postings; the detail page is the second one's.
 */
const NOW = new Date('2026-11-21T10:00:00Z')
const LISTING = sourceFixtureFile('nofluff', 'backend-listing.trimmed.html.txt')
const DETAIL = sourceFixtureFile('nofluff', 'job-detail.trimmed.html.txt')
const ROBOTS = sourceFixtureFile('nofluff', 'robots.txt')

const job = (slug: string) => `https://nofluffjobs.com/pl/job/${slug}`
const URL = job('senior-software-engineer-with-python-codilime-remote-2')
const ITEM: NofluffItem = {
  id: 'SKQKAXAX',
  url: URL,
  title: 'Senior Software Engineer with Python',
  companyName: 'CodiLime',
  cities: ['Warszawa'],
  remote: true,
  seniority: 'Senior',
  tags: ['Python', 'AI', 'Testing', 'API'],
  postedMs: 1795042898186,
  salary: { min: 20500, max: 30000, currency: 'PLN', period: 'MONTH' },
}

const state = (value: unknown) =>
  `<script id="serverApp-state" type="application/json">${JSON.stringify(value)}</script>`
const container = (postings: unknown) => ({ h1: { postings, totalPages: 1 } })
const posting = (reference: string, extra: Record<string, unknown> = {}) => ({
  reference,
  url: 'a-job',
  ...extra,
})

describe('the listing', () => {
  it('reads the postings of the capture, in page order', () => {
    expect(parseNofluffListing(LISTING)).toEqual({
      ok: true,
      items: [
        {
          id: 'M4C7FU9G',
          url: job('administrator-systemow-platformy-sas-k-m-astek-polska-remote'),
          title: 'Administrator Systemów / Platformy SAS K/M',
          companyName: 'ASTEK Polska',
          cities: ['Warszawa'],
          remote: true,
          seniority: 'Senior',
          tags: ['Linux', 'Unix', 'AIX', 'Windows Server'],
          postedMs: 1794870503805,
          salary: null,
        },
        ITEM,
        {
          id: 'YHBOCECA',
          url: job('automation-tester-qa-java-scalo-remote-25'),
          title: 'Automation Tester/QA (Java)',
          companyName: 'Scalo',
          cities: ['Warszawa'],
          remote: true,
          seniority: 'Mid',
          tags: ['Selenium', 'Java', 'Git', 'Jenkins'],
          postedMs: 1795042877885,
          salary: { min: 110, max: 120, currency: 'PLN', period: 'HOUR' },
        },
      ],
      skipped: [],
    })
  })

  it('a posting with only its id and slug maps the rest to empty', () => {
    expect(parseNofluffListing(state(container([posting('ABCD1234')])))).toEqual({
      ok: true,
      items: [
        {
          id: 'ABCD1234',
          url: job('a-job'),
          title: null,
          companyName: null,
          cities: [],
          remote: false,
          seniority: null,
          tags: [],
          postedMs: null,
          salary: null,
        },
      ],
      skipped: [],
    })
  })

  it('cities are unique, without "Remote", and a place without a city is skipped', () => {
    const places = [
      { city: 'Kraków' },
      { city: 'Remote' },
      {},
      { city: 'Kraków' },
      { city: 'Gdańsk' },
    ]
    const parsed = parseNofluffListing(
      state(container([posting('ABCD1234', { location: { places } })])),
    )
    expect(parsed.ok && [parsed.items[0]!.cities, parsed.items[0]!.remote]).toEqual([
      ['Kraków', 'Gdańsk'],
      true,
    ])
  })

  it.each([
    ['no state script', '<html></html>', 'no serverApp-state script'],
    [
      'state that is not JSON',
      '<script id="serverApp-state" type="application/json">{nope</script>',
      'serverApp-state is not JSON',
    ],
    ['state that is not an object', state(null), 'state is not an object'],
    ['state that is a number', state(5), 'state is not an object'],
    ['no container', state({ USER_COUNTRY: { isoCode: 'UA' } }), '0 posting lists'],
    [
      'two containers',
      state({ ...container([]), h2: { postings: [], totalPages: 1 } }),
      '2 posting lists',
    ],
    ['postings that is not an array', state(container({})), 'postings is not an array'],
    ['only a bad reference', state(container([posting('bad ref')])), 'no valid job of 1'],
    ['a reference with a prefix', state(container([posting('xABCD')])), 'no valid job of 1'],
    ['a reference with a suffix', state(container([posting('ABCDx')])), 'no valid job of 1'],
    [
      'a slug with a path after it',
      state(container([posting('ABCD1234', { url: 'a-job/../x' })])),
      'no valid job of 1',
    ],
    ['an empty list', state(container([])), 'no valid job of 0'],
    [
      'most postings malformed',
      state(container([posting('ABCD1234'), posting('ABCD1235', { url: '../x' }), posting('bad')])),
      '2 of 3 jobs malformed',
    ],
  ])('fails on drift: %s', (_name, html, message) => {
    expect(parseNofluffListing(html)).toEqual({ ok: false, message })
  })

  it('skips a malformed posting and keeps the rest (CR-L-2)', () => {
    const parsed = parseNofluffListing(
      state(
        container([posting('ABCD1234'), posting('ABCD1235', { url: '../x' }), posting('ABCD1236')]),
      ),
    )
    expect(parsed.ok && parsed.items.map((i) => i.id)).toEqual(['ABCD1234', 'ABCD1236'])
    expect(parsed.ok && parsed.skipped).toEqual(['posting 1 is malformed'])
  })

  it('reads the first server-state script by indexOf; one without its end is none', () => {
    expect(serverStateOf(`x${state(1)}${state(2)}`)).toBe('1')
    expect(serverStateOf('<script id="serverApp-state" type="application/json">{"a":1}')).toBe(
      undefined,
    )
    expect(serverStateOf('')).toBe(undefined)
    // The closer sits past the opener's length, so a scan from a missing opener would reach it.
    expect(serverStateOf(`<p>${'no state here '.repeat(8)}</p></script>`)).toBe(undefined)
  })

  it('parses 4 MiB of repeated state openers in linear time (NU-M-1)', () => {
    const opener = '<script id="serverApp-state" type="application/json">'
    const adversarial = opener.repeat(Math.ceil((4 * 1024 * 1024) / opener.length))
    const started = performance.now()
    expect(parseNofluffListing(adversarial)).toEqual({
      ok: false,
      message: 'no serverApp-state script',
    })
    // The lazy regex took 44 s on this input; a linear scan takes a few ms.
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('its created time is the listing posted time', () => {
    expect(NOFLUFF_SOURCE.createdAtMs(ITEM)).toBe(1795042898186)
  })

  it('a location without places has no cities', () => {
    const parsed = parseNofluffListing(state(container([posting('ABCD1234', { location: {} })])))
    expect(parsed.ok && parsed.items[0]!.cities).toEqual([])
  })

  it('only an object holding postings and totalPages is a container', () => {
    const parsed = parseNofluffListing(
      state({ a: 'x', b: null, c: { other: 1 }, ...container([posting('ABCD1234')]) }),
    )
    expect(parsed.ok && parsed.items.map((i) => i.id)).toEqual(['ABCD1234'])
  })

  it('a container needs totalPages beside postings', () => {
    expect(parseNofluffListing(state({ h1: { postings: [] } }))).toEqual({
      ok: false,
      message: '0 posting lists',
    })
  })
})

describe('the listing salary (sources-17)', () => {
  const salaryOfPosting = (salary: unknown) => {
    const parsed = parseNofluffListing(state(container([posting('ABCD1234', { salary })])))
    return parsed.ok ? parsed.items[0]?.salary : 'not ok'
  }

  it('maps Year; a day rate, no currency or a text amount is no salary, and the posting stays', () => {
    expect(salaryOfPosting({ from: 200000, to: null, currency: 'EUR', period: 'Year' })).toEqual({
      min: 200000,
      max: null,
      currency: 'EUR',
      period: 'YEAR',
    })
    expect(salaryOfPosting({ from: 1000, to: 1200, currency: 'PLN', period: 'Day' })).toBe(null)
    expect(salaryOfPosting({ from: 1000, to: 1200, currency: null, period: 'Month' })).toBe(null)
    expect(salaryOfPosting({ from: '1k', to: '2k', currency: 'PLN', period: 'Month' })).toBe(null)
    expect(salaryOfPosting('negotiable')).toBe(null)
  })
})

describe('the detail page', () => {
  const postings = () => extractJobPostings(DETAIL, { now: NOW }).postings

  it('selects the one JobPosting of the listed page and maps it', () => {
    const selected = selectNofluffPosting(postings(), DETAIL, ITEM)
    expect(selected.kind).toBe('match')
    if (!('posting' in selected)) return
    const mapped = mapNofluffPosting(selected.posting, ITEM)
    expect({ ...mapped, description: mapped.description?.slice(0, 25) }).toEqual({
      provider: 'NOFLUFF_HTML',
      adapterVersion: 'nofluff-2',
      namespace: 'nofluff',
      nativeId: 'SKQKAXAX',
      url: URL,
      title: 'Senior Software Engineer with Python',
      companyName: 'CodiLime',
      location: 'Warszawa',
      description: '<h3>Get to know us better',
      descriptionKind: 'html',
      remote: true,
      employmentType: 'CONTRACTOR',
      seniorityHint: 'Senior',
      tags: ['Python', 'AI', 'Testing', 'API'],
      applicationUrl: null,
      dates: [{ raw: 1795042898186, contract: 'UNIX_MILLISECONDS', semantics: 'PUBLISHED' }],
      salary: { min: 20500, max: 30000, currency: 'PLN', period: 'MONTH' },
    })
  })

  it('the listing is the only salary source; the JSON-LD baseSalary (the range top) is never used (sources-17)', () => {
    const one = postings()[0]!
    expect(one.baseSalary).toEqual({ min: 30000, max: 30000, currency: 'PLN', period: 'MONTH' })
    expect(mapNofluffPosting(one, ITEM).salary).toEqual(ITEM.salary)
    expect(mapNofluffPosting(one, { ...ITEM, salary: null }).salary).toBe(null)
  })

  it('a Day listing + JSON-LD baseSalary MONTH -> salary null (sources-17)', () => {
    const parsed = parseNofluffListing(
      state(
        container([
          posting('ABCD1234', { salary: { from: 1000, to: 1200, currency: 'PLN', period: 'Day' } }),
        ]),
      ),
    )
    if (!parsed.ok) throw new Error('listing not ok')
    const day = parsed.items[0]!
    expect(day.salary).toBe(null)
    expect(mapNofluffPosting(postings()[0]!, day).salary).toBe(null)
  })

  it('refuses a page whose canonical link is another posting, or missing', () => {
    const other = { ...ITEM, url: job('another') }
    // main's selectByCanonical (CR-L-3): a foreign or missing canonical link is `none`.
    expect(selectNofluffPosting(postings(), DETAIL, other)).toEqual({ kind: 'none' })
    expect(selectNofluffPosting(postings(), '<html></html>', ITEM)).toEqual({ kind: 'none' })
  })

  it('a canonical link without href is not the listed page', () => {
    expect(selectNofluffPosting(postings(), '<link rel="canonical">', ITEM)).toEqual({
      kind: 'none',
    })
  })

  it('reads the canonical link whatever the attribute order', () => {
    const html = `<link href="${URL}" rel="canonical">`
    expect(selectNofluffPosting(postings(), html, ITEM).kind).toBe('match')
  })

  it('needs exactly one JobPosting on the listed page', () => {
    const one = postings()[0]!
    expect(selectNofluffPosting([], DETAIL, ITEM)).toEqual({ kind: 'none' })
    expect(selectNofluffPosting([one, one], DETAIL, ITEM)).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('falls back to the listing; no city, no remote, no date map to null and empty', () => {
    const one = postings()[0]!
    const bare = {
      ...one,
      title: null,
      hiringOrganization: null,
      jobLocationType: null,
      employmentType: [],
    }
    const item = {
      ...ITEM,
      title: 'LT',
      companyName: 'LC',
      cities: [],
      remote: false,
      postedMs: null,
    }
    const mapped = mapNofluffPosting(bare, item)
    expect([mapped.title, mapped.companyName, mapped.location, mapped.remote]).toEqual([
      'LT',
      'LC',
      null,
      null,
    ])
    expect([mapped.employmentType, mapped.dates]).toEqual([null, []])
    expect(mapNofluffPosting({ ...bare, jobLocationType: 'TELECOMMUTE' }, item).remote).toBe(true)
    expect(mapNofluffPosting(one, { ...ITEM, cities: ['A', 'B'] }).location).toBe('A; B')
  })
})

describe('robots (the captured robots.txt, our product token)', () => {
  const policy = () =>
    new RobotsPolicy({
      productToken: ROBOTS_PRODUCT_TOKEN,
      fetchRobots: () =>
        Promise.resolve({ status: 200, bodyText: ROBOTS, headers: {}, etag: null }),
    })
  it.each([...NOFLUFF_LISTING_URLS, URL])('allows %s', async (url) => {
    expect((await policy().check(url)).verdict).toBe('ALLOWED')
  })
  it.each([
    'https://nofluffjobs.com/api/search',
    'https://nofluffjobs.com/pl/posting/x',
    'https://nofluffjobs.com/pl/job/job/x',
  ])('denies %s', async (url) => {
    expect((await policy().check(url)).verdict).toBe('DENIED')
  })
})

describe('a run', () => {
  const run = async (responses: FakeResponse[], held: ReadonlySet<string> = new Set()) => {
    const f = fakeCollectionContext({ now: NOW, responses })
    f.ctx.heldIdentityKeys = async () => held
    const provider = createNofluffProvider(NOFLUFF_BOUNDS, {
      sleep: async () => {},
      random: () => 0,
    })
    const batch = await provider.collectReport(
      nofluffProvider.parseConfig({ configVersion: 1 }),
      f.ctx,
    )
    return { batch, f }
  }

  it('reads robots and eight category pages, then the unseen detail pages', async () => {
    const listings = NOFLUFF_LISTING_URLS.map(() => ({ bodyText: LISTING }))
    const { batch, f } = await run(
      [{ bodyText: ROBOTS }, ...listings, { bodyText: DETAIL }, { status: 404 }],
      new Set([siteIdentityKey({ type: 'NOFLUFF_HTML', namespace: 'nofluff' }, 'M4C7FU9G')]),
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://nofluffjobs.com/robots.txt',
      ...NOFLUFF_LISTING_URLS,
      URL,
      job('automation-tester-qa-java-scalo-remote-25'),
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['SKQKAXAX'])
  })
})

describe('the source', () => {
  it('states its budget: robots + 8 category pages + 25 details', () => {
    expect(NOFLUFF_REQUESTS_PER_RUN).toBe(34)
    expect(NOFLUFF_LISTING_URLS).toEqual(
      [
        'backend',
        'frontend',
        'fullstack',
        'mobile',
        'devops',
        'data',
        'artificial-intelligence',
        'testing',
      ].map((c) => `https://nofluffjobs.com/pl/${c}?page=2`),
    )
    expect(NOFLUFF_SOURCE.listingMaxBytes).toBe(4 * 1024 * 1024)
    expect(NOFLUFF_SOURCE.detailMaxBytes).toBe(2 * 1024 * 1024)
  })

  it('takes no query, no window, no other namespace', () => {
    const cfg = (extra: Record<string, unknown>) =>
      nofluffProvider.parseConfig({ configVersion: 1, ...extra })
    expect(() => cfg({ query: 'java' })).toThrow('No Fluff Jobs is read without a search query')
    expect(() => cfg({ window: { from: '2026-11-01', to: '2026-11-02' } })).toThrow(
      'No Fluff Jobs has no date window',
    )
    expect(() => cfg({ namespace: 'other' })).toThrow()
  })

  it('waits with the real clock by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const f = fakeCollectionContext({
        now: NOW,
        responses: [{ bodyText: ROBOTS }, { status: 403 }],
      })
      const running = createNofluffProvider().collectReport(
        nofluffProvider.parseConfig({ configVersion: 1 }),
        f.ctx,
      )
      await vi.advanceTimersByTimeAsync(10_000)
      const batch = await running
      expect(f.sent).toHaveLength(2)
      expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pins the fixtures the manifest names for this source', () => {
    expect(MANIFEST_DEFINITIONS.find((d) => d.type === 'NOFLUFF_HTML')?.payloadFixtures).toEqual([
      'backend-listing.trimmed.html.txt',
      'job-detail.trimmed.html.txt',
    ])
  })

  it('reaches nofluffjobs.com only', () => {
    expect(nofluffAllowedHosts()).toEqual(['nofluffjobs.com'])
  })

  it('is permitted on the owner decision, with the permission still UNCLEAR', () => {
    expect(NOFLUFF_SOURCE_STATUS.blocked).toBe(false)
    expect(NOFLUFF_SOURCE_STATUS.permission).toBe('UNCLEAR')
  })

  it('every fixture has a provenance file naming its URL', () => {
    for (const name of ['backend-listing.trimmed.html', 'job-detail.trimmed.html']) {
      const p = sourceProvenance('nofluff', name) as { url: string; permission: string }
      expect(p.url).toMatch(/^https:\/\/nofluffjobs\.com\//)
      expect(p.permission).toBe('UNCLEAR')
    }
  })
})
