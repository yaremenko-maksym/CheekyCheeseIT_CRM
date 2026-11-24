import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import {
  parseSolidCompany,
  SOLIDJOBS_MAX_FEED_BYTES,
  SOLIDJOBS_MAX_ITEMS,
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

  it('drops a non-IT entry: it is never observed and not counted as invalid', async () => {
    const feed = rss(
      item('it-1', ['IT', 'Java'], 'Acme • Kraków 20k PLN') +
        item('sales-1', ['Sales'], 'Acme • Kraków 9k PLN'),
    )
    const batch = await collect(feed)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['it-1'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('declares the raised caps the 3,809-item live feed needs', () => {
    expect(solidJobsSpec.limits).toEqual({
      maxBytes: SOLIDJOBS_MAX_FEED_BYTES,
      maxItemsPerPage: SOLIDJOBS_MAX_ITEMS,
    })
    expect(SOLIDJOBS_MAX_FEED_BYTES).toBe(4 * 1024 * 1024)
    expect(SOLIDJOBS_MAX_ITEMS).toBeGreaterThan(3809)
  })
})
