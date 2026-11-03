/**
 * `OutboxGateway` over the real database — position 7a.
 *
 * Separated from `NotificationEmailCronService` on purpose: the cron owns
 * DECISIONS (how many attempts, what counts as failure, when to bury), the repository
 * owns data access. The cron's unit test mocks this interface and therefore
 * checks decisions, not the SQL shape; the SQL itself is checked on a live Postgres
 * (`notification-email-delivery.integration.spec.ts`), because `FOR UPDATE
 * SKIP LOCKED` and the partial-index predicate are executed by Postgres, not by us.
 */
import { Injectable } from '@nestjs/common'
import { and, asc, eq, sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import {
  notificationEmails,
  notificationPreferences,
  notifications,
  userEmails,
  users,
} from '../database/schema'
import { resolveLocale, type NotificationSubjectType } from '@crm/shared'
import { backoffMs, type DeliveryContext, type SkipReason } from './notification-email-outbox'
import type { ClaimedEmail, OutboxGateway } from './notification-email.cron'
import type { NotificationEmailSource } from './notification-email-copy'
import { approvalIdFromData, type SubjectResolution } from './notification-subject-resolver'
import { NotificationSubjectStateService } from './notification-subject-state.service'

/**
 * Lease term of a claimed row. Longer than the longest possible request to the
 * provider (`FETCH_TIMEOUT_MS` = 10 s) with a margin for the batch queue: while
 * the lease has not expired, a second process will not take the same row. Shorter than the
 * shortest retry pause (one minute), so on the normal path the lease never
 * decides when a row returns to work — the backoff does that.
 */
const CLAIM_LEASE_SECONDS = 60

@Injectable()
export class OutboxRepository implements OutboxGateway {
  /**
   * The same device as `NotificationsService.subjectStates`: not a DI parameter of the
   * constructor but a field built right here — `new OutboxRepository(db)`
   * with one argument is assembled by hand in several specs
   * (`notification-email.repository.spec.ts`,
   * `notification-email-delivery.integration.spec.ts`), and adding a second required
   * parameter to them for the sake of a service with no state of its own is pointless.
   */
  private readonly subjectStates: NotificationSubjectStateService

  constructor(private readonly db: DatabaseService) {
    this.subjectStates = new NotificationSubjectStateService(db)
  }

  /**
   * Take the due rows into work.
   *
   * One statement: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
   * `SKIP LOCKED` — the reason two API processes (and in production there may
   * become two) will not take the same row: the second one simply skips past the
   * locked rows instead of waiting for the first. Without it a parallel
   * cron would either duplicate emails or stand waiting on a lock.
   *
   * The UPDATE itself is the claim: it moves `next_attempt_at` by the lease term and
   * increments `attempts`. There is no separate "in work" status — see the header
   * `notification-email.cron.ts`.
   */
  async claimDue(limit: number): Promise<ClaimedEmail[]> {
    const claimed = await this.db.db.execute<{ id: string }>(sql`
      UPDATE ${notificationEmails}
         SET attempts = ${notificationEmails.attempts} + 1,
             next_attempt_at = now() + (${CLAIM_LEASE_SECONDS} || ' seconds')::interval,
             updated_at = now()
       WHERE id IN (
         SELECT id
           FROM ${notificationEmails}
          WHERE status = 'QUEUED'
            AND next_attempt_at <= now()
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id
    `)

    const ids = claimed.rows.map((r) => r.id)
    if (ids.length === 0) return []

    // The message content — a separate read, now without locks: the claim
    // has happened, and no other process touches the rows until the lease ends.
    const rows = await this.db.db
      .select({
        id: notificationEmails.id,
        userId: notificationEmails.userId,
        attempts: notificationEmails.attempts,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        subjectType: notifications.subjectType,
        subjectId: notifications.subjectId,
        data: notifications.data,
      })
      .from(notificationEmails)
      .innerJoin(notifications, eq(notifications.id, notificationEmails.notificationId))
      .where(sql`${notificationEmails.id} IN ${ids}`)
      .orderBy(asc(notificationEmails.createdAt))

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      attempts: r.attempts,
      notification: {
        type: r.type,
        title: r.title,
        body: r.body,
        link: r.link,
        subjectType: r.subjectType as NotificationSubjectType | null,
        subjectId: r.subjectId,
        data: r.data,
      },
    }))
  }

  /**
   * Everything about the recipient that determines the fate of the email at the moment of sending: whether they are alive,
   * where to send, whether they switched this type off.
   *
   * **One query about the person, not two.** `users LEFT JOIN user_emails`
   * — specifically LEFT: a person with no address at all has no join rows, and
   * an INNER JOIN would not distinguish "dismissed" from "no address", that is, it would lose
   * exactly the difference for which `skip_reason` was created. The `users` row
   * is always present while a queue row exists (foreign key with CASCADE).
   *
   * The setting is read ONLY for the needed type: reading all of a person's differences
   * for one value would mean paying for others' types on every email.
   */
  async deliveryContextFor(userId: string, type: string): Promise<DeliveryContext> {
    const rows = await this.db.db
      .select({
        archivedAt: users.archivedAt,
        email: userEmails.email,
        kind: userEmails.kind,
        locale: users.locale,
      })
      .from(users)
      .leftJoin(userEmails, eq(userEmails.userId, users.id))
      .where(eq(users.id, userId))

    const [pref] = await this.db.db
      .select({ emailEnabled: notificationPreferences.emailEnabled })
      .from(notificationPreferences)
      .where(
        and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type)),
      )

    return {
      // The user was not found at all — then there are no addresses either, and the decision will be
      // `NO_ADDRESS`. This case does not merit a separate branch: the queue row
      // leaves together with the user (`ON DELETE CASCADE`), so
      // reaching here without a `users` row is possible only in a race with deletion.
      archived: rows[0]?.archivedAt != null,
      addresses: rows.flatMap((r) =>
        r.email !== null && r.kind !== null ? [{ email: r.email, kind: r.kind }] : [],
      ),
      emailEnabled: pref?.emailEnabled ?? null,
      // The RECIPIENT's language, read at the moment of sending (not enqueueing): a locale
      // changed between the event and the sending, or between retries, is taken into account.
      // `resolveLocale` — garbage / `null` / "no user" yield `uk`, not
      // an exception; the cron reads neither cookies nor headers — it has no request.
      locale: resolveLocale([rows[0]?.locale ?? null]),
    }
  }

  /**
   * The state of the email's object — backlog 208. Called by the cron ONLY for the three
   * types requiring action (`isActionRequiredNotificationType`; the gate lives
   * in `NotificationEmailCronService.deliver`, not here — see the doc comment
   * `OutboxGateway.resolveSubjectState`).
   *
   * Resolved by the same resolver as the popup: the `SubjectRef` is built from exactly the same
   * four fields as in `NotificationsService.resolveSubjectStates`
   * (`type`, `subjectType`, `subjectId`, `approvalId` from `data`), and the query
   * goes through the same `NotificationSubjectStateService` — not a second query
   * written anew against the same tables.
   */
  async resolveSubjectState(
    userId: string,
    notification: NotificationEmailSource,
  ): Promise<SubjectResolution> {
    return this.subjectStates.resolveOne(userId, {
      userId,
      type: notification.type,
      subjectType: notification.subjectType,
      subjectId: notification.subjectId,
      approvalId: approvalIdFromData(notification.data),
    })
  }

  /**
   * `WHERE … status = 'QUEUED'` — the same predicate and the same reasoning as
   * `scheduleRetry` below (SR-L-6, security-review PR #673 round 2): the lease is
   * 60 seconds, and the five-minute bypass of a hung pass (SR-L-4) for a short
   * time could give two passes the same row. Without the predicate a late
   * `markSent` from the hung pass would rewrite an already terminal row (say,
   * `SKIPPED` after the setting was switched off) back to `SENT`, and the trace
   * of delivery in `notification_emails` — the very table by which runbook
   * 7.2 teaches reading the result — would start lying.
   */
  async markSent(id: string, email: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'SENT', sentAt: new Date(), sentToEmail: email, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /**
   * Terminally mark the row "no email will be sent" with a reason.
   *
   * Not `FAILED`: "was not due to be sent" and "could not send" are different
   * facts, and merging them into one status would mean calling for a human to fix a
   * deliberately disabled channel. `last_error` stays empty — there was no error.
   *
   * `WHERE … status = 'QUEUED'` (SR-L-6) — see `markSent` above: the same guard
   * against the same bypass, symmetric across all three terminal-status marks.
   */
  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'SKIPPED', skipReason: reason, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /** `WHERE … status = 'QUEUED'` (SR-L-6) — see `markSent` above. */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'FAILED', lastError: reason, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /**
   * Return the row to the queue with a pause.
   *
   * `WHERE … status = 'QUEUED'` — not decoration: the row could have been buried
   * manually (or a future administrative operation may do it) while the
   * request to the provider was in flight, and resurrecting it with a deferred attempt would be
   * wrong.
   */
  async scheduleRetry(id: string, reason: string, attempts: number): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({
        lastError: reason,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        updatedAt: new Date(),
      })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }
}
