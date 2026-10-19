import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS,
  MeetingRecorderRetentionCronService,
} from './meeting-recorder-retention.cron'

/**
 * MeetingRecorderRetentionCronService against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * `meeting_recorder_webhook_receipts` is class A (SELECT, INSERT, UPDATE, DELETE). The existing
 * cron spec mocks `DatabaseService`, so it cannot see a misclassification of this table — that
 * would first show as a `42501` on the 03:45 fire. Here the service's own `DELETE ... RETURNING`
 * runs through a pool connected as `crm_app`.
 */

const NAME = 'cron-real-db-spec connection'

describe.skipIf(!hasDatabaseUrl())(
  'MeetingRecorderRetentionCronService as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let cron: MeetingRecorderRetentionCronService
    let connectionId: string

    beforeAll(async () => {
      session = await openCrmAppSession()
      cron = new MeetingRecorderRetentionCronService(session.databaseService)
    }, 120_000)

    afterEach(async () => {
      // Receipts cascade with their connection.
      await session?.admin.query(`DELETE FROM meeting_recorder_connections WHERE name = $1`, [NAME])
    })

    afterAll(async () => {
      await session?.close()
    })

    async function insertReceipt(ageDays: number): Promise<string> {
      if (!connectionId || !(await connectionExists())) {
        connectionId = randomUUID()
        await session.admin.query(
          `INSERT INTO meeting_recorder_connections (id, name) VALUES ($1, $2)`,
          [connectionId, NAME],
        )
      }
      const id = randomUUID()
      await session.admin.query(
        `INSERT INTO meeting_recorder_webhook_receipts (id, connection_id, webhook_id, event_type, received_at)
         VALUES ($1, $2, $3, 'meeting.completed', now() - ($4::int * interval '1 day'))`,
        [id, connectionId, `wh-${id}`, ageDays],
      )
      return id
    }

    async function connectionExists(): Promise<boolean> {
      const { rowCount } = await session.admin.query(
        `SELECT 1 FROM meeting_recorder_connections WHERE id = $1`,
        [connectionId],
      )
      return rowCount === 1
    }

    async function exists(id: string): Promise<boolean> {
      const { rowCount } = await session.admin.query(
        `SELECT 1 FROM meeting_recorder_webhook_receipts WHERE id = $1`,
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

    it('purgeExpiredReceipts: the DELETE is permitted to crm_app and removes only receipts past the window', async () => {
      const expired = await insertReceipt(MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS + 5)
      const fresh = await insertReceipt(MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS - 5)

      const deleted = await cron.purgeExpiredReceipts()

      expect(deleted).toBeGreaterThanOrEqual(1)
      expect(await exists(expired)).toBe(false)
      expect(await exists(fresh)).toBe(true)
    })

    it('control: with DELETE withdrawn from crm_app the same call fails with 42501', async () => {
      const expired = await insertReceipt(MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS + 5)

      const state = await session.withPrivilegeWithdrawn(
        'DELETE',
        'meeting_recorder_webhook_receipts',
        () => sqlstateOfRejection(() => cron.purgeExpiredReceipts()),
      )

      expect(state).toBe('42501')
      expect(await exists(expired)).toBe(true)
    })
  },
)
