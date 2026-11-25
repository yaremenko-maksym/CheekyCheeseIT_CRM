import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { baseSourceConfigSchema } from './api-json.provider'
import { collectFeedPages, type RssSourceSpec } from './rss.provider'

/**
 * The optional `keepEntry` slot of the feed base: an entry it rejects is never observed, and a feed
 * without the slot keeps every entry (the unchanged behaviour of every existing feed adapter).
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>
const config = (): Config => configSchema.parse({ namespace: 'board', configVersion: 1 })
const NOW = new Date('2026-10-20T10:00:00Z')

const rss = (items: string) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Jobs</title>${items}</channel></rss>`
const item = (guid: string, category: string) =>
  `<item><title>Role ${guid}</title><link>https://board.example/${guid}</link><guid isPermaLink="false">${guid}</guid><author>Acme</author><category>${category}</category><pubDate>Tue, 20 Oct 2026 09:00:00 +0000</pubDate></item>`
const FEED = rss(item('it-1', 'IT') + item('sales-1', 'Sales') + item('it-2', 'IT'))

function spec(overrides: Partial<RssSourceSpec<Config>> = {}): RssSourceSpec<Config> {
  return {
    type: 'WWR_RSS',
    adapterVersion: 'keep-entry-test-1',
    configSchema,
    inventory: { kind: 'RECENT', windowMs: 24 * 60 * 60 * 1000 },
    feedRequest: () => ({ url: 'https://board.example/feed' }),
    mapEntry: (entry, cfg) => ({
      namespace: cfg.namespace,
      url: entry.link,
      title: entry.title,
      companyName: entry.authors[0] ?? 'Unknown employer',
      description: entry.content ?? entry.summary,
      descriptionKind: 'html',
      dates: [...entry.dates],
    }),
    ...overrides,
  }
}

const collect = async (s: RssSourceSpec<Config>, bodyText: string) => {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(s, config(), f.ctx)
}

describe('keepEntry — the optional entry filter of the feed base', () => {
  it('observes only the entries the predicate keeps, in feed order', async () => {
    const batch = await collect(
      spec({ keepEntry: (entry) => entry.categories.includes('IT') }),
      FEED,
    )
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['it-1', 'it-2'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a rejected entry is not counted as an invalid observation', async () => {
    const batch = await collect(spec({ keepEntry: () => false }), FEED)
    expect(batch.observations).toEqual([])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('without the slot every entry is kept, as before', async () => {
    const batch = await collect(spec(), FEED)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['it-1', 'sales-1', 'it-2'])
  })

  it('the predicate receives the validated config of the run', async () => {
    const seen: string[] = []
    await collect(
      spec({
        keepEntry: (_entry, cfg) => {
          seen.push(cfg.namespace)
          return true
        },
      }),
      FEED,
    )
    expect(seen).toEqual(['board', 'board', 'board'])
  })
})
