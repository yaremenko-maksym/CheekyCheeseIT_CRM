import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * EU Remote Jobs (euremotejobs.com) - a WordPress site running WP Job Manager - read through the shared
 * `RssProvider` base. Seeded with an empty config, kept strict-empty here.
 *
 * THIS SOURCE IS BLOCKED, AND THE ADAPTER EXISTS SO THAT THE BLOCK IS A FACT IN CODE, NOT A GUESS.
 * Measured on 2026-10-23 (`__fixtures__/euremotejobs/*.provenance.json`):
 *  - `https://euremotejobs.com/jobs/feed/`, the seeded endpoint, is a WordPress COMMENTS feed: channel
 *    title "Comments on: Work From Home Jobs", `lastBuildDate` 2025-11-05, zero items. It is a valid
 *    feed, so the base reports a successful run with nothing in it - indistinguishable from a quiet
 *    day, and it would stay that way forever. The adapter cannot tell the two apart (the channel title is
 *    not visible to `mapEntry`), which is the reason this source must not be enabled as seeded.
 *  - The documented job feed (`/?feed=job_feed`) answered 401 with a WordPress error body. It was not
 *    retried or worked around.
 *
 * EMPLOYER. WP Job Manager puts the employer in a namespaced element,
 * `<job_listing:company>` (namespace = the site url; also `location`, `job_type`, `job_category`,
 * `salary`, each in CDATA - from the plugin's `class-wp-job-manager-post-types.php`). So the employer IS
 * in the feed; it is unreachable only because the shared `FeedEntry` reader has no slot for namespaced
 * extension elements. This is NOT Djinni's case (there the feed has no employer field at all). Fixing it
 * is a change to the shared reader, which this task does not own; owner:
 * backlog entry 307 (`.claude/tasks/BACKLOG-followups.md`, second requirement: the shared feed reader
 * exposes no namespaced extension elements; working draft: the untracked task-3.8 file). Until then
 * `companyName` is `null` (not taken from the title; `dc:creator` is the account that posted, not the
 * employer) and the observation builder quarantines the item rather than guessing.
 *
 * PRECONDITION FOR ANYONE ENABLING THIS SOURCE. Do not enable it, and do not register it, while the
 * seeded endpoint is the comments feed above: a run reports SUCCEEDED / WINDOW with zero items, which
 * reads as "nothing was posted" when the truth is "this is the wrong feed". The adapter cannot detect
 * that (the channel title is not visible to `mapEntry`). It is inert today only because the seed row is
 * `enabled = false` and nothing registers the provider (Task 3.7). Enabling needs a working job-feed
 * endpoint AND backlog entry 307, and the spec case "the seeded comments feed is a valid feed with zero items,
 * reported as an empty success" must be revisited then.
 *
 * INVENTORY: RECENT, 1 hour, and UNMEASURED - no job item was ever seen. It is the floor, not a finding:
 * WP Job Manager's feed query defaults to 10 items (`posts_per_page`), so a feed that is the newest 10
 * can cover only a short window of a busy board; a small board covers more. Measure when a real job feed
 * exists.
 */

const FEED_URL = 'https://euremotejobs.com/jobs/feed/'
/** Unmeasured floor: no job item was ever seen, so there is no bound to stay under. */
export const EU_RECENT_WINDOW_MS = 60 * 60 * 1000

/** Strict-empty: only the identity fields. Matches the seed row `{}`. */
const configSchema = baseSourceConfigSchema.omit({ query: true, window: true }).strict()

type EuRemoteJobsConfig = ReturnType<typeof configSchema.parse>

export const euRemoteJobsSpec: RssSourceSpec<EuRemoteJobsConfig> = {
  type: 'EUREMOTEJOBS_RSS',
  adapterVersion: 'euremotejobs-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: EU_RECENT_WINDOW_MS },
  feedRequest: () => ({ url: FEED_URL }),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: entry.title,
    // Not in the title, not in dc:creator; the real field is a namespaced element the reader cannot see.
    companyName: null,
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: [...entry.categories],
    dates: [...entry.dates],
  }),
}

export const euRemoteJobsProvider = defineRssProvider(euRemoteJobsSpec)
