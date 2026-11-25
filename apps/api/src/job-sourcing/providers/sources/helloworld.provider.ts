import { z } from 'zod'
import { classifyRoleFamily } from '../../funnel/layer1'
import type { RoleFamily } from '../../funnel/layer1.types'
import { safeSlice } from '../../normalize/build-posting'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * helloworld.rs (`https://www.helloworld.rs/rss/`), a Serbian job board, through the shared `RssProvider`
 * base. The discovery doc (2026-11-24, row "helloworld.rs": "High for Serbia IT", ~160 active tech jobs,
 * 15 in the public feed) expects IT, but the 2026-11-24 capture also holds non-engineering roles
 * ("Senior Product Designer", "Junior Product Marketing Specialist"). The feed has no category field, so
 * the IT filter is the funnel's own title classifier (`classifyRoleFamily`), applied per entry in `isItTitle`.
 *
 * PERMISSION: UNCLEAR, and the terms page could not be read (the Next.js site answers 404 on the common
 * terms paths). The owner's 2026-11-24 ACCEPT_RISK decision (`HELLOWORLD_OWNER_DECISION`) accepts that as
 * risk for this one feed endpoint (`/rss/`) only. Robots allows all.
 *
 * EMPLOYER. The description is `Company - Location | mode`; the segment before the first ` - ` is the
 * company. An empty company is no employer.
 *
 * DATES. `pubDate` is day-granular: every item carries 00:00 +01:00 of its day, so the window below must
 * cover at least one full day. INVENTORY: RECENT, 24 hours, declared and NOT measured (one capture, all
 * items dated the same day).
 */

export const HELLOWORLD_FEED_URL = 'https://www.helloworld.rs/rss/'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const HELLOWORLD_NAMESPACE = 'helloworld'
/** Declared window: covers a whole day of day-granular `pubDate`s, see the header. */
export const HELLOWORLD_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * The permission verdict the manifest reads. UNCLEAR, lifted only by `HELLOWORLD_OWNER_DECISION`
 * (2026-11-24, ACCEPT_RISK, endpointVariant `rss`).
 */
export const HELLOWORLD_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permitted by the owner decision of 2026-11-24 (ACCEPT_RISK; www.helloworld.rs/rss/ only; terms page unreadable, no evasion of any block)',
} as const

/**
 * The separator is ` - `, or a trailing ` -` when the location is empty: the XML reader trims the
 * element's text, so `Supabase - ` arrives as `Supabase -`.
 */
const SEPARATOR = /\s-(?:\s|$)/

/**
 * The families that are IT. UNKNOWN is kept: a title the classifier names no family for is not dropped
 * as non-IT, so a non-IT title the classifier cannot place passes. That exposure is bounded by the feed
 * itself (the 15 latest postings, see the header) and is accepted under the helloworld owner decision
 * (ACCEPT_RISK, 2026-11-24). DESIGN, PRODUCT and OTHER are dropped.
 */
const IT_ROLE_FAMILIES: ReadonlySet<RoleFamily> = new Set([
  'SOFTWARE',
  'DEVOPS',
  'DATA',
  'QA',
  'UNKNOWN',
])

/**
 * Whether a helloworld posting is IT, by its title through the funnel's own classifier. Only the prefix the
 * observation stores is classified: trimmed, NUL-free, capped at `ORIGINAL_LIMITS.title` (`safeSlice`, so a
 * surrogate pair is not cut). The verdict then matches the stored title, and the classifier is quadratic on
 * a long raw title (PR #1500 SR-H-1).
 */
export function isItTitle(title: string | null): boolean {
  // Stryker disable next-line StringLiteral: an absent title and '' both classify UNKNOWN, which is kept; no title text can differ
  const stored = (title ?? '').trim().replace(/\u0000/g, '')
  return IT_ROLE_FAMILIES.has(
    classifyRoleFamily({ title: safeSlice(stored, ORIGINAL_LIMITS.title) }).value,
  )
}

/** The company is the segment before the first separator. Empty or absent: no employer. */
export function parseHelloworldCompany(description: string | null): string | null {
  // Stryker disable next-line LogicalOperator,StringLiteral: a null description and '' both match no separator, so the fallback choice is equivalent
  const text = description ?? ''
  const separator = SEPARATOR.exec(text)
  if (separator === null) return null
  const companyName = text.slice(0, separator.index).trim()
  return companyName === '' ? null : companyName
}

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    namespace: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.literal(HELLOWORLD_NAMESPACE).default(HELLOWORLD_NAMESPACE),
    ),
  })
  .strict()
  .transform((config) => ({ ...config, query: null, window: null }))

type HelloworldConfig = z.output<typeof configSchema>

export const helloworldSpec: RssSourceSpec<HelloworldConfig> = {
  type: 'HELLOWORLD_RSS',
  adapterVersion: 'helloworld-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: HELLOWORLD_RECENT_WINDOW_MS },
  feedRequest: () => ({ url: HELLOWORLD_FEED_URL }),
  keepEntry: (entry) => isItTitle(entry.title),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: (entry.title ?? '').trim(),
    companyName: parseHelloworldCompany(entry.summary),
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: [...entry.categories],
    dates: [...entry.dates],
  }),
}

export const helloworldProvider = defineRssProvider(helloworldSpec)
