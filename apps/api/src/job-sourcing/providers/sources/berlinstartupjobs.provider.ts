import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * berlinstartupjobs.com, the Berlin startup board, through the shared `RssProvider` base. A GENERAL
 * BOARD, so the feed is read from its IT category feed (`/engineering/feed/`, linked from the site's
 * home page) and each entry is kept only when its own categories include the IT label (`keepEntry`).
 * The site-wide feed `/feed/` mixes every sector; it is not the source used here.
 *
 * Permission verdict: the discovery doc (2026-11-24, row "berlinstartupjobs.com"): robots allows `/` for
 * all agents, and the terms section 3.13 acknowledges third-party crawlers and reuse of job ads.
 *
 * EMPLOYER. The title is `Position // Company`; the company is the segment after the first ` // `. The
 * feed's `dc:creator` is the site's admin account, not the employer, and is never used.
 *
 * INVENTORY. RECENT, 24 hours. The capture holds 12 items dated from 14 October to 17 November 2026, so
 * the feed does not saturate inside 24 h; the claim "everything from the last 24 h is in the feed" is
 * therefore plausible on that one capture. It is still one capture: re-measure before widening.
 */

export const BERLIN_FEED_URL = 'https://berlinstartupjobs.com/engineering/feed/'
/** The site's own IT category label, matched exactly against the entry's categories. */
export const BERLIN_IT_CATEGORY = 'IT / Software Development'
/** Declared window (see the header). */
export const BERLIN_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const BERLIN_NAMESPACE = 'berlinstartupjobs'

const SEPARATOR = ' // '

/** Split `Position // Company` at the first separator. Without a non-empty company, no employer. */
export function parseBerlinTitle(raw: string): { title: string; companyName: string | null } {
  const whole = raw.trim()
  const cut = whole.indexOf(SEPARATOR)
  if (cut === -1) return { title: whole, companyName: null }
  const title = whole.slice(0, cut).trim()
  const companyName = whole.slice(cut + SEPARATOR.length).trim()
  if (title === '' || companyName === '') return { title: whole, companyName: null }
  return { title, companyName }
}

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    namespace: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.literal(BERLIN_NAMESPACE).default(BERLIN_NAMESPACE),
    ),
  })
  .strict()
  .transform((config) => ({ ...config, query: null, window: null }))

type BerlinConfig = z.output<typeof configSchema>

export const berlinStartupJobsSpec: RssSourceSpec<BerlinConfig> = {
  type: 'BERLINSTARTUPJOBS_RSS',
  adapterVersion: 'berlinstartupjobs-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: BERLIN_RECENT_WINDOW_MS },
  feedRequest: () => ({ url: BERLIN_FEED_URL }),
  keepEntry: (entry) => entry.categories.includes(BERLIN_IT_CATEGORY),
  mapEntry: (entry, config) => {
    const { title, companyName } = parseBerlinTitle(entry.title ?? '')
    return {
      namespace: config.namespace,
      url: entry.link,
      title,
      companyName,
      description: entry.content ?? entry.summary,
      descriptionKind: 'html',
      tags: entry.categories.filter((c) => c !== BERLIN_IT_CATEGORY),
      dates: [...entry.dates],
    }
  },
}

export const berlinStartupJobsProvider = defineRssProvider(berlinStartupJobsSpec)
