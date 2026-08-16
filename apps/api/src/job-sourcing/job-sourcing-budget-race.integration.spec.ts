import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { jobPostings, jobSources, jobSuggestions } from '../database/schema'
import * as schema from '../database/schema'
import { DouRssProvider } from './dou.provider'
import type { NormalizedPosting } from './job-source.provider'
import { JobSourceBudgetExhaustedError } from './source-budget.error'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Backlog #53 — the window-reset boundary race on `chargeBudget`'s
 * compare-and-set.
 *
 * THE BUG THIS REPRODUCES
 * ------------------------
 * `chargeBudget` reads a `source` snapshot, decides "not exhausted" (using
 * `resolveBudget`, which correctly recomputes the window from `now` — a
 * rollover is NOT the bug), then writes the new counter guarded by a
 * compare-and-set on `source.budgetUsed` AS READ. Two callers that read the
 * SAME stale, pre-rollover row both correctly conclude "I have quota" — but
 * only the FIRST write can match that stale predicate. The second used to be
 * refused outright with "бюджет исчерпан", even though the source is nowhere
 * near its limit in the fresh window. This spec reproduces that deterministically:
 * two calls sharing one stale `source` snapshot, no real concurrency/timing
 * needed — `collectSource` #1 changes the ROW, `collectSource` #2 still holds
 * the pre-change snapshot, exactly like two processes racing at the reset
 * instant would.
 *
 * WHAT MUST STAY TRUE (the conservative direction, backlog #48)
 * ---------------------------------------------------------------
 * A genuinely exhausted budget (the row really is at its limit) must still
 * refuse. The fix is a bounded RETRY against the row's fresh state, not a
 * removal of the guard — proven below by giving a source a real limit of 1
 * and confirming the second call throws when there is truly nothing left.
 *
 * DB-SKIP-GUARD: when DATABASE_URL is unreachable (CI unit job) every test
 * returns early and the suite stays green — same convention as the sibling
 * job-sourcing.integration.spec.ts.
 *
 * NO HARDCODED DATES (lessons — a fixed calendar date compared against a
 * live `now()` is exactly the class of test that starts failing on its own
 * at midnight, see BACKLOG-followups.md #57). `windowStartedAt` below is
 * always computed relative to the REAL current time
 * (`Date.now() - 24h`), so "yesterday" is always yesterday, whenever this
 * runs, and `chargeBudget`'s own unmocked `new Date()` is always "today"
 * relative to it — no fake timers needed either.
 *
 * MUTATION VERIFICATION (manual — `pnpm mutation:changed` cannot reach this
 * file; see below)
 * -----------------------------------------------------------------------
 * `chargeBudget`'s only test coverage is through this file and its sibling
 * `job-sourcing.integration.spec.ts` — both `*.integration.spec.ts`, which
 * `vitest.config.mts` structurally excludes from test discovery whenever
 * `isIntegrationRun(process.argv)` is false (see
 * `src/test/integration-run-mode.ts`). Stryker's vitest-runner drives Vitest
 * programmatically with no `integration.spec` substring anywhere in its argv,
 * so `pnpm mutation:changed` reports "Vitest failed to find test files
 * related to mutated files" for every line in `chargeBudget` — an
 * infrastructure gap (`scripts/devops/**`), not something fixable from this
 * file's zone. Verified manually instead, against the REAL `crm_qa` Postgres
 * (stronger than a mocked CAS, since it exercises actual SQL semantics):
 *
 *   Mutation A — `CHARGE_BUDGET_MAX_ATTEMPTS` 3 → 1 (removes the retry,
 *   reproducing the pre-fix single-attempt CAS). Result: the FIRST test
 *   below ("a second caller holding a STALE... still succeeds") failed with
 *   the exact false `JobSourceBudgetExhaustedError` the fix removes.
 *
 *   Mutation B — dropped the `budgetWindowStartedAt` arm from the CAS
 *   predicate (count-only compare-and-set, retry loop left intact). Result:
 *   the SECOND test below ("CONTROL: genuine exhaustion still refuses")
 *   failed — the count-only CAS let a stale caller coincidentally match a
 *   row that had already been fully re-spent in the FRESH window (old-window
 *   "used == limit" and new-window "used == limit" are the same number by
 *   construction), silently overwriting a genuinely exhausted budget. This
 *   is what motivated pinning the window start in the predicate, not just
 *   the count (see `chargeBudget`'s own doc block).
 *
 * Both mutations were applied, run, observed red, and reverted (`git diff`
 * against the committed `job-sourcing.service.ts` is empty after revert —
 * verified before this file was committed).
 */

const ADMIN_UUID_NS = 'd5e6f7a8-1b2c-4d3e-ee00-'
const SOURCE_A_ID = `${ADMIN_UUID_NS}000000000001` // ample remaining quota post-rollover
const SOURCE_B_ID = `${ADMIN_UUID_NS}000000000002` // genuinely at its limit

/** A provider whose `collect()` is a canned in-memory list — no RSS parsing, no network. */
class CannedProvider extends DouRssProvider {
  postings: NormalizedPosting[] = []
  private counter = 0

  override collect(): Promise<NormalizedPosting[]> {
    // Each call returns a FRESH fingerprint so two successive collectSource()
    // calls in one test both count as `created`, not `duplicates` — the
    // budget behaviour is what's under test, not the dedupe path (that is
    // job-sourcing.integration.spec.ts's job).
    this.counter += 1
    return Promise.resolve(
      this.postings.map((p, i) => ({
        ...p,
        externalId: `${p.externalId}-${this.counter}-${i}`,
        url: `${p.url}?run=${this.counter}`,
        fingerprint: `${p.fingerprint}-${this.counter}-${i}`,
      })),
    )
  }

  protected override fetchFeed(): Promise<string> {
    return Promise.resolve('')
  }
}

const SOURCE_IDS = [SOURCE_A_ID, SOURCE_B_ID] as const

/**
 * Deletes only what THIS spec's `collectSource` calls could have created —
 * suggestions scoped through OUR postings, postings scoped through OUR
 * sources. `crm_qa` is a SHARED database: a blanket `delete(jobSuggestions)`
 * with no filter would also erase rows a concurrently-running spec (this
 * file's own two tests included, or a different worktree's suite) just
 * created. Scoping the delete is what makes that safe.
 */
async function cleanupCreatedRows(dbSvc: DatabaseService): Promise<void> {
  const ourPostings = await dbSvc.db
    .select({ id: jobPostings.id })
    .from(jobPostings)
    .where(inArray(jobPostings.sourceId, [...SOURCE_IDS]))
  const postingIds = ourPostings.map((p) => p.id)
  if (postingIds.length > 0) {
    await dbSvc.db.delete(jobSuggestions).where(inArray(jobSuggestions.postingId, postingIds))
  }
  await dbSvc.db.delete(jobPostings).where(inArray(jobPostings.sourceId, [...SOURCE_IDS]))
}

function posting(id: string): NormalizedPosting {
  return {
    sourceType: 'DOU_RSS',
    externalId: id,
    url: `https://jobs.dou.ua/companies/x/vacancies/${id}/`,
    title: 'Backend Engineer',
    companyName: 'Raceco',
    companyNameNormalized: 'raceco',
    location: null,
    descriptionMd: 'desc',
    publishedAt: null,
    fingerprint: `fp-${id}`,
  }
}

describe('Job sourcing — budget window-reset boundary race (#53)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let service: JobSourcingService
  let provider: CannedProvider
  let dbAvailable = true
  /** Always a full calendar day behind whenever this test actually runs. */
  let yesterday: Date

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[job-sourcing budget-race] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    provider = new CannedProvider()
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), provider)
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    provider.postings = [posting('race-1')]
    // Yesterday, in a DAY window — `chargeBudget`'s own `new Date()` (real,
    // unmocked) is always "today" relative to this, so every read of this row
    // sees a window that has already rolled over.
    yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // Source A: limit 5, "used" 5 in the OLD window — i.e. exhausted under the
    // stale accounting, but the fresh (rolled-over) window has all 5 units
    // available. This is the false-refusal shape.
    await dbSvc.db
      .insert(jobSources)
      .values({
        id: SOURCE_A_ID,
        type: 'DOU_RSS',
        config: { category: 'JavaScript', race: 'a' },
        budgetLimit: 5,
        budgetWindow: 'DAY',
        budgetUsed: 5,
        budgetWindowStartedAt: yesterday,
      })
      .onConflictDoUpdate({
        target: jobSources.id,
        set: {
          budgetLimit: 5,
          budgetWindow: 'DAY',
          budgetUsed: 5,
          budgetWindowStartedAt: yesterday,
        },
      })

    // Source B: limit 1, same stale accounting — after ONE successful spend in
    // the fresh window, there is truly nothing left for a second caller.
    await dbSvc.db
      .insert(jobSources)
      .values({
        id: SOURCE_B_ID,
        type: 'DOU_RSS',
        config: { category: 'JavaScript', race: 'b' },
        budgetLimit: 1,
        budgetWindow: 'DAY',
        budgetUsed: 1,
        budgetWindowStartedAt: yesterday,
      })
      .onConflictDoUpdate({
        target: jobSources.id,
        set: {
          budgetLimit: 1,
          budgetWindow: 'DAY',
          budgetUsed: 1,
          budgetWindowStartedAt: yesterday,
        },
      })
  })

  afterEach(async () => {
    if (!dbAvailable) return
    await cleanupCreatedRows(dbSvc)
  })

  afterAll(async () => {
    if (!dbAvailable) return
    await cleanupCreatedRows(dbSvc)
    await dbSvc.db.delete(jobSources).where(inArray(jobSources.id, [...SOURCE_IDS]))
    await pool.end()
  }, 30_000)

  it('a second caller holding a STALE pre-rollover snapshot still succeeds when the fresh window has room', async () => {
    if (!dbAvailable) return

    const staleSnapshot = {
      id: SOURCE_A_ID,
      type: 'DOU_RSS' as const,
      config: { category: 'JavaScript', race: 'a' },
      budgetLimit: 5,
      budgetWindow: 'DAY' as const,
      budgetUsed: 5, // the OLD window's spent counter — both callers read this
      budgetWindowStartedAt: yesterday,
    }

    // Caller 1 — writes the row from budgetUsed=5(stale) to budgetUsed=1(fresh).
    await expect(service.collectSource({ ...staleSnapshot })).resolves.toMatchObject({ created: 1 })

    // Caller 2 — SAME stale snapshot (budgetUsed=5). Under the pre-fix code
    // this throws JobSourceBudgetExhaustedError immediately: its CAS predicate
    // (budgetUsed=5) no longer matches the row (now budgetUsed=1), and the old
    // code treated a lost CAS as "exhausted" unconditionally.
    await expect(service.collectSource({ ...staleSnapshot })).resolves.toMatchObject({ created: 1 })

    const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_A_ID))
    // Both callers actually spent — the fresh window started at 0 and now
    // carries 2 units used, not 1 (which a silently-dropped second charge
    // would produce) and not refused (which the bug produced).
    expect(row!.budgetUsed).toBe(2)
  })

  it('CONTROL: genuine exhaustion still refuses — the fix is a retry, not a bypass', async () => {
    if (!dbAvailable) return

    const staleSnapshot = {
      id: SOURCE_B_ID,
      type: 'DOU_RSS' as const,
      config: { category: 'JavaScript', race: 'b' },
      budgetLimit: 1,
      budgetWindow: 'DAY' as const,
      budgetUsed: 1,
      budgetWindowStartedAt: yesterday,
    }

    // Caller 1 spends the ONE unit the fresh window has.
    await expect(service.collectSource({ ...staleSnapshot })).resolves.toMatchObject({ created: 1 })

    // Caller 2, same stale snapshot — this time there is genuinely nothing
    // left after caller 1's spend. Must still refuse.
    await expect(service.collectSource({ ...staleSnapshot })).rejects.toThrow(
      JobSourceBudgetExhaustedError,
    )

    const [row] = await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_B_ID))
    expect(row!.budgetUsed).toBe(1)
  })
})
