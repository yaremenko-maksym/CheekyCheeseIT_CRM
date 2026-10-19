import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
import { hasDatabaseUrl } from '../test/require-real-db'
import { NotificationEmailCronService } from './notification-email.cron'
import { OutboxRepository } from './notification-email.repository'

/**
 * NotificationEmailCronService against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * This is the cron the ADR's count does not name: it never touches `DatabaseService` itself — it
 * calls `OutboxRepository`, which issues `UPDATE notification_emails` (claim: `attempts + 1`,
 * `next_attempt_at`; then `markSent` / `markFailed` / `markSkipped` / `scheduleRetry`). Its unit
 * spec mocks the gateway and `notification-email-delivery.integration.spec.ts` runs the real
 * repository as the MIGRATION role, which owns the table and so cannot see a missing grant.
 * Here the real cron drains a real queued row through a pool connected as `crm_app`; only the
 * HTTP call to the mail provider is stubbed.
 *
 * The cron runs every 15 seconds, so a `42501` here would not be one failed run but a silent
 * stop of all e-mail until the next deploy — which is why the claim `UPDATE` is the one asserted.
 */

const TAG = 'cron-real-db-spec'

describe.skipIf(!hasDatabaseUrl())(
  'NotificationEmailCronService as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let cron: NotificationEmailCronService
    let sent: Array<{ to: string[] }> = []
    const userIds: string[] = []

    beforeAll(async () => {
      session = await openCrmAppSession()
      const mailer = {
        isConfigured: true,
        send: async (input: { to: string[] }) => {
          sent.push({ to: input.to })
        },
      }
      const config = {
        get: (key: string) =>
          key === 'FRONTEND_URL' ? 'https://app.cron-real-db-spec.invalid' : 'hr@example.invalid',
      }
      cron = new NotificationEmailCronService(
        new OutboxRepository(session.databaseService),
        mailer as never,
        makeTelemetryErrorsStub() as never,
        config as never,
      )
    }, 120_000)

    afterEach(async () => {
      sent = []
      // notifications, notification_emails and user_emails cascade with the user.
      for (const id of userIds.splice(0)) {
        await session?.admin.query(`DELETE FROM users WHERE id = $1`, [id])
      }
    })

    afterAll(async () => {
      await session?.close()
    })

    /** A recipient with an address, and one QUEUED, due e-mail for them. Returns the queue row id. */
    async function queueEmail(): Promise<string> {
      const userId = randomUUID()
      userIds.push(userId)
      const email = `${TAG}-${userId}@example.invalid`
      await session.admin.query(
        `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, 'SENIOR')`,
        [userId, email, TAG],
      )
      await session.admin.query(
        `INSERT INTO user_emails (user_id, email, kind) VALUES ($1, $2, 'PERSONAL')`,
        [userId, email],
      )
      const notificationId = randomUUID()
      await session.admin.query(
        `INSERT INTO notifications (id, user_id, type, title, subject_type, subject_id, data)
         VALUES ($1, $2, 'TEAM_MEMBER_ADDED', $3, 'TEAM', $4, '{"teamName":"x"}'::jsonb)`,
        [notificationId, userId, TAG, randomUUID()],
      )
      const emailId = randomUUID()
      await session.admin.query(
        `INSERT INTO notification_emails (id, notification_id, user_id, status, next_attempt_at)
         VALUES ($1, $2, $3, 'QUEUED', now() - interval '1 minute')`,
        [emailId, notificationId, userId],
      )
      return emailId
    }

    async function state(id: string): Promise<{ status: string; attempts: number } | null> {
      const { rows } = await session.admin.query<{ status: string; attempts: number }>(
        `SELECT status::text, attempts FROM notification_emails WHERE id = $1`,
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
        roleMemberships: 0,
      })
    })

    it('drainOnce: the claim UPDATE and the markSent UPDATE are permitted to crm_app', async () => {
      const id = await queueEmail()

      await cron.drainOnce()

      expect(await state(id)).toEqual({ status: 'SENT', attempts: 1 })
      expect(sent).toHaveLength(1)
    })

    it('control: with UPDATE withdrawn from crm_app the drain fails with 42501 and nothing is sent', async () => {
      const id = await queueEmail()

      const code = await session.withPrivilegeWithdrawn('UPDATE', 'notification_emails', () =>
        sqlstateOfRejection(() => cron.drainOnce()),
      )

      expect(code).toBe('42501')
      // Refused outright: still queued, never claimed, nothing went out.
      expect(await state(id)).toEqual({ status: 'QUEUED', attempts: 0 })
      expect(sent).toHaveLength(0)
    })
  },
)
