import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import {
  berlinStartupJobsProvider,
  berlinStartupJobsSpec,
  parseBerlinTitle,
} from './berlinstartupjobs.provider'

/**
 * berlinstartupjobs.com (IT category feed), through the base's public collect path. Expected values are
 * written by hand from the trimmed capture of 2026-11-24
 * (`__fixtures__/berlinstartupjobs/engineering-feed.trimmed.xml`, provenance beside it). The non-IT drop is
 * a SYNTHETIC feed built here, because the capture carries only IT-tagged items.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'berlinstartupjobs', 'engineering-feed.trimmed.xml')
const NOW = new Date('2026-11-24T20:00:00Z')

const config = () =>
  berlinStartupJobsProvider.parseConfig({ namespace: 'berlinstartupjobs', configVersion: 1 })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(berlinStartupJobsSpec, config(), f.ctx)
}

const rss = (items: string) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Berlin</title>${items}</channel></rss>`
const item = (id: string, category: string) =>
  `<item><guid isPermaLink="false">https://berlinstartupjobs.com/?p=${id}</guid><link>https://berlinstartupjobs.com/engineering/job-${id}/</link><title>Role ${id} // Company ${id}</title><description>Role text</description><pubDate>Tue, 17 Nov 2026 16:14:11 +0000</pubDate><category>${category}</category></item>`

describe('parseBerlinTitle - "Position // Company"', () => {
  it.each([
    [
      'a real title',
      'Applied ML Engineer // LANIAKEA solutions',
      { title: 'Applied ML Engineer', companyName: 'LANIAKEA solutions' },
    ],
    [
      'a synthetic title without a separator names no employer',
      'Applied ML Engineer',
      { title: 'Applied ML Engineer', companyName: null },
    ],
  ])('%s', (_label, raw, expected) => {
    expect(parseBerlinTitle(raw)).toEqual(expected)
  })
})

describe('BERLINSTARTUPJOBS_RSS collect on the trimmed capture', () => {
  it('maps title and employer of each IT posting; the creator is not the employer', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(
      batch.observations.map((o) => [
        o.identity.nativeId,
        o.normalized.title,
        o.normalized.companyName,
      ]),
    ).toEqual([
      ['https://berlinstartupjobs.com/?p=453570', 'Applied ML Engineer', 'LANIAKEA solutions'],
      ['https://berlinstartupjobs.com/?p=453406', 'Tech Lead (m/f/d)', 'Superchat'],
      ['https://berlinstartupjobs.com/?p=453055', 'Robotics Engineer', 'prefix.dev GmbH'],
    ])
  })

  it('maps each posting link to its canonical URL and its pubDate to publishedAt', async () => {
    // The normalizer canonicalises the URL: the trailing slash of the feed link is dropped.
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(
      batch.observations.map((o) => [o.sourcePostingUrl, o.normalized.publishedAt?.toISOString()]),
    ).toEqual([
      [
        'https://berlinstartupjobs.com/engineering/applied-ml-engineer-laniakea-solutions',
        '2026-11-17T16:14:11.000Z',
      ],
      [
        'https://berlinstartupjobs.com/engineering/tech-lead-m-f-d-superchat',
        '2026-11-02T14:16:36.000Z',
      ],
      [
        'https://berlinstartupjobs.com/engineering/robotics-engineer-prefix-dev-gmbh',
        '2026-10-14T13:32:04.000Z',
      ],
    ])
  })

  it('drops a non-IT entry: it is never observed and not counted as invalid', async () => {
    const feed = rss(item('1', 'IT / Software Development') + item('2', 'Operations &amp; Support'))
    const batch = await collect(feed)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      'https://berlinstartupjobs.com/?p=1',
    ])
    expect(batch.counts.invalid).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})
