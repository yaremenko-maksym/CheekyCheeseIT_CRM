import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * LaraJobs (`https://larajobs.com/feed`), a Laravel job board, through the shared `RssProvider` base.
 * Laravel-only by construction, so no IT filter is applied. Permission: discovery doc (2026-11-24, row
 * "LaraJobs"): official public RSS linked in the footer, robots allows all, terms carry no clause on
 * automated access.
 *
 * EMPLOYER. The company sits in the namespaced `job:company` element (namespace `https://larajobs.com`).
 * The reader keeps namespaced children it does not read by name in `FeedEntry.extensions`, keyed
 * `{namespace}local`, so the employer is read from there. An item with no `job:company` names no
 * employer, and none is made up.
 *
 * DATES. `pubDate` is present. INVENTORY: RECENT, 14 days, declared and NOT measured (one capture of 8
 * items; the three kept ones are dated 2026-11-13 to 2026-11-24, so a shorter window would drop them).
 */

export const LARAJOBS_FEED_URL = 'https://larajobs.com/feed'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const LARAJOBS_NAMESPACE = 'larajobs'
/** Declared window (see the header: NOT measured for this feed). */
export const LARAJOBS_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** The Clark-notation key of the `job:company` element (see `FeedEntry.extensions`). */
const COMPANY_KEY = '{https://larajobs.com}company'

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    namespace: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.literal(LARAJOBS_NAMESPACE).default(LARAJOBS_NAMESPACE),
    ),
  })
  .strict()
  .transform((config) => ({ ...config, query: null, window: null }))

type LaraJobsConfig = z.output<typeof configSchema>

export const larajobsSpec: RssSourceSpec<LaraJobsConfig> = {
  type: 'LARAJOBS_RSS',
  adapterVersion: 'larajobs-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: LARAJOBS_RECENT_WINDOW_MS },
  feedRequest: () => ({ url: LARAJOBS_FEED_URL }),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: (entry.title ?? '').trim(),
    companyName: entry.extensions[COMPANY_KEY]?.[0] ?? null,
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: [...entry.categories],
    dates: [...entry.dates],
  }),
}

export const larajobsProvider = defineRssProvider(larajobsSpec)
