import { beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, type Manifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { rollbackCadenceHours } from './manifest.seed-sql'

/**
 * The hand-authored half of the manifest, pinned as a table.
 *
 * `manifest.definitions.ts` is declarative data: a provider's display name, an endpoint variant, a
 * scope kind, an interval. The build checks what the repository can contradict (permission,
 * evidence, hashes, owners, attribution, auth, status constants, deadlines, every config against its
 * adapter), but no other test can see a changed `endpointVariant` or a daily source turned weekly.
 * This table is the second place each such value is written, so a change has to be made twice: on
 * purpose.
 *
 * Built inside the tests, never at import or in a hook: see `manifest.spec.ts`.
 */

let built: Manifest | undefined
// A fresh build per test (see manifest.spec.ts: coverage is attributed per test).
beforeEach(() => {
  built = undefined
})
const manifest = () =>
  (built ??= buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  }))

type TypeRow = [string, string, string, string, string, string, number]

const TYPES: TypeRow[] = [
  ['DOU_RSS', 'DOU', 'NONE', 'NONE_RECORDED', 'rss', 'FEED_WINDOW', 1],
  ['REMOTEOK_API', 'Remote OK', 'NONE', 'LINK_BACK_REQUIRED', 'latest-feed', 'LATEST_FEED', 1],
  ['REMOTIVE_API', 'Remotive', 'NONE', 'LINK_BACK_REQUIRED', 'category', 'CATEGORY', 1],
  ['HIMALAYAS_API', 'Himalayas', 'NONE', 'CREDIT_REQUIRED', 'browse', 'BROWSE', 1],
  ['JOBICY_API', 'Jobicy', 'NONE', 'CREDIT_REQUIRED', 'feed', 'FEED_WINDOW', 1],
  ['ARBEITNOW_API', 'Arbeitnow', 'NONE', 'LINK_BACK_REQUIRED', 'job-board-api', 'PAGED_FEED', 5],
  [
    'WORKINGNOMADS_API',
    'Working Nomads',
    'NONE',
    'NONE_RECORDED',
    'exposed-jobs',
    'LATEST_FEED',
    1,
  ],
  ['JOBGETHER_API', 'Jobgether', 'NONE', 'NONE_RECORDED', 'astroapi-ai-jobs', 'PAGED_FEED', 5],
  ['HN_HIRING', 'Hacker News', 'NONE', 'NONE_RECORDED', 'algolia-who-is-hiring', 'THREAD', 2],
  ['GREENHOUSE_ATS', 'Greenhouse', 'NONE', 'NONE_RECORDED', 'job-board-api', 'BOARD', 1],
  ['LEVER_ATS', 'Lever', 'NONE', 'NONE_RECORDED', 'postings-api', 'BOARD', 1],
  ['ASHBY_ATS', 'Ashby', 'NONE', 'NONE_RECORDED', 'posting-api', 'BOARD', 1],
  ['WORKABLE_ATS', 'Workable', 'NONE', 'NONE_RECORDED', 'widget-accounts', 'BOARD', 1],
  ['SMARTRECRUITERS_ATS', 'SmartRecruiters', 'NONE', 'NONE_RECORDED', 'posting-api', 'BOARD', 2],
  [
    'RECRUITEE_ATS',
    'Recruitee',
    'EMPLOYER_TOKEN_FROM_DEADLINE',
    'NONE_RECORDED',
    'careers-site-api',
    'BOARD',
    1,
  ],
  ['PERSONIO_ATS', 'Personio', 'NONE', 'NONE_RECORDED', 'xml-feed', 'BOARD', 1],
  ['JOOBLE_API', 'Jooble', 'API_KEY', 'NONE_RECORDED', 'search-post', 'SEARCH', 1],
  ['JSEARCH_API', 'JSearch', 'API_KEY', 'NONE_RECORDED', 'rapidapi-search', 'SEARCH', 1],
  ['THEIRSTACK_API', 'TheirStack', 'API_KEY', 'NONE_RECORDED', 'jobs-search-post', 'SEARCH', 1],
  ['MUSE_API', 'The Muse', 'NONE', 'LINK_BACK_REQUIRED', 'public-jobs', 'CATEGORY', 5],
  ['REED_API', 'Reed', 'API_KEY', 'NONE_RECORDED', 'jobseeker-search', 'SEARCH', 1],
  ['DJINNI_RSS', 'Djinni', 'NONE', 'NONE_RECORDED', 'rss-primary-keyword', 'FEED_WINDOW', 1],
  ['WWR_RSS', 'We Work Remotely', 'NONE', 'LINK_BACK_REQUIRED', 'rss', 'FEED_WINDOW', 1],
  [
    'EUREMOTEJOBS_RSS',
    'EU Remote Jobs',
    'NONE',
    'NONE_RECORDED',
    'wp-job-manager-feed',
    'FEED_WINDOW',
    1,
  ],
  ['JUSTJOIN_HTML', 'JustJoin.it', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['NOFLUFF_HTML', 'No Fluff Jobs', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['LANDINGJOBS_HTML', 'Landing.jobs', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['NEXTLEVELJOBS_HTML', 'Next Level Jobs', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['DICE_HTML', 'Dice', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['THEHUB_HTML', 'The Hub', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
  ['WTTJ_HTML', 'Welcome to the Jungle', 'NONE', 'NONE_RECORDED', 'html', 'SEARCH', 1],
]

type EntryRow = [
  id: string,
  type: string,
  config: Record<string, unknown>,
  namespace: string,
  seedHours: number,
  budget: { limit: number; window: 'DAY' | 'MONTH' } | null,
  configVersion: number,
]

const MONTHLY = (limit: number) => ({ limit, window: 'MONTH' as const })

const ENTRIES: EntryRow[] = [
  ['remoteok.api.latest', 'REMOTEOK_API', {}, 'remoteok', 24, null, 1],
  [
    'remotive.api.software-dev',
    'REMOTIVE_API',
    { category: 'software-dev' },
    'remotive',
    24,
    null,
    1,
  ],
  ['remotive.api.devops', 'REMOTIVE_API', { category: 'devops' }, 'remotive', 24, null, 1],
  ['remotive.api.data', 'REMOTIVE_API', { category: 'data' }, 'remotive', 24, null, 1],
  ['himalayas.api.browse', 'HIMALAYAS_API', {}, 'himalayas', 24, null, 1],
  [
    'jobicy.api.engineering-europe',
    'JOBICY_API',
    { count: 100, industry: 'engineering', geo: 'europe' },
    'jobicy',
    24,
    null,
    1,
  ],
  ['arbeitnow.api.feed', 'ARBEITNOW_API', { maxPages: 5 }, 'arbeitnow', 24, null, 1],
  [
    'workingnomads.api.development',
    'WORKINGNOMADS_API',
    { categories: ['development'] },
    'workingnomads',
    24,
    null,
    1,
  ],
  ['jobgether.api.jobs', 'JOBGETHER_API', {}, 'jobgether', 24, null, 1],
  ['hn-hiring.thread.latest', 'HN_HIRING', {}, 'hn-hiring', 24, null, 1],
  [
    'greenhouse.board.stripe',
    'GREENHOUSE_ATS',
    {
      board: 'stripe',
      employer: { name: 'Stripe', domain: 'stripe.com', evidence: 'PAYLOAD_FIELD (720 of 720)' },
    },
    'greenhouse:stripe',
    24,
    null,
    1,
  ],
  [
    'greenhouse.board.airbnb',
    'GREENHOUSE_ATS',
    {
      board: 'airbnb',
      employer: { name: 'Airbnb', domain: null, evidence: 'PAYLOAD_FIELD (191 of 191)' },
    },
    'greenhouse:airbnb',
    24,
    null,
    1,
  ],
  [
    'greenhouse.board.cloudflare',
    'GREENHOUSE_ATS',
    {
      board: 'cloudflare',
      employer: { name: 'Cloudflare', domain: null, evidence: 'PAYLOAD_FIELD (453 of 453)' },
    },
    'greenhouse:cloudflare',
    24,
    null,
    1,
  ],
  [
    'lever.board.spotify',
    'LEVER_ATS',
    {
      board: 'spotify',
      employer: { name: 'Spotify', domain: null, evidence: 'TEXT_PARTIAL (87 of 90)' },
    },
    'lever:global:spotify',
    24,
    null,
    1,
  ],
  [
    'lever.board.eu.siteimprove',
    'LEVER_ATS',
    {
      board: 'siteimprove',
      region: 'eu',
      employer: { name: 'Siteimprove', domain: null, evidence: 'TEXT_FULL (12 of 12)' },
    },
    'lever:eu:siteimprove',
    24,
    null,
    1,
  ],
  [
    'lever.board.quantco-',
    'LEVER_ATS',
    {
      board: 'quantco-',
      employer: { name: 'QuantCo', domain: null, evidence: 'TEXT_FULL (14 of 14)' },
    },
    'lever:global:quantco-',
    24,
    null,
    1,
  ],
  [
    'ashby.board.linear',
    'ASHBY_ATS',
    {
      board: 'linear',
      employer: { name: 'Linear', domain: null, evidence: 'TEXT_FULL (34 of 34)' },
    },
    'ashby:linear',
    24,
    null,
    1,
  ],
  [
    'ashby.board.supabase',
    'ASHBY_ATS',
    {
      board: 'supabase',
      employer: { name: 'Supabase', domain: null, evidence: 'TEXT_FULL (59 of 59)' },
    },
    'ashby:supabase',
    24,
    null,
    1,
  ],
  [
    'workable.board.huggingface',
    'WORKABLE_ATS',
    {
      board: 'huggingface',
      employer: { name: 'Hugging Face', domain: null, evidence: 'PAYLOAD_FIELD' },
    },
    'workable:huggingface',
    24,
    null,
    1,
  ],
  [
    'workable.board.hirefellows',
    'WORKABLE_ATS',
    {
      board: 'hirefellows',
      employer: { name: 'Hire Fellows', domain: null, evidence: 'PAYLOAD_FIELD' },
    },
    'workable:hirefellows',
    24,
    null,
    1,
  ],
  [
    'smartrecruiters.board.ubisoft2',
    'SMARTRECRUITERS_ATS',
    { board: 'ubisoft2', employer: { name: 'Ubisoft', domain: null, evidence: 'PAYLOAD_FIELD' } },
    'smartrecruiters:ubisoft2',
    24,
    null,
    1,
  ],
  [
    'smartrecruiters.board.smartrecruiters',
    'SMARTRECRUITERS_ATS',
    {
      board: 'smartrecruiters',
      employer: { name: 'SmartRecruiters Inc', domain: null, evidence: 'PAYLOAD_FIELD' },
    },
    'smartrecruiters:smartrecruiters',
    24,
    null,
    1,
  ],
  [
    'recruitee.board.bunq',
    'RECRUITEE_ATS',
    { board: 'bunq', employer: { name: 'bunq', domain: null, evidence: 'PAYLOAD_FIELD' } },
    'recruitee:bunq',
    24,
    null,
    1,
  ],
  [
    'personio.board.westwing',
    'PERSONIO_ATS',
    {
      board: 'westwing',
      language: 'en',
      employer: { name: 'Westwing', domain: null, evidence: 'PAYLOAD_FIELD' },
    },
    'personio:westwing',
    24,
    null,
    1,
  ],
  [
    'personio.board.personio',
    'PERSONIO_ATS',
    {
      board: 'personio',
      language: 'en',
      employer: { name: 'Personio', domain: null, evidence: 'PAYLOAD_FIELD' },
    },
    'personio:personio',
    24,
    null,
    1,
  ],
  [
    'jooble.api.senior-developer-remote',
    'JOOBLE_API',
    { keywords: 'senior developer', location: 'remote' },
    'jooble',
    168,
    MONTHLY(6),
    1,
  ],
  [
    'jsearch.rapidapi.backend',
    'JSEARCH_API',
    { query: 'senior backend developer remote' },
    'jsearch',
    24,
    MONTHLY(60),
    1,
  ],
  [
    'jsearch.rapidapi.frontend',
    'JSEARCH_API',
    { query: 'senior frontend developer remote' },
    'jsearch',
    24,
    MONTHLY(60),
    1,
  ],
  [
    'jsearch.rapidapi.ai-engineer',
    'JSEARCH_API',
    { query: 'senior ai engineer remote' },
    'jsearch',
    24,
    MONTHLY(60),
    1,
  ],
  [
    'theirstack.api.senior',
    'THEIRSTACK_API',
    { limit: 25, seniority: ['senior'] },
    'theirstack',
    96,
    MONTHLY(8),
    1,
  ],
  [
    'muse.api.software-engineering-senior',
    'MUSE_API',
    { category: 'Software Engineering', level: 'Senior Level', maxPages: 5 },
    'themuse',
    24,
    null,
    1,
  ],
  [
    'reed.api.senior-developer-remote',
    'REED_API',
    { keywords: 'senior developer', locationName: 'remote' },
    'reed',
    24,
    null,
    1,
  ],
  ['djinni.rss.python', 'DJINNI_RSS', { primaryKeyword: 'Python' }, '', 24, null, 1],
  ['djinni.rss.rust', 'DJINNI_RSS', { primaryKeyword: 'Rust' }, '', 24, null, 1],
  ['wwr.rss.all-jobs', 'WWR_RSS', {}, 'wwr', 24, null, 2],
  ['wwr.rss.devops', 'WWR_RSS', { category: 'remote-devops-sysadmin-jobs' }, 'wwr', 24, null, 2],
  ['euremotejobs.rss.feed', 'EUREMOTEJOBS_RSS', {}, '', 24, null, 1],
]

describe('the hand-authored half of the manifest, pinned', () => {
  it.each(TYPES)('%s: provider, auth, attribution, endpoint, scope, requests per run', (...row) => {
    const t = manifest().types.find((x) => x.type === row[0])!
    expect([
      t.type,
      t.provider,
      t.auth,
      t.attribution,
      t.endpointVariant,
      t.scopeKind,
      t.requestsPerRun,
    ]).toEqual(row)
  })

  it('covers the 31 types and no other', () => {
    expect(manifest().types.map((t) => t.type)).toEqual(TYPES.map((r) => r[0]))
  })

  // U1b: the cadence column is now the seed's `min_interval_hours` (`rollbackCadenceHours`), unchanged
  // for every entry; the profile itself is pinned in manifest.fetch-profile.spec.ts.
  it.each(ENTRIES)(
    '%s: type, stored config, namespace, seed hours, budget, config version',
    (...row) => {
      const e = manifest().entries.find((x) => x.id === row[0])!
      const hours = rollbackCadenceHours(e.fetchProfile)
      expect([e.id, e.type, e.config, e.namespace, hours, e.budget, e.configVersion]).toEqual(row)
      expect([e.configVersion, e.manifestVersion, e.policyVersion]).toEqual([row[6], 1, 1])
    },
  )

  it('covers the 37 entries and no other', () => {
    expect(manifest().entries.map((e) => e.id)).toEqual(ENTRIES.map((r) => r[0]))
  })

  it('the quota accounts, in full', () => {
    const quotas = manifest()
      .types.filter((t) => t.quota)
      .map((t) => {
        const { limitSource, seedMeter, ...terms } = t.quota!
        return [t.type, terms, limitSource, seedMeter] as const
      })
    expect(quotas.map((q) => [q[0], q[1]])).toEqual([
      ['JOOBLE_API', { account: 'jooble:api-main', unit: 'REQUEST', window: null, limit: null }],
      [
        'JSEARCH_API',
        { account: 'jsearch:rapidapi-main', unit: 'REQUEST', window: 'MONTH', limit: 200 },
      ],
      [
        'THEIRSTACK_API',
        { account: 'theirstack:api-main', unit: 'RECORD', window: null, limit: null },
      ],
      ['REED_API', { account: 'reed:api-main', unit: 'REQUEST', window: null, limit: null }],
    ])
    expect(quotas.map((q) => q[2])).toEqual([
      'unpublished: "usage limits [are] set per key" (jooble provenance notes)',
      'the plan figure recorded in the vacancy-matching task (JSearch allows 200 requests a MONTH); NOT confirmed against a provider response, because no key is provisioned',
      'unpublished: one API credit per job returned is documented, the plan allowance is not (theirstack provenance notes)',
      'unpublished: the developer page gives no rate limit (reed provenance notes)',
    ])
    // PR #1372: the meter the seed delta creates, an A1 default cap below the provider's allowance.
    const owner = 'an A1 default of 2026-11-17 (PR #1372), not an owner figure'
    expect(quotas.map((q) => q[3])).toEqual([
      {
        window: 'DAY',
        limit: 50,
        source: `${owner}: the provider publishes no limit, so 50 requests a day`,
      },
      {
        window: 'MONTH',
        limit: 150,
        source: `${owner}: 150 of the 200-request free plan, a hard limit`,
      },
      { window: 'MONTH', limit: 150, source: `${owner}: 150 of the 200-record free plan` },
      {
        window: 'DAY',
        limit: 50,
        source: `${owner}: the provider publishes no limit, so 50 requests a day`,
      },
    ])
  })

  it('DOU is on the legacy path by decision, the HTML types are plan Task 5.6', () => {
    const d = (t: string) => manifest().types.find((x) => x.type === t)!.disposition
    expect(d('DOU_RSS')).toEqual({
      kind: 'IMPLEMENTED',
      contract: 'LEGACY',
      note: 'stays on the legacy JobSourceProvider path by decision (plan A1h / C-20); the seed delta never touches its rows',
    })
    for (const t of [
      'JUSTJOIN_HTML',
      'NOFLUFF_HTML',
      'LANDINGJOBS_HTML',
      'NEXTLEVELJOBS_HTML',
      'DICE_HTML',
      'THEHUB_HTML',
      'WTTJ_HTML',
    ]) {
      expect(d(t)).toEqual({
        kind: 'BLOCKED',
        reason: 'no adapter is implemented; the HTML adapters are plan Task 5.6',
        owner: 'plan Task 5.6',
      })
    }
  })

  it('the Recruitee deadline is read, not copied, and carries its symbol', () => {
    const t = manifest().types.find((x) => x.type === 'RECRUITEE_ATS')!
    expect(t.deadlines.map((d) => [d.kind, d.symbol])).toEqual([
      ['AUTH_REQUIRED_FROM', 'RECRUITEE_TOKEN_DEADLINE'],
    ])
  })
})
