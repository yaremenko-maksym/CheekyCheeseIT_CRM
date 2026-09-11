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
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  Notification as NotificationDto,
  NotificationListFilters,
  NotificationSubjectType,
  NotificationType,
  NotificationsListResponse,
} from '@crm/shared'
import { isNewNotificationType, notificationDataSchemaFor } from '@crm/shared'
import { safeNotificationLinkSchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  approvals,
  employeeContracts,
  nonDeletedTransactions,
  notifications,
  projects,
  teams,
  users,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import {
  approvalChecksFor,
  computeSubjectMissing,
  groupSubjectIds,
  liveApprovalKey,
  type SubjectRef,
} from './notification-subject-resolver'

/**
 * Что производитель кладёт в запись. §7.1: тип события и идентификаторы
 * объектов — НЕ готовые кнопки и НЕ готовый текст подробностей.
 *
 * `title` при этом остаётся и обязателен: это НЕЙТРАЛЬНЫЙ заголовок без сумм и
 * процентов, один на тип (`NOTIFICATION_TITLES`). Он же — то единственное, что
 * позиция 7 имеет право положить в письмо: письмо уходит на личную почту вне
 * нашего контура, и цифры туда не идут (§10).
 */
export type CreateNotificationInput = {
  userId: string
  type: NotificationType
  title: string
  body?: string | null
  link?: string | null
  subjectType?: NotificationSubjectType | null
  subjectId?: string | null
  secondaryId?: string | null
  /** Факты события. Форма задана `notificationDataSchemaFor(type)`. */
  data?: unknown
  /**
   * Идемпотентность там, где событие может повториться (`<TYPE>:<subjectId>`).
   * `undefined` = дублей не боимся: повторное предложение доли ОБЯЗАНО спросить
   * заново, и глушить его было бы потерянным подтверждением.
   */
  dedupeKey?: string | null
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly telemetry: TelemetryErrorsService,
  ) {}

  /**
   * Insert a new notification row. The schema enum is the single source of
   * truth for `type` values; callers should reference the shared
   * `NotificationType` so a typo at the emitter site fails at compile time.
   *
   * Security: link is validated server-side against safeNotificationLinkSchema
   * (relative path only, no '://' or 'javascript:') before insert to prevent
   * storing open-redirect or XSS payloads.
   */
  async create(input: CreateNotificationInput): Promise<NotificationDto | null> {
    return this.db.db.transaction((tx) => this.createInTx(tx, input))
  }

  /**
   * Тот же код, но ВНУТРИ транзакции, которую открыл вызывающий. Именно этим
   * пользуются производители: «каждый вызов производителя — внутри той же
   * транзакции, что и событие, либо после её коммита с явным обоснованием;
   * уведомление о несостоявшемся событии недопустимо». Внутри транзакции это
   * не дисциплина, а свойство: откатилось событие — откатилась и запись.
   *
   * `create()` выше — тонкая обёртка, открывающая свою транзакцию, чтобы две
   * точки входа не могли разойтись (тот же приём, что у
   * `ApprovalsService.propose` / `proposeInTx`).
   *
   * Возвращает `null`, когда запись погашена идемпотентностью — вызывающему это
   * знать не обязательно, но и врать «создал» нельзя.
   */
  async createInTx(tx: DrizzleTx, input: CreateNotificationInput): Promise<NotificationDto | null> {
    // Validate link server-side before insert (defence-in-depth: shared schema
    // also validates on the DTO layer, but the service is the last gate before DB).
    if (input.link != null) {
      const result = safeNotificationLinkSchema.safeParse(input.link)
      if (!result.success) {
        return this.refuse(
          input,
          // Stryker disable next-line OptionalChaining: issues[0] существует всегда при неудачном разборе — мутант ненаблюдаем
          `Invalid notification link: ${result.error.issues[0]?.message ?? 'invalid'}`,
        )
      }
    }

    // Данные разбираются формой СВОЕГО типа прямо здесь — последний рубеж перед
    // базой, ровно как со ссылкой выше. Клиент, встретив неразбираемые данные,
    // покажет общий вид (AC2) и не упадёт; но пропускать в базу заведомо
    // нечитаемую запись — значит соглашаться, что кнопка у неё не появится.
    if (isNewNotificationType(input.type) && input.data !== undefined && input.data !== null) {
      const parsed = notificationDataSchemaFor(input.type).safeParse(input.data)
      if (!parsed.success) {
        // `issues` непустой всегда, когда разбор не удался, — это свойство
        // самой Zod, а не наше допущение. Значит, снятие `?.` не наблюдается
        // ничем: списка с нулём причин отказа не порождает ни одна форма, и
        // запасное «invalid» недостижимо. Оставлено страховкой на случай смены
        // библиотеки — но проверить его нечем.
        return this.refuse(
          input,
          // Stryker disable next-line OptionalChaining: issues[0] существует всегда при неудачном разборе — мутант ненаблюдаем
          `Invalid notification data for ${input.type}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        )
      }
    }

    const values = {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      secondaryId: input.secondaryId ?? null,
      data: input.data ?? null,
      dedupeKey: input.dedupeKey ?? null,
    }

    // Идемпотентность по (type, subjectId, userId): ключ несёт первые два,
    // частичный уникальный индекс `uq_notifications_user_dedupe` добавляет
    // получателя. `DO NOTHING` вместо предварительного SELECT — иначе между
    // проверкой и вставкой остаётся окно, в которое повторная доставка
    // события пролезает целиком.
    const rows =
      values.dedupeKey === null
        ? await tx.insert(notifications).values(values).returning()
        : await tx
            .insert(notifications)
            .values(values)
            .onConflictDoNothing({
              target: [notifications.userId, notifications.dedupeKey],
              // Предикат ЧАСТИЧНОГО индекса — без него Postgres не сопоставит
              // конфликт с `uq_notifications_user_dedupe` и упадёт на
              // «no unique or exclusion constraint matching».
              where: sql`${notifications.dedupeKey} IS NOT NULL`,
            })
            .returning()

    const row = rows[0]
    if (!row) {
      if (values.dedupeKey !== null) return null
      throw new Error('Failed to insert notification')
    }
    return this.mapNotification(row)
  }

  /**
   * Уведомление не имеет права вето над событием (SR-H-1, security-review
   * круг 1).
   *
   * Пять производителей из шести зовут `createInTx` ВНУТРИ транзакции самого
   * события — это осознанный выбор: «уведомление о несостоявшемся событии
   * недопустимо». Но у выбора была вторая половина, которую никто не проверял:
   * пока эта ветка БРОСАЛА, неудачный разбор данных откатывал и саму
   * транзакцию. Синьор не мог отказать, потому что причина отказа оказалась
   * длиннее потолка формы уведомления; проект не создавался из-за длины
   * названия. Цена ошибки в описании события равнялась цене ошибки в самом
   * событии — несоразмерно.
   *
   * Поэтому: запись пропускается, событие живёт. Пропуск при этом громкий —
   * `logger.error` в консоли сервера И строка в телеметрии ошибок, которая
   * доезжает до дайджеста. Тихо потерянное уведомление было бы вторым концом
   * той же палки.
   *
   * Возвращается `null` — тот же ответ, что и у погашенной идемпотентностью
   * записи: вызывающему не нужно различать «не создал, потому что дубль» и
   * «не создал, потому что данные не той формы», а нужно не упасть.
   */
  private async refuse(input: CreateNotificationInput, reason: string): Promise<null> {
    this.logger.error(
      `Уведомление пропущено (событие не откатываем): ${reason} [type=${input.type} userId=${input.userId}]`,
    )
    try {
      await this.telemetry.recordError({
        source: 'API',
        message: `Notification skipped — ${reason}`,
        route: '/api/notifications',
        userId: input.userId,
        // Ни `title`, ни `data` сюда не едут: дайджест уходит в отдельный
        // репозиторий, а форма данных уже названа типом и сообщением.
        meta: { type: input.type, subjectType: input.subjectType ?? null },
      })
    } catch (err) {
      // Телеметрия — канал наблюдения, а не участник события. Её отказ не
      // имеет права сделать то, что мы только что запретили разбору данных:
      // уронить транзакцию события.
      this.logger.error(
        `Телеметрия не приняла отказ уведомления: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return null
  }

  /**
   * Пачка получателей одного события. Отдельный метод, а не цикл на стороне
   * производителя, потому что «кому уходит» — свойство события, и держать его
   * в одном месте дешевле, чем повторять цикл в пяти модулях.
   */
  async createManyInTx(tx: DrizzleTx, inputs: CreateNotificationInput[]): Promise<void> {
    for (const input of inputs) {
      await this.createInTx(tx, input)
    }
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

    // §7.4. Считается ЗДЕСЬ, а не на каждой целевой странице: страниц пять, а
    // список один, и «объекта больше нет» — свойство записи на момент чтения, а
    // не свойство маршрута.
    const missing = await this.resolveSubjectMissing(rows)

    return {
      items: rows.map((r) => this.mapNotification(r, missing.has(r.id))),
      unreadCount,
    }
  }

  /**
   * Половина §7.4 с запросами. Решение принимает
   * `notification-subject-resolver.ts` — здесь только по одному запросу на
   * встреченный вид объекта плюс один на живость согласований.
   *
   * Транзакции читаются через `non_deleted_transactions` (VIEW), а не из
   * `transactions`: этот модуль вне `finance/**`, и мягко удалённая транзакция
   * для него не существует — ровно то, что нужно сказать про кнопку.
   */
  private async resolveSubjectMissing(
    rows: (typeof notifications.$inferSelect)[],
  ): Promise<Set<string>> {
    const refs: SubjectRef[] = rows.map((r) => ({
      userId: r.userId,
      type: r.type,
      subjectType: (r.subjectType as NotificationSubjectType | null) ?? null,
      subjectId: r.subjectId ?? null,
    }))

    const existingIdsByType = new Map<NotificationSubjectType, Set<string>>()
    for (const [subjectType, ids] of groupSubjectIds(refs)) {
      existingIdsByType.set(subjectType, await this.loadExistingIds(subjectType, ids))
    }

    const liveApprovalKeys = new Set<string>()
    const checks = approvalChecksFor(refs)
    if (checks.length > 0) {
      const live = await this.db.db
        .select({
          subjectType: approvals.subjectType,
          subjectId: approvals.subjectId,
          approverUserId: approvals.approverUserId,
        })
        .from(approvals)
        .where(
          and(
            isNull(approvals.supersededAt),
            inArray(
              approvals.subjectId,
              checks.map((c) => c.subjectId),
            ),
          ),
        )
      for (const row of live) {
        liveApprovalKeys.add(liveApprovalKey(row.subjectType, row.subjectId, row.approverUserId))
      }
    }

    const missing = new Set<string>()
    for (const [index, ref] of refs.entries()) {
      if (computeSubjectMissing(ref, existingIdsByType, liveApprovalKeys)) {
        missing.add(rows[index]!.id)
      }
    }
    return missing
  }

  private async loadExistingIds(
    subjectType: NotificationSubjectType,
    ids: string[],
  ): Promise<Set<string>> {
    switch (subjectType) {
      case 'PROJECT': {
        const found = await this.db.db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, ids))
        return new Set(found.map((r) => r.id))
      }
      case 'TEAM': {
        const found = await this.db.db
          .select({ id: teams.id })
          .from(teams)
          .where(inArray(teams.id, ids))
        return new Set(found.map((r) => r.id))
      }
      case 'USER': {
        const found = await this.db.db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, ids))
        return new Set(found.map((r) => r.id))
      }
      case 'TRANSACTION': {
        const found = await this.db.db
          .select({ id: nonDeletedTransactions.id })
          .from(nonDeletedTransactions)
          .where(inArray(nonDeletedTransactions.id, ids))
        return new Set(found.map((r) => r.id))
      }
      default: {
        const found = await this.db.db
          .select({ id: employeeContracts.id })
          .from(employeeContracts)
          .where(inArray(employeeContracts.id, ids))
        return new Set(found.map((r) => r.id))
      }
    }
  }

  /**
   * Mark a single notification as read. Throws 404 if missing or if the row
   * belongs to a different user — a uniform 404 avoids leaking notification
   * existence to other users (existence oracle, SEC-10).
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const row = await this.db.db.query.notifications.findFirst({
      where: eq(notifications.id, notificationId),
    })
    if (!row) throw new NotFoundException('Уведомление не найдено')
    if (row.userId !== userId) {
      // SEC-10: return 404 (not 403) to avoid leaking that the notification
      // exists but belongs to another user (existence oracle).
      throw new NotFoundException('Уведомление не найдено')
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

  /**
   * Hard-delete a single notification row. Used by the Trash icon in the
   * header bell dropdown. Ownership semantics:
   *   - 404 when the row does not exist
   *   - 404 (not 403) when the row belongs to a different user — avoids leaking
   *     existence (SEC-10 existence oracle).
   * (No soft delete — notifications are ephemeral, recreated by the system
   *  whenever the underlying event re-occurs.)
   */
  async delete(userId: string, notificationId: string): Promise<void> {
    const row = await this.db.db.query.notifications.findFirst({
      where: eq(notifications.id, notificationId),
    })
    if (!row) throw new NotFoundException('Уведомление не найдено')
    if (row.userId !== userId) {
      // SEC-10: return 404 (not 403) to avoid leaking that the notification
      // exists but belongs to another user (existence oracle).
      throw new NotFoundException('Уведомление не найдено')
    }
    await this.db.db.delete(notifications).where(eq(notifications.id, notificationId))
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapNotification(
    row: typeof notifications.$inferSelect,
    subjectMissing = false,
  ): NotificationDto {
    return {
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body ?? null,
      link: row.link ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      subjectType: (row.subjectType as NotificationSubjectType | null) ?? null,
      subjectId: row.subjectId ?? null,
      secondaryId: row.secondaryId ?? null,
      data: row.data ?? null,
      subjectMissing,
    }
  }
}
