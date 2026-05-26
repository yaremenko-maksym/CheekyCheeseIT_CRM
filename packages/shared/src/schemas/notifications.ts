import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * In-app notification event types. Kept as a Zod enum even though the DB
 * column is VARCHAR(50) (forward-compatible) — every emitter must validate
 * against this enum before writing.
 *
 * Today only the Invoice Signing Epic emits notifications. Future epics
 * (transaction validation reminders, payout updates, …) will append new
 * values here without touching the DB schema.
 */
export const notificationTypeSchema = z.enum([
  'INVOICE_SIGN_REQUIRED', // counterparty must click "Подписать"
  'INVOICE_SIGNED', // ADMIN tracking — counterparty completed the sign
])
export type NotificationType = z.infer<typeof notificationTypeSchema>

// ---------------------------------------------------------------------------
// Notification DTO
// ---------------------------------------------------------------------------

/**
 * Notification as returned by `GET /api/notifications`. `link` is a
 * relative front-end path (e.g. `/crm/finance/invoices/<id>`) — clicking
 * the row in the header dropdown navigates to it AND marks the row as
 * read (single round-trip via the PATCH endpoint).
 */
export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string().min(1).max(255),
  body: z.string().nullable(),
  link: z.string().max(500).nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})
export type Notification = z.infer<typeof notificationSchema>

// ---------------------------------------------------------------------------
// List response (drives badge + dropdown)
// ---------------------------------------------------------------------------

/**
 * Response from `GET /api/notifications`. `unreadCount` is a server-side
 * computation (filtered count via the partial index) — the front-end uses
 * it directly for the badge instead of `items.filter(…)` so the count is
 * accurate even with a paginated `items` list.
 */
export const notificationsListResponseSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
})
export type NotificationsListResponse = z.infer<typeof notificationsListResponseSchema>

// ---------------------------------------------------------------------------
// List filters (query string)
// ---------------------------------------------------------------------------

export const notificationListFiltersSchema = z.object({
  unreadOnly: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(100).optional().default(10),
})
export type NotificationListFilters = z.infer<typeof notificationListFiltersSchema>
