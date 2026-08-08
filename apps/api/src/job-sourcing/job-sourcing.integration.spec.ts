import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray, isNull } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { jobCollectionRunSchema } from '@crm/shared'
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
import { DouRssProvider } from './dou.provider'
import type { NormalizedPosting } from './job-source.provider'
import { MAX_FAILURE_MESSAGE_CHARS } from './safe-failure-message'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Job sourcing — real-database integration spec (task-job-sourcing-slice1 AC8).
 *
 * Covers the behaviours that ONLY a real database can prove, because each one
 * is enforced by SQL rather than by TypeScript:
 *   AC1 — a second collection run creates no duplicates (unique fingerprint
 *         index + ON CONFLICT), including the case that actually bites: DOU's
 *         `<guid>` carries a NEW timestamp query on every fetch.
 *   AC3 — a senior is never offered their own client, with the client spelled
 *         differently in the feed than in the CRM.
 *   AC4 — a REJECTED posting never comes back, not even after a re-collect.
 *   RBAC — HR scope / SENIOR self-only / other roles rejected, against real
 *         team_members rows (mocked tests cannot prove a backend guard — this
 *         repo has learned that three times, see feedback_mocked_e2e_guards).
 *
 * The feed itself is stubbed (`StubDouProvider.fetchFeed`) — the test must not
 * depend on jobs.dou.ua being up, and hammering a third party from a test suite
 * would be rude. Everything BELOW the fetch (parse → normalize → dedupe →
 * filter → persist) is the real code path.
 *
 * DB-SKIP-GUARD: when DATABASE_URL is unreachable (CI unit job) every test
 * returns early and the suite stays green.
 */

// Seed namespace: d5e6f7a8-1b2c-4d3e-**
const ADMIN: SessionUser = {
  id: 'd5e6f7a8-1b2c-4d3e-aa00-000000000001',
  email: 'js-admin@test.spec',
  displayName: 'JS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
/** Works at "EPAM Systems Inc." — the feed spells the same company «ЕПАМ». */
const SENIOR_A: SessionUser = {
  id: 'd5e6f7a8-1b2c-4d3e-aa00-000000000002',
  email: 'js-senior-a@test.spec',
  displayName: 'JS Senior A',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
/** No projects — sees everything. In a different team from HR_A. */
const SENIOR_B: SessionUser = {
  id: 'd5e6f7a8-1b2c-4d3e-aa00-000000000003',
  email: 'js-senior-b@test.spec',
  displayName: 'JS Senior B',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const HR_A: SessionUser = {
  id: 'd5e6f7a8-1b2c-4d3e-aa00-000000000004',
  email: 'js-hr-a@test.spec',
  displayName: 'JS HR A',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'd5e6f7a8-1b2c-4d3e-aa00-000000000005',
  email: 'js-accountant@test.spec',
  displayName: 'JS Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEAM_A_ID = 'd5e6f7a8-1b2c-4d3e-bb00-000000000001'
const TEAM_B_ID = 'd5e6f7a8-1b2c-4d3e-bb00-000000000002'
const PROJECT_ID = 'd5e6f7a8-1b2c-4d3e-cc00-000000000001'
const SOURCE_ID = 'd5e6f7a8-1b2c-4d3e-dd00-000000000001'

const TEST_USER_IDS = [ADMIN.id, SENIOR_A.id, SENIOR_B.id, HR_A.id, ACCOUNTANT.id]

/** Feed entry helper — `guidSuffix` simulates DOU's changing guid query. */
function douFeed(
  entries: Array<{ title: string; path: string; guidSuffix?: string; description?: string }>,
): string {
  const items = entries
    .map(
      (e) =>
        `<item><title>${e.title}</title>` +
        `<link>https://jobs.dou.ua${e.path}?utm_source=jobsrss</link>` +
        `<guid isPermaLink="false">https://jobs.dou.ua${e.path}?${e.guidSuffix ?? '1'}</guid>` +
        `<pubDate>Fri, 07 Aug 2026 11:48:38 +0300</pubDate>` +
        `<description>${e.description ?? '&lt;p&gt;desc&lt;/p&gt;'}</description></item>`,
    )
    .join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`
}

/** Real provider with ONLY the network call replaced. */
class StubDouProvider extends DouRssProvider {
  feedXml = ''
  /** Set to a category to make THAT source fail — used for the partial-run test. */
  failForCategory: string | null = null
  failWith: Error = new Error('stub failure')

  override collect(config: Record<string, unknown> = {}): Promise<NormalizedPosting[]> {
    if (this.failForCategory && config['category'] === this.failForCategory) {
      return Promise.reject(this.failWith)
    }
    return super.collect(config)
  }

  protected override fetchFeed(): Promise<string> {
    return Promise.resolve(this.feedXml)
  }
}

const BASE_FEED = douFeed([
  {
    title: 'Senior Frontend Engineer в ЕПАМ, Київ, віддалено',
    path: '/companies/epam/vacancies/1/',
  },
  { title: 'Senior Node.js Engineer в Ciklum, Львів', path: '/companies/ciklum/vacancies/2/' },
  { title: 'Lead Fullstack в Mobilunity, віддалено', path: '/companies/mobilunity/vacancies/3/' },
])

describe('Job sourcing — real DB integration', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let service: JobSourcingService
  let provider: StubDouProvider
  let dbAvailable = true

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[job-sourcing integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    provider = new StubDouProvider()
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), provider)

    await db
      .insert(users)
      .values(
        [ADMIN, SENIOR_A, SENIOR_B, HR_A, ACCOUNTANT].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-js-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: TEAM_A_ID, name: 'JS Team A' },
        { id: TEAM_B_ID, name: 'JS Team B' },
      ])
      .onConflictDoNothing()

    // TEAM_A: SENIOR_A + HR_A. TEAM_B: SENIOR_B (HR_A has no access there).
    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_A_ID, userId: SENIOR_A.id },
        { teamId: TEAM_A_ID, userId: HR_A.id },
        { teamId: TEAM_B_ID, userId: SENIOR_B.id },
      ])
      .onConflictDoNothing()

    // SENIOR_A's own client, spelled the LONG Latin way. The feed spells the
    // same company «ЕПАМ» — only normalization connects the two (AC3).
    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'JS Integration Project',
        companyName: 'EPAM Systems Inc.',
        domain: 'AI',
        seniorId: SENIOR_A.id,
        rate: 1000,
        currency: 'USD',
        startDate: new Date('2026-01-01'),
      })
      .onConflictDoNothing()

    await db
      .insert(jobSources)
      .values({ id: SOURCE_ID, type: 'DOU_RSS', config: { category: 'JavaScript' } })
      .onConflictDoNothing()
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    // Each test starts from a clean posting/suggestion/exclusion state; the
    // users/teams/projects/source seed above is shared.
    const db = dbSvc.db
    await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, TEST_USER_IDS))
    await db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))
    await db.delete(jobExclusionFilters).where(inArray(jobExclusionFilters.seniorId, TEST_USER_IDS))
    provider.feedXml = BASE_FEED
  })

  afterAll(async () => {
    if (!dbAvailable) return
    const db = dbSvc.db
    await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, TEST_USER_IDS))
    await db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))
    await db.delete(jobExclusionFilters).where(inArray(jobExclusionFilters.seniorId, TEST_USER_IDS))
    await db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.delete(teamMembers).where(inArray(teamMembers.userId, TEST_USER_IDS))
    await db.delete(teams).where(inArray(teams.id, [TEAM_A_ID, TEAM_B_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await pool.end()
  }, 30_000)

  const source = { id: SOURCE_ID, type: 'DOU_RSS' as const, config: { category: 'JavaScript' } }

  // ── AC1 — collection + dedupe ──────────────────────────────────────────────

  it('AC1: collection fills postings from the feed', async () => {
    if (!dbAvailable) return
    const result = await service.collectSource(source)

    expect(result.fetched).toBe(3)
    expect(result.created).toBe(3)
    expect(result.duplicates).toBe(0)

    const rows = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceId, SOURCE_ID))
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.companyName).sort()).toEqual(['Ciklum', 'Mobilunity', 'ЕПАМ'])
    // The stored URL is canonical — no utm, no trailing slash.
    expect(rows.every((r) => !r.url.includes('utm_source'))).toBe(true)
  })

  it('AC1: a second run over the SAME feed creates no duplicates', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const second = await service.collectSource(source)

    expect(second.fetched).toBe(3)
    expect(second.created).toBe(0)
    expect(second.duplicates).toBe(3)
    expect(
      await dbSvc.db.select().from(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID)),
    ).toHaveLength(3)
  })

  it('AC1: dedupe survives DOU changing the guid timestamp between fetches', async () => {
    if (!dbAvailable) return
    provider.feedXml = douFeed([
      { title: 'Dev в Ciklum, Київ', path: '/companies/ciklum/vacancies/9/', guidSuffix: '1111' },
    ])
    const first = await service.collectSource(source)

    // Same vacancy, brand-new guid query — this is what the live feed does on
    // every single request. A raw-URL fingerprint would duplicate here.
    provider.feedXml = douFeed([
      { title: 'Dev в Ciklum, Київ', path: '/companies/ciklum/vacancies/9/', guidSuffix: '9999' },
    ])
    const second = await service.collectSource(source)

    expect(first.created).toBe(1)
    expect(second.created).toBe(0)
    expect(second.duplicates).toBe(1)
  })

  it('AC1: dedupe is enforced by the DATABASE, not only by application code', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const [existing] = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceId, SOURCE_ID))
      .limit(1)

    await expect(
      dbSvc.db.insert(jobPostings).values({
        sourceType: 'DOU_RSS',
        sourceId: SOURCE_ID,
        externalId: existing!.externalId,
        url: existing!.url,
        title: 'Manual duplicate',
        companyName: existing!.companyName,
        companyNameNormalized: existing!.companyNameNormalized,
        descriptionMd: '',
        fingerprint: existing!.fingerprint,
      }),
    ).rejects.toThrow()
  })

  // ── AC3 — auto-filled exclusions from the senior's projects ────────────────

  it('AC3: the senior is not offered a vacancy at their OWN client (different spelling)', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)

    const queue = await service.listSuggestions(SENIOR_A.id, ADMIN)
    const companies = queue.items.map((i) => i.posting.companyName)

    // Feed says «ЕПАМ», the CRM project says «EPAM Systems Inc.» — same company.
    expect(companies).not.toContain('ЕПАМ')
    expect(companies).toEqual(expect.arrayContaining(['Ciklum', 'Mobilunity']))
  })

  it('AC3: a senior WITHOUT that project still sees the same vacancy', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)

    const queue = await service.listSuggestions(SENIOR_B.id, ADMIN)
    expect(queue.items.map((i) => i.posting.companyName)).toContain('ЕПАМ')
  })

  it('AC3: the derived exclusion is listed with its project as the source', async () => {
    if (!dbAvailable) return
    const { items } = await service.listExclusions(SENIOR_A.id, ADMIN)
    const derived = items.find((i) => i.origin === 'PROJECT')

    expect(derived).toMatchObject({
      id: null,
      kind: 'COMPANY',
      value: 'EPAM Systems Inc.',
      sourceLabel: 'JS Integration Project',
    })
  })

  it('AC3: no NEW suggestion row is even created for the senior’s own client', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)

    const rows = await dbSvc.db
      .select({ company: jobPostings.companyName })
      .from(jobSuggestions)
      .innerJoin(jobPostings, eq(jobSuggestions.postingId, jobPostings.id))
      .where(eq(jobSuggestions.seniorId, SENIOR_A.id))

    expect(rows.map((r) => r.company)).not.toContain('ЕПАМ')
  })

  // ── AC4 — a rejected posting stays rejected ────────────────────────────────

  it('AC4: a REJECTED posting disappears from the queue', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)

    const before = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    const target = before.items[0]!
    await service.updateStatus(target.id, { status: 'REJECTED' }, SENIOR_B)

    const after = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    expect(after.items.map((i) => i.id)).not.toContain(target.id)
    expect(after.total).toBe(before.total - 1)
  })

  it('AC4: a re-collect does NOT resurface a rejected posting as NEW', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const before = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    const target = before.items[0]!
    await service.updateStatus(target.id, { status: 'REJECTED' }, SENIOR_B)

    // The feed still carries the vacancy — as it will every day.
    await service.collectSource(source)

    const after = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    expect(after.items.map((i) => i.posting.id)).not.toContain(target.posting.id)

    const counts = await service.countSuggestionsByStatus(SENIOR_B.id)
    expect(counts['REJECTED']).toBe(1)
  })

  it('AC4: an APPLIED posting also leaves the queue and keeps its status', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const before = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    const target = before.items[0]!

    const updated = await service.updateStatus(target.id, { status: 'APPLIED' }, SENIOR_B)
    expect(updated.status).toBe('APPLIED')
    expect(updated.statusChangedByName).toBe(SENIOR_B.displayName)

    const after = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    expect(after.items.map((i) => i.id)).not.toContain(target.id)
  })

  // ── Manual exclusions ──────────────────────────────────────────────────────

  it('a manual company exclusion hides the vacancy immediately, without re-collecting', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    expect((await service.listSuggestions(SENIOR_B.id, SENIOR_B)).items.length).toBe(3)

    await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'ciklum' },
      SENIOR_B,
    )

    const after = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    expect(after.items.map((i) => i.posting.companyName)).not.toContain('Ciklum')
  })

  it('adding the same exclusion twice is a no-op, not an error', async () => {
    if (!dbAvailable) return
    const first = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'Devart' },
      SENIOR_B,
    )
    const second = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'devart' },
      SENIOR_B,
    )
    expect(second.id).toBe(first.id)
  })

  it('a GLOBAL exclusion applies to every senior', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    await service.createExclusion({ scope: 'GLOBAL', kind: 'COMPANY', value: 'Mobilunity' }, ADMIN)

    try {
      for (const senior of [SENIOR_A, SENIOR_B]) {
        const queue = await service.listSuggestions(senior.id, ADMIN)
        expect(queue.items.map((i) => i.posting.companyName)).not.toContain('Mobilunity')
      }
    } finally {
      await dbSvc.db.delete(jobExclusionFilters).where(eq(jobExclusionFilters.createdBy, ADMIN.id))
    }
  })

  /**
   * Code + security review round 4 — the CREATE path had zero tests while the
   * delete path had four, and the line that decides ownership
   * (`assertCanAccessSenior(user, dto.seniorId ?? undefined)`) became
   * load-bearing exactly when the client stopped sending an id. A mutation to
   * "trust the client" (`seniorId = dto.seniorId ?? user.id`) left 37/37 green.
   *
   * Both tests below fail on that mutation: the first because the row would be
   * created against the id the client asked for, the second because an
   * ADMIN/HR with no id would silently get a row of their own instead of a
   * refusal.
   */
  it('a SENIOR who passes ANOTHER senior’s id still gets the row on themselves', async () => {
    if (!dbAvailable) return
    const created = await service.createExclusion(
      // SENIOR_B asking for SENIOR_A's list — the shape an IDOR attempt takes.
      { scope: 'SENIOR', seniorId: SENIOR_A.id, kind: 'COMPANY', value: 'Wetelo' },
      SENIOR_B,
    )

    expect(created.seniorId).toBe(SENIOR_B.id)
    const [row] = await dbSvc.db
      .select()
      .from(jobExclusionFilters)
      .where(eq(jobExclusionFilters.id, created.id!))
    expect(row!.seniorId).toBe(SENIOR_B.id)

    // …and SENIOR_A's own list is untouched.
    const victim = await service.listExclusions(SENIOR_A.id, ADMIN)
    expect(victim.items.filter((i) => i.origin === 'MANUAL').map((i) => i.value)).not.toContain(
      'Wetelo',
    )
  })

  it('an ADMIN/HR without a senior gets a refusal, not a studio-wide row', async () => {
    if (!dbAvailable) return
    const globalsBefore = await dbSvc.db
      .select()
      .from(jobExclusionFilters)
      .where(isNull(jobExclusionFilters.seniorId))

    for (const actor of [ADMIN, HR_A]) {
      await expect(
        service.createExclusion({ scope: 'SENIOR', kind: 'COMPANY', value: 'Mobilunity' }, actor),
      ).rejects.toThrow(/Выберите синьора/)
    }

    // Nothing leaked into the GLOBAL list (senior_id IS NULL) as a side effect.
    const globalsAfter = await dbSvc.db
      .select()
      .from(jobExclusionFilters)
      .where(isNull(jobExclusionFilters.seniorId))
    expect(globalsAfter).toHaveLength(globalsBefore.length)
  })

  it('HR cannot create an exclusion for a senior outside their teams', async () => {
    if (!dbAvailable) return
    await expect(
      service.createExclusion(
        { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'Ciklum' },
        HR_A,
      ),
    ).rejects.toThrow(/не в ваших командах/)
  })

  it('HR CAN create an exclusion for a senior in their own team', async () => {
    if (!dbAvailable) return
    const created = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_A.id, kind: 'COMPANY', value: 'Ciklum' },
      HR_A,
    )
    expect(created.seniorId).toBe(SENIOR_A.id)
  })

  it('a SENIOR cannot create a studio-wide exclusion', async () => {
    if (!dbAvailable) return
    await expect(
      service.createExclusion({ scope: 'GLOBAL', kind: 'COMPANY', value: 'Whatever' }, SENIOR_B),
    ).rejects.toThrow(/ADMIN и HR/)
  })

  it('deleting an exclusion brings the vacancy back', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const created = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'Ciklum' },
      SENIOR_B,
    )
    expect(
      (await service.listSuggestions(SENIOR_B.id, SENIOR_B)).items.map(
        (i) => i.posting.companyName,
      ),
    ).not.toContain('Ciklum')

    await service.deleteExclusion(created.id!, SENIOR_B)
    expect(
      (await service.listSuggestions(SENIOR_B.id, SENIOR_B)).items.map(
        (i) => i.posting.companyName,
      ),
    ).toContain('Ciklum')
  })

  // ── RBAC (real team_members rows) ──────────────────────────────────────────

  it('RBAC: a SENIOR always gets their OWN queue, whatever seniorId they pass', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const queue = await service.listSuggestions(SENIOR_A.id, SENIOR_B)
    expect(queue.items.every((i) => i.seniorId === SENIOR_B.id)).toBe(true)
  })

  it('RBAC: HR reaches a senior in their own team', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const queue = await service.listSuggestions(SENIOR_A.id, HR_A)
    expect(queue.items.every((i) => i.seniorId === SENIOR_A.id)).toBe(true)
  })

  it('RBAC: HR cannot reach a senior from another team', async () => {
    if (!dbAvailable) return
    await expect(service.listSuggestions(SENIOR_B.id, HR_A)).rejects.toThrow(/не в ваших командах/)
  })

  it('RBAC: ACCOUNTANT is rejected outright', async () => {
    if (!dbAvailable) return
    await expect(service.listSuggestions(SENIOR_A.id, ACCOUNTANT)).rejects.toThrow(/Нет доступа/)
  })

  it('RBAC: a SENIOR cannot change the status of another senior’s suggestion', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const otherQueue = await service.listSuggestions(SENIOR_A.id, ADMIN)
    const foreign = otherQueue.items[0]!

    await expect(
      service.updateStatus(foreign.id, { status: 'APPLIED' }, SENIOR_B),
    ).rejects.toThrow()

    const counts = await service.countSuggestionsByStatus(SENIOR_A.id)
    expect(counts['APPLIED']).toBeUndefined()
  })

  /**
   * Security-review round 2, HIGH-2 — the paired tests that did not exist.
   *
   * `updateStatus` had an IDOR test; `deleteExclusion` had none, and its check
   * was `await assertCanAccessSenior(user, row.seniorId)` with the RESULT
   * THROWN AWAY. For a SENIOR that method returns `user.id` unconditionally
   * without consulting the argument, so the call asserted nothing at all: any
   * senior could delete any other senior's exclusion by id and silently
   * re-expose the company their colleague had shut out.
   */
  it('RBAC: a SENIOR cannot delete ANOTHER senior’s exclusion (HIGH-2)', async () => {
    if (!dbAvailable) return
    const victim = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_A.id, kind: 'COMPANY', value: 'Ciklum' },
      ADMIN,
    )

    await expect(service.deleteExclusion(victim.id!, SENIOR_B)).rejects.toThrow(/Нет доступа/)

    // Still there — the check must PREVENT the delete, not merely complain.
    const stillThere = await dbSvc.db
      .select()
      .from(jobExclusionFilters)
      .where(eq(jobExclusionFilters.id, victim.id!))
    expect(stillThere).toHaveLength(1)
  })

  it('RBAC: HR cannot delete an exclusion of a senior outside their teams (HIGH-2)', async () => {
    if (!dbAvailable) return
    const victim = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'Devart' },
      ADMIN,
    )

    await expect(service.deleteExclusion(victim.id!, HR_A)).rejects.toThrow(/не в ваших командах/)
    expect(
      await dbSvc.db
        .select()
        .from(jobExclusionFilters)
        .where(eq(jobExclusionFilters.id, victim.id!)),
    ).toHaveLength(1)
  })

  it('RBAC: a SENIOR can delete their OWN exclusion (the check does not over-block)', async () => {
    if (!dbAvailable) return
    const own = await service.createExclusion(
      { scope: 'SENIOR', seniorId: SENIOR_B.id, kind: 'COMPANY', value: 'Devart' },
      SENIOR_B,
    )

    await service.deleteExclusion(own.id!, SENIOR_B)
    expect(
      await dbSvc.db.select().from(jobExclusionFilters).where(eq(jobExclusionFilters.id, own.id!)),
    ).toHaveLength(0)
  })

  it('RBAC: a SENIOR cannot delete a GLOBAL exclusion', async () => {
    if (!dbAvailable) return
    const global = await service.createExclusion(
      { scope: 'GLOBAL', kind: 'COMPANY', value: 'GlobalOnly' },
      ADMIN,
    )
    try {
      await expect(service.deleteExclusion(global.id!, SENIOR_B)).rejects.toThrow(/ADMIN и HR/)
    } finally {
      await dbSvc.db.delete(jobExclusionFilters).where(eq(jobExclusionFilters.id, global.id!))
    }
  })

  it('RBAC: HR cannot act on a suggestion of a senior outside their teams', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const queue = await service.listSuggestions(SENIOR_B.id, ADMIN)
    await expect(
      service.updateStatus(queue.items[0]!.id, { status: 'REJECTED' }, HR_A),
    ).rejects.toThrow(/не в ваших командах/)
  })

  // ── Retention ──────────────────────────────────────────────────────────────

  it('purges stale postings but keeps the ones a senior applied to', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const queue = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    const applied = queue.items[0]!
    await service.updateStatus(applied.id, { status: 'APPLIED' }, SENIOR_B)

    // Age every posting past the retention window.
    await dbSvc.db
      .update(jobPostings)
      .set({ collectedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(jobPostings.sourceId, SOURCE_ID))

    const purged = await service.purgeStalePostings()
    expect(purged).toBeGreaterThanOrEqual(2)

    const left = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceId, SOURCE_ID))
    expect(left.map((p) => p.id)).toEqual([applied.posting.id])
  })

  it('keeps recent postings', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    expect(await service.purgeStalePostings()).toBe(0)
  })

  /**
   * Code review round 3 — the AC4 hole. Retention used to keep only APPLIED
   * postings, so a REJECTED one was deleted with its suggestion (cascade) and
   * could be re-collected and re-offered to the same senior 90 days later.
   */
  it('AC4: a REJECTED posting survives retention, so it can never be re-offered', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const queue = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    const rejected = queue.items[0]!
    await service.updateStatus(rejected.id, { status: 'REJECTED' }, SENIOR_B)

    await dbSvc.db
      .update(jobPostings)
      .set({ collectedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(jobPostings.sourceId, SOURCE_ID))

    await service.purgeStalePostings()

    // The posting is still there, and so is the REJECTED decision.
    const survivors = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.id, rejected.posting.id))
    expect(survivors).toHaveLength(1)

    // Re-collecting cannot turn it back into a NEW suggestion.
    await service.collectSource(source)
    const after = await service.listSuggestions(SENIOR_B.id, SENIOR_B)
    expect(after.items.map((i) => i.posting.id)).not.toContain(rejected.posting.id)
    expect((await service.countSuggestionsByStatus(SENIOR_B.id))['REJECTED']).toBe(1)
  })

  /** Code review round 3 — a broken source must not look like a quiet day. */
  it('a feed that yields no postings fails loudly and does NOT mark the source collected', async () => {
    if (!dbAvailable) return
    await service.collectSource(source)
    const [before] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
    expect(before!.lastCollectedAt).not.toBeNull()

    // The feed changed shape — still HTTP 200, but nothing we can parse.
    provider.feedXml = '<?xml version="1.0"?><feed><entry><name>new format</name></entry></feed>'

    await expect(service.collectSource(source)).rejects.toThrow(/0 usable postings/)

    const [after] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
    expect(after!.lastCollectedAt?.getTime()).toBe(before!.lastCollectedAt?.getTime())
  })

  it('collectAll survives one broken source and reports it', async () => {
    if (!dbAvailable) return
    provider.feedXml = '<?xml version="1.0"?><rss><channel></channel></rss>'

    // collectAll swallows per-source failures by design (a third-party outage
    // must not kill the cron) — the failure surfaces as a missing result plus
    // an error log, not as a thrown exception.
    const { results, failures } = await service.collectAll()
    expect(results.find((r) => r.sourceType === 'DOU_RSS')).toBeUndefined()
    // The failure is RETURNED, not merely logged — this is what lets the
    // ADMIN-triggered endpoint answer 503 instead of an innocuous `200 []`.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.sourceType).toBe('DOU_RSS')
    expect(failures[0]?.message).toMatch(/0 usable postings/)
  })

  /**
   * Security-review round 5 — the PARTIAL-success path, which needs two enabled
   * sources to exist at all (the seed ships one, which is why this stayed
   * latent). One source succeeds, the other throws a realistic Drizzle failure;
   * the run must come back reportable rather than blowing up its own schema.
   */
  it('a run with one broken source is reportable, not a 400, and leaks no SQL', async () => {
    if (!dbAvailable) return

    const [secondSource] = await dbSvc.db
      .insert(jobSources)
      .values({ type: 'DOU_RSS', config: { category: 'PHP' } })
      .returning()

    // The stub fails for the second source's config and works for the first.
    provider.failForCategory = 'PHP'
    provider.failWith = new Error(
      'Failed query: insert into "job_postings" ("id", "source_type", "url", "title", ' +
        '"company_name", "description_md", "fingerprint") values (default, $1, $2, $3, $4, $5, $6) ' +
        'returning "id", "source_type", "url", "title", "company_name"\n' +
        'params: DOU_RSS,https://jobs.dou.ua/companies/epam-systems/vacancies/356562,' +
        `Senior Engineer,EPAM,${'long description '.repeat(60)},abc123`,
    )

    try {
      const run = await service.collectAll()

      expect(run.results).toHaveLength(1)
      expect(run.failures).toHaveLength(1)

      // THE regression: the controller `.parse()`s this on the way out. With a
      // raw message it threw, and the admin got "Validation failed" instead of
      // both the working source's numbers and the name of the broken one.
      expect(() => jobCollectionRunSchema.parse(run)).not.toThrow()

      const [failure] = run.failures
      expect(failure!.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS)
      expect(failure!.message).not.toContain('insert into')
      expect(failure!.message).not.toContain('job_postings')
      expect(failure!.message).not.toContain('params:')
      expect(failure!.message).not.toContain('$1')
    } finally {
      provider.failForCategory = null
      await dbSvc.db.delete(jobSources).where(eq(jobSources.id, secondSource!.id))
    }
  })

  it('tells an ADMIN/HR to pick a senior instead of complaining about a parameter', async () => {
    if (!dbAvailable) return
    await expect(service.listSuggestions(undefined, ADMIN)).rejects.toThrow(/Выберите синьора/)
    await expect(service.listSuggestions(undefined, HR_A)).rejects.toThrow(/Выберите синьора/)
    // A SENIOR never needs the parameter — their own queue is implied.
    await expect(service.listSuggestions(undefined, SENIOR_B)).resolves.toBeDefined()
  })

  // ── Untrusted content, end to end ──────────────────────────────────────────

  it('stores a hostile description as markdown with no HTML and no script', async () => {
    if (!dbAvailable) return
    provider.feedXml = douFeed([
      {
        title: 'Dev в Devart, Київ',
        path: '/companies/devart/vacancies/77/',
        description:
          '&lt;script&gt;alert(document.cookie)&lt;/script&gt;&lt;p&gt;Real &lt;strong&gt;text&lt;/strong&gt;&lt;/p&gt;',
      },
    ])
    await service.collectSource(source)

    const [row] = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.companyName, 'Devart'))

    expect(row!.descriptionMd).toContain('Real **text**')
    expect(row!.descriptionMd).not.toContain('alert')
    expect(row!.descriptionMd).not.toMatch(/(?<!\\)<[a-z!/]/i)
  })

  /** Security-review round 2, MED-2 — one hostile row must not sink the batch. */
  it('MED-2: a NUL byte in the feed does not abort the whole collection run', async () => {
    if (!dbAvailable) return
    const nul = '\u0000'
    provider.feedXml = douFeed([
      {
        title: `Dev${nul} в Ciklum, Київ`,
        path: '/companies/ciklum/vacancies/501/',
        description: `Before${nul}after`,
      },
      { title: 'Second в Devart, Київ', path: '/companies/devart/vacancies/502/' },
    ])

    const result = await service.collectSource(source)

    // BOTH rows land: the NUL is stripped at normalize time rather than being
    // handed to Postgres (which rejects a NUL byte in a text column, 22021).
    expect(result.created).toBe(2)
    const rows = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceId, SOURCE_ID))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.title.includes(nul) && !r.descriptionMd.includes(nul))).toBe(true)
  })

  /** Security-review round 2, MED-3 — the URL slug takes part in matching. */
  it('MED-3: an exclusion matches the company in the URL even when the title says otherwise', async () => {
    if (!dbAvailable) return
    // Title claims an innocuous company; the board-assigned URL slug says EPAM.
    provider.feedXml = douFeed([
      {
        title: 'Senior Engineer в Ромашка Digital, Київ',
        path: '/companies/epam-systems/vacancies/777/',
      },
    ])
    await service.collectSource(source)

    // SENIOR_A's project client is "EPAM Systems Inc." — the derived exclusion
    // must catch this posting through the URL, not the (spoofed) title.
    const queue = await service.listSuggestions(SENIOR_A.id, ADMIN)
    expect(queue.items.map((i) => i.posting.companyName)).not.toContain('Ромашка Digital')

    // …and a senior without that client still sees it.
    const other = await service.listSuggestions(SENIOR_B.id, ADMIN)
    expect(other.items.map((i) => i.posting.companyName)).toContain('Ромашка Digital')
  })

  it('drops a feed entry whose link is not https but keeps the rest of the batch', async () => {
    if (!dbAvailable) return
    provider.feedXml =
      `<?xml version="1.0"?><rss><channel>` +
      `<item><title>Evil в Hacker, Kyiv</title>` +
      `<link>javascript:alert(1)</link><guid>javascript:alert(1)</guid>` +
      `<description>x</description></item>` +
      `<item><title>Good в Devart, Київ</title>` +
      `<link>https://jobs.dou.ua/companies/devart/vacancies/900/</link>` +
      `<guid>https://jobs.dou.ua/companies/devart/vacancies/900/?1</guid>` +
      `<description>ok</description></item>` +
      `</channel></rss>`

    const result = await service.collectSource(source)
    expect(result.created).toBe(1)

    const rows = await dbSvc.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceId, SOURCE_ID))
    expect(rows.map((r) => r.companyName)).toEqual(['Devart'])
    expect(rows.every((r) => r.url.startsWith('https://'))).toBe(true)
  })

  it('a feed where EVERY entry is unusable is treated as a broken source', async () => {
    if (!dbAvailable) return
    provider.feedXml =
      `<?xml version="1.0"?><rss><channel><item>` +
      `<title>Evil в Hacker, Kyiv</title>` +
      `<link>javascript:alert(1)</link><guid>javascript:alert(1)</guid>` +
      `<description>x</description></item></channel></rss>`

    await expect(service.collectSource(source)).rejects.toThrow(/0 usable postings/)
    expect(
      await dbSvc.db.select().from(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID)),
    ).toHaveLength(0)
  })
})
