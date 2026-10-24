import type { EntryDefinition, PolicyDeadline, QuotaDeclaration, TypeDefinition } from './manifest'
import { ARBEITNOW_SOURCE_STATUS } from './sources/arbeitnow.provider'
import { JOBGETHER_SOURCE_STATUS } from './sources/jobgether.provider'
import { HN_SOURCE_STATUS } from './sources/hn-hiring.provider'
import { JOOBLE_SOURCE_STATUS } from './sources/jooble.provider'
import { JSEARCH_SOURCE_STATUS } from './sources/jsearch.provider'
import { MUSE_SOURCE_STATUS } from './sources/muse.provider'
import { RECRUITEE_TOKEN_DEADLINE } from './sources/recruitee.provider'
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

const DAILY = 24

const legacy = (
  id: string,
  config: Record<string, unknown>,
  extra: Partial<EntryDefinition> = {},
): EntryDefinition => ({ id, config, legacySeed: true, intervalHours: DAILY, ...extra })

const fresh = (
  id: string,
  config: Record<string, unknown>,
  extra: Partial<EntryDefinition> = {},
): EntryDefinition => ({ id, config, intervalHours: DAILY, ...extra })

/** An ATS board whose owner is evidenced by the named fixtures' `EVIDENCE:` tokens. */
const board = (
  id: string,
  config: Record<string, unknown>,
  fixtures: readonly string[],
  name: string,
  domain: string | null = null,
): EntryDefinition => fresh(id, config, { ownership: { fixtures, name, domain } })

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
    entries: [legacy('remoteok.api.latest', {})],
  },
  {
    type: 'REMOTIVE_API',
    provider: 'Remotive',
    disposition: REPORTING,
    fixtureDir: 'remotive',
    status: { symbol: 'REMOTIVE_SOURCE_STATUS', value: REMOTIVE_SOURCE_STATUS },
    auth: 'NONE',
    attribution: 'LINK_BACK_REQUIRED',
    endpointVariant: 'category',
    scopeKind: 'CATEGORY',
    // The provider advises at most about four requests a day (provenance notes): six hours apart.
    minIntervalHoursFloor: 6,
    entries: [
      legacy('remotive.api.software-dev', { category: 'software-dev' }),
      legacy('remotive.api.devops', { category: 'devops' }),
      legacy('remotive.api.data', { category: 'data' }),
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
    requestsPerRun: 5,
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
    // No entries: the adapter refuses EVERY config (`SourceBlockedError`), so none can be validated.
    entries: [],
  },
  {
    type: 'JOBGETHER_API',
    provider: 'Jobgether',
    disposition: REPORTING,
    fixtureDir: 'jobgether',
    status: { symbol: 'JOBGETHER_SOURCE_STATUS', value: JOBGETHER_SOURCE_STATUS },
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'astroapi-ai-jobs',
    scopeKind: 'PAGED_FEED',
    requestsPerRun: 5,
    entries: [fresh('jobgether.api.jobs', {})],
  },
  {
    type: 'HN_HIRING',
    provider: 'Hacker News',
    disposition: REPORTING,
    fixtureDir: 'hn-hiring',
    status: { symbol: 'HN_SOURCE_STATUS', value: HN_SOURCE_STATUS },
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'algolia-who-is-hiring',
    scopeKind: 'THREAD',
    requestsPerRun: 2,
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
    entries: [
      board(
        'greenhouse.board.stripe',
        { board: 'stripe' },
        ['stripe-board.json'],
        'Stripe',
        'stripe.com',
      ),
      board('greenhouse.board.airbnb', { board: 'airbnb' }, ['airbnb-board.json'], 'Airbnb'),
      board(
        'greenhouse.board.cloudflare',
        { board: 'cloudflare' },
        ['cloudflare-board.json'],
        'Cloudflare',
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
    entries: [
      board(
        'lever.board.spotify',
        { board: 'spotify' },
        ['spotify-page1.json', 'spotify-page2.json'],
        'Spotify',
      ),
      board(
        'lever.board.eu.siteimprove',
        { board: 'siteimprove', region: 'eu' },
        ['siteimprove-eu-board.json'],
        'Siteimprove',
      ),
      board(
        'lever.board.quantco-',
        { board: 'quantco-' },
        ['quantco-trailing-hyphen-board.json'],
        'QuantCo',
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
    entries: [
      board('ashby.board.linear', { board: 'linear' }, ['linear-board.json'], 'Linear'),
      board('ashby.board.supabase', { board: 'supabase' }, ['supabase-board.json'], 'Supabase'),
    ],
  },
  {
    type: 'WORKABLE_ATS',
    provider: 'Workable',
    disposition: REPORTING,
    fixtureDir: 'workable',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'widget-accounts',
    scopeKind: 'BOARD',
    entries: [
      board(
        'workable.board.huggingface',
        { board: 'huggingface' },
        ['huggingface-account.json'],
        'Hugging Face',
      ),
      board(
        'workable.board.hirefellows',
        { board: 'hirefellows' },
        ['hirefellows-account.json'],
        'Hire Fellows',
      ),
    ],
  },
  {
    type: 'SMARTRECRUITERS_ATS',
    provider: 'SmartRecruiters',
    disposition: REPORTING,
    fixtureDir: 'smartrecruiters',
    auth: 'NONE',
    attribution: 'NONE_RECORDED',
    endpointVariant: 'posting-api',
    scopeKind: 'BOARD',
    // No entries: the API host's robots.txt disallows this collector, so no board was ever captured.
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
    entries: [board('recruitee.board.bunq', { board: 'bunq' }, ['bunq-offers.json'], 'bunq')],
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
    entries: [
      board(
        'personio.board.westwing',
        { board: 'westwing', language: 'en' },
        ['westwing-en.xml'],
        'Westwing',
      ),
      board(
        'personio.board.personio',
        { board: 'personio', language: 'en' },
        ['personio-en.xml'],
        'Personio',
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
    quota: JOOBLE_ACCOUNT,
    entries: [
      legacy(
        'jooble.api.senior-developer-remote',
        { keywords: 'senior developer', location: 'remote' },
        { intervalHours: 168, budget: { limit: 6, window: 'MONTH' } },
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
    quota: JSEARCH_ACCOUNT,
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
    quota: THEIRSTACK_ACCOUNT,
    entries: [
      legacy(
        'theirstack.api.senior',
        { limit: 25, seniority: ['senior'] },
        { intervalHours: 96, budget: { limit: 8, window: 'MONTH' } },
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
    requestsPerRun: 5,
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
    quota: REED_ACCOUNT,
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
