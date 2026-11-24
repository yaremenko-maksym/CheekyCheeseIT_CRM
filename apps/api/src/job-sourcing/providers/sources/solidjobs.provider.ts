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
 * 500-item and 2 MiB caps would refuse it, so both are raised here, measured, with the item cap at about
 * 30% headroom. Parse cost stays bounded by the pre-scan ceilings in `xml/xml-limits.ts`.
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
/** 3,809 items measured; ~30% headroom. */
export const SOLIDJOBS_MAX_ITEMS = 5000

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
  limits: { maxBytes: SOLIDJOBS_MAX_FEED_BYTES, maxItemsPerPage: SOLIDJOBS_MAX_ITEMS },
  feedRequest: () => ({ url: SOLIDJOBS_FEED_URL }),
  keepEntry: (entry) => entry.categories.includes(SOLIDJOBS_IT_CATEGORY),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: entry.title ?? '',
    companyName: parseSolidCompany(entry.summary),
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: entry.categories.filter((c) => c !== SOLIDJOBS_IT_CATEGORY),
    dates: [...entry.dates],
  }),
}

export const solidJobsProvider = defineRssProvider(solidJobsSpec)
