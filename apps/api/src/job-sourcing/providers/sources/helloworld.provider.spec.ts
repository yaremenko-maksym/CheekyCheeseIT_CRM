import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import {
  helloworldProvider,
  helloworldSpec,
  isItTitle,
  parseHelloworldCompany,
} from './helloworld.provider'

/**
 * helloworld.rs, through the base's public collect path. Expected values are written by hand from the
 * trimmed capture of 2026-11-24 (`__fixtures__/helloworld/rss.trimmed.xml`, provenance beside it). The
 * empty-employer cases are SYNTHETIC.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'helloworld', 'rss.trimmed.xml')
const NOW = new Date('2026-11-24T20:00:00Z')

const config = () => helloworldProvider.parseConfig({ namespace: 'helloworld', configVersion: 1 })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(helloworldSpec, config(), f.ctx)
}

describe('parseHelloworldCompany - the segment before " - "', () => {
  it.each([
    [
      'a real description with a location',
      'Pollard Digital Solutions - Beograd | Hibrid',
      'Pollard Digital Solutions',
    ],
    ['a real description with no location', 'Supabase - ', 'Supabase'],
    ['a real description with no location, as the reader trims it', 'Supabase -', 'Supabase'],
    ['a synthetic description with an empty company', ' - Beograd', null],
    ['a synthetic description without a separator', 'Supabase', null],
    ['an absent description', null, null],
  ] as const)('%s', (_label, description, expected) => {
    expect(parseHelloworldCompany(description)).toBe(expected)
  })
})

describe('isItTitle - the funnel title classifier keeps the IT families', () => {
  it.each([
    ['a software title', 'Software Engineer - Interfaces Backend', true],
    ['an engineering-management title', 'Engineering Manager', true],
    ['a design title', 'Senior Product Designer', false],
    ['a product-marketing title', 'Junior Product Marketing Specialist', false],
    ['an absent title is undecided, so kept', null, true],
    [
      'an unclassified title is kept: UNKNOWN passes, bounded by the 15-item feed',
      'Happy Hour Host',
      true,
    ],
  ] as const)('%s', (_label, title, expected) => {
    expect(isItTitle(title)).toBe(expected)
  })
})

describe('HELLOWORLD_RSS drops a non-IT posting: never observed, not counted invalid', () => {
  const rss = (items: string) =>
    `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>helloworld</title>${items}</channel></rss>`
  const item = (n: string, title: string) =>
    `<item><guid isPermaLink="false">https://www.helloworld.rs/posao/${n}</guid><link>https://www.helloworld.rs/posao/${n}</link><title>${title}</title><description>Acme - Beograd | Hibrid</description><pubDate>Tue, 24 Nov 2026 00:00:00 +0100</pubDate></item>`

  it('keeps the software posting and drops the design posting', async () => {
    const batch = await collect(
      rss(item('1-designer', 'Senior Product Designer') + item('2-engineer', 'Software Engineer')),
    )
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      'https://www.helloworld.rs/posao/2-engineer',
    ])
    expect(batch.counts.invalid).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})

describe('HELLOWORLD_RSS collect on the trimmed capture', () => {
  it('maps title and employer of each posting', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => [o.normalized.title, o.normalized.companyName])).toEqual([
      ['Software Engineer - Interfaces Backend', 'Supabase'],
      ['Engineering Manager', 'Pollard Digital Solutions'],
      ['Front-End Developer', 'Brezna d.o.o.'],
    ])
  })
})
