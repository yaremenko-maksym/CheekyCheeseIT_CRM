import type { FetchProfile } from '../scheduling/next-slot'
import type { EntryDefinition, PolicyDeadline, QuotaDeclaration, TypeDefinition } from './manifest'
import { boardEntries } from './manifest.boards'
import { ASHBY_BOARDS } from './boards/ashby.boards'
import { GREENHOUSE_BOARDS } from './boards/greenhouse.boards'
import { LEVER_BOARDS } from './boards/lever.boards'
import { PERSONIO_BOARDS } from './boards/personio.boards'
import { RECRUITEE_BOARDS } from './boards/recruitee.boards'
import { SMARTRECRUITERS_BOARDS } from './boards/smartrecruiters.boards'
import { WORKABLE_BOARDS } from './boards/workable.boards'
import { FIXED_SLOTS_INTERVAL_MINUTES, HTML_RUN_TIMES } from './manifest.fetch-profile'
import { ARBEITNOW_SOURCE_STATUS } from './sources/arbeitnow.provider'
import { JOBGETHER_SOURCE_STATUS } from './sources/jobgether.provider'
import { HN_SOURCE_STATUS } from './sources/hn-hiring.provider'
import { JOOBLE_SOURCE_STATUS } from './sources/jooble.provider'
import { JSEARCH_SOURCE_STATUS } from './sources/jsearch.provider'
import {
  ASHBY_OWNER_DECISION,
  DJINNI_OWNER_DECISION,
  DICE_OWNER_DECISION,
  HN_OWNER_DECISION,
  JOBGETHER_OWNER_DECISION,
  NEXTLEVELJOBS_OWNER_DECISION,
  LANDINGJOBS_OWNER_DECISION,
  JUSTJOIN_OWNER_DECISION,
  THEHUB_OWNER_DECISION,
  NOFLUFF_OWNER_DECISION,
  REMOTIVE_OWNER_DECISION,
  SMARTRECRUITERS_OWNER_DECISION,
  WORKABLE_OWNER_DECISION,
  WORKINGNOMADS_OWNER_DECISION,
  HELLOWORLD_OWNER_DECISION,
} from './owner-decisions'
import {
  DICE_ENDPOINT_VARIANT,
  DICE_HOST,
  DICE_REQUESTS_PER_RUN,
  DICE_SOURCE_STATUS,
} from './sources/dice.provider'
import { LEVER_HOSTS } from './sources/lever.provider'
import {
  NEXTLEVELJOBS_BOUNDS,
  NEXTLEVELJOBS_ENDPOINT_VARIANT,
  NEXTLEVELJOBS_HOST,
  NEXTLEVELJOBS_SOURCE_STATUS,
} from './sources/nextleveljobs.provider'
import { MAX_SITEMAP_PARTS } from './sources/sitemap-jsonld'
import {
  LANDINGJOBS_BOUNDS,
  LANDINGJOBS_ENDPOINT_VARIANT,
  LANDINGJOBS_HOST,
  LANDINGJOBS_SOURCE_STATUS,
} from './sources/landingjobs.provider'
import {
  JUSTJOIN_BOUNDS,
  JUSTJOIN_ENDPOINT_VARIANT,
  JUSTJOIN_HOST,
  JUSTJOIN_SOURCE_STATUS,
} from './sources/justjoin.provider'
import {
  THEHUB_BOUNDS,
  THEHUB_ENDPOINT_VARIANT,
  THEHUB_HOST,
  THEHUB_SOURCE_STATUS,
} from './sources/thehub.provider'
import {
  NOFLUFF_ENDPOINT_VARIANT,
  NOFLUFF_HOST,
  NOFLUFF_REQUESTS_PER_RUN,
  NOFLUFF_SOURCE_STATUS,
} from './sources/nofluff.provider'
import { RECRUITEE_TOKEN_DEADLINE } from './sources/recruitee.provider'
import {
  SMARTRECRUITERS_BOUNDS,
  smartrecruitersAllowedHosts,
} from './sources/smartrecruiters.provider'
import { workableAllowedHosts } from './sources/workable.provider'
import { REED_SOURCE_STATUS } from './sources/reed.provider'
import { REMOTIVE_SOURCE_STATUS } from './sources/remotive.provider'
import { THEIRSTACK_SOURCE_STATUS } from './sources/theirstack.provider'
import { WORKINGNOMADS_SOURCE_STATUS } from './sources/workingnomads.provider'
import { HELLOWORLD_SOURCE_STATUS } from './sources/helloworld.provider'

/**
 * Every multi-board host (`scopeKind: 'BOARD'`) carries the same two U11 figures, inline on each
 * type below (ADR section 8; owner decision 11, 2026-10-26):
 *  - `hostRequestBudget: { perMinute: 2, perHour: 120 }` per host key — the ban-safety floor. A raise
 *    is a manual edit after two weeks without a refusal from that host, never automatic.
 *  - `requestsPerRun: 1` — a board lists in ONE request a run today (`detailMode: 'IN_LIST'`), so its
 *    real current maximum is 1 (SR-H-1b). The collection context enforces this ceiling at runtime and
 *    `claimHostSlot` counts an in-flight run as this figure, so the budget is a TRUE upper bound.
 * SmartRecruiters is the single exception since task sources-04: its adapter spends a detail
 * request per posting. Since 2026-11-21 (owner, task sources-15) its host budget is 10 a minute,
 * overriding the two-week rule above for SmartRecruiters only, so its `requestsPerRun` is 10 and its
 * own bounds hold a run to nine postings. `SMARTRECRUITERS_BOUNDS.maxRequests` is that one constant,
 * read by both the adapter and the definition below.
 * WHEN U10 wires Greenhouse detail-on-demand (`detailPerRun: 5`), Greenhouse's `requestsPerRun` MUST
 * rise to cover the detail fetches AND the per-host budget MUST be revisited then: a 5-request run
 * does not fit a 2-a-minute budget (`assertPolicy` fails loud on `requestsPerRun > perMinute`). That
 * re-tuning is U10's / the owner's to make (a backlog follow-up).
 */

/**
 * The hand-authored half of the manifest: what CANNOT be read from the repository. Everything that
 * can (permission, evidence, hashes, readiness, namespaces, the date a permission changes) is read
 * by `buildManifest` from the fixtures and the adapters, and a fact stated here that the repository
 * also states is checked against it there (attribution, authentication, employer names).
 *
 * One definition per `JobSourceType`, in the order of `jobSourceTypeSchema`. A type with no
 * definition is a finding (`MISSING_DISPOSITION`), and the drift spec also requires that every
 * adapter module, `*_SOURCE_STATUS` constant and `__fixtures__` directory in the tree is accounted
 * for here, so adding an adapter without touching this file fails a test.
 *
 * The three `legacySeed` groups below are the 15 manifest entries whose `(type, config)` the
 * immutable 2026-10-05 seed already holds. `workingnomads` has a seeded row but NO entry: its
 * adapter refuses every config, so no config of it can be validated, and the seed delta blocks the
 * type instead of claiming the row.
 */

// ---------------------------------------------------------------------------
// Quota accounts (the PROVIDER's published figures; never a count of seed rows)
// ---------------------------------------------------------------------------

const JSEARCH_ACCOUNT: QuotaDeclaration = {
  account: 'jsearch:rapidapi-main',
  unit: 'REQUEST',
  window: 'MONTH',
  limit: 200,
  limitSource:
    'the plan figure recorded in the vacancy-matching task (JSearch allows 200 requests a MONTH); NOT confirmed against a provider response, because no key is provisioned',
  seedMeter: {
    window: 'MONTH',
    limit: 150,
    source: `an A1 default of 2026-11-17 (PR #1372), not an owner figure: 150 of the 200-request free plan, a hard limit`,
  },
}
const JOOBLE_ACCOUNT: QuotaDeclaration = {
  account: 'jooble:api-main',
  unit: 'REQUEST',
  window: null,
  limit: null,
  limitSource: 'unpublished: "usage limits [are] set per key" (jooble provenance notes)',
  seedMeter: {
    window: 'DAY',
    limit: 50,
    source: `an A1 default of 2026-11-17 (PR #1372), not an owner figure: the provider publishes no limit, so 50 requests a day`,
  },
}
const REED_ACCOUNT: QuotaDeclaration = {
  account: 'reed:api-main',
  unit: 'REQUEST',
  window: null,
  limit: null,
  limitSource: 'unpublished: the developer page gives no rate limit (reed provenance notes)',
  seedMeter: {
    window: 'DAY',
    limit: 50,
    source: `an A1 default of 2026-11-17 (PR #1372), not an owner figure: the provider publishes no limit, so 50 requests a day`,
  },
}
const THEIRSTACK_ACCOUNT: QuotaDeclaration = {
  account: 'theirstack:api-main',
  unit: 'RECORD',
  window: null,
  limit: null,
  limitSource:
    'unpublished: one API credit per job returned is documented, the plan allowance is not (theirstack provenance notes)',
  // Within FREE_PLAN_METERS (job-run-worker): RECORD / MONTH, at most 200.
  seedMeter: {
    window: 'MONTH',
    limit: 150,
    source: `an A1 default of 2026-11-17 (PR #1372), not an owner figure: 150 of the 200-record free plan`,
  },
}

// ---------------------------------------------------------------------------
// Deadlines: read from the adapter's own constant, never retyped
// ---------------------------------------------------------------------------

const RECRUITEE_DEADLINES: readonly PolicyDeadline[] = [
  { kind: 'AUTH_REQUIRED_FROM', at: RECRUITEE_TOKEN_DEADLINE, symbol: 'RECRUITEE_TOKEN_DEADLINE' },
]

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

const legacy = (
  id: string,
  config: Record<string, unknown>,
  extra: Partial<EntryDefinition> = {},
): EntryDefinition => ({ id, config, legacySeed: true, ...extra })

const fresh = (
  id: string,
  config: Record<string, unknown>,
  extra: Partial<EntryDefinition> = {},
): EntryDefinition => ({ id, config, ...extra })

// ---------------------------------------------------------------------------
// Fetch profiles (source fetch strategy ADR, section 8; owner Q1, Q2, Q8)
// ---------------------------------------------------------------------------

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const

/** `interval` / `off` minutes, inside / outside 08:00-19:00 Mon-Fri in `timeZone` (owner, Q2). */
const workingHours = (timeZone: string, interval: number, off: number | null): FetchProfile => ({
  intervalMinutes: interval,
  offIntervalMinutes: off,
  window: { timeZone, days: [...WEEKDAYS], from: '08:00', to: '19:00' },
})

/** Once a day, at the stagger minute after 00:00 UTC: today's cadence, for the unchanged types. */
const DAILY: FetchProfile = { intervalMinutes: 24 * 60, offIntervalMinutes: null, window: null }

/**
 * One attempt every Monday in the Kyiv working day. `intervalMinutes` is NOT this cadence (the window
 * holds one slot whatever it is): it only carries the legacy seed hours `rollbackCadenceHours`
 * derives (168 for Jooble, 96 for TheirStack), so the committed seed delta stays byte-identical.
 */
const mondays = (intervalMinutes: number): FetchProfile => ({
  intervalMinutes,
  offIntervalMinutes: null,
  window: { timeZone: 'Europe/Kyiv', days: ['MON'], from: '08:00', to: '19:00' },
})

/** A fixed local time in Kyiv, once a day (Remotive, one entry per slot; Himalayas, sweep only). */
const kyivAt = (time: string): FetchProfile => ({
  intervalMinutes: FIXED_SLOTS_INTERVAL_MINUTES,
  offIntervalMinutes: null,
  window: null,
  fixedSlots: { timeZone: 'Europe/Kyiv', times: [time] },
})

/**
 * The live HTML types: the four Kyiv slots of the HTML cron, 6 h apart (owner, 2026-11-21, task
 * sources-15). Fixed slots, not a working-hours grid: the HTML handler claims only when its cron
 * fires, and a staggered grid slot that falls between two firings would leave a firing claiming
 * nothing. The per-run bounds are unchanged; only the number of runs grows.
 */
const HTML_SLOTS: FetchProfile = {
  intervalMinutes: FIXED_SLOTS_INTERVAL_MINUTES,
  offIntervalMinutes: null,
  window: null,
  fixedSlots: { timeZone: 'Europe/Kyiv', times: [...HTML_RUN_TIMES] },
}

/** One map for every provider's board file: the same employer under two ATS types is refused. */
const CLAIMED_BOARDS = new Map<string, string>()
/** An ATS board's profile: hourly in its employer's working day, every 3 h outside (section 8). */
const BOARD_PROFILE = (timeZone: string): FetchProfile => workingHours(timeZone, 60, 180)

const blockedHtml = (type: string, provider: string): TypeDefinition => ({
  type,
  provider,
  disposition: {
    kind: 'BLOCKED',
    reason: 'no adapter is implemented; the HTML adapters are plan Task 5.6',
    owner: 'plan Task 5.6',
  },
  auth: 'NONE',
  attribution: 'NONE_RECORDED',
  endpointVariant: 'html',
  scopeKind: 'SEARCH',
  entries: [],
})

const REPORTING = { kind: 'IMPLEMENTED', contract: 'REPORTING' } as const

// ---------------------------------------------------------------------------
// The 30 types, in `jobSourceTypeSchema` order
// ---------------------------------------------------------------------------

export const MANIFEST_DEFINITIONS: readonly TypeDefinition[] = [
  {
    type: 'DOU_RSS',
    provider: 'DOU',
    disposition: {
      kind: 'IMPLEMENTED',
      contract: 'LEGACY',
      note: 'stays on the legacy JobSourceProvider path by decision (plan A1h / C-20); the seed delta never touches its rows',
    },
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    entries: [],
  },
  {
    type: 'REMOTEOK_API',
    provider: 'Remote OK',
    disposition: REPORTING,
    fixtureDir: 'remoteok',
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'latest-feed',
    scopeKind: 'LATEST_FEED',
    hostKey: () => 'remoteok.com',
    // A global feed; its postings are mostly US-hours, so the working day is New York's (A1).
    fetchProfile: workingHours('America/New_York', 60, 180),
    entries: [legacy('remoteok.api.latest', {})],
  },
  {
    type: 'REMOTIVE_API',
    provider: 'Remotive',
    disposition: REPORTING,
    fixtureDir: 'remotive',
    status: { symbol: 'REMOTIVE_SOURCE_STATUS', value: REMOTIVE_SOURCE_STATUS },
    ownerDecisions: [REMOTIVE_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'category',
    scopeKind: 'CATEGORY',
    hostKey: () => 'remotive.com',
    // The provenance notes: at most about four requests a day and never more than two a minute,
    // across every Remotive entry and manual run (#1139 SR-L-3). One request per run.
    hostRate: { perMinute: 2, perDay: 4 },
    // The provider advises at most about four requests a day (provenance notes): six hours apart.
    minIntervalHoursFloor: 6,
    // Section 8: one fixed Kyiv slot per entry, 3 of the host's 4 a day (one left for a manual run).
    entries: [
      legacy(
        'remotive.api.software-dev',
        { category: 'software-dev' },
        { fetchProfile: kyivAt('09:00') },
      ),
      legacy('remotive.api.devops', { category: 'devops' }, { fetchProfile: kyivAt('13:00') }),
      legacy('remotive.api.data', { category: 'data' }, { fetchProfile: kyivAt('17:00') }),
    ],
  },
  {
    type: 'HIMALAYAS_API',
    provider: 'Himalayas',
    disposition: REPORTING,
    fixtureDir: 'himalayas',
    auth: 'NONE',
    attribution: 'CREDIT_REQUIRED',
    endpointVariant: 'browse',
    scopeKind: 'BROWSE',
    hostKey: () => 'himalayas.app',
    // "Sweep only (once a day)": the slot is the sweep's own 08:00 Kyiv, so a sweep run and the
    // tick never both claim it (the sweep's finish moves the slot to the next day).
    fetchProfile: kyivAt('08:00'),
    entries: [fresh('himalayas.api.browse', {})],
  },
  {
    type: 'JOBICY_API',
    provider: 'Jobicy',
    disposition: REPORTING,
    fixtureDir: 'jobicy',
    auth: 'NONE',
    attribution: 'CREDIT_REQUIRED',
    endpointVariant: 'feed',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'jobicy.com',
    // The entry reads the Europe feed: Berlin's working day.
    fetchProfile: workingHours('Europe/Berlin', 120, 240),
    entries: [
      legacy('jobicy.api.engineering-europe', {
        count: 100,
        industry: 'engineering',
        geo: 'europe',
      }),
    ],
  },
  {
    type: 'ARBEITNOW_API',
    provider: 'Arbeitnow',
    disposition: REPORTING,
    fixtureDir: 'arbeitnow',
    status: { symbol: 'ARBEITNOW_SOURCE_STATUS', value: ARBEITNOW_SOURCE_STATUS },
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'job-board-api',
    scopeKind: 'PAGED_FEED',
    hostKey: () => 'www.arbeitnow.com',
    requestsPerRun: 5,
    // A routine run reads page 1 only; full pages only in the sweep (section 8).
    fetchProfile: { ...workingHours('Europe/Berlin', 120, null), routinePages: 1 },
    entries: [legacy('arbeitnow.api.feed', { maxPages: 5 })],
  },
  {
    type: 'WORKINGNOMADS_API',
    provider: 'Working Nomads',
    disposition: REPORTING,
    fixtureDir: 'workingnomads',
    status: { symbol: 'WORKINGNOMADS_SOURCE_STATUS', value: WORKINGNOMADS_SOURCE_STATUS },
    ownerDecisions: [WORKINGNOMADS_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'exposed-jobs',
    scopeKind: 'LATEST_FEED',
    hostKey: () => 'www.workingnomads.com',
    // ONE request a run: the endpoint answers the whole feed in one unparameterised array, and the
    // `categories` filter is applied client-side (measured 2026-11-19, see the capture provenance).
    requestsPerRun: 1,
    payloadFixtures: ['exposed-jobs.json'],
    // The cadence the 2026-10-05 seed row already carries (24 h), unchanged by connecting it.
    fetchProfile: DAILY,
    // The seeded production row is `('WORKINGNOMADS_API', '{"categories":["development"]}')`, so
    // this config must stay byte-equal to it: the delta's adopt step matches on `s.config = m.config`.
    entries: [legacy('workingnomads.api.development', { categories: ['development'] })],
  },
  {
    type: 'JOBGETHER_API',
    provider: 'Jobgether',
    disposition: REPORTING,
    fixtureDir: 'jobgether',
    status: { symbol: 'JOBGETHER_SOURCE_STATUS', value: JOBGETHER_SOURCE_STATUS },
    ownerDecisions: [JOBGETHER_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'astroapi-ai-jobs',
    scopeKind: 'PAGED_FEED',
    hostKey: () => 'jobgether.com',
    requestsPerRun: 5,
    // Owner, Q8: connected last (U12). Once a day, the slowest cadence any API type has.
    fetchProfile: DAILY,
    entries: [fresh('jobgether.api.jobs', {})],
  },
  {
    type: 'HN_HIRING',
    provider: 'Hacker News',
    disposition: REPORTING,
    fixtureDir: 'hn-hiring',
    status: { symbol: 'HN_SOURCE_STATUS', value: HN_SOURCE_STATUS },
    ownerDecisions: [HN_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'algolia-who-is-hiring',
    scopeKind: 'THREAD',
    hostKey: () => 'hn.algolia.com',
    requestsPerRun: 2,
    // Owner, Q8: connected last (U12). The thread is monthly, so once a day is enough.
    fetchProfile: DAILY,
    entries: [legacy('hn-hiring.thread.latest', {})],
  },
  {
    type: 'GREENHOUSE_ATS',
    provider: 'Greenhouse',
    disposition: REPORTING,
    fixtureDir: 'greenhouse',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'job-board-api',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    hostKey: () => 'boards-api.greenhouse.io',
    // ADR 6a: U10 flips this to ON_DEMAND; until then the adapter reads `content=true`.
    detailMode: 'IN_LIST',
    detailPerRun: 5,
    entries: boardEntries({
      prefix: 'greenhouse',
      lines: GREENHOUSE_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'LEVER_ATS',
    provider: 'Lever',
    disposition: REPORTING,
    fixtureDir: 'lever',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'postings-api',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    // Two regions, two API hosts, two data sets: each region is its own scope.
    hostKey: (config) => LEVER_HOSTS[config['region'] as keyof typeof LEVER_HOSTS],
    entries: boardEntries({
      prefix: 'lever',
      lines: LEVER_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'ASHBY_ATS',
    provider: 'Ashby',
    disposition: REPORTING,
    fixtureDir: 'ashby',
    ownerDecisions: [ASHBY_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'posting-api',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    hostKey: () => 'api.ashbyhq.com',
    entries: boardEntries({
      prefix: 'ashby',
      lines: ASHBY_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'WORKABLE_ATS',
    provider: 'Workable',
    disposition: REPORTING,
    fixtureDir: 'workable',
    ownerDecisions: [WORKABLE_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'widget-accounts',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    // Every tenant is a path on ONE host (`workableAllowedHosts`), so one key for all of them.
    hostKey: () => workableAllowedHosts()[0]!,
    entries: boardEntries({
      prefix: 'workable',
      lines: WORKABLE_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'SMARTRECRUITERS_ATS',
    provider: 'SmartRecruiters',
    disposition: REPORTING,
    fixtureDir: 'smartrecruiters',
    ownerDecisions: [SMARTRECRUITERS_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'posting-api',
    scopeKind: 'BOARD',
    // Ten a minute, not the BOARD floor of two: the owner's raise of 2026-11-21 (task sources-15),
    // which overrides decision 11's "raise only after two weeks without a refusal" for this host
    // only. `perHour` stays 120: two boards at the hourly working-hours cadence spend at most 20.
    hostRequestBudget: { perMinute: 10, perHour: 120 },
    // Ten, not the one every other board type declares: this adapter spends one list request and a
    // detail request per posting, nine postings a run. The figure is both the collection context's runtime ceiling and
    // what `claimHostSlot` counts against the budget above, so it has to cover the pair.
    //
    // WHERE THAT DETAIL REQUEST LIVES (SR-L-1). It is sent INLINE inside `collectReport`, one GET
    // a posting, and it is therefore counted by `requestsPerRun` above and by nothing else. It is
    // NOT the ADR 6a detail tail: this adapter carries no `collectDetail`, and `job-run-worker.ts`
    // builds the tail port only for an adapter that has one AND a `detailPerRun >= 1`. So the
    // declared `detailMode` stays the default `IN_LIST` with `detailPerRun` absent - declaring
    // `ON_DEMAND` here would record a tail the worker can never run. The consequence a reader must
    // carry away: raising `pageSize` above 9 costs ONE EXTRA REQUEST PER POSTING, and that cost
    // lands on `requestsPerRun`, which is what this host's 10-a-minute budget is checked against.
    // `manifest.owner-decisions.spec.ts` pins this relation so it is not a comment alone.
    requestsPerRun: SMARTRECRUITERS_BOUNDS.maxRequests,
    hostKey: () => smartrecruitersAllowedHosts()[0]!,
    // The postings API payload is committed for each board below (task sources-04: one plain GET a
    // board, inside the owner's permission of 2026-10-24), which is what cleared NO_API_CAPTURE.
    payloadFixtures: ['postings-list.json'],
    entries: boardEntries({
      prefix: 'smartrecruiters',
      lines: SMARTRECRUITERS_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'RECRUITEE_ATS',
    provider: 'Recruitee',
    disposition: REPORTING,
    fixtureDir: 'recruitee',
    deadlines: RECRUITEE_DEADLINES,
    auth: 'EMPLOYER_TOKEN_FROM_DEADLINE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'careers-site-api',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    // Tenant subdomains (`{board}.recruitee.com`): the provider's apex, so a provider-wide limit
    // pauses every tenant; a 403 is one tenant's own answer and bans only that source (SR-M-24).
    hostKey: () => 'recruitee.com',
    banScope: 'SOURCE',
    entries: boardEntries({
      prefix: 'recruitee',
      lines: RECRUITEE_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'PERSONIO_ATS',
    provider: 'Personio',
    disposition: REPORTING,
    fixtureDir: 'personio',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'xml-feed',
    scopeKind: 'BOARD',
    hostRequestBudget: { perMinute: 2, perHour: 120 },
    requestsPerRun: 1,
    // Tenant subdomains (`{board}.jobs.personio.{tld}`): the apex of the tld the adapter uses, so
    // a provider-wide limit pauses every tenant; a 403 bans only that source (SR-M-24).
    hostKey: (config) => `personio.${String(config['tld'])}`,
    banScope: 'SOURCE',
    entries: boardEntries({
      prefix: 'personio',
      lines: PERSONIO_BOARDS,
      profileFor: BOARD_PROFILE,
      claimed: CLAIMED_BOARDS,
    }),
  },
  {
    type: 'JOOBLE_API',
    provider: 'Jooble',
    disposition: REPORTING,
    fixtureDir: 'jooble',
    status: { symbol: 'JOOBLE_SOURCE_STATUS', value: JOOBLE_SOURCE_STATUS },
    auth: 'API_KEY',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'search-post',
    scopeKind: 'SEARCH',
    hostKey: () => 'jooble.org',
    quota: JOOBLE_ACCOUNT,
    entries: [
      legacy(
        'jooble.api.senior-developer-remote',
        { keywords: 'senior developer', location: 'remote' },
        // Weekly, as the 168 h it had; the grid cannot say "every 7 days" any other way.
        { fetchProfile: mondays(168 * 60), budget: { limit: 6, window: 'MONTH' } },
      ),
    ],
  },
  {
    type: 'JSEARCH_API',
    provider: 'JSearch',
    disposition: REPORTING,
    fixtureDir: 'jsearch',
    status: { symbol: 'JSEARCH_SOURCE_STATUS', value: JSEARCH_SOURCE_STATUS },
    auth: 'API_KEY',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rapidapi-search',
    scopeKind: 'SEARCH',
    hostKey: () => 'jsearch.p.rapidapi.com',
    quota: JSEARCH_ACCOUNT,
    fetchProfile: DAILY,
    entries: [
      legacy(
        'jsearch.rapidapi.backend',
        { query: 'senior backend developer remote' },
        { budget: { limit: 60, window: 'MONTH' } },
      ),
      legacy(
        'jsearch.rapidapi.frontend',
        { query: 'senior frontend developer remote' },
        { budget: { limit: 60, window: 'MONTH' } },
      ),
      legacy(
        'jsearch.rapidapi.ai-engineer',
        { query: 'senior ai engineer remote' },
        { budget: { limit: 60, window: 'MONTH' } },
      ),
    ],
  },
  {
    type: 'THEIRSTACK_API',
    provider: 'TheirStack',
    disposition: REPORTING,
    fixtureDir: 'theirstack',
    status: { symbol: 'THEIRSTACK_SOURCE_STATUS', value: THEIRSTACK_SOURCE_STATUS },
    auth: 'API_KEY',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'jobs-search-post',
    scopeKind: 'SEARCH',
    hostKey: () => 'api.theirstack.com',
    quota: THEIRSTACK_ACCOUNT,
    entries: [
      legacy(
        'theirstack.api.senior',
        { limit: 25, seniority: ['senior'] },
        // Was every 96 h; a daily grid cannot repeat every 4 days, and two weekdays would exceed the
        // 8 a month, so weekly (fewer runs, never more). The interval keeps the seed's 96 h.
        { fetchProfile: mondays(96 * 60), budget: { limit: 8, window: 'MONTH' } },
      ),
    ],
  },
  {
    type: 'REED_API',
    provider: 'Reed',
    disposition: REPORTING,
    fixtureDir: 'reed',
    status: { symbol: 'REED_SOURCE_STATUS', value: REED_SOURCE_STATUS },
    auth: 'API_KEY',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'jobseeker-search',
    scopeKind: 'SEARCH',
    hostKey: () => 'www.reed.co.uk',
    quota: REED_ACCOUNT,
    fetchProfile: DAILY,
    entries: [
      legacy('reed.api.senior-developer-remote', {
        keywords: 'senior developer',
        locationName: 'remote',
      }),
    ],
  },
  {
    type: 'DJINNI_RSS',
    provider: 'Djinni',
    disposition: REPORTING,
    fixtureDir: 'djinni',
    ownerDecisions: [DJINNI_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss-primary-keyword',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'djinni.co',
    // 100 newest, about 3.1 h at peak: any gap over about 3 h loses postings, so 120 off-window.
    fetchProfile: {
      intervalMinutes: 60,
      offIntervalMinutes: 120,
      window: {
        timeZone: 'Europe/Kyiv',
        days: [...WEEKDAYS, 'SAT', 'SUN'],
        from: '08:00',
        to: '20:00',
      },
    },
    entries: [
      // configVersion 2: the revise step rewrites the stored `namespace` from `''` to `djinni`.
      // Both prod rows carried the empty one, which is no namespace at all, so every item of
      // every run was refused `INVALID_NAMESPACE` before the record store saw it and nothing was
      // persisted — a run row reading `received 0` because that counter counts what reached the
      // store. Full mechanism: `DJINNI_NAMESPACE` in `sources/djinni.provider.ts`.
      fresh('djinni.rss.python', { primaryKeyword: 'Python' }, { configVersion: 2 }),
      fresh('djinni.rss.rust', { primaryKeyword: 'Rust' }, { configVersion: 2 }),
    ],
  },
  {
    type: 'WWR_RSS',
    provider: 'We Work Remotely',
    disposition: REPORTING,
    fixtureDir: 'wwr',
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'weworkremotely.com',
    // A Chicago-based board (A1 on the region).
    fetchProfile: workingHours('America/Chicago', 180, 360),
    entries: [
      fresh('wwr.rss.all-jobs', {}, { configVersion: 2 }),
      fresh('wwr.rss.devops', { category: 'remote-devops-sysadmin-jobs' }, { configVersion: 2 }),
    ],
  },
  {
    type: 'EUREMOTEJOBS_RSS',
    provider: 'EU Remote Jobs',
    disposition: REPORTING,
    fixtureDir: 'euremotejobs',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'wp-job-manager-feed',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'euremotejobs.com',
    // Blocked (section 8: no schedule change); the daily cadence it had.
    fetchProfile: DAILY,
    entries: [legacy('euremotejobs.rss.feed', {})],
  },
  {
    type: 'JUSTJOIN_HTML',
    provider: 'JustJoin.it',
    disposition: REPORTING,
    fixtureDir: 'justjoin',
    status: { symbol: 'JUSTJOIN_SOURCE_STATUS', value: JUSTJOIN_SOURCE_STATUS },
    ownerDecisions: [JUSTJOIN_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: JUSTJOIN_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => JUSTJOIN_HOST,
    // robots.txt + the index + at most 2 parts (`MAX_SITEMAP_PARTS`) + at most 20 detail pages
    // (`JUSTJOIN_BOUNDS`) = 24, under this bound of 27. No redirect is followed (task sources-16):
    // the sitemaps are requested at the CDN host directly, so none costs a hop.
    requestsPerRun: JUSTJOIN_BOUNDS.maxDetails + MAX_SITEMAP_PARTS + 1 + 4,
    hostRequestBudget: { perMinute: 30, perHour: 60 },
    payloadFixtures: [
      'active-jobs-index.xml',
      'active-jobs-part0.trimmed.xml',
      'job-fullstack-developer-java-angular.jsonld.html.txt',
    ],
    // A Warsaw-based board with a large inflow (~160 new postings a day). The backlog of ~11 000
    // unseen postings never drains.
    fetchProfile: HTML_SLOTS,
    entries: [fresh('justjoin.sitemap.jobs', {})],
  },
  {
    type: 'NOFLUFF_HTML',
    provider: 'No Fluff Jobs',
    disposition: REPORTING,
    fixtureDir: 'nofluff',
    status: { symbol: 'NOFLUFF_SOURCE_STATUS', value: NOFLUFF_SOURCE_STATUS },
    ownerDecisions: [NOFLUFF_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: NOFLUFF_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => NOFLUFF_HOST,
    // 1 robots + 8 category pages + at most 25 detail pages (`NOFLUFF_REQUESTS_PER_RUN`). No
    // redirect is followed (each 3xx is its own counted request), so nothing is reserved for one.
    // The adapter waits at least 3 s before each request after the first.
    requestsPerRun: NOFLUFF_REQUESTS_PER_RUN,
    // One run's worth a minute, two an hour: a second run inside the hour waits for the next.
    hostRequestBudget: { perMinute: 40, perHour: 80 },
    payloadFixtures: ['backend-listing.trimmed.html.txt', 'job-detail.trimmed.html.txt'],
    // A Polish board.
    fetchProfile: HTML_SLOTS,
    entries: [fresh('nofluff.listing.it', {})],
  },
  {
    type: 'LANDINGJOBS_HTML',
    provider: 'Landing.jobs',
    disposition: REPORTING,
    fixtureDir: 'landingjobs',
    status: { symbol: 'LANDINGJOBS_SOURCE_STATUS', value: LANDINGJOBS_SOURCE_STATUS },
    ownerDecisions: [LANDINGJOBS_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: LANDINGJOBS_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => LANDINGJOBS_HOST,
    // robots.txt + 1 sitemap + at most 25 detail pages (`LANDINGJOBS_BOUNDS`) = 27, under this
    // bound of 30. No redirect is followed (task sources-16), so none costs a hop.
    requestsPerRun: LANDINGJOBS_BOUNDS.maxDetails + 5,
    hostRequestBudget: { perMinute: 30, perHour: 60 },
    payloadFixtures: [
      'sitemap.trimmed.xml',
      'job-aws-cloud-solutions-architect.jsonld.html.txt',
      'job-application-integration-consultant.jsonld.html.txt',
    ],
    // A Lisbon-based board with a small inflow (75 open jobs in the sitemap on 2026-11-21).
    fetchProfile: HTML_SLOTS,
    entries: [fresh('landingjobs.sitemap.jobs', {})],
  },
  {
    type: 'NEXTLEVELJOBS_HTML',
    provider: 'Next Level Jobs',
    disposition: REPORTING,
    fixtureDir: 'nextleveljobs',
    status: { symbol: 'NEXTLEVELJOBS_SOURCE_STATUS', value: NEXTLEVELJOBS_SOURCE_STATUS },
    ownerDecisions: [NEXTLEVELJOBS_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: NEXTLEVELJOBS_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => NEXTLEVELJOBS_HOST,
    // robots.txt + 1 sitemap + at most 25 detail pages (`NEXTLEVELJOBS_BOUNDS`) = 27, under this
    // bound of 30; no redirect is followed (task sources-16). The adapter itself waits 3 to 4.5 s
    // before each request after the first, so a run of 27 takes about two minutes and never
    // exceeds 0.34 requests a second.
    requestsPerRun: NEXTLEVELJOBS_BOUNDS.maxDetails + 5,
    // One run's worth a minute, two an hour: a second run inside the hour waits for the next.
    hostRequestBudget: { perMinute: 30, perHour: 60 },
    payloadFixtures: [
      'jobs-sitemap.trimmed.xml',
      'job-security-engineer.html.txt',
      'job-engineering-manager.html.txt',
    ],
    // A Berlin-based board, with an inflow measured at 50 to 110 a day (sitemap ids, 2026-11-20).
    fetchProfile: HTML_SLOTS,
    entries: [fresh('nextleveljobs.sitemap.jobs', {})],
  },
  {
    type: 'DICE_HTML',
    provider: 'Dice',
    disposition: REPORTING,
    fixtureDir: 'dice',
    status: { symbol: 'DICE_SOURCE_STATUS', value: DICE_SOURCE_STATUS },
    // PROHIBITED by the terms; runnable ONLY through the ACCEPT_PROHIBITED_RISK decision (sources-14).
    ownerDecisions: [DICE_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: DICE_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => DICE_HOST,
    // 1 robots + 3 listing pages + at most 25 detail pages (`DICE_BOUNDS`). No redirect is
    // followed (each 3xx is its own counted request), so nothing is reserved for one.
    // The adapter waits at least 3 s before each request after the first.
    requestsPerRun: DICE_REQUESTS_PER_RUN,
    hostRequestBudget: { perMinute: 40, perHour: 80 },
    payloadFixtures: ['jobs-listing.trimmed.html.txt', 'job-detail.trimmed.html.txt'],
    // A US board.
    fetchProfile: HTML_SLOTS,
    entries: [fresh('dice.listing.jobs', {})],
  },
  {
    type: 'THEHUB_HTML',
    provider: 'The Hub',
    disposition: REPORTING,
    fixtureDir: 'thehub',
    status: { symbol: 'THEHUB_SOURCE_STATUS', value: THEHUB_SOURCE_STATUS },
    ownerDecisions: [THEHUB_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: THEHUB_ENDPOINT_VARIANT,
    scopeKind: 'BROWSE',
    hostKey: () => THEHUB_HOST,
    // robots.txt + 1 sitemap + at most 25 detail pages (`THEHUB_BOUNDS`) = 27, under this bound of
    // 30. No redirect is followed (task sources-16), so none costs a hop.
    requestsPerRun: THEHUB_BOUNDS.maxDetails + 5,
    hostRequestBudget: { perMinute: 30, perHour: 60 },
    payloadFixtures: [
      'jobs-sitemap.trimmed.xml',
      'job-sar-annotation-consultant.jsonld.html.txt',
      'job-people-operations-specialist.jsonld.html.txt',
    ],
    // A Copenhagen-based board, with a sitemap of ~1 300 open jobs.
    fetchProfile: HTML_SLOTS,
    entries: [fresh('thehub.sitemap.jobs', {})],
  },
  blockedHtml('WTTJ_HTML', 'Welcome to the Jungle'),
  {
    type: 'PYTHONORG_RSS',
    provider: 'Python.org Jobs',
    disposition: REPORTING,
    fixtureDir: 'pythonorg',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'www.python.org',
    // Daily, the cadence of the other RSS boards (no measured cadence for this feed).
    fetchProfile: DAILY,
    entries: [fresh('pythonorg.rss.jobs', {}, { configVersion: 1 })],
  },
  {
    type: 'SOLIDJOBS_RSS',
    provider: 'solid.jobs',
    disposition: REPORTING,
    fixtureDir: 'solidjobs',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'solid.jobs',
    // Daily: the site says real-time RSS; the daily cadence is the conservative choice until measured.
    fetchProfile: DAILY,
    entries: [fresh('solidjobs.rss.job-offers', {}, { configVersion: 1 })],
  },
  {
    type: 'BERLINSTARTUPJOBS_RSS',
    provider: 'Berlin Startup Jobs',
    disposition: REPORTING,
    fixtureDir: 'berlinstartupjobs',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'berlinstartupjobs.com',
    fetchProfile: DAILY,
    entries: [fresh('berlinstartupjobs.rss.engineering', {}, { configVersion: 1 })],
  },
  {
    type: 'HELLOWORLD_RSS',
    provider: 'helloworld.rs',
    disposition: REPORTING,
    fixtureDir: 'helloworld',
    status: { symbol: 'HELLOWORLD_SOURCE_STATUS', value: HELLOWORLD_SOURCE_STATUS },
    ownerDecisions: [HELLOWORLD_OWNER_DECISION],
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'www.helloworld.rs',
    fetchProfile: DAILY,
    entries: [fresh('helloworld.rss.feed', {}, { configVersion: 1 })],
  },
  {
    type: 'LARAJOBS_RSS',
    provider: 'LaraJobs',
    disposition: REPORTING,
    fixtureDir: 'larajobs',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'larajobs.com',
    // Daily, the cadence of the other RSS boards (no measured cadence for this feed).
    fetchProfile: DAILY,
    entries: [fresh('larajobs.rss.feed', {}, { configVersion: 1 })],
  },
]
