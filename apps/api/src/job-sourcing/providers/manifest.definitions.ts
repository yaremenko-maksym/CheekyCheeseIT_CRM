import type { FetchProfile } from '../scheduling/next-slot'
import type { EntryDefinition, PolicyDeadline, QuotaDeclaration, TypeDefinition } from './manifest'
import { ARBEITNOW_SOURCE_STATUS } from './sources/arbeitnow.provider'
import { JOBGETHER_SOURCE_STATUS } from './sources/jobgether.provider'
import { HN_SOURCE_STATUS } from './sources/hn-hiring.provider'
import { JOOBLE_SOURCE_STATUS } from './sources/jooble.provider'
import { JSEARCH_SOURCE_STATUS } from './sources/jsearch.provider'
import { MUSE_SOURCE_STATUS } from './sources/muse.provider'
import {
  HN_OWNER_DECISION,
  JOBGETHER_OWNER_DECISION,
  REMOTIVE_OWNER_DECISION,
  SMARTRECRUITERS_OWNER_DECISION,
  WORKABLE_OWNER_DECISION,
} from './owner-decisions'
import { LEVER_HOSTS } from './sources/lever.provider'
import { RECRUITEE_TOKEN_DEADLINE } from './sources/recruitee.provider'
import { smartrecruitersAllowedHosts } from './sources/smartrecruiters.provider'
import { workableAllowedHosts } from './sources/workable.provider'
import { REED_SOURCE_STATUS } from './sources/reed.provider'
import { REMOTIVE_SOURCE_STATUS } from './sources/remotive.provider'
import { THEIRSTACK_SOURCE_STATUS } from './sources/theirstack.provider'
import { WORKINGNOMADS_SOURCE_STATUS } from './sources/workingnomads.provider'

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
}
const JOOBLE_ACCOUNT: QuotaDeclaration = {
  account: 'jooble:api-main',
  unit: 'REQUEST',
  window: null,
  limit: null,
  limitSource: 'unpublished: "usage limits [are] set per key" (jooble provenance notes)',
}
const REED_ACCOUNT: QuotaDeclaration = {
  account: 'reed:api-main',
  unit: 'REQUEST',
  window: null,
  limit: null,
  limitSource: 'unpublished: the developer page gives no rate limit (reed provenance notes)',
}
const THEIRSTACK_ACCOUNT: QuotaDeclaration = {
  account: 'theirstack:api-main',
  unit: 'RECORD',
  window: null,
  limit: null,
  limitSource:
    'unpublished: one API credit per job returned is documented, the plan allowance is not (theirstack provenance notes)',
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

/** One attempt every Monday in the Kyiv working day; the interval keeps the seed's legacy hours. */
const mondays = (intervalMinutes: number): FetchProfile => ({
  intervalMinutes,
  offIntervalMinutes: null,
  window: { timeZone: 'Europe/Kyiv', days: ['MON'], from: '08:00', to: '19:00' },
})

/** A fixed local time in Kyiv, once a day (Remotive, one entry per slot; Himalayas, sweep only). */
const kyivAt = (time: string): FetchProfile => ({
  intervalMinutes: 24 * 60,
  offIntervalMinutes: null,
  window: null,
  fixedSlots: { timeZone: 'Europe/Kyiv', times: [time] },
})

/** An ATS board, hourly in its employer's working day, every 3 h outside (section 8). */
const board = (
  id: string,
  config: Record<string, unknown>,
  fixtures: readonly string[],
  name: string,
  timeZone: string,
  domain: string | null = null,
): EntryDefinition =>
  fresh(id, config, {
    ownership: { fixtures, name, domain },
    fetchProfile: workingHours(timeZone, 60, 180),
  })

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
// The 31 types, in `jobSourceTypeSchema` order
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
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'exposed-jobs',
    scopeKind: 'LATEST_FEED',
    hostKey: () => 'www.workingnomads.com',
    // No entries: the adapter refuses EVERY config (`SourceBlockedError`), so none can be validated.
    entries: [],
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
    // Owner, Q8: connected at the very end; never scheduled until then.
    fetchProfile: null,
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
    // Owner, Q8: connected at the very end; never scheduled until then.
    fetchProfile: null,
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
    hostKey: () => 'boards-api.greenhouse.io',
    // ADR 6a: U10 flips this to ON_DEMAND; until then the adapter reads `content=true`.
    detailMode: 'IN_LIST',
    detailPerRun: 5,
    entries: [
      board(
        'greenhouse.board.stripe',
        { board: 'stripe' },
        ['stripe-board.json'],
        'Stripe',
        'America/Los_Angeles',
        'stripe.com',
      ),
      board(
        'greenhouse.board.airbnb',
        { board: 'airbnb' },
        ['airbnb-board.json'],
        'Airbnb',
        'America/Los_Angeles',
      ),
      board(
        'greenhouse.board.cloudflare',
        { board: 'cloudflare' },
        ['cloudflare-board.json'],
        'Cloudflare',
        'America/Los_Angeles',
      ),
    ],
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
    // Two regions, two API hosts, two data sets: each region is its own scope.
    hostKey: (config) => LEVER_HOSTS[config['region'] as keyof typeof LEVER_HOSTS],
    entries: [
      board(
        'lever.board.spotify',
        { board: 'spotify' },
        ['spotify-page1.json', 'spotify-page2.json'],
        'Spotify',
        'Europe/Stockholm',
      ),
      board(
        'lever.board.eu.siteimprove',
        { board: 'siteimprove', region: 'eu' },
        ['siteimprove-eu-board.json'],
        'Siteimprove',
        'Europe/Copenhagen',
      ),
      board(
        'lever.board.quantco-',
        { board: 'quantco-' },
        ['quantco-trailing-hyphen-board.json'],
        'QuantCo',
        'Europe/Berlin',
      ),
    ],
  },
  {
    type: 'ASHBY_ATS',
    provider: 'Ashby',
    disposition: REPORTING,
    fixtureDir: 'ashby',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'posting-api',
    scopeKind: 'BOARD',
    hostKey: () => 'api.ashbyhq.com',
    entries: [
      // Both under 5 MB (linear 0.46 MB measured; supabase not measured), so the ordinary 60 / 180.
      board(
        'ashby.board.linear',
        { board: 'linear' },
        ['linear-board.json'],
        'Linear',
        'America/Los_Angeles',
      ),
      board(
        'ashby.board.supabase',
        { board: 'supabase' },
        ['supabase-board.json'],
        'Supabase',
        'America/Los_Angeles',
      ),
    ],
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
    // Every tenant is a path on ONE host (`workableAllowedHosts`), so one key for all of them.
    hostKey: () => workableAllowedHosts()[0]!,
    entries: [
      board(
        'workable.board.huggingface',
        { board: 'huggingface' },
        ['huggingface-account.json'],
        'Hugging Face',
        'America/New_York',
      ),
      board(
        'workable.board.hirefellows',
        { board: 'hirefellows' },
        ['hirefellows-account.json'],
        'Hire Fellows',
        'Asia/Bahrain',
      ),
    ],
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
    hostKey: () => smartrecruitersAllowedHosts()[0]!,
    // No entries: no board was ever captured. The only committed fixture is the host's robots.txt,
    // which is not the postings API payload. The owner accepted the robots.txt risk on 2026-10-24,
    // so the decision above lifts the PERMISSION blocker, but the type stays not ready
    // (NO_API_CAPTURE) until a real capture of the postings API payload is committed under the name
    // below. The first real call within the owner's permission (a controlled smoke) would clear it.
    payloadFixtures: ['postings-list.json'],
    // Owner, Q8: connected at the very end; never scheduled until then.
    fetchProfile: null,
    entries: [],
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
    // Tenant subdomains (`{board}.recruitee.com`): the provider's apex, so a provider-wide limit
    // pauses every tenant; a 403 is one tenant's own answer and bans only that source (SR-M-24).
    hostKey: () => 'recruitee.com',
    banScope: 'SOURCE',
    entries: [
      board(
        'recruitee.board.bunq',
        { board: 'bunq' },
        ['bunq-offers.json'],
        'bunq',
        'Europe/Amsterdam',
      ),
    ],
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
    // Tenant subdomains (`{board}.jobs.personio.{tld}`): the apex of the tld the adapter uses, so
    // a provider-wide limit pauses every tenant; a 403 bans only that source (SR-M-24).
    hostKey: (config) => `personio.${String(config['tld'])}`,
    banScope: 'SOURCE',
    entries: [
      board(
        'personio.board.westwing',
        { board: 'westwing', language: 'en' },
        ['westwing-en.xml'],
        'Westwing',
        'Europe/Berlin',
      ),
      board(
        'personio.board.personio',
        { board: 'personio', language: 'en' },
        ['personio-en.xml'],
        'Personio',
        'Europe/Berlin',
      ),
    ],
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
    type: 'MUSE_API',
    provider: 'The Muse',
    disposition: REPORTING,
    fixtureDir: 'muse',
    status: { symbol: 'MUSE_SOURCE_STATUS', value: MUSE_SOURCE_STATUS },
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'public-jobs',
    scopeKind: 'CATEGORY',
    hostKey: () => 'www.themuse.com',
    requestsPerRun: 5,
    // Blocked (section 8: no schedule change); the daily cadence it had.
    fetchProfile: DAILY,
    entries: [
      legacy('muse.api.software-engineering-senior', {
        category: 'Software Engineering',
        level: 'Senior Level',
        maxPages: 5,
      }),
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
      fresh('djinni.rss.python', { primaryKeyword: 'Python' }),
      fresh('djinni.rss.rust', { primaryKeyword: 'Rust' }),
    ],
  },
  {
    type: 'WWR_RSS',
    provider: 'We Work Remotely',
    disposition: REPORTING,
    fixtureDir: 'wwr',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'rss',
    scopeKind: 'FEED_WINDOW',
    hostKey: () => 'weworkremotely.com',
    // A Chicago-based board (A1 on the region).
    fetchProfile: workingHours('America/Chicago', 180, 360),
    entries: [
      fresh('wwr.rss.all-jobs', {}),
      fresh('wwr.rss.devops', { category: 'remote-devops-sysadmin-jobs' }),
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
  blockedHtml('JUSTJOIN_HTML', 'JustJoin.it'),
  blockedHtml('NOFLUFF_HTML', 'No Fluff Jobs'),
  blockedHtml('LANDINGJOBS_HTML', 'Landing.jobs'),
  blockedHtml('NEXTLEVELJOBS_HTML', 'Next Level Jobs'),
  blockedHtml('DICE_HTML', 'Dice'),
  blockedHtml('THEHUB_HTML', 'The Hub'),
  blockedHtml('WTTJ_HTML', 'Welcome to the Jungle'),
]
