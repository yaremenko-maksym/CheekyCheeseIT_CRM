import { z } from 'zod'
import { NEW_NOTIFICATION_TYPES, notificationSubjectTypeSchema } from './notification-registry'

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
  'VACANCY_APPLICATION', // task-vacancies-api — ADMIN/HR: new public vacancy application
  // ── The ten types of the notifications-and-confirmations spec §7.2 ────────
  // (position 6). Their human-visible text lives in `notification-registry.ts`
  // — this enum only names the events. Order matches the spec's own grouping:
  // informing, action-required, admin-facing.
  ...NEW_NOTIFICATION_TYPES,
])
export type NotificationType = z.infer<typeof notificationTypeSchema>

// ---------------------------------------------------------------------------
// Notification DTO
// ---------------------------------------------------------------------------

/**
 * Safe relative-path validator for notification links.
 *
 * Must start with a single '/' (true relative path) and must NOT be:
 *   - Protocol-relative: '//evil.com'  (browsers treat as scheme-inherit → open-redirect)
 *   - Backslash-relative: '/\evil.com' (IE/Edge normalise to '//evil.com')
 *   - External URL: contains '://'
 *   - XSS URI: contains 'javascript:' (case-insensitive)
 * Null is allowed (no link).
 *
 * Security rationale: notification links are stored verbatim and rendered
 * as <a href={link}> in the header dropdown. Without this guard an attacker
 * who can create a notification (server-side emitter) could store an external
 * redirect or javascript: URI.
 *
 * MED-1 fix: added rejection of protocol-relative ('//') and backslash
 * ('/\') prefixes — both bypass the simple startsWith('/') check.
 */
export const safeNotificationLinkSchema = z
  .string()
  .max(500)
  .refine(
    (v) =>
      v.startsWith('/') &&
      !v.startsWith('//') &&
      !v.startsWith('/\\') &&
      !v.includes('://') &&
      !/javascript:/i.test(v),
    {
      message:
        "Link must be a true relative path starting with '/' (no protocol-relative '//…', backslash '/\\…', external URLs, or javascript:)",
    },
  )
  .nullable()

/**
 * Notification as returned by `GET /api/notifications`. `link` is a
 * relative front-end path (e.g. `/finance/invoices/<id>`) — clicking
 * the row in the header dropdown navigates to it AND marks the row as
 * read (single round-trip via the PATCH endpoint).
 */
export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string().min(1).max(255),
  body: z.string().nullable(),
  link: safeNotificationLinkSchema,
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // ── §7.1: тип события и идентификаторы объектов ──────────────────────────
  // `link` перестал быть источником правды для действия: кнопки и их подписи
  // клиент выводит из `type` + `subjectType` + `subjectId`
  // (`notification-registry.ts`). Колонка `link` осталась ради трёх старых
  // типов и как запасной путь для типа, которого клиент ещё не знает.
  subjectType: notificationSubjectTypeSchema.nullable(),
  subjectId: z.string().uuid().nullable(),
  /**
   * Второй участник события, когда он есть: новый участник команды в
   * `TEAM_NEW_MEMBER`, подтвердивший сотрудник в `APPROVAL_*`. Отдельной
   * колонкой, а не внутри `data`, потому что по нему строится адресация, а не
   * текст.
   */
  secondaryId: z.string().uuid().nullable(),
  /**
   * Факты события (суммы, проценты, снятые на момент события названия) — из
   * них клиент строит подробную строку. Форма зависит от `type`; разбирается
   * `notificationDataSchemaFor(type)`. `unknown`, а не конкретная форма,
   * потому что запись типа, которого клиент ещё не знает, обязана доехать и
   * отрендериться общим видом, а не уронить разбор всего списка.
   */
  data: z.unknown().nullable(),
  /**
   * §7.4: объекта, о котором уведомление, больше нет (удалён) либо
   * согласование погашено. Считается сервером при чтении списка — клиент
   * рисует честное «Проект удалён» вместо кнопки в белый экран.
   */
  subjectMissing: z.boolean(),
  /**
   * QA-M-3 / QA-L-2 (manual-qa круг 2, #664): объект цел, но убран в архив.
   * Отдельное поле, а не разновидность `subjectMissing`, потому что разными
   * будут и подпись, и правда: «Проект удалён» на архивном проекте — ложь, и
   * именно на неё жаловался живой прогон. Оба поля выводятся сервером из
   * одного состояния (`NotificationsService.mapNotification`), поэтому
   * «исчез и в архиве сразу» не бывает.
   */
  subjectArchived: z.boolean(),
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
