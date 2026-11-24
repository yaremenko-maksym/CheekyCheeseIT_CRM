import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import { PARSE_ITEMS_PER_MS } from '../../xml/xml-limits'
import {
  parseSolidCompany,
  SOLIDJOBS_MAX_FEED_BYTES,
  SOLIDJOBS_MAX_ITEMS,
  SOLIDJOBS_MAX_WALL_CLOCK_MS,
  solidJobsProvider,
  solidJobsSpec,
} from './solidjobs.provider'

/**
 * solid.jobs, through the base's public collect path. Expected values are written by hand from the trimmed
 * capture of 2026-11-24 (`__fixtures__/solidjobs/job-offers.trimmed.xml`, provenance beside it). The
 * non-IT drop is a SYNTHETIC feed built here: the capture kept only IT-tagged items.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'solidjobs', 'job-offers.trimmed.xml')
const NOW = new Date('2026-11-24T20:00:00Z')

const config = () => solidJobsProvider.parseConfig({ namespace: 'solidjobs', configVersion: 1 })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(solidJobsSpec, config(), f.ctx)
}

const rss = (items: string) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>SOLID.Jobs</title>${items}</channel></rss>`
const item = (guid: string, categories: string[], description: string) =>
  `<item><guid>${guid}</guid><link>https://solid.jobs/o/${guid}/rss</link><title>Role ${guid}</title><description>${description}</description>${categories.map((c) => `<category>${c}</category>`).join('')}</item>`

describe('parseSolidCompany - the segment before " • "', () => {
  it.each([
    [
      'a real description',
      'Verita HR • Centrum, Kraków 26.3k–30.5k PLN netto/m (B2B)',
      'Verita HR',
    ],
    ['a synthetic description without a separator', 'Centrum, Kraków', null],
    ['a synthetic description with an empty company', ' • Centrum', null],
    ['an absent description', null, null],
  ] as const)('%s', (_label, description, expected) => {
    expect(parseSolidCompany(description)).toBe(expected)
  })
})

describe('SOLIDJOBS_RSS collect on the trimmed capture', () => {
  it('maps title and employer of each IT posting', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(
      batch.observations.map((o) => [
        o.identity.nativeId,
        o.normalized.title,
        o.normalized.companyName,
      ]),
    ).toEqual([
      [
        '035a05cb-43a0-4735-8045-b7455bd909af',
        'Senior Fullstack Engineer (Java + React)',
        'Verita HR',
      ],
      ['cd181e8e-8411-4ec5-b3c2-35027b1c2511', 'Senior Analityk Biznesowy (Remote)', 'apreel'],
      ['07d679c6-1939-4f9d-9fa2-1b9d259977d4', 'Analityk Systemowy (Remote)', 'apreel'],
    ])
  })

  it('maps each posting link to its URL and its pubDate to publishedAt', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(
      batch.observations.map((o) => [o.sourcePostingUrl, o.normalized.publishedAt?.toISOString()]),
    ).toEqual([
      ['https://solid.jobs/o/p7umrgyk/rss', '2026-09-23T15:30:49.000Z'],
      ['https://solid.jobs/o/l7p1ucu4/rss', '2026-06-22T12:57:20.000Z'],
      ['https://solid.jobs/o/s2nf83ff/rss', '2026-09-23T14:11:13.000Z'],
    ])
  })

  it('drops a non-IT entry: it is never observed and not counted as invalid', async () => {
    const feed = rss(
      item('it-1', ['IT', 'Java'], 'Acme • Kraków 20k PLN') +
        item('sales-1', ['Sales'], 'Acme • Kraków 9k PLN'),
    )
    const batch = await collect(feed)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['it-1'])
    expect(batch.counts.invalid).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('declares the raised caps the 3,809-item live feed needs', () => {
    expect(solidJobsSpec.limits).toEqual({
      maxBytes: SOLIDJOBS_MAX_FEED_BYTES,
      maxItemsPerPage: SOLIDJOBS_MAX_ITEMS,
      maxWallClockMs: SOLIDJOBS_MAX_WALL_CLOCK_MS,
    })
    expect(SOLIDJOBS_MAX_FEED_BYTES).toBe(4 * 1024 * 1024)
    // The unit budget admits floor((400 × 100 − 14) / 9) entries after the ~14-unit wrapper; the cap sits below it.
    expect(SOLIDJOBS_MAX_ITEMS).toBeLessThanOrEqual(
      Math.floor((SOLIDJOBS_MAX_WALL_CLOCK_MS * PARSE_ITEMS_PER_MS - 14) / 9),
    )
    expect(SOLIDJOBS_MAX_ITEMS).toBeGreaterThanOrEqual(3809)
    expect(SOLIDJOBS_MAX_WALL_CLOCK_MS).toBe(400)
  })

  it('accepts a full-size 3,809-entry feed of the live shape through the shared loop', async () => {
    const batch = await collect(fullSizeFeed(3809))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(3809)
    expect(batch.counts.invalid).toBe(0)
  })

  it('accepts a feed of exactly the declared item cap', async () => {
    const batch = await collect(fullSizeFeed(SOLIDJOBS_MAX_ITEMS))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(SOLIDJOBS_MAX_ITEMS)
  })

  it('the default 250 ms budget refuses that same feed with PAYLOAD_TOO_LARGE: the raised budget is what admits it', async () => {
    const defaultBudget = {
      ...solidJobsSpec,
      limits: { maxBytes: SOLIDJOBS_MAX_FEED_BYTES, maxItemsPerPage: SOLIDJOBS_MAX_ITEMS },
    }
    const f = fakeCollectionContext({ responses: [{ bodyText: fullSizeFeed(3809) }], now: NOW })
    const batch = await collectFeedPages(defaultBudget, config(), f.ctx)
    // The body is ~1 MB, under the 4 MiB byte cap and the 100,000-element cap: the budget is what it exceeds.
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('refuses one entry past the declared item cap with PAYLOAD_TOO_LARGE', async () => {
    // 4,401 × 9 + 14 = 39,623 units is still inside the 40,000-unit budget, so the declared cap is what refuses it.
    const batch = await collect(fullSizeFeed(SOLIDJOBS_MAX_ITEMS + 1))
    expect(batch.outcome).not.toBe('SUCCEEDED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.requests.at(-1)?.error?.message).toBe(
      `page carried ${SOLIDJOBS_MAX_ITEMS + 1} items, over the ${SOLIDJOBS_MAX_ITEMS} cap`,
    )
  })
})

/** The live shape: 8 elements and one attribute (9 units) per entry, all IT, all inside the 24 h window. */
function fullSizeFeed(count: number): string {
  const items = Array.from(
    { length: count },
    (_, n) =>
      `<item><guid isPermaLink="false">it-${n}</guid><link>https://solid.jobs/o/it-${n}/rss</link>` +
      `<title>Role ${n}</title><description>Acme • Kraków 20k PLN</description>` +
      `<category>IT</category><category>Java</category>` +
      `<pubDate>Tue, 24 Nov 2026 18:00:00 +0100</pubDate></item>`,
  ).join('')
  return rss(items)
}
