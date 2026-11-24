import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * solid.jobs (`https://solid.jobs/rss/job-offers`), a Polish general board for technology roles, through
 * the shared `RssProvider` base. A GENERAL BOARD: the feed mixes sectors, so only the entries the site
 * tags `IT` are kept (`keepEntry`, decided per entry from its own categories). Permission verdict: the
 * discovery doc (2026-11-24, row "solid.jobs"); robots allows `/`.
 *
 * EMPLOYER. The item description is `Company • Location salary`: the segment before ` • ` is the company.
 * A description without that separator names no employer, and the item is quarantined, not guessed.
 *
 * SIZE. The feed is the whole live inventory: 3,809 items and about 1.7 MB raw on 2026-11-24. The default
 * 500-item, 2 MiB and 250 ms caps would refuse it, so all three are raised here. The pre-scan spends the
 * time budget as a count of elements and attributes (`floor(maxWallClockMs × 100)`); the live feed is
 * about 34,300 of those (3,809 × 9). At 9 units per entry the 40,000-unit budget admits about 4,442
 * entries once the ~14-unit RSS wrapper is counted, so the item cap is set BELOW that, at 4,400: the
 * declared number is the one that binds (about 15% headroom over 3,809). Parse cost stays bounded by the
 * pre-scan ceilings in `xml/xml-limits.ts`.
 *
 * INVENTORY. RECENT, 24 hours. shortcut: the window is a declared claim, not measured on this feed (the
 * capture carries `pubDate`s from weeks back, so the 24 h floor is an under-claim, not a proof). Upgrade:
 * measure the age gap of the 3,809-item feed before widening.
 */

export const SOLIDJOBS_FEED_URL = 'https://solid.jobs/rss/job-offers'
/** The site's own sector tag for technology roles. Matched exactly. */
export const SOLIDJOBS_IT_CATEGORY = 'IT'
/** Declared window: under the feed's measured age span, see the header. */
export const SOLIDJOBS_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const SOLIDJOBS_NAMESPACE = 'solidjobs'
/** 2× the 2 MiB default: the live feed is about 1.7 MB raw (measured 2026-11-24). */
export const SOLIDJOBS_MAX_FEED_BYTES = 4 * 1024 * 1024
/**
 * 3,809 items measured on 2026-11-24. Below the unit budget's entry ceiling (about 4,442 after the RSS
 * wrapper, see the header SIZE paragraph), so this declared cap, not the budget, binds first.
 */
export const SOLIDJOBS_MAX_ITEMS = 4400
/**
 * 400 ms, not the 250 ms default. The budget is a unit count, not a clock: `itemCeiling` converts it at
 * `PARSE_ITEMS_PER_MS` (100 units per ms) into 40,000 element/attribute units. The live feed is ~34,300 of
 * them, over the default 25,000. Reference timings: the whole `collectFeedPages` call on a canned body (no
 * network), this machine, 2026-11-25, load average 15–30, 3 runs each:
 *   3,809 items, 1.0 MB body:                 465–623 ms
 *   3,809 items + 3 MB text, 4.0 MB body:     495–631 ms (the per-byte residue of the 4 MiB cap adds little)
 * The loaded host ran above 400 ms, so 400 is a unit ceiling here, not a wall-time guarantee.
 * shortcut: the budget is a unit model; if parse time becomes the concern, re-measure on an idle host and
 * revisit `PARSE_ITEMS_PER_MS`, not this constant. Upgrade: before the feed passes ~4,400 entries.
 */
export const SOLIDJOBS_MAX_WALL_CLOCK_MS = 400

const SEPARATOR = ' • '

/** The company is the segment before ` • `. Anything else names no employer. */
export function parseSolidCompany(description: string | null): string | null {
  if (description === null) return null
  const cut = description.indexOf(SEPARATOR)
  if (cut === -1) return null
  const companyName = description.slice(0, cut).trim()
  return companyName === '' ? null : companyName
}

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    namespace: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.literal(SOLIDJOBS_NAMESPACE).default(SOLIDJOBS_NAMESPACE),
    ),
  })
  .strict()
  .transform((config) => ({ ...config, query: null, window: null }))

type SolidJobsConfig = z.output<typeof configSchema>

export const solidJobsSpec: RssSourceSpec<SolidJobsConfig> = {
  type: 'SOLIDJOBS_RSS',
  adapterVersion: 'solidjobs-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: SOLIDJOBS_RECENT_WINDOW_MS },
  limits: {
    maxBytes: SOLIDJOBS_MAX_FEED_BYTES,
    maxItemsPerPage: SOLIDJOBS_MAX_ITEMS,
    maxWallClockMs: SOLIDJOBS_MAX_WALL_CLOCK_MS,
  },
  feedRequest: () => ({ url: SOLIDJOBS_FEED_URL }),
  keepEntry: (entry) => entry.categories.includes(SOLIDJOBS_IT_CATEGORY),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: (entry.title ?? '').trim(),
    companyName: parseSolidCompany(entry.summary),
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: entry.categories.filter((c) => c !== SOLIDJOBS_IT_CATEGORY),
    dates: [...entry.dates],
  }),
}

export const solidJobsProvider = defineRssProvider(solidJobsSpec)
