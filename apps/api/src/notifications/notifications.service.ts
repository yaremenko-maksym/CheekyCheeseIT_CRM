/**
 * NotificationsService — server-side in-app notifications backing the header
 * bell + dropdown. PHASE 1 had a front-end-only stub; the Invoice Signing
 * Epic upgrades it to a persistent log (`notifications` table) shared across
 * sessions.
 *
 * Surface:
 *   - `create(...)` — single emitter, called by InvoicesService (and future
 *     epics) whenever a user-visible event happens.
 *   - `listForUser(...)` — fetched by the header dropdown on a 30s poll
 *     (WebSockets are deliberately out of scope for v1).
 *   - `markRead` / `markAllRead` — flip `read_at` so the badge count drops.
 *
 * Why a thin service: the table is intentionally schema-flat (no JSON blob,
 * no event-source) so emitters validate against the Zod `notificationType`
 * enum at the boundary instead of reusing a heavier event bus. Adding new
 * notification types only requires appending to the enum + a single emitter
 * call site.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type {
  Notification as NotificationDto,
  NotificationListFilters,
  NotificationType,
  NotificationsListResponse,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { notifications } from '../database/schema'

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Insert a new notification row. The schema enum is the single source of
   * truth for `type` values; callers should reference the shared
   * `NotificationType` so a typo at the emitter site fails at compile time.
   */
  async create(input: {
    userId: string
    type: NotificationType
    title: string
    body?: string | null
    link?: string | null
  }): Promise<NotificationDto> {
    const [row] = await this.db.db
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
      })
      .returning()

    if (!row) throw new Error('Failed to insert notification')
    return this.mapNotification(row)
  }

  /**
   * Header dropdown payload. Returns the N most-recent notifications for the
   * user (default 10, capped at 100) and a server-computed `unreadCount` that
   * drives the badge bubble. The unread count is intentionally derived from
   * the full set, not the paginated `items.length`, so the badge stays
   * accurate even when the dropdown caps at 10.
   */
  async listForUser(
    userId: string,
    opts: NotificationListFilters,
  ): Promise<NotificationsListResponse> {
    const limit = opts.limit ?? 10

    // Conditional where: when `unreadOnly` is set, also AND read_at IS NULL.
    // The partial index `idx_notifications_user_unread` covers this path.
    const where = opts.unreadOnly
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId)

    const rows = await this.db.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)

    // Unread count is always for the user globally, regardless of the filter.
    // The partial index makes this a constant-cost lookup at any list size.
    const unreadRows = await this.db.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))

    const unreadCount = unreadRows[0]?.count ?? 0

    return {
      items: rows.map((r) => this.mapNotification(r)),
      unreadCount,
    }
  }

  /**
   * Mark a single notification as read. Throws 404 if missing, 403 if the
   * caller is not the owner — we deliberately surface a different code from
   * 404 here so the front-end can distinguish (e.g. show "permission denied"
   * vs "already-deleted" toasts).
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const row = await this.db.db.query.notifications.findFirst({
      where: eq(notifications.id, notificationId),
    })
    if (!row) throw new NotFoundException('Уведомление не найдено')
    if (row.userId !== userId) {
      throw new ForbiddenException('Это уведомление принадлежит другому пользователю')
    }
    if (row.readAt) return // idempotent
    await this.db.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, notificationId))
  }

  /**
   * Mark every unread notification for `userId` as read. Used by the
   * "Прочитать всё" footer button in the header dropdown. One UPDATE — no
   * reads required.
   */
  async markAllRead(userId: string): Promise<void> {
    await this.db.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapNotification(row: typeof notifications.$inferSelect): NotificationDto {
    return {
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body ?? null,
      link: row.link ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
