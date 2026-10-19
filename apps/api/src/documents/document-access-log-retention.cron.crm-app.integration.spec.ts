import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'
import {
  ACCESS_LOG_RETENTION_DAYS,
  DocumentAccessLogRetentionCronService,
} from './document-access-log-retention.cron'

/**
 * DocumentAccessLogRetentionCronService against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * `document_access_log` is the one audit log the API prunes (class `A-log-prunable`:
 * SELECT, INSERT, DELETE). `document-access-log-retention.cron.spec.ts` mocks
 * `DatabaseService`, so it stays green whatever the grants are; the failure it cannot see is a
 * `42501` on the first daily fire, inside a handler that swallows its errors. This spec runs the
 * service's own `DELETE` through a pool connected as `crm_app` and asserts that it succeeds, that
 * the pool really is `crm_app`, and that withdrawing the privilege makes the same call fail.
 */

const TAG = 'cron-real-db-spec'

describe.skipIf(!hasDatabaseUrl())(
  'DocumentAccessLogRetentionCronService as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let cron: DocumentAccessLogRetentionCronService

    beforeAll(async () => {
      session = await openCrmAppSession()
      cron = new DocumentAccessLogRetentionCronService(session.databaseService)
    }, 120_000)

    afterEach(async () => {
      await session?.admin.query(`DELETE FROM document_access_log WHERE metadata->>'spec' = $1`, [
        TAG,
      ])
    })

    afterAll(async () => {
      await session?.close()
    })

    /** Inserted as the migration role: `crm_app` may insert here too, but the fixture's age is the point. */
    async function insertEntry(ageDays: number): Promise<string> {
      const id = randomUUID()
      await session.admin.query(
        `INSERT INTO document_access_log (id, target_id, action, metadata, created_at)
         VALUES ($1, $2, 'VIEW', jsonb_build_object('spec', $3::text), now() - ($4::int * interval '1 day'))`,
        [id, randomUUID(), TAG, ageDays],
      )
      return id
    }

    async function exists(id: string): Promise<boolean> {
      const { rowCount } = await session.admin.query(
        `SELECT 1 FROM document_access_log WHERE id = $1`,
        [id],
      )
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

    it('purgeExpiredEntries: the DELETE is permitted to crm_app and removes only rows past the window', async () => {
      const expired = await insertEntry(ACCESS_LOG_RETENTION_DAYS + 5)
      const fresh = await insertEntry(ACCESS_LOG_RETENTION_DAYS - 5)

      const deleted = await cron.purgeExpiredEntries()

      expect(deleted).toBeGreaterThanOrEqual(1)
      expect(await exists(expired)).toBe(false)
      expect(await exists(fresh)).toBe(true)
    })

    it('control: with DELETE withdrawn from crm_app the same call fails with 42501 — the spec is sensitive to the grant', async () => {
      const expired = await insertEntry(ACCESS_LOG_RETENTION_DAYS + 5)

      const state = await session.withPrivilegeWithdrawn('DELETE', 'document_access_log', () =>
        sqlstateOfRejection(() => cron.purgeExpiredEntries()),
      )

      expect(state).toBe('42501')
      // Refused outright, not half-applied (ADR §4 "The bound").
      expect(await exists(expired)).toBe(true)
      // And the restore worked: the grant is back, so the call succeeds again.
      await expect(cron.purgeExpiredEntries()).resolves.toBeGreaterThanOrEqual(1)
      expect(await exists(expired)).toBe(false)
    })

    it('the cron handler itself purges when the grant is there', async () => {
      const expired = await insertEntry(ACCESS_LOG_RETENTION_DAYS + 5)
      const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      try {
        await expect(cron.handleRetention()).resolves.toBeUndefined()

        // The handler, not only the method it wraps, reached the database.
        expect(await exists(expired)).toBe(false)
        expect(logged).toHaveBeenCalledWith(
          expect.stringMatching(/^Document access log retention: deleted [1-9]\d* row\(s\)$/),
        )
      } finally {
        logged.mockRestore()
      }
    })

    it('the cron handler swallows the refusal — which is why only a real database can see it', async () => {
      const expired = await insertEntry(ACCESS_LOG_RETENTION_DAYS + 5)
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      try {
        await session.withPrivilegeWithdrawn('DELETE', 'document_access_log', async () => {
          await expect(cron.handleRetention()).resolves.toBeUndefined()
        })

        // Resolving proves nothing by itself: a handler that did nothing resolves too. What
        // distinguishes "swallowed a refusal" from "never ran" is the row it could not delete and
        // the failure it logged instead of throwing.
        expect(await exists(expired)).toBe(true)
        expect(logged).toHaveBeenCalledTimes(1)
        // Only the static message: how the error behind it is formatted is the handler's to
        // change, and is being changed elsewhere; that it logged and did not throw is the claim.
        expect(logged.mock.calls[0]?.[0]).toBe(
          'Document access log retention cron failed — will retry next cycle',
        )
      } finally {
        logged.mockRestore()
      }
    })
  },
)
