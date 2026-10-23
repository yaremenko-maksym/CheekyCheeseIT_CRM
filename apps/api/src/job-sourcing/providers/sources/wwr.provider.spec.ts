import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { parseWwrTitle, WWR_CATEGORIES, wwrProvider, wwrSpec } from './wwr.provider'

/**
 * We Work Remotely, through the base's public collect path with a stubbed fetch.
 *
 * Expected values are read by hand from the committed captures in `__fixtures__/wwr/` (verbatim cuts of
 * real responses; see their provenance files) and written here as literals. The title cases are real
 * titles from the four feeds fetched on 2026-10-23; the synthetic ones say so.
 */

const FIXTURES = join(__dirname, '__fixtures__', 'wwr')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const NOW = new Date('2026-10-23T20:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const config = (overrides: Record<string, unknown> = {}) =>
  wwrProvider.parseConfig({ namespace: 'wwr', configVersion: 1, ...overrides })

async function collect(
  response: { bodyText: string; status?: number },
  overrides: Record<string, unknown> = {},
) {
  const f = fakeCollectionContext({ responses: [response], now: NOW })
  const mapped: ReturnType<typeof wwrSpec.mapEntry>[] = []
  const recording = {
    ...wwrSpec,
    mapEntry: (...args: Parameters<typeof wwrSpec.mapEntry>) => {
      const fields = wwrSpec.mapEntry(...args)
      mapped.push(fields)
      return fields
    },
  }
  const batch = await collectFeedPages(recording, config(overrides), f.ctx)
  return { batch, f, mapped }
}

describe('parseWwrTitle - "Company: Position"', () => {
  const cases: Array<[string, string, { companyName: string | null; title: string }]> = [
    [
      'a plain title',
      'Aquifer: Development Manager',
      { companyName: 'Aquifer', title: 'Development Manager' },
    ],
    [
      'a long company name with a hyphenated position',
      'Committee for Children: Senior Product Manager - Edtech Innovation',
      {
        companyName: 'Committee for Children',
        title: 'Senior Product Manager - Edtech Innovation',
      },
    ],
    [
      'a comma and an ampersand in the position',
      'Wrike: Director, Global GTM Strategy & Operations',
      { companyName: 'Wrike', title: 'Director, Global GTM Strategy & Operations' },
    ],
    [
      'a second colon inside the position (FULL TIME:)',
      'Yooli: FULL TIME: Software Engineer Position - React and Rest',
      { companyName: 'Yooli', title: 'FULL TIME: Software Engineer Position - React and Rest' },
    ],
    [
      'a second colon inside the position, with LLC in the company',
      'ZoomInfo Technologies LLC: Principal Infrastructure Architect: Data Platform',
      {
        companyName: 'ZoomInfo Technologies LLC',
        title: 'Principal Infrastructure Architect: Data Platform',
      },
    ],
    [
      'trailing whitespace exactly as the live feed sent it',
      'Askable: Software Engineer, AI Coding Tasks (Contract) ',
      { companyName: 'Askable', title: 'Software Engineer, AI Coding Tasks (Contract)' },
    ],
    [
      'leading whitespace and a double space after the colon (synthetic)',
      '  Acme:  Backend Engineer',
      { companyName: 'Acme', title: 'Backend Engineer' },
    ],
  ]

  it.each(cases)('%s', (_label, raw, expected) => {
    expect(parseWwrTitle(raw)).toEqual(expected)
  })

  const unparseable: Array<[string, string]> = [
    ['no colon at all (synthetic)', 'Senior Backend Engineer'],
    ['nothing before the colon (synthetic)', ': Senior Backend Engineer'],
    ['nothing after the colon (synthetic)', 'Acme:'],
    ['only whitespace after the colon (synthetic)', 'Acme:   '],
  ]

  it.each(unparseable)(
    'keeps the whole string as the title and names no employer: %s',
    (_label, raw) => {
      expect(parseWwrTitle(raw)).toEqual({ companyName: null, title: raw.trim() })
    },
  )

  it('splits at the FIRST colon: a colon inside a company name would be mis-split (known limit)', () => {
    // None of the 179 distinct real titles fetched had a colon inside the company name, so the rule is
    // pinned on what the data shows. A synthetic "A: B: C" cannot say which colon is the boundary.
    expect(parseWwrTitle('A: B: C')).toEqual({ companyName: 'A', title: 'B: C' })
  })
})

describe('config is closed and refused before any network call', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['a category slug that was never verified', { category: 'remote-data-science-jobs' }],
    ['the stale legacy programming feed', { category: 'remote-programming-jobs' }],
    ['a category with a path in it', { category: '../remote-jobs' }],
    ['a free-text query', { query: 'rust' }],
    ['a window (a RECENT feed cannot be asked for one)', { window: { from: NOW, to: NOW } }],
  ]

  it.each(refused)('rejects %s, and the fetch stub is never called', async (_label, overrides) => {
    const f = fakeCollectionContext({ responses: [{ bodyText: fixture('all-jobs.trimmed.xml') }] })
    expect(() => config(overrides)).toThrow()
    await expect(
      wwrProvider.collectReport(
        { namespace: 'wwr', configVersion: 1, ...overrides } as never,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })

  it('offers exactly the four category feeds that were fetched and found live', () => {
    expect(WWR_CATEGORIES).toEqual([
      'remote-back-end-programming-jobs',
      'remote-front-end-programming-jobs',
      'remote-full-stack-programming-jobs',
      'remote-devops-sysadmin-jobs',
    ])
  })
})

describe('the request', () => {
  it('asks for the all-jobs feed when no category is configured', async () => {
    const { f } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(f.sent.map((r) => r.url)).toEqual(['https://weworkremotely.com/remote-jobs.rss'])
  })

  it('asks for the category feed, and the scope carries the category', async () => {
    const { f, batch } = await collect(
      { bodyText: fixture('category-devops.trimmed.xml') },
      { category: 'remote-devops-sysadmin-jobs' },
    )
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
    ])
    expect(batch.scope.query).toBe('remote-devops-sysadmin-jobs')
  })

  it('leaves the all-jobs scope without a query', async () => {
    const { batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(batch.scope.query).toBeNull()
  })

  it('sends the honest user agent', async () => {
    const { f } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(f.sent[0]?.headers?.['user-agent']).toBe(
      'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)',
    )
  })
})

describe('the real all-jobs capture (6 of 95 items, verbatim)', () => {
  it('turns every item into an observation with the employer read from the title', async () => {
    const { batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(
      batch.observations.map((o) => [
        o.normalized.companyName,
        o.normalized.title,
        o.sourcePostingUrl,
      ]),
    ).toEqual([
      [
        'Committee for Children',
        'Senior Product Manager - Edtech Innovation',
        'https://weworkremotely.com/remote-jobs/committee-for-children-senior-product-manager-edtech-innovation',
      ],
      [
        'Aquifer',
        'Development Manager',
        'https://weworkremotely.com/remote-jobs/aquifer-development-manager',
      ],
      [
        'BeyondTrust',
        'Enterprise Account Manager, SLED',
        'https://weworkremotely.com/remote-jobs/beyondtrust-enterprise-account-manager-sled-1',
      ],
      [
        'Discord',
        'QA/DevOps Engineer',
        'https://weworkremotely.com/remote-jobs/discord-qa-devops-engineer',
      ],
      [
        'BeyondTrust',
        'Enterprise Account Manager, SLED',
        'https://weworkremotely.com/remote-jobs/beyondtrust-enterprise-account-manager-sled',
      ],
      [
        'New Law Business Model',
        'Solutions Engineer - Customer Success',
        'https://weworkremotely.com/remote-jobs/new-law-business-model-solutions-engineer-customer-success',
      ],
    ])
  })

  it('keeps the two BeyondTrust postings (same title, different link) as two identities', async () => {
    const { batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    const beyondTrust = batch.observations.filter((o) => o.normalized.companyName === 'BeyondTrust')
    expect(beyondTrust.map((o) => o.identity.nativeId)).toEqual([
      'https://weworkremotely.com/remote-jobs/beyondtrust-enterprise-account-manager-sled-1',
      'https://weworkremotely.com/remote-jobs/beyondtrust-enterprise-account-manager-sled',
    ])
    expect(new Set(batch.observations.map((o) => o.identity.identityKey)).size).toBe(6)
  })

  it('reads the feed category as a tag and the RFC 2822 pubDate as the published date (UTC)', async () => {
    const { mapped, batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(mapped.map((m) => m.tags)).toEqual([
      ['Product'],
      ['DevOps and Sysadmin'],
      ['DevOps and Sysadmin'],
      ['DevOps and Sysadmin'],
      ['Sales and Marketing'],
      ['Customer Support'],
    ])
    expect(mapped[0]?.dates).toEqual([
      { raw: 'Fri, 23 Oct 2026 16:55:36 +0000', contract: 'RFC_2822', semantics: 'PUBLISHED' },
    ])
    expect(batch.observations[0]?.normalized.dates[0]?.value?.toISOString()).toBe(
      '2026-10-23T16:55:36.000Z',
    )
  })

  it('does not read a posting date off a renewed listing: the 2023 pubDate stays 2023', async () => {
    const { batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(batch.observations[5]?.normalized.dates[0]?.value?.toISOString()).toBe(
      '2023-02-07T20:07:41.000Z',
    )
  })

  it('passes the entity-escaped HTML description through as html', async () => {
    const { mapped } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(mapped[0]?.descriptionKind).toBe('html')
    expect(mapped[0]?.description).toContain('<strong>Headquarters:</strong> 2815 2nd Ave, Seattle')
  })
})

describe('the real category captures', () => {
  it('splits the real titles that contain a second colon in the position', async () => {
    const full = await collect(
      { bodyText: fixture('category-full-stack.trimmed.xml') },
      { category: 'remote-full-stack-programming-jobs' },
    )
    expect(
      full.batch.observations.map((o) => [o.normalized.companyName, o.normalized.title]),
    ).toEqual([
      ['Askable', 'Software Engineer, AI Coding Tasks (Contract)'],
      ['ZoomInfo Technologies LLC', 'Director, Applied AI'],
      ['Yooli', 'FULL TIME: Software Engineer Position - React and Rest'],
    ])
    const devops = await collect(
      { bodyText: fixture('category-devops.trimmed.xml') },
      { category: 'remote-devops-sysadmin-jobs' },
    )
    expect(
      devops.batch.observations.map((o) => [o.normalized.companyName, o.normalized.title]),
    ).toEqual([['ZoomInfo Technologies LLC', 'Principal Infrastructure Architect: Data Platform']])
  })
})

describe('company uncertainty', () => {
  const feed = (title: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>${title}</title>` +
    `<link>https://weworkremotely.com/remote-jobs/x</link><guid>https://weworkremotely.com/remote-jobs/x</guid>` +
    `<pubDate>Fri, 23 Oct 2026 16:55:36 +0000</pubDate></item></channel></rss>`

  it('a title with no "Company:" prefix names no employer, and the item is quarantined, not guessed', async () => {
    const { mapped, batch } = await collect({ bodyText: feed('Senior Backend Engineer') })
    expect(mapped[0]).toMatchObject({ companyName: null, title: 'Senior Backend Engineer' })
    expect(batch.observations).toEqual([])
    expect(batch.counts.quarantined).toBe(1)
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('window semantics', () => {
  it('declares a 24 hour recent window, under the 57.4 h measured for the busiest category', () => {
    expect(wwrSpec.inventory).toEqual({ kind: 'RECENT', windowMs: DAY })
  })

  it('reports WINDOW coverage and a [now - 24h, now] scope for a complete run', async () => {
    const { batch } = await collect({ bodyText: fixture('all-jobs.trimmed.xml') })
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({ from: new Date(NOW.getTime() - DAY), to: NOW })
  })

  it('reports PARTIAL coverage when the run does not complete', async () => {
    const { batch } = await collect({ bodyText: fixture('category-devops.truncated.xml') })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('envelopes', () => {
  it('a valid feed with no items succeeds with zero entries', async () => {
    const empty =
      '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>We Work Remotely: DevOps and Sysadmin Jobs</title><ttl>60</ttl></channel></rss>'
    const { batch } = await collect({ bodyText: empty })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations).toEqual([])
  })

  it('a transfer cut off after the first item is drift', async () => {
    const { batch, mapped } = await collect({ bodyText: fixture('category-devops.truncated.xml') })
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^MALFORMED: /)
    expect(mapped).toEqual([])
  })
})

describe('a challenge is a stop, never something to get around', () => {
  it('the real 403 interstitial fails the run as an access-policy block after exactly one request', async () => {
    const { batch, f, mapped } = await collect({
      status: 403,
      bodyText: fixture('unknown-category.challenge-403.html'),
    })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
    expect(f.sent).toHaveLength(1)
    expect(mapped).toEqual([])
    expect(batch.observations).toEqual([])
  })

  it('the same interstitial served with 200 is drift, also after exactly one request', async () => {
    const { batch, f } = await collect({
      status: 200,
      bodyText: fixture('unknown-category.challenge-403.html'),
    })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(f.sent).toHaveLength(1)
  })
})
