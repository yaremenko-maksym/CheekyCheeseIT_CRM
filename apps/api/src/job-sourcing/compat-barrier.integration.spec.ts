import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { hasDatabaseUrl } from '../test/require-real-db'
import { DouRssProvider } from './dou.provider'
import { JobSourcingService, POSTING_RETENTION_DAYS } from './job-sourcing.service'
import { JobSourceBudgetExhaustedError } from './source-budget.error'
import { BRIDGE_FLAG_VALUES, bridgeConfig } from './bridge-flag.test-helper'
import { JobRunLedger } from './ownership/job-run-ledger'
import { JobSourceRunBusyError } from './ownership/legacy-run-claim'
import { SpecCatalog, specRegistry } from '../test/ledger-fixtures'
import * as recordStore from './store/source-record.store'

/** The staged bridge table, pushed into the scratch DB so the flag-on path can enqueue/drain. */
const BRIDGE_DDL = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-10-31_job_bridge_deliveries.sql',
)

/**
 * Compatibility barrier (r5 Task 4.6a) — the DB-touching half. Pins, on real SQL and the REAL
 * collector over the golden DOU fixture, what the legacy path does that no other spec joins up:
 *
 *   1. decided postings (APPLIED / REJECTED) survive a purge AND a re-collection, while undecided
 *      ones are purged and come back as fresh rows with fresh NEW suggestions;
 *   2. the purge cutoff is exact (`collected_at < now - 90 days`), with a controlled `now`;
 *   3. the one-unit budget arithmetic against real counters over the golden feed, including a
 *      zero-postings run that keeps its spent unit and leaves `last_collected_at` untouched;
 *   4. the legacy resume-based ranking of the GOLDEN postings (order, scores, threshold split).
 *
 * The fixture feed is the golden one with every vacancy id moved from 3xxxxx to 93xxxx, so these
 * rows have fingerprints no other spec owns (dou-golden.integration.spec.ts cleans up by golden
 * fingerprint; sharing them would race when files run in parallel).
 *
 * QUEUE FLAG (S6a): the whole suite runs for `JOB_QUEUE_BRIDGE_ENABLED` off AND on. Until S6c/S6d
 * the flag-on path is the same code; the parity test at the end compares both variants' stored rows
 * by fingerprint and content (never by id). The flag-on `it.todo` at the end stays for S6d.
 *
 * Scratch DB only (inline DATABASE_URL, never crm_db). Skipped when DATABASE_URL is unset.
 */
// Seed namespace: c0b4a246-7a6e-4f10-**
const id = (kind: string, n: number) => `c0b4a246-7a6e-4f10-${kind}-${String(n).padStart(12, '0')}`

function seniorUser(n: number, label: string): SessionUser {
  return {
    id: id('aa00', n),
    email: `compat-barrier-${label}@test.spec`,
    displayName: `Compat Barrier ${label}`,
    avatarUrl: null,
    role: 'SENIOR',
    seniorSharePercent: 26,
    legalFullName: null,
  }
}

/** Decides on postings; has a resume stack. */
const S_DECIDER = seniorUser(1, 'decider')
/** Never decides anything, no resume. */
const S_BYSTANDER = seniorUser(2, 'bystander')
const SENIORS = [S_DECIDER, S_BYSTANDER]
const SENIOR_IDS = SENIORS.map((s) => s.id)

const TEAM_ID = id('bb00', 1)
const SOURCE_ID = id('dd00', 1)

/** Controlled clock for every `purgeStalePostings` call. */
const NOW = new Date('2026-03-15T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z')

const FEED_XML = readFileSync(join(__dirname, '__fixtures__', 'dou-feed.golden.xml'), 'utf8')
  // Fresh identities: every vacancy id gets a leading 9, so no fingerprint is shared with the
  // golden spec (356562 -> 9356562, 360001 -> 9360001).
  .replaceAll('/vacancies/3', '/vacancies/93')

/** Real provider with ONLY the network call replaced; counts how often the network is reached. */
class FixtureDouProvider extends DouRssProvider {
  feedXml = FEED_XML
  fetchCalls = 0
  protected override fetchFeed(): Promise<string> {
    this.fetchCalls += 1
    return Promise.resolve(this.feedXml)
  }
}

/**
 * Flag-off snapshot, read by the flag-on parity assertion. ORDER DEPENDENCY: describe.each runs
 * false before true in file order; if the flag-off recording did not run (shuffle, `-t` filter) the
 * parity test fails on its `toBeDefined` guard instead of passing falsely.
 */
const snapshots = new Map<boolean, unknown>()

const URL_OF = (tail: string) => `https://jobs.dou.ua/companies/${tail}`

describe.skipIf(!hasDatabaseUrl()).each(BRIDGE_FLAG_VALUES)(
  'Compat barrier — legacy DOU path: real DB (bridge flag %s)',
  (flagOn) => {
    let pool: Pool
    let dbSvc: DatabaseService
    let service: JobSourcingService
    let provider: FixtureDouProvider

    const source = { id: SOURCE_ID, type: 'DOU_RSS' as const, config: { category: 'JavaScript' } }

    const myPostings = () =>
      dbSvc.db.select().from(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))

    const sourceRow = async () =>
      (await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, SOURCE_ID)))[0]!

    async function suggestionOf(seniorId: string, postingId: string) {
      const rows = await dbSvc.db
        .select({ id: jobSuggestions.id, status: jobSuggestions.status })
        .from(jobSuggestions)
        .where(and(eq(jobSuggestions.seniorId, seniorId), eq(jobSuggestions.postingId, postingId)))
      return rows[0]
    }

    async function postingIdByUrl(urlTail: string): Promise<string> {
      const row = (await myPostings()).find((p) => p.url.includes(urlTail))
      if (!row) throw new Error(`fixture posting ${urlTail} not stored`)
      return row.id
    }

    async function statusCounts(seniorId: string): Promise<Record<string, number>> {
      return service.countSuggestionsByStatus(seniorId)
    }

    async function clean(): Promise<void> {
      const db = dbSvc.db
      await db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, SENIOR_IDS))
      await db.delete(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID))
      // Flag-on artifacts, deleted children-first (bridge rows RESTRICT the run they cite; runs
      // RESTRICT the source). The run delete cascades its page-membership rows.
      await pool.query(`DELETE FROM job_bridge_deliveries WHERE source_id = $1`, [SOURCE_ID])
      await pool.query(`DELETE FROM job_collection_runs WHERE source_id = $1`, [SOURCE_ID])
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await pool.query('SELECT 1')
      // The staged bridge table (idempotent CREATE IF NOT EXISTS) so the flag-on path can deliver.
      await pool.query(readFileSync(BRIDGE_DDL, 'utf8'))
      const db = drizzle(pool, { schema })
      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      provider = new FixtureDouProvider()
      // Flag ON routes through collectViaBridge, which claims and finishes a DOU run through the
      // ledger; flag OFF never touches it. The registry marks DOU as LEGACY (the reporting arg lists
      // only REMOTIVE_API), which is exactly what claimLegacyRun requires.
      const ledger = flagOn
        ? new JobRunLedger(db, specRegistry(['REMOTIVE_API']), new SpecCatalog())
        : undefined
      service = new JobSourcingService(
        dbSvc,
        new HrAccessService(dbSvc),
        provider,
        bridgeConfig(flagOn),
        ledger,
      )

      await db
        .insert(users)
        .values(
          SENIORS.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            googleId: `test-compat-barrier-${u.id}`,
          })),
        )
        .onConflictDoNothing()
      await db
        .insert(teams)
        .values({ id: TEAM_ID, name: 'Compat Barrier Team' })
        .onConflictDoNothing()
      await db
        .insert(teamMembers)
        .values(SENIORS.map((s) => ({ teamId: TEAM_ID, userId: s.id })))
        .onConflictDoNothing()
      await db
        .insert(seniorResumes)
        .values({
          userId: S_DECIDER.id,
          content: {
            summary: '',
            skills: ['TypeScript', 'React', 'GraphQL', 'Kubernetes'],
            experience: [],
            education: [],
            languages: [],
            links: [],
          },
        })
        .onConflictDoNothing()
      await db
        .insert(jobSources)
        .values({ id: SOURCE_ID, type: 'DOU_RSS', config: { category: 'JavaScript' } })
        .onConflictDoNothing()
      await clean()
    }, 30_000)

    beforeEach(async () => {
      await clean()
      await dbSvc.db
        .update(jobSources)
        .set({
          lastCollectedAt: null,
          triggerMode: 'BOTH',
          enabled: true,
          budgetLimit: null,
          budgetWindow: null,
          budgetUsed: 0,
          budgetWindowStartedAt: null,
        })
        .where(eq(jobSources.id, SOURCE_ID))
      provider.feedXml = FEED_XML
      provider.fetchCalls = 0
    })

    afterAll(async () => {
      const db = dbSvc.db
      await clean()
      await db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
      await db.delete(seniorResumes).where(inArray(seniorResumes.userId, SENIOR_IDS))
      await db.delete(teamMembers).where(inArray(teamMembers.userId, SENIOR_IDS))
      await db.delete(teams).where(eq(teams.id, TEAM_ID))
      await db.delete(users).where(inArray(users.id, SENIOR_IDS))
      await pool.end()
    }, 30_000)

    // ── 1. decided postings survive purge AND re-collection ────────────────────

    it('APPLIED and REJECTED postings survive purge + re-collection untouched; undecided ones are purged and re-offered as fresh NEW rows', async () => {
      await service.collectSource(source)
      expect(await myPostings()).toHaveLength(8)

      const applied = await postingIdByUrl('/wetelo/vacancies/9360001')
      const rejected = await postingIdByUrl('/ciklum/vacancies/9360003')
      const appliedSuggestion = await suggestionOf(S_DECIDER.id, applied)
      const rejectedSuggestion = await suggestionOf(S_DECIDER.id, rejected)
      await service.updateStatus(appliedSuggestion!.id, { status: 'APPLIED' }, S_DECIDER)
      await service.updateStatus(rejectedSuggestion!.id, { status: 'REJECTED' }, S_DECIDER)
      const before = await myPostings()
      const oldIds = new Set(before.map((p) => p.id))
      const fingerprintOf = (rows: typeof before, rowId: string) =>
        rows.find((p) => p.id === rowId)?.fingerprint
      const appliedFingerprint = fingerprintOf(before, applied)
      const rejectedFingerprint = fingerprintOf(before, rejected)
      expect(appliedFingerprint).toMatch(/^[0-9a-f]{64}$/)

      await dbSvc.db
        .update(jobPostings)
        .set({ collectedAt: LONG_AGO })
        .where(eq(jobPostings.sourceId, SOURCE_ID))

      // 8 stored - 2 decided = 6 undecided, all older than the cutoff. The delete is global, so the
      // count is a floor; the exact claim is made on this spec's own rows just below.
      expect(await service.purgeStalePostings(NOW)).toBeGreaterThanOrEqual(6)
      expect((await myPostings()).map((p) => p.id).sort()).toEqual([applied, rejected].sort())

      // Re-collect the SAME feed: the two survivors collide on fingerprint, the six come back.
      const again = await service.collectSource(source)
      expect(again).toMatchObject({ fetched: 9, created: 6, duplicates: 3 })

      const after = await myPostings()
      expect(after).toHaveLength(8)
      // The survivors are the SAME rows (same ids), not re-inserted copies.
      expect(fingerprintOf(after, applied)).toBe(appliedFingerprint)
      expect(fingerprintOf(after, rejected)).toBe(rejectedFingerprint)
      // The six others are new rows with new ids.
      const reborn = after.filter((p) => p.id !== applied && p.id !== rejected)
      expect(reborn).toHaveLength(6)
      expect(reborn.every((p) => !oldIds.has(p.id))).toBe(true)

      // The decisions are intact and were not re-offered.
      expect(await suggestionOf(S_DECIDER.id, applied)).toMatchObject({
        id: appliedSuggestion!.id,
        status: 'APPLIED',
      })
      expect(await suggestionOf(S_DECIDER.id, rejected)).toMatchObject({
        id: rejectedSuggestion!.id,
        status: 'REJECTED',
      })
      expect(await statusCounts(S_DECIDER.id)).toMatchObject({ NEW: 6, APPLIED: 1, REJECTED: 1 })
      // A senior who decided nothing keeps their NEW offer on the survivors and gets the six again.
      expect((await statusCounts(S_BYSTANDER.id))['NEW']).toBe(8)
      const queue = await service.listSuggestions(S_DECIDER.id, S_DECIDER)
      expect(queue.total).toBe(6)
      expect(queue.items.map((i) => i.posting.id)).not.toContain(applied)
      expect(queue.items.map((i) => i.posting.id)).not.toContain(rejected)
    })

    // ── 2. the purge cutoff is exact ───────────────────────────────────────────

    it('purge cutoff: a posting collected exactly 90 days before `now` is kept, one millisecond older is purged', async () => {
      expect(POSTING_RETENTION_DAYS).toBe(90)
      await service.collectSource(source)
      const rows = await myPostings()
      const [atCutoff, justOlder] = rows as [(typeof rows)[number], (typeof rows)[number]]

      // Everything else is fresh, so only the two probes are in play.
      await dbSvc.db
        .update(jobPostings)
        .set({ collectedAt: new Date(NOW.getTime() - DAY_MS) })
        .where(eq(jobPostings.sourceId, SOURCE_ID))
      await dbSvc.db
        .update(jobPostings)
        .set({ collectedAt: new Date(NOW.getTime() - 90 * DAY_MS) })
        .where(eq(jobPostings.id, atCutoff.id))
      await dbSvc.db
        .update(jobPostings)
        .set({ collectedAt: new Date(NOW.getTime() - 90 * DAY_MS - 1) })
        .where(eq(jobPostings.id, justOlder.id))

      // Global delete: assert the exact outcome on this spec's own rows, the count only as a floor.
      expect(await service.purgeStalePostings(NOW)).toBeGreaterThanOrEqual(1)

      const left = (await myPostings()).map((p) => p.id)
      expect(left).toContain(atCutoff.id)
      expect(left).not.toContain(justOlder.id)
      expect(left).toHaveLength(7)
    })

    // ── 3. one-unit budget arithmetic over the golden feed ─────────────────────

    it('C-06: each collectSource over the golden feed spends exactly one unit; C-05: a zero-postings run still spends its unit and leaves last_collected_at alone; then the budget refuses before the network', async () => {
      await dbSvc.db
        .update(jobSources)
        .set({ budgetLimit: 3, budgetWindow: 'MONTH' })
        .where(eq(jobSources.id, SOURCE_ID))

      await service.collectSource(await sourceRow())
      expect((await sourceRow()).budgetUsed).toBe(1)
      expect(provider.fetchCalls).toBe(1)
      const collectedAfterFirst = (await sourceRow()).lastCollectedAt
      expect(collectedAfterFirst).toBeInstanceOf(Date)

      // A second run over the same feed creates nothing but still costs one unit.
      await service.collectSource(await sourceRow())
      expect((await sourceRow()).budgetUsed).toBe(2)

      // Zero usable postings: fails, keeps the spent unit, does NOT stamp last_collected_at.
      const stampBefore = (await sourceRow()).lastCollectedAt
      provider.feedXml = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'
      await expect(service.collectSource(await sourceRow())).rejects.toThrow(/0 usable postings/)
      const afterZero = await sourceRow()
      expect(afterZero.budgetUsed).toBe(3)
      expect(afterZero.lastCollectedAt?.getTime()).toBe(stampBefore?.getTime())
      expect(provider.fetchCalls).toBe(3)

      // Budget now spent: typed stop, and the network is NOT reached again.
      await expect(service.collectSource(await sourceRow())).rejects.toBeInstanceOf(
        JobSourceBudgetExhaustedError,
      )
      expect(provider.fetchCalls).toBe(3)
      expect((await sourceRow()).budgetUsed).toBe(3)
    })

    // ── 4. legacy resume-based ranking of the golden postings ──────────────────

    async function setStack(skills: string[]): Promise<void> {
      await dbSvc.db
        .update(seniorResumes)
        .set({
          content: { summary: '', skills, experience: [], education: [], languages: [], links: [] },
        })
        .where(eq(seniorResumes.userId, S_DECIDER.id))
    }

    /** Explicit, distinct collected_at per row so no ordering rests on separate now() values. */
    async function pinCollectedAt(): Promise<void> {
      const rows = [...(await myPostings())].sort((a, b) => a.url.localeCompare(b.url))
      for (const [i, row] of rows.entries()) {
        await dbSvc.db
          .update(jobPostings)
          .set({ collectedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)) })
          .where(eq(jobPostings.id, row.id))
      }
    }

    const summaryOf = (list: Awaited<ReturnType<JobSourcingService['listSuggestions']>>['items']) =>
      list.map((i) => [i.posting.url.replace(URL_OF(''), ''), i.matchScore, i.matchedKeywords])

    it('score order beats freshness order: the OLDEST published posting leads when it scores highest', async () => {
      await service.collectSource(source)
      await pinCollectedAt()
      await setStack(['AWS', 'Kubernetes', 'Terraform'])

      const ranked = await service.listSuggestions(S_DECIDER.id, S_DECIDER)

      // DevOps/9360010 is the oldest published item here, yet scores 1, so it must lead. Freshness
      // alone would put wetelo (published 08-06) first. The two 1/3 ties keep freshness order
      // (wetelo is fresher than soft-serve).
      expect(summaryOf(ranked.items)).toEqual([
        ['ciklum/vacancies/9360010', 1, ['aws', 'kubernetes', 'terraform']],
        ['wetelo/vacancies/9360001', 1 / 3, ['kubernetes']],
        ['soft-serve/vacancies/9360004', 1 / 3, ['aws']],
      ])
    })

    it('threshold split of the golden postings: below 0.2 is collapsed but counted, in freshness order; a no-resume senior keeps pure freshness', async () => {
      await service.collectSource(source)
      await pinCollectedAt()
      await setStack(['TypeScript', 'React', 'GraphQL', 'Kubernetes'])

      const ranked = await service.listSuggestions(S_DECIDER.id, S_DECIDER)

      expect({
        threshold: ranked.threshold,
        stackKeywords: ranked.stackKeywords,
        total: ranked.total,
        lowMatchCount: ranked.lowMatchCount,
        items: summaryOf(ranked.items),
        lowMatch: summaryOf(ranked.lowMatch).map((row) => row.slice(0, 2)),
      }).toEqual({
        threshold: 0.2,
        stackKeywords: ['typescript', 'react', 'graphql', 'kubernetes'],
        total: 8,
        lowMatchCount: 5,
        items: [
          ['epam-systems/vacancies/9356562', 0.75, ['typescript', 'react', 'graphql']],
          ['wetelo/vacancies/9360001', 0.25, ['kubernetes']],
          ['ciklum/vacancies/9360010', 0.25, ['kubernetes']],
        ],
        // Score 0 everywhere; the two unpublished rows (romashka, rnd-labs) are ordered by the
        // explicit collected_at pinned above (romashka later), the rest by publishedAt.
        lowMatch: [
          ['romashka/vacancies/9360009', 0],
          ['rnd-labs/vacancies/9360008', 0],
          ['asd-team/vacancies/9360002', 0],
          ['ciklum/vacancies/9360003', 0],
          ['soft-serve/vacancies/9360004', 0],
        ],
      })

      const fresh = await service.listSuggestions(S_BYSTANDER.id, S_BYSTANDER)
      expect(fresh.lowMatch).toEqual([])
      expect(fresh.lowMatchCount).toBe(0)
      expect(fresh.stackKeywords).toEqual([])
      expect(fresh.total).toBe(8)
    })

    // ── 5. bare row vs live row; trigger mode over real rows ───────────────────

    it('CHARACTERISES TODAY, NOT A REQUIREMENT: collectSource charges the row object it is given — a bare {id,type,config} is treated as unlimited, the live row is charged', async () => {
      await dbSvc.db
        .update(jobSources)
        .set({ budgetLimit: 3, budgetWindow: 'MONTH' })
        .where(eq(jobSources.id, SOURCE_ID))

      await service.collectSource(source)
      expect((await sourceRow()).budgetUsed).toBe(0)
      expect(provider.fetchCalls).toBe(1)

      await service.collectSource(await sourceRow())
      expect((await sourceRow()).budgetUsed).toBe(1)
      expect(provider.fetchCalls).toBe(2)
    })

    it('trigger mode over real rows: a SCHEDULED-only source is skipped by a MANUAL collectAll and runs under a SCHEDULED one, even beside another enabled BOTH-mode DOU source', async () => {
      await dbSvc.db
        .update(jobSources)
        .set({ triggerMode: 'SCHEDULED', enabled: true, budgetLimit: 5, budgetWindow: 'MONTH' })
        .where(eq(jobSources.id, SOURCE_ID))
      // A neighbour that every collectAll below WILL run (BOTH, enabled, same provider and feed).
      // It can win the unique fingerprints before this spec's source, which is why nothing below
      // asserts on posting counts of the scheduled run: only on this source's own row state.
      const [neighbour] = await dbSvc.db
        .insert(jobSources)
        .values({ type: 'DOU_RSS', config: { category: 'Python' }, triggerMode: 'BOTH' })
        .returning()
      const only = { onlyTypes: ['DOU_RSS' as const] }

      try {
        const manualRun = await service.collectAll('MANUAL', only)
        expect(manualRun.failures).toEqual([])
        // The neighbour proves the run happened; our SCHEDULED-only row was not touched by it.
        const neighbourAfter = (
          await dbSvc.db.select().from(jobSources).where(eq(jobSources.id, neighbour!.id))
        )[0]
        expect(neighbourAfter?.lastCollectedAt).toBeInstanceOf(Date)
        const skipped = await sourceRow()
        expect(skipped.budgetUsed).toBe(0)
        expect(skipped.lastCollectedAt).toBeNull()
        expect(await myPostings()).toHaveLength(0)

        await service.collectAll('SCHEDULED', only)
        const ran = await sourceRow()
        expect(ran.budgetUsed).toBe(1)
        expect(ran.lastCollectedAt).toBeInstanceOf(Date)
      } finally {
        await dbSvc.db.delete(jobSuggestions).where(inArray(jobSuggestions.seniorId, SENIOR_IDS))
        await dbSvc.db.delete(jobPostings).where(eq(jobPostings.sourceId, neighbour!.id))
        // Flag-on: the neighbour collected under a run; clear its bridge rows and run (children
        // first) before the source, which both RESTRICT.
        await pool.query(`DELETE FROM job_bridge_deliveries WHERE source_id = $1`, [neighbour!.id])
        await pool.query(`DELETE FROM job_collection_runs WHERE source_id = $1`, [neighbour!.id])
        await dbSvc.db.delete(jobSources).where(eq(jobSources.id, neighbour!.id))
      }
    })

    /**
     * What a collection over the golden feed leaves behind, keyed by FINGERPRINT and content --
     * never by generated id. Both flag variants record theirs; the flag-on variant's assertion IS
     * the comparison with the flag-off result of the same fixture (parity).
     */
    async function collectionSnapshot() {
      const result = await service.collectSource(source)
      const postings = (await myPostings())
        .map((p) => ({
          fingerprint: p.fingerprint,
          externalId: p.externalId,
          url: p.url,
          title: p.title,
          companyName: p.companyName,
          location: p.location,
          descriptionMd: p.descriptionMd,
          publishedAt: p.publishedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
      const byId = new Map((await myPostings()).map((p) => [p.id, p.fingerprint]))
      const suggestions = (
        await dbSvc.db
          .select({
            seniorId: jobSuggestions.seniorId,
            postingId: jobSuggestions.postingId,
            status: jobSuggestions.status,
          })
          .from(jobSuggestions)
          .where(inArray(jobSuggestions.seniorId, SENIOR_IDS))
      )
        .map((s) => `${s.seniorId}|${byId.get(s.postingId) ?? 'unknown'}|${s.status}`)
        .sort()
      const row = await sourceRow()
      return { result, postings, suggestions, budgetUsed: row.budgetUsed }
    }

    it('PARITY: a collection over the golden feed leaves the same postings, suggestions and counts under flag off and on', async () => {
      const snapshot = await collectionSnapshot()
      expect(snapshot.postings.length).toBeGreaterThan(0)
      expect(snapshot.suggestions.length).toBeGreaterThan(0)
      snapshots.set(flagOn, snapshot)
    })

    it.runIf(flagOn)(
      'PARITY: the flag-on snapshot equals the flag-off snapshot of the same fixture',
      () => {
        // ORDER DEPENDENCY: relies on the flag-off block (and its recording test) running first in
        // this file. A shuffled or `-t`-filtered run leaves the Map empty and fails loudly on the
        // `toBeDefined` guard below; it cannot pass falsely.
        const off = snapshots.get(false)
        expect(off, 'the flag-off variant of this fixture must have run first').toBeDefined()
        expect(snapshots.get(true)).toEqual(off)
      },
    )

    if (!flagOn) {
      it('flag OFF: two concurrent collections of one source BOTH proceed -- two fetches, two units, one set of postings', async () => {
        await dbSvc.db
          .update(jobSources)
          .set({ budgetLimit: 5, budgetWindow: 'MONTH' })
          .where(eq(jobSources.id, SOURCE_ID))

        const results = await Promise.allSettled([
          service.collectSource(await sourceRow()),
          service.collectSource(await sourceRow()),
        ])

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(provider.fetchCalls).toBe(2)
        expect((await sourceRow()).budgetUsed).toBe(2)
        // Both runs wrote the same fingerprints: the unique key left exactly one row each.
        const fingerprints = (await myPostings()).map((p) => p.fingerprint)
        expect(new Set(fingerprints).size).toBe(fingerprints.length)
      })
    } else {
      it('flag ON: two concurrent collections of one source -> the second throws JobSourceRunBusyError and spends zero extra units', async () => {
        await dbSvc.db
          .update(jobSources)
          .set({ budgetLimit: 5, budgetWindow: 'MONTH' })
          .where(eq(jobSources.id, SOURCE_ID))

        const results = await Promise.allSettled([
          service.collectSource(await sourceRow()),
          service.collectSource(await sourceRow()),
        ])

        const statuses = results.map((r) => r.status).sort()
        expect(statuses).toEqual(['fulfilled', 'rejected'])
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason).toBeInstanceOf(JobSourceRunBusyError)
        // Single-flight: the loser was refused at the claim, BEFORE the budget or the provider — one
        // unit spent, one fetch made, one set of postings.
        expect((await sourceRow()).budgetUsed).toBe(1)
        expect(provider.fetchCalls).toBe(1)
        const fingerprints = (await myPostings()).map((p) => p.fingerprint)
        expect(new Set(fingerprints).size).toBe(fingerprints.length)
      })

      it('flag ON: the roster + exclusions are read ONCE per drain pass (O(S), not O(P×S))', async () => {
        const spy = vi.spyOn(
          service as unknown as { buildExclusionSet: (id: string) => Promise<unknown> },
          'buildExclusionSet',
        )
        const result = await service.collectSource(source)
        expect(result.created).toBeGreaterThan(1) // P > 1 postings in the golden feed
        // O(S), not O(P×S): each eligible senior's exclusion set is read AT MOST ONCE per pass, no
        // matter how many postings are drained. The call count equals the distinct senior count.
        const seniorArgs = spy.mock.calls.map((c) => c[0])
        expect(seniorArgs.length).toBe(new Set(seniorArgs).size)
        spy.mockRestore()
      })

      it('flag ON: a T2 observation-store failure is swallowed — the legacy delivery still succeeds (Q3)', async () => {
        const spy = vi
          .spyOn(recordStore, 'saveObservationPage')
          .mockRejectedValue(new Error('observation store down'))

        const result = await service.collectSource(source)

        // The store write failed, but T1/T3/T4 still delivered: postings and suggestions are there.
        expect(spy).toHaveBeenCalled()
        expect(result.created).toBeGreaterThan(0)
        expect(result.suggestionsCreated).toBeGreaterThan(0)
        expect((await myPostings()).length).toBe(result.created)
        spy.mockRestore()
      })
    }
  },
)
