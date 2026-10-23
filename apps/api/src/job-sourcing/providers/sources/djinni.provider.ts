import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { defineRssProvider, type RssSourceSpec } from '../rss.provider'

/**
 * Djinni (djinni.co) vacancies, read from its public RSS feed through the shared `RssProvider` base.
 *
 * Every claim below was measured on 2026-10-23 against the live feed; the captures, the counts and the
 * permission verdict are in `__fixtures__/djinni/*.provenance.json`.
 *
 * THE FILTER TAXONOMY IS CLOSED BECAUSE THE SITE IGNORES WHAT IT DOES NOT KNOW. A misspelt
 * `primary_keyword`, an unknown `exp_level` and a feed-only group label such as `Development` each came
 * back byte-identical to the UNFILTERED feed (sha256 4697214590f5...). A typo would therefore not fail:
 * it would silently widen a Rust search to the whole board, every profession included. So the values are
 * an enum, and the enum is the 157 keys of the site's own filter tree (`/jobs/`, the `primary_keyword`
 * multiselect) rather than the 170 `<category>` elements of the channel, thirteen of which are group
 * labels the filter does not accept.
 *
 * THE FEED HAS NO EMPLOYER. An item is `title, link, description, pubDate, guid` and two `<category>`
 * elements (the second empty on every item); there is no author, `dc:creator` or company element, and the
 * company named inside a description is prose, not a field. This adapter does not read a company out of
 * the title or the description, so `companyName` is `null` and the observation builder quarantines every
 * Djinni item as MISSING_COMPANY. That is the honest outcome under today's contract and it makes the
 * source unusable until the contract can represent "employer not disclosed" (withheld at the source, by
 * the site's design). Owner: the backlog entry "A posting whose employer is withheld at the source has nowhere to live"
 * in `.claude/tasks/BACKLOG-followups.md` (numbered 309 when written; the title is the address; working draft: the untracked task-3.8 file) - reported, not worked
 * around by writing "Djinni" or a guess into the field.
 *
 * INVENTORY: RECENT, 1 hour. The feed is the newest 100 postings of the filter, not a time window and
 * not the whole board: the unfiltered feed returned exactly 100 items spanning 6.9 hours (busiest hour:
 * 32 postings), `primary_keyword=Python` returned 100 reaching back 24 days, while Rust returned 8 and
 * `Rust` + `5y` 2 - those are whole result sets. The one thing true of every response is "everything
 * posted in the last N hours is in it", and N is bounded below by the cap over the peak rate:
 * 100 / 32 = 3.1 h. One hour is a conservative floor under that. A second capture on a busier weekday
 * could lower the peak rate; re-measure before widening this number.
 *
 * The earlier note in `dou.provider.ts` that Djinni's feed returns 1-2 items does not reproduce for the
 * unfiltered feed (100); it does for narrow filters (`Rust` + `5y`: 2).
 */

export const DJINNI_PRIMARY_KEYWORDS = [
  '.NET',
  '.NET Gamedev',
  '2D Animation',
  '2D Artist',
  '3D Animation',
  '3D Artist',
  'ASIC / Chip Design',
  'ASP.NET',
  'Account Manager',
  'Accountant',
  'Advertising',
  'Affiliate Manager',
  'Android',
  'Angular',
  'Architect',
  'Artist',
  'Avionics',
  'Blazor',
  'Business Analyst',
  'Business Development',
  'C Lang',
  'C++',
  'CAD Designer',
  'CBDO',
  'CCO',
  'CEO',
  'CFO',
  'CIO',
  'CMO',
  'COO',
  'CPO',
  'CPP',
  'CSO',
  'CTO',
  'Content Design',
  'Content Manager',
  'Content Marketing',
  'Content Writing',
  'Data Analyst',
  'Data Engineer',
  'Data Science',
  'DefTech',
  'Delivery Manager',
  'Design',
  'DevOps',
  'Digital Marketing',
  'Digital Marketing Manager',
  'Dotnet Cloud',
  'Dotnet Desktop',
  'Dotnet Mobile',
  'Dotnet Web',
  'Drupal',
  'ERP',
  'Electrical Engineering',
  'Electronic Warfare',
  'Electronics / PCB Design',
  'Elixir',
  'Embedded',
  'Engineering / CAD Design',
  'Engineering Manager',
  'FPGA Engineer',
  'FinOps',
  'Finance Manager',
  'Finances',
  'Financial Analyst',
  'Firmware Engineer',
  'Flutter',
  'Fullstack',
  'Game Design',
  'Game Developer',
  'Golang',
  'Graphic Design',
  'HR',
  'Hardware',
  'Hardware Engineer',
  'Head Chief',
  'Illustrator',
  'Industrial Design',
  'Information Security',
  'Interviewer',
  'Java',
  'JavaScript',
  'Kotlin',
  'Laravel',
  'Lead',
  'Lead Generation',
  'Level Design',
  'MAUI',
  'ML AI',
  'MS Dynamics',
  'Magento',
  'Marketing',
  'Marketing Analyst',
  'Markup',
  'Mechanical Engineering',
  'Media Buying',
  'Military Software / C4ISR',
  'Motion Design',
  'No Code',
  'Node.js',
  'Odoo',
  'Other',
  'PHP',
  'PPC',
  'PR Manager',
  'Penetration Tester',
  'Performance Marketing',
  'Product Design',
  'Product Manager',
  'Product Owner',
  'Project Manager',
  'Python',
  'QA',
  'QA Automation',
  'QA Hardware / Embedded',
  'RF Engineer',
  'React Native',
  'React.js',
  'Recruiter',
  'Robotics Engineer',
  'Ruby',
  'Rust',
  'SAP',
  'SEO',
  'SQL',
  'Sales',
  'Sales Leadership',
  'Sales Manager',
  'Salesforce',
  'Scala',
  'Scrum Master',
  'Security',
  'Security Analyst',
  'Social Media',
  'Support',
  'Svelte',
  'Symfony',
  'Sysadmin',
  'Technical Writing',
  'UAV / Drone Engineer',
  'UAV / Drone Pilot',
  'UI UX',
  'UX Research',
  'Unity',
  'Unity Developer',
  'Unreal Developer',
  'VFX Artist',
  'Video Editor',
  'Vue.js',
  'WPF',
  'Weapons Systems',
  'Web Analyst',
  'WinForms',
  'WordPress',
  'Xamarin',
  'Yii',
  'iOS',
] as const

/** The site's experience filter: `no_exp`, then 1 to 10 years (`/jobs/`, input name `exp_level`). */
export const DJINNI_EXP_LEVELS = [
  'no_exp',
  '1y',
  '2y',
  '3y',
  '4y',
  '5y',
  '6y',
  '7y',
  '8y',
  '9y',
  '10y',
] as const

const FEED_URL = 'https://djinni.co/jobs/rss/'
/**
 * The feed cap (items) and the busiest measured hour (items/hour); their quotient is the bound.
 *
 * DERIVATION (2026-10-23). Inputs: the UNFILTERED feed returned exactly 100 items per response (the
 * cap), spanning 6.9 hours, and its busiest single hour held 32 postings. Operation: 100 / 32 = 3.125 h,
 * x 3 600 000 ms/h = 11 250 000 ms. LIMIT: the unfiltered capture is NOT in the repository (the
 * committed `primary-keyword-rust.xml` is a filtered 8-item response), so the 100, the 6.9 h and the 32
 * are recorded figures, not re-derivable here. Only the division is checkable.
 */
export const DJINNI_FEED_CAP = 100
export const DJINNI_PEAK_ITEMS_PER_HOUR = 32
/** 100 / 32 = 3.125 h: past this age "everything posted in the last N hours is in the feed" is unknown. */
export const DJINNI_MEASURED_COVERAGE_BOUND_MS =
  (DJINNI_FEED_CAP / DJINNI_PEAK_ITEMS_PER_HOUR) * 60 * 60 * 1000
/** Declared window: a conservative floor under `DJINNI_MEASURED_COVERAGE_BOUND_MS`. */
export const DJINNI_RECENT_WINDOW_MS = 60 * 60 * 1000

/** The query string for a filter. It is also the scope's `query`, so each filter has its own scope. */
function filterQuery(filter: {
  primaryKeyword: (typeof DJINNI_PRIMARY_KEYWORDS)[number]
  expLevel?: (typeof DJINNI_EXP_LEVELS)[number] | undefined
}): string {
  const params = new URLSearchParams({ primary_keyword: filter.primaryKeyword })
  if (filter.expLevel !== undefined) params.set('exp_level', filter.expLevel)
  return params.toString()
}

/**
 * No `query` and no `window` in the input: the query is derived from the filter, and a RECENT feed
 * refuses a window (see `assertConfigWindow` in the base).
 */
const configSchema = baseSourceConfigSchema
  .omit({ query: true, window: true })
  .extend({
    primaryKeyword: z.enum(DJINNI_PRIMARY_KEYWORDS),
    expLevel: z.enum(DJINNI_EXP_LEVELS).optional(),
  })
  .strict()
  .transform((config) => ({ ...config, query: filterQuery(config), window: null }))

type DjinniConfig = z.output<typeof configSchema>

export const djinniSpec: RssSourceSpec<DjinniConfig> = {
  type: 'DJINNI_RSS',
  adapterVersion: 'djinni-1',
  configSchema,
  inventory: { kind: 'RECENT', windowMs: DJINNI_RECENT_WINDOW_MS },
  feedRequest: (config) => ({ url: `${FEED_URL}?${config.query}` }),
  mapEntry: (entry, config) => ({
    namespace: config.namespace,
    url: entry.link,
    title: entry.title,
    // The feed names no employer; see the header. `null`, never a guess.
    companyName: null,
    description: entry.content ?? entry.summary,
    descriptionKind: 'html',
    tags: [...entry.categories],
    dates: [...entry.dates],
  }),
}

export const djinniProvider = defineRssProvider(djinniSpec)
