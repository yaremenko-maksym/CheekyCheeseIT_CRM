import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * We Work Remotely (weworkremotely.com) vacancies, from its public RSS feeds through the shared
 * `RssProvider` base. Measurements, captures and the permission verdict:
 * `__fixtures__/wwr/*.provenance.json` (2026-10-23).
 *
 * FEEDS. The all-jobs feed (`/remote-jobs.rss`) and the category feeds
 * (`/categories/<slug>.rss`). The category is a closed enum of the four feeds that were fetched and
 * found live. A slug that does not exist is not a 404: the site answers 403 with a Cloudflare "Just a
 * moment..." interstitial (captured as `unknown-category.challenge-403.html`), so a guessed slug would
 * cost a challenge against our own address. The legacy `remote-programming-jobs.rss` is left out: it
 * answered 200 with 25 items, no `expires_at` and nothing newer than 2026-10-05 while its siblings had
 * items from the day of the fetch.
 *
 * A CHALLENGE IS A STOP. The honest client does not solve it, retry around it or change identity (the
 * base sets the user agent and strips browser client hints). A 403 is classified ACCESS_POLICY by the
 * loop; a challenge served with 200 is not well-formed XML and is PARSE_DRIFT. Either ends the run
 * after exactly one request.
 *
 * EMPLOYER. WWR titles are `Company: Position`. The employer is read from that prefix and from nowhere
 * else; a title without it keeps the whole string as the title and names no employer (the observation
 * builder then quarantines the item - an employer is never made up). The split is at the FIRST colon,
 * because 2 of 179 distinct real titles carry a second colon and in both it sits inside the position
 * (`Yooli: FULL TIME: Software Engineer ...`). No real title had a colon inside the company name, so a
 * company that contains one would be mis-split; there is no signal in the feed to tell the two apart
 * (the link slug is derived from the whole title, so it cannot arbitrate).
 *
 * WHAT THE SHARED READER DOES NOT EXPOSE. `region`, `country`, `state`, `type`, `skills` and `expires_at`
 * are plain child elements of every item that `FeedEntry` has no slot for, so location, employment type
 * and expiry are not mapped. Adding them is a change to the feed reader, which this task does not own.
 * `remote` is not set either: the board is remote-only by its name, but that is the board's claim about
 * itself and not a field of the item.
 *
 * INVENTORY: RECENT, 24 hours. The all-jobs feed is not the board and not a time window: it is the 10
 * newest items of each of 10 categories (95 items because Back-End has 7 and Front-End 8). Hence
 * "everything published in the last N hours is in it" holds for N up to the age gap of the busiest
 * saturated category: measured, the 10th-newest item of "All Other Remote" was 57.4 h older than the
 * feed's newest item, and all 8 items of the three category feeds fetched that were published in the
 * last 24 h were present in all-jobs. The category feeds were each a superset of the all-jobs items of
 * their category (10/10, 10/10, 7/7, 8/8), so the same floor holds for them. 24 h is under half the
 * measured 57.4 h. One capture on one Friday evening; re-measure before widening. `pubDate` is not a
 * posting date for a renewed listing (one item carried 2023-02-07 with `expires_at` 2026-11-18); it is
 * still the date the feed publishes, and is mapped as PUBLISHED.
 */

export const WWR_CATEGORIES = [
  'remote-back-end-programming-jobs',
  'remote-front-end-programming-jobs',
  'remote-full-stack-programming-jobs',
  'remote-devops-sysadmin-jobs',
] as const

const ALL_JOBS_URL = 'https://weworkremotely.com/remote-jobs.rss'
const categoryUrl = (slug: string): string => `https://weworkremotely.com/categories/${slug}.rss`
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Split `Company: Position` at the first colon. Anything that does not yield a non-empty company AND a
 * non-empty position is returned whole, as the title, with no company.
 */
export function parseWwrTitle(raw: string): { companyName: string | null; title: string } {
  const whole = raw.trim()
  const colon = whole.indexOf(':')
  if (colon === -1) return { companyName: null, title: whole }
  const companyName = whole.slice(0, colon).trim()
  const title = whole.slice(colon + 1).trim()
  if (companyName === '' || title === '') return { companyName: null, title: whole }
  return { companyName, title }
}

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({ category: z.enum(WWR_CATEGORIES).optional() })
  .strict()
  .transform((config) => ({ ...config, query: config.category ?? null, window: null }))

type WwrConfig = z.output<typeof configSchema>

export const wwrSpec: RssSourceSpec<WwrConfig> = {
  type: 'WWR_RSS',
  adapterVersion: 'wwr-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: RECENT_WINDOW_MS },
  feedRequest: (config) => ({
    url: config.category === undefined ? ALL_JOBS_URL : categoryUrl(config.category),
  }),
  mapEntry: (entry, config) => {
    const { companyName, title } = parseWwrTitle(entry.title ?? '')
    return {
      namespace: config.namespace,
      url: entry.link,
      title,
      companyName,
      description: entry.content ?? entry.summary,
      descriptionKind: 'html',
      tags: [...entry.categories],
      dates: [...entry.dates],
    }
  },
}

export const wwrProvider = defineRssProvider(wwrSpec)
