import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  jobPostings,
  jobSources,
  jobSuggestions,
  seniorResumes,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { DouRssProvider } from './dou.provider'
import type { NormalizedPosting } from './job-source.provider'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Stack matching + source budgets — real-database integration spec
 * (task-vacancy-matching AC1 / AC3 / AC5 / AC6 / AC7).
 *
 * Separate file from job-sourcing.integration.spec.ts on purpose: that one owns
 * slice 1's dedupe/exclusion/RBAC guarantees, this one owns the ranking and the
 * budget. Splitting them keeps either suite runnable on its own — a whole-suite
 * run against a real Postgres is slow enough that "just run the relevant file"
 * is worth preserving.
 *
 * WHAT ONLY A REAL DATABASE CAN PROVE HERE
 * ----------------------------------------
 *   AC1 — the senior's resume skills reach the ranking through a real jsonb
 *         column, and an irrelevant vacancy really does sink below a relevant
 *         one in the ORDER the API returns.
 *   AC3 — the below-threshold ones are still THERE, counted, one flag away —
 *         not deleted by the query that hides them.
 *   AC5 — an exhausted budget stops the collector BEFORE it fetches. The proof
 *         is a provider that COUNTS its calls: 0 calls is the assertion, which
 *         is the difference between "refused" and "fetched then discarded".
 *   AC6 — a manual run spends the same counter as a scheduled one, so repeated
 *         button presses cannot outrun the monthly cap.
 *   AC7 — the remainder the UI renders is computed from the row, including a
 *         window that has already rolled over.
 *
 * The feed is stubbed; everything below it is the real code path.
 *
 * DB-SKIP-GUARD: with DATABASE_URL unreachable every test returns early and the
 * suite stays green (the CI unit job has no Postgres).
 */

// Seed namespace: c1d2e3f4-5a6b-4c7d-**  (distinct from the slice-1 spec's)
const ADMIN: SessionUser = {
  id: 'c1d2e3f4-5a6b-4c7d-bb00-000000000001',
  email: 'jm-admin@test.spec',
  displayName: 'JM Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
/** Java/Spring senior — resume skills drive the ranking. */
const SENIOR_JAVA: SessionUser = {
  id: 'c1d2e3f4-5a6b-4c7d-bb00-000000000002',
  email: 'jm-senior-java@test.spec',
  displayName: 'JM Senior Java',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
/** Deliberately has NO resume — the "not everyone filled it in" case. */
const SENIOR_NO_RESUME: SessionUser = {
  id: 'c1d2e3f4-5a6b-4c7d-bb00-000000000003',
  email: 'jm-senior-bare@test.spec',
  displayName: 'JM Senior Bare',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const TEAM_ID = 'c1d2e3f4-5a6b-4c7d-bb00-0000000000f1'
const SOURCE_ID = 'c1d2e3f4-5a6b-4c7d-bb00-0000000000f2'
const ALL_USER_IDS = [ADMIN.id, SENIOR_JAVA.id, SENIOR_NO_RESUME.id]

/** Posting factory — `title`/`descriptionMd` are what the matcher reads. */
function posting(over: Partial<NormalizedPosting> & { externalId: string }): NormalizedPosting {
  return {
    sourceType: 'DOU_RSS',
    url: `https://jobs.dou.ua/companies/acme/vacancies/${over.externalId}/`,
    title: 'Developer',
    companyName: 'Acme',
    companyNameNormalized: 'acme',
    location: 'віддалено',
    descriptionMd: '',
    publishedAt: new Date('2026-08-10T10:00:00.000Z'),
    fingerprint: `fp-jm-${over.externalId}`,
    ...over,
  }
}

/**
 * Provider that COUNTS its calls.
 *
 * The counter is the whole instrument for AC5: "the collector refused" and "the
 * collector fetched and then threw the data away" produce an identical result
 * object, and only `collectCalls` tells them apart.
 */
class CountingProvider extends DouRssProvider {
  collectCalls = 0
  batch: NormalizedPosting[] = []

  override async collect(): Promise<NormalizedPosting[]> {
    this.collectCalls += 1
    return this.batch
  }
}

describe('Job matching + source budgets — real DB integration', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let service: JobSourcingService
  let provider: CountingProvider
  let dbAvailable = true
  /**
   * Sources this spec switched off so `collectAll` sees ONLY its own.
   *
   * `collectAll` iterates every ENABLED source by design, so any leftover row
   * in the shared QA database joins the run and spends the call counter these
   * tests assert on — which is how the first version of this file failed: a
   * stray `DOU_RSS` row made "the cron collected 0 sources" read as 1. Rather
   * than assume a pristine database (a test that only passes on a clean DB is a
   * test that will fail on someone else's machine), the spec makes its own world
   * deterministic and puts it back afterwards. Safe because integration runs
   * disable file parallelism — see vitest.config.mts.
   */
  let disabledSourceIds: string[] = []

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[job-matching integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    provider = new CountingProvider()
    // No ConfigService — the service falls back to the same default the env
    // schema uses (0.2), which is what these expectations are written against.
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), provider)

    await db
      .insert(users)
      .values(
        [ADMIN, SENIOR_JAVA, SENIOR_NO_RESUME].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-jm-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values({ id: TEAM_ID, name: 'JM Team', seniorId: SENIOR_JAVA.id })
      .onConflictDoNothing()

    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_ID, userId: SENIOR_JAVA.id },
        { teamId: TEAM_ID, userId: SENIOR_NO_RESUME.id },
      ])
      .onConflictDoNothing()

    // The stack under test. Spellings differ from the vacancies on purpose:
    // the resume says `PostgreSQL`, a posting says `Postgres`.
    await db
      .insert(seniorResumes)
      .values({
        userId: SENIOR_JAVA.id,
        content: {
          summary: '',
          skills: ['Java', 'Spring Boot', 'PostgreSQL', 'Docker'],
          experience: [],
          education: [],
          languages: [],
          links: [],
        },
      })
      .onConflictDoNothing()

    // Quieten every foreign source for the duration of this file.
    const foreign = await db
      .select({ id: jobSources.id })
      .from(jobSources)
      .where(eq(jobSources.enabled, true))
    disabledSourceIds = foreign.map((r) => r.id).filter((id) => id !== SOURCE_ID)
    if (disabledSourceIds.length > 0) {
      await db
        .update(jobSources)
        .set({ enabled: false })
        .where(inArray(jobSources.id, disabledSourceIds))
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    const db = dbSvc.db
    if (disabledSourceIds.length > 0) {
      await db
        .update(jobSources)
        .set({ enabled: true })
        .where(inArray(jobSources.id, disabledSourceIds))
    }
    await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, ALL_USER_IDS))
    await db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))
    await db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
    await db.delete(seniorResumes).where(inArray(seniorResumes.userId, ALL_USER_IDS))
    await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
    await db.delete(teams).where(eq(teams.id, TEAM_ID))
    await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
    await pool.end()
  })

  beforeEach(async () => {
    if (!dbAvailable) return
    const db = dbSvc.db
    await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, ALL_USER_IDS))
    await db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))
    await db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
    provider.collectCalls = 0
    provider.batch = []
  })

  /** Insert a source row with an explicit budget/trigger configuration. */
  async function seedSource(over: Partial<typeof jobSources.$inferInsert> = {}) {
    await dbSvc.db
      .insert(jobSources)
      .values({
        id: SOURCE_ID,
        type: 'DOU_RSS',
        // Unique config so the (type, config) unique index never collides with
        // a real DOU row that may already exist in the QA database.
        config: { category: 'Java' },
        enabled: true,
        ...over,
      })
      .onConflictDoNothing()
    return (await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID)))[0]!
  }

  // ---------------------------------------------------------------------------
  // AC1 / AC3 — ranking
  // ---------------------------------------------------------------------------

  describe('ranking by stack match (AC1, AC3)', () => {
    beforeEach(async () => {
      if (!dbAvailable) return
      await seedSource()
      provider.batch = [
        // Irrelevant to a Java senior — and PUBLISHED LATEST, so under the old
        // freshness-only ordering it would sit at the top of the queue.
        posting({
          externalId: 'php-1',
          title: 'Middle PHP Developer',
          descriptionMd: 'Laravel, MySQL, jQuery. The rest of the team is remote.',
          publishedAt: new Date('2026-08-11T10:00:00.000Z'),
        }),
        // Relevant — and OLDER. It must still come first.
        posting({
          externalId: 'java-1',
          title: 'Senior Java Developer',
          descriptionMd: 'Spring Boot, Postgres, Docker, Kubernetes.',
          publishedAt: new Date('2026-08-09T10:00:00.000Z'),
        }),
      ]
      await service.collectSource(await seedSource())
    })

    it('puts the matching vacancy above a fresher irrelevant one', async () => {
      if (!dbAvailable) return
      const queue = await service.listSuggestions(SENIOR_JAVA.id, ADMIN)

      expect(queue.items[0]?.posting.title).toBe('Senior Java Developer')
      expect(queue.items[0]?.matchScore).toBe(1)
      // …and the ordering really is the ranking, not the publish date: the PHP
      // posting is NEWER, so freshness alone would have inverted this.
      expect(queue.items[0]?.posting.publishedAt).toBe('2026-08-09T10:00:00.000Z')
    })

    it('names the keywords it matched on, folding spellings', async () => {
      if (!dbAvailable) return
      const queue = await service.listSuggestions(SENIOR_JAVA.id, ADMIN)

      // Resume says `PostgreSQL`, the vacancy says `Postgres`.
      expect(queue.items[0]?.matchedKeywords).toContain('postgresql')
      expect(queue.items[0]?.matchedKeywords).toContain('spring boot')
    })

    it('collapses the irrelevant one but keeps it counted and reachable (AC3)', async () => {
      if (!dbAvailable) return
      const queue = await service.listSuggestions(SENIOR_JAVA.id, ADMIN)

      expect(queue.lowMatchCount).toBe(1)
      expect(queue.lowMatch[0]?.posting.title).toBe('Middle PHP Developer')
      // Counted in the total: hidden is not deleted.
      expect(queue.total).toBe(2)
      expect(queue.items.map((i) => i.posting.title)).not.toContain('Middle PHP Developer')
    })

    it('echoes the threshold and the stack so the UI can explain the split (AC4)', async () => {
      if (!dbAvailable) return
      const queue = await service.listSuggestions(SENIOR_JAVA.id, ADMIN)

      expect(queue.threshold).toBe(0.2)
      expect(queue.stackKeywords).toEqual(['java', 'spring boot', 'postgresql', 'docker'])
    })

    /**
     * THE test for the sort itself — and the reason it exists.
     *
     * The obvious "relevant beats irrelevant" test above does NOT prove the
     * ordering: the irrelevant posting scores 0, so the THRESHOLD already
     * removes it from `items` and the sort has nothing left to do. Deleting the
     * `sort` line left that test green (verified by mutation), i.e. it was an
     * instrument that could not show the opposite.
     *
     * So both postings here sit ABOVE the threshold with DIFFERENT scores, and
     * the weaker one is the FRESHER one. Now only the sort can produce this
     * order, and removing it flips the assertion.
     */
    it('orders two above-threshold matches by score, not by date', async () => {
      if (!dbAvailable) return
      // Fresh state: this test needs its own two postings.
      await dbSvc.db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, ALL_USER_IDS))
      await dbSvc.db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))

      provider.batch = [
        // 1 of 4 keywords (0.25 — above the 0.2 threshold), NEWEST.
        posting({
          externalId: 'weak-fresh',
          title: 'Platform Engineer',
          descriptionMd: 'Mostly Docker and Terraform work.',
          publishedAt: new Date('2026-08-11T10:00:00.000Z'),
        }),
        // 3 of 4 keywords (0.75), OLDER.
        posting({
          externalId: 'strong-stale',
          title: 'Backend Engineer',
          descriptionMd: 'Java, Spring Boot and Postgres.',
          publishedAt: new Date('2026-08-08T10:00:00.000Z'),
        }),
      ]
      await service.collectSource(await seedSource())

      const queue = await service.listSuggestions(SENIOR_JAVA.id, ADMIN)

      expect(queue.items.map((i) => i.posting.title)).toEqual([
        'Backend Engineer',
        'Platform Engineer',
      ])
      expect(queue.items[0]?.matchScore).toBeGreaterThan(queue.items[1]?.matchScore ?? 1)
      // Both survived the threshold — so the order above is the SORT's doing,
      // not the filter's.
      expect(queue.lowMatchCount).toBe(0)
    })

    it('a senior with no resume gets freshness order and NO hidden tail', async () => {
      if (!dbAvailable) return
      // The measured reality when this shipped: 0 of 4 active seniors had a
      // resume. Scoring everything 0 would have collapsed their entire queue.
      const queue = await service.listSuggestions(SENIOR_NO_RESUME.id, ADMIN)

      expect(queue.stackKeywords).toEqual([])
      expect(queue.lowMatchCount).toBe(0)
      expect(queue.items).toHaveLength(2)
      expect(queue.items.every((i) => i.matchScore === null)).toBe(true)
      // Newest first — the pre-existing behaviour, untouched.
      expect(queue.items[0]?.posting.title).toBe('Middle PHP Developer')
    })
  })

  // ---------------------------------------------------------------------------
  // AC5 / AC6 — budgets
  // ---------------------------------------------------------------------------

  describe('source budget stops collection (AC5)', () => {
    it('refuses to FETCH when the budget is spent', async () => {
      if (!dbAvailable) return
      const source = await seedSource({
        budgetLimit: 5,
        budgetWindow: 'MONTH',
        budgetUsed: 5,
        budgetWindowStartedAt: new Date(),
      })
      provider.batch = [posting({ externalId: 'x-1' })]

      await expect(service.collectSource(source)).rejects.toThrow(/бюджет запросов исчерпан/i)
      // THE assertion: the provider was never asked. A collector that fetched
      // and then discarded would pass every other check in this test.
      expect(provider.collectCalls).toBe(0)
    })

    it('reports the stop as a budget stop, not as a broken feed', async () => {
      if (!dbAvailable) return
      await seedSource({
        budgetLimit: 5,
        budgetWindow: 'MONTH',
        budgetUsed: 5,
        budgetWindowStartedAt: new Date(),
      })

      const run = await service.collectAll('SCHEDULED')
      const failure = run.failures.find((f) => f.sourceType === 'DOU_RSS')

      expect(failure?.budgetExhausted).toBe(true)
      expect(failure?.message).toMatch(/исчерпан/i)
      expect(provider.collectCalls).toBe(0)
    })

    it('collects normally while the budget lasts, and charges one unit', async () => {
      if (!dbAvailable) return
      const source = await seedSource({
        budgetLimit: 5,
        budgetWindow: 'MONTH',
        budgetUsed: 0,
        budgetWindowStartedAt: new Date(),
      })
      provider.batch = [posting({ externalId: 'ok-1', title: 'Senior Java Developer' })]

      await service.collectSource(source)

      expect(provider.collectCalls).toBe(1)
      const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
      expect(row?.budgetUsed).toBe(1)
    })

    it('an unlimited source is never blocked', async () => {
      if (!dbAvailable) return
      const source = await seedSource({ budgetLimit: null, budgetWindow: null })
      provider.batch = [posting({ externalId: 'free-1' })]

      await service.collectSource(source)
      expect(provider.collectCalls).toBe(1)
    })
  })

  describe('manual runs spend the same budget (AC6)', () => {
    it('repeated manual triggers stop at the cap instead of overrunning it', async () => {
      if (!dbAvailable) return
      await seedSource({
        budgetLimit: 3,
        budgetWindow: 'MONTH',
        budgetUsed: 0,
        budgetWindowStartedAt: new Date(),
        triggerMode: 'BOTH',
      })
      provider.batch = [posting({ externalId: 'm-1' })]

      // Twenty presses of the button against a budget of three.
      const runs = []
      for (let i = 0; i < 20; i += 1) {
        runs.push(await service.collectAll('MANUAL'))
      }

      expect(provider.collectCalls).toBe(3)
      const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID))
      expect(row?.budgetUsed).toBe(3)
      // …and the 17 refusals were reported, not silently swallowed.
      const refusals = runs.filter((r) => r.failures.some((f) => f.budgetExhausted))
      expect(refusals).toHaveLength(17)
    })

    it('a manual spend leaves the scheduled run nothing left to spend', async () => {
      if (!dbAvailable) return
      await seedSource({
        budgetLimit: 1,
        budgetWindow: 'MONTH',
        budgetUsed: 0,
        budgetWindowStartedAt: new Date(),
        triggerMode: 'BOTH',
      })
      provider.batch = [posting({ externalId: 's-1' })]

      await service.collectAll('MANUAL')
      expect(provider.collectCalls).toBe(1)

      const scheduled = await service.collectAll('SCHEDULED')
      expect(provider.collectCalls).toBe(1)
      expect(scheduled.failures[0]?.budgetExhausted).toBe(true)
    })
  })

  describe('trigger mode decides who may collect (§5)', () => {
    it('the cron does not touch a MANUAL-only source', async () => {
      if (!dbAvailable) return
      await seedSource({ triggerMode: 'MANUAL', budgetLimit: 200, budgetWindow: 'MONTH' })
      provider.batch = [posting({ externalId: 'manual-only' })]

      const run = await service.collectAll('SCHEDULED')

      expect(provider.collectCalls).toBe(0)
      // Not a failure either — it was simply not this trigger's source.
      expect(run.failures).toHaveLength(0)
      expect(run.results).toHaveLength(0)
    })

    it('the same source collects when a human asks', async () => {
      if (!dbAvailable) return
      await seedSource({ triggerMode: 'MANUAL', budgetLimit: 200, budgetWindow: 'MONTH' })
      provider.batch = [posting({ externalId: 'manual-only-2' })]

      await service.collectAll('MANUAL')
      expect(provider.collectCalls).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // AC7 — the remainder the UI shows
  // ---------------------------------------------------------------------------

  describe('remaining budget as the UI reads it (AC7)', () => {
    it('reports the remainder and the reset instant', async () => {
      if (!dbAvailable) return
      await seedSource({
        budgetLimit: 200,
        budgetWindow: 'MONTH',
        budgetUsed: 153,
        budgetWindowStartedAt: new Date('2026-08-01T00:00:00.000Z'),
      })

      const sources = await service.listSources(new Date('2026-08-12T09:00:00.000Z'))
      const mine = sources.find((s) => s.id === SOURCE_ID)

      expect(mine?.budget.remaining).toBe(47)
      expect(mine?.budget.limit).toBe(200)
      expect(mine?.budget.resetsAt).toBe('2026-09-01T00:00:00.000Z')
    })

    it('shows a full allowance once the window has rolled over', async () => {
      if (!dbAvailable) return
      // Counter belongs to JULY; "now" is August. Reading the row raw would
      // report a spent budget for a month that has already reset.
      await seedSource({
        budgetLimit: 200,
        budgetWindow: 'MONTH',
        budgetUsed: 200,
        budgetWindowStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      })

      const sources = await service.listSources(new Date('2026-08-12T09:00:00.000Z'))
      expect(sources.find((s) => s.id === SOURCE_ID)?.budget.remaining).toBe(200)
    })

    it('reports an unlimited source as unlimited rather than as zero', async () => {
      if (!dbAvailable) return
      await seedSource({ budgetLimit: null, budgetWindow: null })

      const mine = (await service.listSources()).find((s) => s.id === SOURCE_ID)
      expect(mine?.budget.limit).toBeNull()
      expect(mine?.budget.remaining).toBeNull()
    })
  })
})
