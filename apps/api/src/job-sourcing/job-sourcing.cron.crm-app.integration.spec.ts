import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { HrAccessService } from '../common/hr-access.service'
import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import { jobSources } from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { DouRssProvider } from './dou.provider'
import { JobSourcingService, POSTING_RETENTION_DAYS } from './job-sourcing.service'

/**
 * JobSourcingCronService's database work against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * The daily 05:00 cron holds no database handle; it calls `JobSourcingService.collectAll` and then
 * `purgeStalePostings`. Between them they issue, per source: `UPDATE job_sources` to charge the
 * budget (`chargeBudget`), `INSERT job_postings` / `job_suggestions`, and a second
 * `UPDATE job_sources` for `last_collected_at`; and then `DELETE job_postings` (which cascades to
 * `job_suggestions`). All of it is class A. `job-sourcing.integration.spec.ts` runs this on a real
 * database but as the MIGRATION role, which owns the tables, so it cannot see a missing grant.
 *
 * `collectSource` is the per-source body `collectAll` loops over, so that is what runs here (a
 * `collectAll` would also walk every other enabled source in the database, and the question is the
 * grant, not the fan-out). Only the HTTP fetch is stubbed.
 */

const TAG = 'cron-real-db-spec'

function feed(path: string): string {
  return (
    `<?xml version="1.0"?><rss version="2.0"><channel><item>` +
    `<title>Senior Node.js Engineer в ${TAG}, Київ</title>` +
    `<link>https://jobs.dou.ua${path}?utm_source=jobsrss</link>` +
    `<guid isPermaLink="false">https://jobs.dou.ua${path}?1</guid>` +
    `<pubDate>Fri, 07 Aug 2026 11:48:38 +0300</pubDate>` +
    `<description>&lt;p&gt;desc&lt;/p&gt;</description></item></channel></rss>`
  )
}

/** The real provider with ONLY the network call replaced. */
class StubDouProvider extends DouRssProvider {
  feedXml = ''
  protected override fetchFeed(): Promise<string> {
    return Promise.resolve(this.feedXml)
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'JobSourcingCronService database work as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let service: JobSourcingService
    let provider: StubDouProvider
    const sourceIds: string[] = []
    const userIds: string[] = []

    /** Row counts before the first test, so `afterAll` can prove the run left nothing behind. */
    let baseline: { postings: number; suggestions: number }

    async function counts(): Promise<{ postings: number; suggestions: number }> {
      const { rows } = await session.admin.query<{ postings: string; suggestions: string }>(
        `SELECT (SELECT count(*) FROM job_postings)::text AS postings,
                (SELECT count(*) FROM job_suggestions)::text AS suggestions`,
      )
      const row = rows[0] as { postings: string; suggestions: string }
      return { postings: Number(row.postings), suggestions: Number(row.suggestions) }
    }

    beforeAll(async () => {
      session = await openCrmAppSession()
      baseline = await counts()
      provider = new StubDouProvider()
      service = new JobSourcingService(
        session.databaseService,
        new HrAccessService(session.databaseService),
        provider,
      )
    }, 120_000)

    afterEach(async () => {
      // Postings (and through them suggestions) first, then their sources and users. Matched on
      // the company as well as the title: the DOU provider splits «… в <company>» out of the title,
      // so a collected posting carries the tag in `company_name` and NOT in `title` — matching the
      // title alone left 2 postings and 8 suggestions behind on every run (CR-M-3 of #1040).
      await session?.admin.query(
        `DELETE FROM job_postings WHERE title LIKE $1 OR company_name = $2`,
        [`%${TAG}%`, TAG],
      )
      for (const id of sourceIds.splice(0)) {
        await session?.admin.query(`DELETE FROM job_sources WHERE id = $1`, [id])
      }
      for (const id of userIds.splice(0)) {
        await session?.admin.query(`DELETE FROM users WHERE id = $1`, [id])
      }
    })

    afterAll(async () => {
      try {
        // A leak is a failure of THIS suite, not something a reviewer finds by counting rows.
        expect(await counts()).toEqual(baseline)
      } finally {
        await session?.close()
      }
    })

    /** A DOU source row; `budgeted` makes `chargeBudget` issue its UPDATE. */
    async function insertSource(budgeted: boolean) {
      const id = randomUUID()
      sourceIds.push(id)
      await session.admin.query(
        `INSERT INTO job_sources (id, type, config, enabled, budget_limit, budget_window)
         VALUES ($1, 'DOU_RSS', $2::jsonb, true, $3, $4)`,
        [
          id,
          JSON.stringify({ category: 'JavaScript' }),
          budgeted ? 100 : null,
          budgeted ? 'DAY' : null,
        ],
      )
      return { id }
    }

    /** `collectSource` takes the drizzle row shape, so read it back the way the service does. */
    async function loadSource(id: string) {
      const [source] = await session.databaseService.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.id, id))
      if (!source) throw new Error('fixture source vanished')
      return source
    }

    async function sourceState(id: string) {
      const { rows } = await session.admin.query<{
        budget_used: number
        last_collected_at: Date | null
      }>(`SELECT budget_used, last_collected_at FROM job_sources WHERE id = $1`, [id])
      return rows[0] as { budget_used: number; last_collected_at: Date | null }
    }

    async function insertStalePosting(ageDays: number, withSuggestion: boolean): Promise<string> {
      const id = randomUUID()
      await session.admin.query(
        `INSERT INTO job_postings
           (id, source_type, external_id, url, title, company_name, company_name_normalized,
            description_md, fingerprint, collected_at, queue_status)
         VALUES ($1, 'DOU_RSS', $2, $3, $4, $5, $5, 'x', $6,
                 now() - ($7::int * interval '1 day'), 'NEW')`,
        [
          id,
          `ext-${id}`,
          `https://jobs.dou.ua/${TAG}/${id}`,
          `Old posting ${TAG}`,
          TAG,
          `${TAG}-${id}`,
          ageDays,
        ],
      )
      if (withSuggestion) {
        const seniorId = randomUUID()
        userIds.push(seniorId)
        await session.admin.query(
          `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, 'SENIOR')`,
          [seniorId, `${TAG}-${seniorId}@example.invalid`, TAG],
        )
        await session.admin.query(
          `INSERT INTO job_suggestions (posting_id, senior_id) VALUES ($1, $2)`,
          [id, seniorId],
        )
      }
      return id
    }

    async function postingExists(id: string): Promise<boolean> {
      const { rowCount } = await session.admin.query(`SELECT 1 FROM job_postings WHERE id = $1`, [
        id,
      ])
      return rowCount === 1
    }

    it('is connected as crm_app — not a superuser, not an owner of anything', async () => {
      expect(await session.identity()).toEqual({
        currentUser: 'crm_app',
        sessionUser: 'crm_app',
        isSuperuser: false,
        bypassesRls: false,
        ownedRelations: 0,
        roleMemberships: 0,
      })
    })

    it('collectSource: both job_sources UPDATEs and the posting INSERT are permitted to crm_app', async () => {
      const { id } = await insertSource(true)
      provider.feedXml = feed(`/companies/${TAG}/vacancies/${randomUUID()}/`)

      const result = await service.collectSource(await loadSource(id))

      expect(result.created).toBeGreaterThanOrEqual(1)
      const after = await sourceState(id)
      expect(after.budget_used).toBe(1) // chargeBudget's UPDATE
      expect(after.last_collected_at).not.toBeNull() // the closing UPDATE
    })

    it('purgeStalePostings: the DELETE (cascading to job_suggestions) is permitted to crm_app', async () => {
      const stale = await insertStalePosting(POSTING_RETENTION_DAYS + 10, true)
      const fresh = await insertStalePosting(POSTING_RETENTION_DAYS - 10, false)

      const purged = await service.purgeStalePostings()

      expect(purged).toBeGreaterThanOrEqual(1)
      expect(await postingExists(stale)).toBe(false)
      expect(await postingExists(fresh)).toBe(true)
    })

    it('control: with UPDATE withdrawn the budget charge fails with 42501 before anything is fetched', async () => {
      const { id } = await insertSource(true)
      provider.feedXml = feed(`/companies/${TAG}/vacancies/${randomUUID()}/`)
      const source = await loadSource(id)

      const code = await session.withPrivilegeWithdrawn('UPDATE', 'job_sources', () =>
        sqlstateOfRejection(() => service.collectSource(source)),
      )

      expect(code).toBe('42501')
      expect((await sourceState(id)).budget_used).toBe(0)
    })

    it('control: with UPDATE withdrawn the closing last_collected_at UPDATE fails with 42501 too', async () => {
      // No budget configured, so chargeBudget issues no UPDATE and the refusal can only be the
      // closing one — the two statements are separate grants-in-use, and are told apart here.
      const { id } = await insertSource(false)
      provider.feedXml = feed(`/companies/${TAG}/vacancies/${randomUUID()}/`)
      const source = await loadSource(id)

      const code = await session.withPrivilegeWithdrawn('UPDATE', 'job_sources', () =>
        sqlstateOfRejection(() => service.collectSource(source)),
      )

      expect(code).toBe('42501')
      expect((await sourceState(id)).last_collected_at).toBeNull()
    })

    it('control: with DELETE withdrawn on job_postings the purge fails with 42501', async () => {
      const stale = await insertStalePosting(POSTING_RETENTION_DAYS + 10, false)

      const code = await session.withPrivilegeWithdrawn('DELETE', 'job_postings', () =>
        sqlstateOfRejection(() => service.purgeStalePostings()),
      )

      expect(code).toBe('42501')
      expect(await postingExists(stale)).toBe(true)
    })
  },
)
