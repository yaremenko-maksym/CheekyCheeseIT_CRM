import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'
import { SeniorResumesService } from './resumes.service'

/**
 * ResumeExtractionCronService's database work against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * The cron (every 5 minutes) holds no database handle: it calls three methods of
 * `SeniorResumesService`, each of which issues an `UPDATE senior_resumes` — `sweepStuckExtractions`
 * (RUNNING -> FAILED), `requeueAbandoned` (-> `failUnclaimed`, QUEUED -> FAILED) and
 * `sweepStuckRenders` (RUNNING -> QUEUED). The ADR's count of "cron services with a mocked
 * `DatabaseService`" does not see it, because its unit spec mocks the service, not the database.
 * `senior_resumes` is class A; this spec runs each of the three statements as `crm_app`.
 *
 * The service is built with its real `DatabaseService` and inert stand-ins for the object store, the
 * model and the typesetter: none of the three methods reaches them for the rows seeded here
 * (the abandoned row has no stored source, so there is nothing to re-read; the render row's
 * `updated_at` is fresh, so the "re-drive abandoned" half of `sweepStuckRenders` finds nothing).
 * If a future change makes them reach one, the stand-in throws and the spec says so, rather than
 * the spec quietly passing around it.
 */

const TAG = 'cron-real-db-spec'
const inert = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`resume-extraction crm_app spec reached the stand-in: ${String(prop)}`)
    },
  },
)

describe.skipIf(!hasDatabaseUrl())(
  'ResumeExtractionCronService database work as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let resumes: SeniorResumesService
    const userIds: string[] = []

    beforeAll(async () => {
      session = await openCrmAppSession()
      resumes = new SeniorResumesService(
        session.databaseService,
        inert as never,
        inert as never,
        inert as never,
        inert as never,
      )
    }, 120_000)

    afterEach(async () => {
      for (const id of userIds.splice(0)) {
        await session?.admin.query(`DELETE FROM users WHERE id = $1`, [id])
      }
    })

    afterAll(async () => {
      await session?.close()
    })

    /** A SENIOR and their one resume row (user_id is UNIQUE), in the given state. */
    async function seedResume(opts: {
      status?: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED'
      extractionStartedMinutesAgo?: number
      updatedMinutesAgo: number
      renderStatus?: 'IDLE' | 'RUNNING'
      renderStartedMinutesAgo?: number
    }): Promise<string> {
      const userId = randomUUID()
      userIds.push(userId)
      await session.admin.query(
        `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, 'SENIOR')`,
        [userId, `${TAG}-${userId}@example.invalid`, TAG],
      )
      const id = randomUUID()
      // Milliseconds: the service compares `updated_at` it read back through a JS Date, which
      // cannot carry the microseconds `now()` would give it.
      await session.admin.query(
        `INSERT INTO senior_resumes
           (id, user_id, status, extraction_started_at, pdf_render_status, pdf_render_started_at, updated_at)
         VALUES ($1, $2, $3,
                 CASE WHEN $4::int IS NULL THEN NULL ELSE now() - ($4::int * interval '1 minute') END,
                 $5,
                 CASE WHEN $6::int IS NULL THEN NULL ELSE now() - ($6::int * interval '1 minute') END,
                 date_trunc('milliseconds', now() - ($7::int * interval '1 minute')))`,
        [
          id,
          userId,
          opts.status ?? 'READY',
          opts.extractionStartedMinutesAgo ?? null,
          opts.renderStatus ?? 'IDLE',
          opts.renderStartedMinutesAgo ?? null,
          opts.updatedMinutesAgo,
        ],
      )
      return id
    }

    async function row(id: string): Promise<{
      status: string
      error_code: string | null
      pdf_render_status: string
    }> {
      const { rows } = await session.admin.query<{
        status: string
        error_code: string | null
        pdf_render_status: string
      }>(
        `SELECT status::text, error_code, pdf_render_status::text FROM senior_resumes WHERE id = $1`,
        [id],
      )
      return rows[0] as { status: string; error_code: string | null; pdf_render_status: string }
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

    it('sweepStuckExtractions: the UPDATE is permitted to crm_app (RUNNING -> FAILED)', async () => {
      const id = await seedResume({
        status: 'RUNNING',
        extractionStartedMinutesAgo: 60,
        updatedMinutesAgo: 60,
      })

      const swept = await resumes.sweepStuckExtractions()

      expect(swept).toBeGreaterThanOrEqual(1)
      expect(await row(id)).toMatchObject({ status: 'FAILED', error_code: 'STALLED' })
    })

    it('requeueAbandoned: the failUnclaimed UPDATE is permitted to crm_app (QUEUED, no source -> FAILED)', async () => {
      const id = await seedResume({ status: 'QUEUED', updatedMinutesAgo: 60 })

      const handled = await resumes.requeueAbandoned()

      expect(handled).toBeGreaterThanOrEqual(1)
      expect(await row(id)).toMatchObject({ status: 'FAILED', error_code: 'STALLED' })
    })

    it('sweepStuckRenders: the UPDATE is permitted to crm_app (render RUNNING -> QUEUED)', async () => {
      const id = await seedResume({
        updatedMinutesAgo: 0,
        renderStatus: 'RUNNING',
        renderStartedMinutesAgo: 60,
      })

      const swept = await resumes.sweepStuckRenders()

      expect(swept).toBeGreaterThanOrEqual(1)
      expect(await row(id)).toMatchObject({ pdf_render_status: 'QUEUED' })
    })

    it('control: with UPDATE withdrawn from crm_app all three sweeps fail with 42501', async () => {
      await seedResume({
        status: 'RUNNING',
        extractionStartedMinutesAgo: 60,
        updatedMinutesAgo: 60,
      })
      await seedResume({ status: 'QUEUED', updatedMinutesAgo: 60 })
      await seedResume({
        updatedMinutesAgo: 0,
        renderStatus: 'RUNNING',
        renderStartedMinutesAgo: 60,
      })

      const codes = await session.withPrivilegeWithdrawn('UPDATE', 'senior_resumes', async () => ({
        extractions: await sqlstateOfRejection(() => resumes.sweepStuckExtractions()),
        requeue: await sqlstateOfRejection(() => resumes.requeueAbandoned()),
        renders: await sqlstateOfRejection(() => resumes.sweepStuckRenders()),
      }))

      expect(codes).toEqual({ extractions: '42501', requeue: '42501', renders: '42501' })
    })
  },
)
