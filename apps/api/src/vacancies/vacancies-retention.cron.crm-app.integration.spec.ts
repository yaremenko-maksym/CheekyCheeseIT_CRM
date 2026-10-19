import { randomUUID } from 'node:crypto'

import type { ConfigService } from '@nestjs/config'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import type { S3Service } from '../documents/s3.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import type { GoogleIndexingService } from './google-indexing.service'
import {
  FILE_RETENTION_DAYS,
  RETENTION_DAYS,
  VacanciesRetentionCronService,
} from './vacancies-retention.cron'

/**
 * VacanciesRetentionCronService against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * This job issues BOTH shapes the ADR names: a `DELETE` of whole applications
 * (`purgeExpiredApplications`) and an `UPDATE` that clears the resume columns of rows it keeps
 * (`purgeExpiredResumeFiles`) — on `vacancy_applications`, class A — plus a join read of
 * `vacancies`. The existing cron spec mocks `DatabaseService`; a misclassification of either
 * table would first show as a `42501` on the 03:00 fire, inside a handler that swallows it.
 *
 * Only the object store and Google Indexing are stubbed: neither is a database, and the
 * question here is the grant. The stubbed `deleteOrThrow` resolves, so the code proceeds to the
 * statement under test exactly as it does in production after a successful R2 delete.
 */

const TAG = 'cron-real-db-spec'

describe.skipIf(!hasDatabaseUrl())(
  'VacanciesRetentionCronService as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let cron: VacanciesRetentionCronService
    const deletedKeys: string[] = []

    beforeAll(async () => {
      session = await openCrmAppSession()
      const s3 = {
        deleteOrThrow: async (key: string): Promise<void> => {
          deletedKeys.push(key)
        },
      } as unknown as S3Service
      const config = {
        get: () => 'https://landing.cron-real-db-spec.invalid',
      } as unknown as ConfigService<never, true>
      cron = new VacanciesRetentionCronService(
        session.databaseService,
        s3,
        {} as GoogleIndexingService,
        config,
      )
    }, 120_000)

    afterEach(async () => {
      deletedKeys.length = 0
      // Applications cascade with their vacancy.
      await session?.admin.query(`DELETE FROM vacancies WHERE slug LIKE $1`, [`${TAG}-%`])
    })

    afterAll(async () => {
      await session?.close()
    })

    async function insertVacancy(): Promise<string> {
      const id = randomUUID()
      await session.admin.query(
        `INSERT INTO vacancies
           (id, slug, title, description_md, domain, seniority, employment_type, location, status, created_by)
         VALUES ($1, $2, $3, 'x',
                 (enum_range(NULL::vacancy_domain))[1],
                 (enum_range(NULL::vacancy_seniority))[1],
                 (enum_range(NULL::vacancy_employment_type))[1],
                 'Remote', 'PUBLISHED', (SELECT id FROM users LIMIT 1))`,
        [id, `${TAG}-${id}`, TAG],
      )
      return id
    }

    async function insertApplication(
      vacancyId: string,
      opts: { status: 'NEW' | 'VIEWED' | 'REJECTED'; ageDays: number; resumeKey: string | null },
    ): Promise<string> {
      const id = randomUUID()
      await session.admin.query(
        `INSERT INTO vacancy_applications
           (id, vacancy_id, full_name, email, status, resume_s3_key, resume_size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() - ($8::int * interval '1 day'))`,
        [
          id,
          vacancyId,
          TAG,
          `${TAG}@example.invalid`,
          opts.status,
          opts.resumeKey,
          opts.resumeKey ? 1234 : null,
          opts.ageDays,
        ],
      )
      return id
    }

    async function row(id: string): Promise<{ resume_s3_key: string | null } | null> {
      const { rows } = await session.admin.query<{ resume_s3_key: string | null }>(
        `SELECT resume_s3_key FROM vacancy_applications WHERE id = $1`,
        [id],
      )
      return rows[0] ?? null
    }

    it('is connected as crm_app — not a superuser, not an owner of anything', async () => {
      expect(await session.identity()).toEqual({
        currentUser: 'crm_app',
        sessionUser: 'crm_app',
        isSuperuser: false,
        bypassesRls: false,
        ownedRelations: 0,
      })
    })

    it('purgeExpiredApplications: the DELETE (and the vacancies join read) are permitted to crm_app', async () => {
      const vacancy = await insertVacancy()
      const rejectedOld = await insertApplication(vacancy, {
        status: 'REJECTED',
        ageDays: RETENTION_DAYS + 10,
        resumeKey: `${TAG}/rejected-old.pdf`,
      })
      const rejectedFresh = await insertApplication(vacancy, {
        status: 'REJECTED',
        ageDays: RETENTION_DAYS - 10,
        resumeKey: null,
      })

      const deleted = await cron.purgeExpiredApplications()

      expect(deleted).toBeGreaterThanOrEqual(1)
      expect(await row(rejectedOld)).toBeNull()
      expect(await row(rejectedFresh)).not.toBeNull()
      expect(deletedKeys).toContain(`${TAG}/rejected-old.pdf`)
    })

    it('purgeExpiredResumeFiles: the UPDATE is permitted to crm_app and keeps the row', async () => {
      const vacancy = await insertVacancy()
      // NEW on an open vacancy: the 90-day row rule does not match, only the 180-day file rule.
      const old = await insertApplication(vacancy, {
        status: 'NEW',
        ageDays: FILE_RETENTION_DAYS + 10,
        resumeKey: `${TAG}/new-old.pdf`,
      })

      const purged = await cron.purgeExpiredResumeFiles()

      expect(purged).toBeGreaterThanOrEqual(1)
      expect(await row(old)).toEqual({ resume_s3_key: null })
    })

    it('control: with DELETE withdrawn from crm_app the row purge fails with 42501', async () => {
      const vacancy = await insertVacancy()
      const rejectedOld = await insertApplication(vacancy, {
        status: 'REJECTED',
        ageDays: RETENTION_DAYS + 10,
        resumeKey: null,
      })

      const state = await session.withPrivilegeWithdrawn('DELETE', 'vacancy_applications', () =>
        sqlstateOfRejection(() => cron.purgeExpiredApplications()),
      )

      expect(state).toBe('42501')
      expect(await row(rejectedOld)).not.toBeNull()
    })

    it('control: with UPDATE withdrawn from crm_app the file purge fails with 42501', async () => {
      const vacancy = await insertVacancy()
      const old = await insertApplication(vacancy, {
        status: 'NEW',
        ageDays: FILE_RETENTION_DAYS + 10,
        resumeKey: `${TAG}/control.pdf`,
      })

      const state = await session.withPrivilegeWithdrawn('UPDATE', 'vacancy_applications', () =>
        sqlstateOfRejection(() => cron.purgeExpiredResumeFiles()),
      )

      expect(state).toBe('42501')
      expect(await row(old)).toEqual({ resume_s3_key: `${TAG}/control.pdf` })
    })
  },
)
