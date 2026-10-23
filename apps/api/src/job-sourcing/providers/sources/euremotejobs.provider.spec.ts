import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { euRemoteJobsProvider, euRemoteJobsSpec } from './euremotejobs.provider'

/**
 * EU Remote Jobs, through the base's public collect path with a stubbed fetch.
 *
 * THERE IS NO AUTHENTIC JOB ITEM TO TEST AGAINST. The seeded endpoint (`/jobs/feed/`) is a WordPress
 * COMMENTS feed with zero items (committed as `jobs-feed.comments-feed.xml`, a complete real response), and the
 * documented job feed answered 401. So the two halves are kept apart on purpose:
 *  - what was MEASURED: the real capture, asserted as such;
 *  - what is only DOCUMENTED: an inline item in the WP Job Manager shape (its source,
 *    `class-wp-job-manager-post-types.php`: `xmlns:job_listing="<site url>"`, `job_listing:location`,
 *    `job_type`, `job_category`, `company`, `salary`, each in CDATA). It proves how the adapter treats
 *    that shape, and says nothing about what the live site emits - the tests name it "documented".
 */

const FIXTURES = join(__dirname, '__fixtures__', 'euremotejobs')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const NOW = new Date('2026-10-23T20:00:00Z')
const HOUR = 60 * 60 * 1000

const config = (overrides: Record<string, unknown> = {}) =>
  euRemoteJobsProvider.parseConfig({ namespace: 'euremotejobs', configVersion: 1, ...overrides })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  const mapped: ReturnType<typeof euRemoteJobsSpec.mapEntry>[] = []
  const recording = {
    ...euRemoteJobsSpec,
    mapEntry: (...args: Parameters<typeof euRemoteJobsSpec.mapEntry>) => {
      const fields = euRemoteJobsSpec.mapEntry(...args)
      mapped.push(fields)
      return fields
    },
  }
  const batch = await collectFeedPages(recording, config(), f.ctx)
  return { batch, f, mapped }
}

// The WP Job Manager item shape, from the plugin source (NOT a capture).
const DOCUMENTED_ITEM = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:job_listing="https://euremotejobs.com">
<channel><title>EU Remote Jobs</title>
<item>
  <title>Senior Rust Engineer</title>
  <link>https://euremotejobs.com/job/senior-rust-engineer/</link>
  <pubDate>Fri, 23 Oct 2026 09:30:00 +0000</pubDate>
  <dc:creator>admin</dc:creator>
  <guid isPermaLink="false">https://euremotejobs.com/?post_type=job_listing&amp;p=4711</guid>
  <description><![CDATA[<p>Build &amp; run the thing</p>]]></description>
  <job_listing:location><![CDATA[Berlin, Germany]]></job_listing:location>
  <job_listing:job_type><![CDATA[Full Time]]></job_listing:job_type>
  <job_listing:company><![CDATA[Ferrous Systems]]></job_listing:company>
</item>
</channel></rss>`

describe('config is strict-empty, matching the seeded row, and refused before the network', () => {
  it('accepts only the identity fields', () => {
    expect(config()).toMatchObject({ namespace: 'euremotejobs', configVersion: 1 })
  })

  const refused: Array<[string, Record<string, unknown>]> = [
    ['an invented category', { category: 'engineering' }],
    ['a free-text query', { query: 'rust' }],
    ['a window (a RECENT feed cannot be asked for one)', { window: { from: NOW, to: NOW } }],
    ['a feed url', { url: 'https://example.com/feed' }],
  ]

  it.each(refused)('rejects %s, and the fetch stub is never called', async (_label, overrides) => {
    const f = fakeCollectionContext({
      responses: [{ bodyText: fixture('jobs-feed.comments-feed.xml') }],
    })
    expect(() => config(overrides)).toThrow()
    await expect(
      euRemoteJobsProvider.collectReport(
        { namespace: 'euremotejobs', configVersion: 1, ...overrides } as never,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })
})

describe('the request', () => {
  it('asks for the one seeded endpoint with the honest user agent', async () => {
    const { f } = await collect(fixture('jobs-feed.comments-feed.xml'))
    expect(f.sent.map((r) => r.url)).toEqual(['https://euremotejobs.com/jobs/feed/'])
    expect(f.sent[0]?.headers?.['user-agent']).toBe(
      'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)',
    )
  })
})

describe('the real capture of the seeded endpoint', () => {
  // PRECONDITION: this is the WRONG feed (WordPress comments) reported as an empty success. It is safe only
  // while the source is disabled in the seed and unregistered; see the header of euremotejobs.provider.ts.
  it('the seeded comments feed is a valid feed with zero items, reported as an empty success', async () => {
    const { batch, mapped } = await collect(fixture('jobs-feed.comments-feed.xml'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations).toEqual([])
    expect(mapped).toEqual([])
  })

  it('a transfer cut off before the channel closes is drift, not an empty feed', async () => {
    const { batch } = await collect(fixture('jobs-feed.truncated.xml'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^MALFORMED: /)
  })
})

describe('description source (synthetic)', () => {
  const feedWith = (inner: string) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><item>` +
    `<title>Engineer</title><link>https://euremotejobs.com/job/x</link><guid>https://euremotejobs.com/job/x</guid>` +
    `<pubDate>Fri, 23 Oct 2026 16:55:36 +0000</pubDate>${inner}</item></channel></rss>`

  it('prefers the full content:encoded body over the short description when both arrive', async () => {
    const { mapped } = await collect(
      feedWith(
        '<description>short summary</description><content:encoded>full body</content:encoded>',
      ),
    )
    expect(mapped[0]?.description).toBe('full body')
  })

  it('falls back to the description when there is no content:encoded', async () => {
    const { mapped } = await collect(feedWith('<description>short summary</description>'))
    expect(mapped[0]?.description).toBe('short summary')
  })
})

describe('window semantics', () => {
  it('declares the 1 hour floor, which is unmeasured: there is no job item to measure', () => {
    expect(euRemoteJobsSpec.inventory).toEqual({ kind: 'RECENT', windowMs: HOUR })
  })

  it('reports WINDOW coverage and a [now - 1h, now] scope for a complete run', async () => {
    const { batch } = await collect(fixture('jobs-feed.comments-feed.xml'))
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({ from: new Date(NOW.getTime() - HOUR), to: NOW })
    expect(batch.scope.query).toBeNull()
  })
})

describe('the documented WP Job Manager item shape (not a capture)', () => {
  it('maps title, link and the UTC date, and decodes the CDATA description as html', async () => {
    const { mapped } = await collect(DOCUMENTED_ITEM)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]).toMatchObject({
      title: 'Senior Rust Engineer',
      url: 'https://euremotejobs.com/job/senior-rust-engineer/',
      description: '<p>Build &amp; run the thing</p>',
      descriptionKind: 'html',
      dates: [
        { raw: 'Fri, 23 Oct 2026 09:30:00 +0000', contract: 'RFC_2822', semantics: 'PUBLISHED' },
      ],
    })
  })

  it('does not take the employer from anywhere the reader does not give it: the namespaced company is not read', async () => {
    const { mapped, batch } = await collect(DOCUMENTED_ITEM)
    // `job_listing:company` ("Ferrous Systems") is in the document; the shared FeedEntry reader has no
    // slot for it, and the title and the dc:creator ("admin", the poster) are not employers.
    expect(mapped[0]?.companyName).toBeNull()
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.coverage).toBe('PARTIAL')
  })

  it('does not read an employer out of a "Company - Role" style title either', async () => {
    const { mapped } = await collect(
      DOCUMENTED_ITEM.replace('Senior Rust Engineer', 'Ferrous Systems - Senior Rust Engineer'),
    )
    expect(mapped[0]).toMatchObject({
      title: 'Ferrous Systems - Senior Rust Engineer',
      companyName: null,
    })
  })
})
