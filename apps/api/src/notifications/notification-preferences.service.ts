/**
 * Channel settings — position 7a, §3 decision 6 («channels are configured by the
 * employee»).
 *
 * RBAC here is exactly one rule, and it is structural: **every method takes `userId` from the
 * session and is not parameterized by anything else.** The user identifier is absent from the
 * path and from the request body, so others' settings can be neither read nor
 * written — not because a check forbids it, but because there is no one to name
 * as the other party (`security-review`, pattern 2: authorization lives in the service
 * body, and it cannot be judged from the controller — there is nothing here to judge).
 *
 * No role differences by design: setting one's own email is not a privilege. All
 * six roles (`ADMIN`, `SENIOR`, `JUNIOR`, `HR`, `ACCOUNTANT`, `DROP`)
 * work with it identically, which is verified live in
 * `notification-preferences.rbac.integration.spec.ts`.
 */
import { Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import {
  isEmailChannelLocked,
  CONFIGURABLE_NOTIFICATION_TYPES,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesInput,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { notificationPreferences } from '../database/schema'

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * All ten types, not only those that have a row.
   *
   * The client must not know the default: if it did, the default would be written in
   * two places and would eventually diverge.
   */
  async listForUser(userId: string): Promise<NotificationPreferencesResponse> {
    const rows = await this.db.db
      .select({
        type: notificationPreferences.type,
        emailEnabled: notificationPreferences.emailEnabled,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))

    const stored = new Map(rows.map((r) => [r.type, r.emailEnabled]))

    return {
      items: CONFIGURABLE_NOTIFICATION_TYPES.map((type) => {
        const locked = isEmailChannelLocked(type)
        return {
          type,
          // A locked type is always returned as enabled, even if the database holds
          // "disabled" (a row from an earlier version or one entered by hand).
          // Otherwise a person would see a disabled toggle and keep
          // receiving emails — that is, the interface would lie about the state of the system.
          emailEnabled: locked ? true : (stored.get(type) ?? true),
          locked,
        }
      }),
    }
  }

  /**
   * Write the differences from the default and return the new state in full.
   *
   * Parsing (`updateNotificationPreferencesSchema`) has already rejected an attempt to
   * disable a locked type — such a request never reaches this method. Here
   * there is therefore no second check of the same thing: two checks of one rule in different
   * places silently diverge, while reading (`listForUser`) and queueing
   * (`shouldQueueEmail`) already ignore "disabled" for a locked type.
   */
  async updateForUser(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferencesResponse> {
    if (input.items.length > 0) {
      await this.db.db
        .insert(notificationPreferences)
        .values(input.items.map((i) => ({ userId, type: i.type, emailEnabled: i.emailEnabled })))
        // One row per pair (user, type) — the index
        // `uq_notification_preferences_user_type`. A repeated edit
        // overwrites rather than multiplies.
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.type],
          set: {
            // `excluded` — the value from the rejected insert, that is, what
            // the client sent.
            emailEnabled: sql`excluded.email_enabled`,
            updatedAt: new Date(),
          },
        })
    }
    return this.listForUser(userId)
  }
}
