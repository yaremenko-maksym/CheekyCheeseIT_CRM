import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { asc, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  jobExclusionFilters,
  jobPostings,
  jobSources,
  jobSuggestions,
  projects,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { DouRssProvider } from './dou.provider'
import { JobSourcingService } from './job-sourcing.service'

/**
 * DOU golden characterization — the DB-touching half (r5 compatibility fixture gate).
 *
 * Runs the REAL collector (`collectSource` -> provider.collect -> `persistPostings` ->
 * `createSuggestions`) over the same hand-crafted fixture as `dou-golden.spec.ts` and pins
 * what lands in Postgres TODAY. Only the network call is stubbed.
 *
 * Pinned on purpose even where it looks "unambitious":
 *   - ON CONFLICT (fingerprint) is DO NOTHING: a re-collected posting is NOT touched —
 *     no `last_seen_at` bump, no description refresh, first write wins.
 *   - the queue-v2 columns (`dedupe_key`, `also_seen_on`, `matched_*`, `rank_score`,
 *     `queue_status`) are left at their defaults by the DOU path.
 *   - suggestions are created for EVERY eligible senior minus exclusions — no stack relevance
 *     funnel yet (`filtered` is always 0).
 * r5 phases 1-4 will legitimately change some of this; a red test here means "decide on
 * purpose", not "restore".
 *
 * Scratch DB only (inline DATABASE_URL, never crm_db). DB-SKIP-GUARD: suite is skipped when
 * DATABASE_URL is unset.
 */

// Seed namespace: d0d0c4a2-6b1e-4f10-**
const id = (kind: string, n: number) => `d0d0c4a2-6b1e-4f10-${kind}-${String(n).padStart(12, '0')}`

function seniorUser(n: number, label: string): SessionUser {
  return {
    id: id('aa00', n),
    email: `dou-golden-${label}@test.spec`,
    displayName: `DOU Golden ${label}`,
    avatarUrl: null,
    role: 'SENIOR',
    seniorSharePercent: 26,
    legalFullName: null,
  }
}

/** Works at "EPAM Systems Inc." — the feed spells the company just «EPAM». */
const S_CLIENT = seniorUser(1, 'client')
/** No projects, no exclusions: sees everything. */
const S_FREE = seniorUser(2, 'free')
/** Carries a KEYWORD exclusion `java`. */
const S_KEYWORD = seniorUser(3, 'keyword')
/** Archived account: not eligible. */
const S_ARCHIVED = seniorUser(4, 'archived')
/** Never joined a team: not eligible. */
const S_NO_TEAM = seniorUser(5, 'noteam')
/** Left the team: not eligible. */
const S_LEFT = seniorUser(6, 'left')

const ALL_SENIORS = [S_CLIENT, S_FREE, S_KEYWORD, S_ARCHIVED, S_NO_TEAM, S_LEFT]
const SENIOR_IDS = ALL_SENIORS.map((s) => s.id)

const TEAM_ID = id('bb00', 1)
const PROJECT_ID = id('cc00', 1)
const SOURCE_ID = id('dd00', 1)

const FIXTURES = join(__dirname, '__fixtures__')
const FEED_XML = readFileSync(join(FIXTURES, 'dou-feed.golden.xml'), 'utf8')
const GOLDEN = JSON.parse(
  readFileSync(join(FIXTURES, 'dou-feed.golden.expected.json'), 'utf8'),
) as {
  postings: Array<{
    sourceType: string
    externalId: string
    url: string
    title: string
    companyName: string
    companyNameNormalized: string
    location: string | null
    descriptionMd: string
    publishedAt: string | null
    fingerprint: string
  }>
}
const GOLDEN_FINGERPRINTS = GOLDEN.postings.map((p) => p.fingerprint)
/** The feed carries the EPAM vacancy twice; the first occurrence wins, the second is a duplicate. */
const GOLDEN_STORED = GOLDEN.postings
  .filter((p, i, all) => all.findIndex((q) => q.fingerprint === p.fingerprint) === i)
  .sort((a, b) => a.url.localeCompare(b.url))

const MALFORMED_ONLY_FEED =
  '<?xml version="1.0"?><rss version="2.0"><channel>' +
  '<item><title>Evil Engineer в Hacker, Київ</title><link>javascript:alert(1)</link>' +
  '<guid>javascript:alert(1)</guid><description>x</description></item>' +
  '<item><title>Insecure в Plainhttp, Одеса</title>' +
  '<link>http://jobs.dou.ua/companies/plainhttp/vacancies/360005/</link>' +
  '<guid>http://jobs.dou.ua/companies/plainhttp/vacancies/360005/?1</guid></item>' +
  '</channel></rss>'

/** Real provider with ONLY the network call replaced. */
class FixtureDouProvider extends DouRssProvider {
  feedXml = FEED_XML
  protected override fetchFeed(): Promise<string> {
    return Promise.resolve(this.feedXml)
  }
}

describe.skipIf(!hasDatabaseUrl())('DOU golden characterization — real DB', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let service: JobSourcingService
  let provider: FixtureDouProvider

  const source = { id: SOURCE_ID, type: 'DOU_RSS' as const, config: { category: 'JavaScript' } }

  const storedRows = () =>
    dbSvc.db
      .select()
      .from(jobPostings)
      .where(inArray(jobPostings.fingerprint, GOLDEN_FINGERPRINTS))
      .orderBy(asc(jobPostings.url))

  async function suggestionCount(seniorId: string): Promise<number> {
    const rows = await dbSvc.db
      .select({ id: jobSuggestions.id })
      .from(jobSuggestions)
      .where(eq(jobSuggestions.seniorId, seniorId))
    return rows.length
  }

  async function cleanPostings(): Promise<void> {
    const db = dbSvc.db
    await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, SENIOR_IDS))
    await db.delete(jobPostings).where(inArray(jobPostings.fingerprint, GOLDEN_FINGERPRINTS))
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await pool.query('SELECT 1')
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    provider = new FixtureDouProvider()
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), provider)

    await db
      .insert(users)
      .values(
        ALL_SENIORS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-dou-golden-${u.id}`,
          archivedAt: u.id === S_ARCHIVED.id ? new Date('2026-01-01T00:00:00Z') : null,
        })),
      )
      .onConflictDoNothing()
    await db.insert(teams).values({ id: TEAM_ID, name: 'DOU Golden Team' }).onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_ID, userId: S_CLIENT.id },
        { teamId: TEAM_ID, userId: S_FREE.id },
        { teamId: TEAM_ID, userId: S_KEYWORD.id },
        { teamId: TEAM_ID, userId: S_ARCHIVED.id },
        { teamId: TEAM_ID, userId: S_LEFT.id, leftAt: new Date('2026-02-01T00:00:00Z') },
      ])
      .onConflictDoNothing()
    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'DOU Golden Project',
        companyName: 'EPAM Systems Inc.',
        domain: 'AI',
        seniorId: S_CLIENT.id,
        rate: 1000,
        currency: 'USD',
        startDate: new Date('2026-01-01'),
      })
      .onConflictDoNothing()
    await db
      .insert(jobSources)
      .values({ id: SOURCE_ID, type: 'DOU_RSS', config: { category: 'JavaScript' } })
      .onConflictDoNothing()
    await cleanPostings()
    await service.createExclusion(
      { scope: 'SENIOR', seniorId: S_KEYWORD.id, kind: 'KEYWORD', value: 'java' },
      S_KEYWORD,
    )
  }, 30_000)

  beforeEach(async () => {
    await cleanPostings()
    await dbSvc.db
      .update(jobSources)
      .set({ lastCollectedAt: null })
      .where(eq(jobSources.id, SOURCE_ID))
    provider.feedXml = FEED_XML
  })

  afterAll(async () => {
    const db = dbSvc.db
    await cleanPostings()
    await db.delete(jobExclusionFilters).where(inArray(jobExclusionFilters.seniorId, SENIOR_IDS))
    await db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.delete(teamMembers).where(inArray(teamMembers.userId, SENIOR_IDS))
    await db.delete(teams).where(eq(teams.id, TEAM_ID))
    await db.delete(users).where(inArray(users.id, SENIOR_IDS))
    await pool.end()
  }, 30_000)

  // ── collectSource: first collection ────────────────────────────────────────

  it('first collection: reports 9 fetched / 8 created / 1 in-feed duplicate, funnel counters 0', async () => {
    const result = await service.collectSource(source)

    expect(result).toEqual({
      sourceType: 'DOU_RSS',
      fetched: 9,
      created: 8,
      duplicates: 1,
      invalid: 0,
      merged: 0,
      filtered: 0,
      suggestionsCreated: expect.any(Number),
    })
    // 7 (client) + 8 (free) + 7 (keyword) from the seniors seeded here; other eligible seniors
    // sharing the scratch DB can only add to the total.
    expect(result.suggestionsCreated).toBeGreaterThanOrEqual(22)
  })

  it('persists exactly the golden postings (twin collapsed, first write wins)', async () => {
    await service.collectSource(source)

    const rows = await storedRows()
    expect(
      rows.map((r) => ({
        sourceType: r.sourceType,
        externalId: r.externalId,
        url: r.url,
        title: r.title,
        companyName: r.companyName,
        companyNameNormalized: r.companyNameNormalized,
        location: r.location,
        descriptionMd: r.descriptionMd,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        fingerprint: r.fingerprint,
      })),
    ).toEqual(GOLDEN_STORED)
    expect(rows.every((r) => r.sourceId === SOURCE_ID)).toBe(true)
  })

  it('leaves the queue-v2 columns at their defaults on the DOU path', async () => {
    await service.collectSource(source)

    for (const row of await storedRows()) {
      expect(row).toMatchObject({
        dedupeKey: null,
        alsoSeenOn: [],
        matchedSeniorIds: [],
        matchedKeywords: [],
        seniority: 'UNKNOWN',
        stackUnknown: false,
        rankScore: 0,
        queueStatus: 'NEW',
        takenBy: null,
        takenAt: null,
      })
    }
  })

  it('marks the source collected on success', async () => {
    await service.collectSource(source)
    const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
    expect(row?.lastCollectedAt).toBeInstanceOf(Date)
  })

  // ── re-collection: ON CONFLICT (fingerprint) DO NOTHING ────────────────────

  it('re-collection: 0 created, 9 duplicates, no duplicate rows', async () => {
    await service.collectSource(source)
    const second = await service.collectSource(source)

    expect(second).toMatchObject({
      fetched: 9,
      created: 0,
      duplicates: 9,
      invalid: 0,
      suggestionsCreated: 0,
    })
    expect(await storedRows()).toHaveLength(8)
  })

  it('re-collection does NOT touch the existing rows (no last_seen_at / updated_at bump)', async () => {
    await service.collectSource(source)
    const before = await storedRows()

    await service.collectSource(source)
    const after = await storedRows()

    // Row-for-row identical, timestamps included: today the upsert is DO NOTHING.
    expect(after).toEqual(before)
    expect(after.map((r) => r.lastSeenAt.getTime())).toEqual(
      before.map((r) => r.lastSeenAt.getTime()),
    )
  })

  it('re-collection does NOT refresh a changed description or title (first write wins)', async () => {
    await service.collectSource(source)
    provider.feedXml = FEED_XML.replace(
      'Node.js, PostgreSQL, Kubernetes. Remote.',
      'COMPLETELY NEW DESCRIPTION',
    ).replace('Middle Node.js Developer', 'Middle Rewritten Developer')

    const second = await service.collectSource(source)

    expect(second.created).toBe(0)
    const wetelo = (await storedRows()).find((r) => r.url.endsWith('/360001'))
    expect(wetelo?.descriptionMd).toBe('Node.js, PostgreSQL, Kubernetes. Remote.')
    expect(wetelo?.title).toBe('Middle Node.js Developer')
  })

  // ── zero usable postings = failure ─────────────────────────────────────────

  it('a feed whose every entry is malformed throws and leaves the source uncollected', async () => {
    provider.feedXml = MALFORMED_ONLY_FEED

    await expect(service.collectSource(source)).rejects.toThrow(
      'Source DOU_RSS returned 0 usable postings — feed format changed, source is down, or every entry was rejected. lastCollectedAt left unchanged.',
    )

    const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
    expect(row?.lastCollectedAt).toBeNull()
    expect(await storedRows()).toHaveLength(0)
  })

  it('an unparseable body (HTML error page served with 200) fails the same way', async () => {
    provider.feedXml = '<html><body>503 Service Unavailable</body></html>'
    await expect(service.collectSource(source)).rejects.toThrow(/0 usable postings/)
  })

  // ── createSuggestions ──────────────────────────────────────────────────────

  it('offers each eligible senior every posting minus their exclusions', async () => {
    await service.collectSource(source)

    // the senior's own client (EPAM) is withheld, everything else is offered
    expect(await suggestionCount(S_CLIENT.id)).toBe(7)
    // nothing to exclude -> all 8 distinct postings
    expect(await suggestionCount(S_FREE.id)).toBe(8)
    // KEYWORD `java` hides the one posting with Java in the TITLE (R&D Labs); not Soft Serve,
    // whose description mentions Java but whose title does not
    expect(await suggestionCount(S_KEYWORD.id)).toBe(7)
  })

  it('withholds exactly the excluded postings and creates only NEW rows', async () => {
    await service.collectSource(source)

    const rows = await dbSvc.db
      .select({
        seniorId: jobSuggestions.seniorId,
        status: jobSuggestions.status,
        url: jobPostings.url,
      })
      .from(jobSuggestions)
      .innerJoin(jobPostings, eq(jobPostings.id, jobSuggestions.postingId))
      .where(inArray(jobSuggestions.seniorId, [S_CLIENT.id, S_KEYWORD.id]))

    const urlsFor = (seniorId: string) =>
      rows
        .filter((r) => r.seniorId === seniorId)
        .map((r) => r.url)
        .sort()
    const allUrls = GOLDEN_STORED.map((p) => p.url)

    expect(urlsFor(S_CLIENT.id)).toEqual(
      allUrls.filter((u) => u !== 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562'),
    )
    expect(urlsFor(S_KEYWORD.id)).toEqual(
      allUrls.filter((u) => u !== 'https://jobs.dou.ua/companies/rnd-labs/vacancies/360008'),
    )
    expect(rows.every((r) => r.status === 'NEW')).toBe(true)
  })

  it('ineligible seniors (archived / no team / left the team) get nothing', async () => {
    await service.collectSource(source)

    expect(await suggestionCount(S_ARCHIVED.id)).toBe(0)
    expect(await suggestionCount(S_NO_TEAM.id)).toBe(0)
    expect(await suggestionCount(S_LEFT.id)).toBe(0)
  })

  it('re-collection creates no further suggestions', async () => {
    await service.collectSource(source)
    await service.collectSource(source)

    expect(await suggestionCount(S_CLIENT.id)).toBe(7)
    expect(await suggestionCount(S_FREE.id)).toBe(8)
    expect(await suggestionCount(S_KEYWORD.id)).toBe(7)
  })
})
