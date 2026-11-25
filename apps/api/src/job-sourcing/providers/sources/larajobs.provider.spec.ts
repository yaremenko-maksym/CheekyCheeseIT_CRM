import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import { larajobsProvider, larajobsSpec } from './larajobs.provider'

/**
 * LaraJobs, through the base's public collect path. Expected values are written by hand from the trimmed
 * capture of 2026-11-24 (`__fixtures__/larajobs/rss.trimmed.xml`, provenance beside it). The two
 * employer cases that are NOT in the capture are SYNTHETIC.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'larajobs', 'rss.trimmed.xml')
const NOW = new Date('2026-11-24T20:00:00Z')

const config = () => larajobsProvider.parseConfig({ namespace: 'larajobs', configVersion: 1 })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(larajobsSpec, config(), f.ctx)
}

const feed = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:job="https://larajobs.com" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>LaraJobs</title>${items}</channel></rss>`

const item = (n: number, inner: string) =>
  `<item><title>Role ${n}</title><link>https://larajobs.com/job/${n}</link><pubDate>Tue, 24 Nov 2026 11:55:45 +0000</pubDate>${inner}<guid isPermaLink="false">https://larajobs.com/job/${n}</guid></item>`

describe('LARAJOBS_RSS collect on the trimmed capture', () => {
  it('maps title and employer of each posting from the namespaced job:company element', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => [o.normalized.title, o.normalized.companyName])).toEqual([
      ['Lead Software Engineer', 'Founders Law'],
      ['Senior Product Engineer', 'Paul Xavier International LLC'],
      ['Senior Full Stack Software Engineer (Remote, USA or Brazil)', 'Emergent 3'],
    ])
  })

  it('maps each job link to its URL and its pubDate to publishedAt', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(
      batch.observations.map((o) => [o.sourcePostingUrl, o.normalized.publishedAt?.toISOString()]),
    ).toEqual([
      ['https://larajobs.com/job/3959', '2026-11-24T11:55:45.000Z'],
      ['https://larajobs.com/job/3957', '2026-11-16T16:51:21.000Z'],
      ['https://larajobs.com/job/3956', '2026-11-13T19:00:11.000Z'],
    ])
  })
})

describe('LARAJOBS_RSS employer comes from job:company, never from dc:creator', () => {
  it('reads the employer from job:company when dc:creator names someone else', async () => {
    const batch = await collect(
      feed(item(1, '<dc:creator>Site Account</dc:creator><job:company>Acme Labs</job:company>')),
    )
    expect(batch.observations).toHaveLength(1)
    expect(batch.observations[0]?.normalized.companyName).toBe('Acme Labs')
  })

  it('does not observe a posting that names no employer: no employer is made up', async () => {
    const batch = await collect(feed(item(2, '<dc:creator>Site Account</dc:creator>')))
    expect(batch.observations).toHaveLength(0)
    expect(batch.counts.raw).toBe(1)
    expect(batch.counts.quarantined).toBe(1)
    expect(batch.counts.invalid).toBe(0)
  })
})
