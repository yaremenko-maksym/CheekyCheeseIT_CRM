import { describe, expect, it, vi } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { sourceFixtureFile, sourceProvenance } from '../../../test/source-fixtures'
import { extractJobPostings, selectByIdentity } from '../../structuring/json-ld'
import { RobotsPolicy } from '../../structuring/robots-policy'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import {
  createDiceProvider,
  DICE_BOUNDS,
  DICE_LISTING_URLS,
  DICE_REQUESTS_PER_RUN,
  DICE_SOURCE,
  DICE_SOURCE_STATUS,
  diceAllowedHosts,
  diceProvider,
  type DiceItem,
  mapDicePosting,
  parseDiceListing,
} from './dice.provider'
import { identityKeyOf, ROBOTS_PRODUCT_TOKEN } from './listing-detail.collector'

/**
 * Dice through its public provider. Every expected value is hand-read from the captures in
 * `__fixtures__/dice/` (2026-11-21, permitted by the owner's decision of 2026-11-20; see their
 * provenance files) and written here as a literal, never produced by running the mapper.
 *
 * The listing fixture keeps the search list's first 4 jobs (the first one featured) and the
 * similar-jobs list cut to 1 job, in two push scripts split inside the search row.
 */
const NOW = new Date('2026-11-21T10:00:00Z')
const LISTING = sourceFixtureFile('dice', 'jobs-listing.trimmed.html.txt')
const DETAIL = sourceFixtureFile('dice', 'job-detail.trimmed.html.txt')
const ROBOTS = sourceFixtureFile('dice', 'robots.txt')

const GUID = '0f607ad0-18b8-459d-9641-445d11e58a95'
const URL = `https://www.dice.com/job-detail/${GUID}`
const IDS = [
  GUID,
  '6e660512-af87-49ee-a6fc-23fdb1878896',
  '8491a114-144c-441a-96c2-d0d0e21bd223',
  'e56f4e3c-0dc1-4e95-acd0-b96e59f8842a',
]

const ITEM: DiceItem = {
  id: GUID,
  url: URL,
  title: 'Principal/Lead Specialist - IT ETRM Systems',
  companyName: 'Energy Transfer',
  location: 'Houston, Texas, USA',
  isRemote: false,
}

/** A flight payload of one push script per row. */
const flight = (...rows: string[]) =>
  rows
    .map((row) => `<script>self.__next_f.push(${JSON.stringify([1, `${row}\n`])})</script>`)
    .join('')
const job = (guid: string, extra: Record<string, unknown> = {}) => ({
  guid,
  detailsPageUrl: `https://www.dice.com/job-detail/${guid}`,
  title: 'T',
  companyName: 'C',
  jobLocation: { displayName: 'L' },
  isRemote: false,
  ...extra,
})
const searchRow = (data: unknown[], extra: Record<string, unknown> = {}) =>
  `3b:${JSON.stringify(['$', '$L1', null, { jobList: { data }, totalPages: 9, ...extra }])}`

describe('the listing', () => {
  it('reads the search list of the capture, not the similar-jobs list', () => {
    const parsed = parseDiceListing(LISTING)
    expect(parsed).toEqual({
      ok: true,
      items: [
        ITEM,
        {
          id: IDS[1],
          url: `https://www.dice.com/job-detail/${IDS[1]}`,
          title: 'Information Systems Security Engineer (ISSE)',
          companyName: 'SAIC',
          location: 'Colorado Springs, Colorado, USA',
          isRemote: false,
        },
        {
          id: IDS[2],
          url: `https://www.dice.com/job-detail/${IDS[2]}`,
          title: 'Technical Writer',
          companyName: 'SAIC',
          location: 'Colorado Springs, Colorado, USA',
          isRemote: false,
        },
        {
          id: IDS[3],
          url: `https://www.dice.com/job-detail/${IDS[3]}`,
          title: 'M365 Migration Support Engineer',
          companyName: 'SAIC',
          location: 'Huntsville, Alabama, USA',
          isRemote: false,
        },
      ],
    })
  })

  it('skips rows that are not JSON and pushes that are not text chunks', () => {
    const html =
      '<script>self.__next_f.push([0])</script><script>self.__next_f.push([1, broken])</script>' +
      flight('1:"$Sreact.fragment"', '2:I[123,"x"]', 'nonsense', searchRow([job(IDS[1]!)]))
    const parsed = parseDiceListing(html)
    expect(parsed.ok && parsed.items.map((i) => i.id)).toEqual([IDS[1]])
  })

  it('reads only text chunks of push kind 1', () => {
    const push = (chunk: unknown) => `<script>self.__next_f.push(${JSON.stringify(chunk)})</script>`
    const other = push([0, `${searchRow([job(IDS[2]!)]).replace('3b:', '3c:')}\n`])
    const parsed = parseDiceListing(other + flight(searchRow([job(IDS[1]!)])))
    expect(parsed.ok && parsed.items.map((i) => i.id)).toEqual([IDS[1]])
    // A non-text chunk is skipped whole, never glued onto the next row.
    const glued = parseDiceListing(push([1, { a: 1 }]) + flight(searchRow([job(IDS[1]!)])))
    expect(glued.ok && glued.items.map((i) => i.id)).toEqual([IDS[1]])
  })

  it('a row id starts the line', () => {
    expect(parseDiceListing(flight(`!${searchRow([job(IDS[1]!)])}`))).toEqual({
      ok: false,
      message: '0 search job lists',
    })
  })

  it('maps missing optional fields to null and isRemote true only when true', () => {
    const parsed = parseDiceListing(
      flight(
        searchRow([
          { guid: IDS[1], detailsPageUrl: `https://www.dice.com/job-detail/${IDS[1]}` },
          job(IDS[2]!, { isRemote: true, jobLocation: null }),
        ]),
      ),
    )
    expect(parsed).toEqual({
      ok: true,
      items: [
        {
          id: IDS[1],
          url: `https://www.dice.com/job-detail/${IDS[1]}`,
          title: null,
          companyName: null,
          location: null,
          isRemote: false,
        },
        {
          id: IDS[2],
          url: `https://www.dice.com/job-detail/${IDS[2]}`,
          title: 'T',
          companyName: 'C',
          location: null,
          isRemote: true,
        },
      ],
    })
  })

  it.each([
    ['no list', flight('1:"x"'), '0 search job lists'],
    [
      'two lists',
      flight(searchRow([job(IDS[1]!)]), searchRow([job(IDS[2]!)]).replace('3b:', '3c:')),
      '2 search job lists',
    ],
    [
      'the similar list only',
      flight(searchRow([job(IDS[1]!)], { isSimilarJobsList: true })),
      '0 search job lists',
    ],
    [
      'no data array',
      flight(`3b:${JSON.stringify([{ jobList: {}, totalPages: 1 }])}`),
      'the job list has no data array',
    ],
    [
      'a null list',
      flight(`3b:${JSON.stringify([{ jobList: null, totalPages: 1 }])}`),
      'the job list has no data array',
    ],
    ['a malformed job', flight(searchRow([job('not-a-guid')])), 'job 0 is malformed'],
    ['a guid with a prefix', flight(searchRow([job(`x${IDS[1]}`)])), 'job 0 is malformed'],
    ['a guid with a suffix', flight(searchRow([job(`${IDS[1]}x`)])), 'job 0 is malformed'],
    [
      'a foreign URL',
      flight(
        searchRow([
          job(IDS[1]!),
          job(IDS[2]!, { detailsPageUrl: 'https://evil.test/job-detail/x' }),
        ]),
      ),
      'job 1 has a foreign URL',
    ],
  ])('fails on drift: %s', (_name, html, message) => {
    expect(parseDiceListing(html)).toEqual({ ok: false, message })
  })

  it('a list without totalPages is not the search list', () => {
    const row = `3b:${JSON.stringify([{ jobList: { data: [job(IDS[1]!)] } }])}`
    expect(parseDiceListing(flight(row))).toEqual({ ok: false, message: '0 search job lists' })
  })
})

describe('the detail page', () => {
  it('selects the one JobPosting whose url is the listed URL and maps it', () => {
    const postings = extractJobPostings(DETAIL, { now: NOW }).postings
    const selected = selectByIdentity(postings, { url: URL })
    expect(selected.kind).toBe('match')
    if (selected.kind !== 'match') return
    const mapped = mapDicePosting(selected.posting, ITEM)
    expect({ ...mapped, description: mapped.description?.slice(0, 40) }).toEqual({
      provider: 'DICE_HTML',
      adapterVersion: 'dice-1',
      namespace: 'dice',
      nativeId: GUID,
      url: URL,
      title: 'Principal/Lead Specialist - IT ETRM Systems',
      companyName: 'Energy Transfer',
      location: 'Houston, TX, US',
      description: 'Energy Transfer, recognized by Forbes as',
      descriptionKind: 'html',
      remote: null,
      employmentType: 'FULL_TIME',
      tags: [],
      applicationUrl: null,
      dates: [
        { raw: '2026-10-25T12:03:01.000Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
        { raw: '2026-12-21T13:00:25.000Z', contract: 'ISO_ZONED', semantics: 'EXPIRY' },
      ],
    })
  })

  it('falls back to the listing for title, company and location; remote from either side', () => {
    const posting = extractJobPostings(DETAIL, { now: NOW }).postings[0]!
    const bare = { ...posting, title: null, hiringOrganization: null, jobLocations: [] }
    const mapped = mapDicePosting(bare, { ...ITEM, isRemote: true })
    expect([mapped.title, mapped.companyName, mapped.location, mapped.remote]).toEqual([
      ITEM.title,
      ITEM.companyName,
      ITEM.location,
      true,
    ])
    const telecommute = mapDicePosting({ ...posting, jobLocationType: 'TELECOMMUTE' }, ITEM)
    expect(telecommute.remote).toBe(true)
    expect(mapDicePosting({ ...posting, employmentType: [] }, ITEM).employmentType).toBeNull()
    expect(mapDicePosting({ ...posting, jobLocations: ['A', 'B'] }, ITEM).location).toBe('A; B')
  })
})

describe('robots (the captured robots.txt, our product token)', () => {
  const policy = () =>
    new RobotsPolicy({
      productToken: ROBOTS_PRODUCT_TOKEN,
      fetchRobots: () =>
        Promise.resolve({ status: 200, bodyText: ROBOTS, headers: {}, etag: null }),
    })
  it.each([...DICE_LISTING_URLS, URL])('allows %s', async (url) => {
    expect((await policy().check(url)).verdict).toBe('ALLOWED')
  })
  it.each([
    'https://www.dice.com/jobs?q=java',
    'https://www.dice.com/job/123',
    'https://www.dice.com/feed/x',
    'https://www.dice.com/apply-redirect?x=1',
  ])('denies %s', async (url) => {
    expect((await policy().check(url)).verdict).toBe('DENIED')
  })
})

describe('a run', () => {
  const run = async (responses: FakeResponse[], held: ReadonlySet<string> = new Set()) => {
    const f = fakeCollectionContext({ now: NOW, responses })
    f.ctx.heldIdentityKeys = async () => held
    const sleeps: number[] = []
    const provider = createDiceProvider(DICE_BOUNDS, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 0,
    })
    const batch = await provider.collectReport(
      diceProvider.parseConfig({ configVersion: 1 }),
      f.ctx,
    )
    return { batch, f, sleeps }
  }

  it('reads robots and three listing pages, then the unseen detail pages', async () => {
    const { batch, f, sleeps } = await run(
      [
        { bodyText: ROBOTS },
        { bodyText: LISTING },
        { bodyText: LISTING },
        { bodyText: LISTING },
        { bodyText: DETAIL },
        { status: 404 },
      ],
      new Set([IDS[2], IDS[3]].map((id) => identityKeyOf('DICE_HTML', 'dice', id!))),
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://www.dice.com/robots.txt',
      'https://www.dice.com/jobs',
      'https://www.dice.com/jobs?page=2',
      'https://www.dice.com/jobs?page=3',
      URL,
      `https://www.dice.com/job-detail/${IDS[1]}`,
    ])
    expect(sleeps).toEqual([3000, 3000, 3000, 3000, 3000])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([GUID])
    expect(f.sent[1]?.maxBytes).toBe(4 * 1024 * 1024)
  })

  it('a challenge page instead of the listing is drift, never retried', async () => {
    const { batch, f } = await run([
      { bodyText: ROBOTS },
      { bodyText: '<html>Just a moment...</html>' },
    ])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('the source', () => {
  it('states its budget: robots + 3 listing pages + 25 details', () => {
    expect(DICE_REQUESTS_PER_RUN).toBe(29)
    expect(DICE_LISTING_URLS).toEqual([
      'https://www.dice.com/jobs',
      'https://www.dice.com/jobs?page=2',
      'https://www.dice.com/jobs?page=3',
    ])
    expect(DICE_SOURCE.detailMaxBytes).toBe(2 * 1024 * 1024)
  })

  it('takes no query, no window, no other namespace', () => {
    const cfg = (extra: Record<string, unknown>) =>
      diceProvider.parseConfig({ configVersion: 1, ...extra })
    expect(() => cfg({ query: 'java' })).toThrow('Dice is read without a search query')
    expect(() => cfg({ window: { from: '2026-11-01', to: '2026-11-02' } })).toThrow(
      'Dice has no date window',
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
      const running = createDiceProvider().collectReport(
        diceProvider.parseConfig({ configVersion: 1 }),
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
    expect(MANIFEST_DEFINITIONS.find((d) => d.type === 'DICE_HTML')?.payloadFixtures).toEqual([
      'jobs-listing.trimmed.html.txt',
      'job-detail.trimmed.html.txt',
    ])
  })

  it('reaches www.dice.com only', () => {
    expect(diceAllowedHosts()).toEqual(['www.dice.com'])
  })

  it('is permitted on the owner override, with the permission still PROHIBITED', () => {
    expect(DICE_SOURCE_STATUS.blocked).toBe(false)
    expect(DICE_SOURCE_STATUS.permission).toBe('PROHIBITED')
  })

  it('every fixture has a provenance file naming its URL', () => {
    for (const name of ['jobs-listing.trimmed.html', 'job-detail.trimmed.html']) {
      const p = sourceProvenance('dice', name) as { url: string; permission: string }
      expect(p.url).toMatch(/^https:\/\/www\.dice\.com\//)
      expect(p.permission).toBe('PROHIBITED')
    }
  })
})
