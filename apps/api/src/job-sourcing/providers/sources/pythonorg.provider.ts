import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * Python.org Jobs (`https://www.python.org/jobs/feed/rss/`), the public job board of the Python
 * Software Foundation, through the shared `RssProvider` base. IT by construction: every posting on the
 * board is a Python role. Permission and robots verdict: the discovery doc (2026-11-24, row "Python.org
 * Jobs"); robots allows the feed path and the PSF legal page has no clause on automated access.
 *
 * FEED. The latest postings, 20 items in the capture of 2026-11-24. The feed carries NO `pubDate`, so an
 * item's age is unknown: the RECENT window below is a declared claim that is NOT measured for this feed.
 * Re-measure before relying on it.
 *
 * EMPLOYER. Titles are `Position, Company` (the company after the LAST comma). A legal suffix after that
 * comma ("Acme, Inc.") belongs to the company, so it is rejoined with the segment before it. A title with
 * no company keeps the whole string as the title and names no employer: the observation builder then
 * quarantines it, and an employer is never made up.
 */

export const PYTHONORG_FEED_URL = 'https://www.python.org/jobs/feed/rss/'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const PYTHONORG_NAMESPACE = 'pythonorg'
/** Declared window (see the header: NOT measured for this feed). */
export const PYTHONORG_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

const LEGAL_SUFFIX = /^(inc\.?|llc|ltd\.?|limited|corp\.?|gmbh|co\.?|b\.v\.?|s\.a\.)$/i

/** Split `Position, Company` at the last comma. Anything without a non-empty pair is the whole title. */
export function parsePythonTitle(raw: string): { title: string; companyName: string | null } {
  const whole = raw.trim()
  const last = whole.lastIndexOf(', ')
  if (last === -1) return { title: whole, companyName: null }
  let title = whole.slice(0, last).trim()
  let companyName = whole.slice(last + 2).trim()
  if (LEGAL_SUFFIX.test(companyName)) {
    const prior = title.lastIndexOf(', ')
    if (prior !== -1) {
      companyName = `${title.slice(prior + 2).trim()}, ${companyName}`
      title = title.slice(0, prior).trim()
    }
  }
  if (title === '' || companyName === '') return { title: whole, companyName: null }
  return { title, companyName }
}

const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    namespace: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.literal(PYTHONORG_NAMESPACE).default(PYTHONORG_NAMESPACE),
    ),
  })
  .strict()
  .transform((config) => ({ ...config, query: null, window: null }))

type PythonOrgConfig = z.output<typeof configSchema>

export const pythonOrgSpec: RssSourceSpec<PythonOrgConfig> = {
  type: 'PYTHONORG_RSS',
  adapterVersion: 'pythonorg-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: PYTHONORG_RECENT_WINDOW_MS },
  feedRequest: () => ({ url: PYTHONORG_FEED_URL }),
  mapEntry: (entry, config) => {
    const { title, companyName } = parsePythonTitle(entry.title ?? '')
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

export const pythonOrgProvider = defineRssProvider(pythonOrgSpec)
