/**
 * `OutboxGateway` поверх настоящей базы — позиция 7a.
 *
 * Отделён от `NotificationEmailCronService` намеренно: крон отвечает за
 * РЕШЕНИЯ (сколько попыток, что считать отказом, когда хоронить), репозиторий
 * — за доступ к данным. Юнит-тест крона мокает этот интерфейс и потому
 * проверяет решения, а не форму SQL; сам SQL проверяется на живой Postgres
 * (`notification-email-delivery.integration.spec.ts`), потому что `FOR UPDATE
 * SKIP LOCKED` и предикат частичного индекса исполняет Postgres, а не мы.
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
import type { NotificationSubjectType } from '@crm/shared'
import { backoffMs, type DeliveryContext, type SkipReason } from './notification-email-outbox'
import type { ClaimedEmail, OutboxGateway } from './notification-email.cron'

/**
 * Срок аренды захваченной строки. Больше, чем самый долгий возможный запрос к
 * провайдеру (`FETCH_TIMEOUT_MS` = 10 с) с запасом на очередь пачки: пока
 * аренда не истекла, второй процесс ту же строку не возьмёт. Меньше самой
 * короткой паузы ретрая (минута), поэтому на нормальном пути аренда никогда
 * не определяет, когда строка вернётся в работу, — это делает бэкофф.
 */
const CLAIM_LEASE_SECONDS = 60

@Injectable()
export class OutboxRepository implements OutboxGateway {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Взять созревшие строки в работу.
   *
   * Один оператор: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
   * `SKIP LOCKED` — то, благодаря чему два процесса API (а в проде их может
   * стать два) не возьмут одну строку: второй просто пройдёт мимо
   * заблокированных, вместо того чтобы ждать первого. Без него параллельный
   * крон либо дублировал бы письма, либо стоял на блокировке.
   *
   * Сам `UPDATE` и есть захват: он двигает `next_attempt_at` на срок аренды и
   * увеличивает `attempts`. Отдельного статуса «в работе» нет — см. заголовок
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

    // Содержание письма — отдельным чтением, уже без блокировок: захват
    // состоялся, и строки никто другой не тронет до конца аренды.
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
   * Всё о получателе, что решает судьбу письма в момент отправки: жив ли он,
   * куда слать, не выключил ли он этот тип.
   *
   * **Одним запросом про человека, а не двумя.** `users LEFT JOIN user_emails`
   * — именно LEFT: у человека без единого адреса строк соединения нет, и
   * INNER JOIN не отличил бы «уволен» от «адреса нет», то есть потерял бы
   * ровно то различие, ради которого заведён `skip_reason`. Строка `users`
   * при этом есть всегда, пока есть строка очереди (внешний ключ с CASCADE).
   *
   * Настройка читается ТОЛЬКО по нужному типу: читать все отличия человека
   * ради одного значения значило бы платить за чужие типы на каждом письме.
   */
  async deliveryContextFor(userId: string, type: string): Promise<DeliveryContext> {
    const rows = await this.db.db
      .select({
        archivedAt: users.archivedAt,
        email: userEmails.email,
        kind: userEmails.kind,
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
      // Пользователя не нашли вовсе — тогда и адресов нет, и решение выйдет
      // `NO_ADDRESS`. Отдельной ветки этот случай не заслуживает: строка
      // очереди уходит вместе с пользователем (`ON DELETE CASCADE`), поэтому
      // доехать сюда без строки `users` можно только в гонке с удалением.
      archived: rows[0]?.archivedAt != null,
      addresses: rows.flatMap((r) =>
        r.email !== null && r.kind !== null ? [{ email: r.email, kind: r.kind }] : [],
      ),
      emailEnabled: pref?.emailEnabled ?? null,
    }
  }

  /**
   * `WHERE … status = 'QUEUED'` — тот же предикат и то же обоснование, что у
   * `scheduleRetry` ниже (SR-L-6, security-review PR #673 круг 2): аренда —
   * 60 секунд, а пятиминутный байпас зависшего прохода (SR-L-4) на короткое
   * время может дать двум проходам одну и ту же строку. Без предиката поздний
   * `markSent` зависшего прохода переписал бы уже терминальную строку (скажем,
   * `SKIPPED` после того как настройку выключили) обратно в `SENT`, и след
   * доставки в `notification_emails` — той самой таблице, по которой runbook
   * 7.2 учит читать результат — начал бы врать.
   */
  async markSent(id: string, email: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'SENT', sentAt: new Date(), sentToEmail: email, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /**
   * Терминально пометить строку «письма не будет» с причиной.
   *
   * Не `FAILED`: «не полагалось отправлять» и «не смогли отправить» — разные
   * факты, и сливать их в один статус значило бы звать чинить выключенный
   * человеком канал. `last_error` при этом остаётся пустым — ошибки не было.
   *
   * `WHERE … status = 'QUEUED'` (SR-L-6) — см. `markSent` выше: та же защита
   * от того же байпаса, симметричная во все три марка терминального статуса.
   */
  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'SKIPPED', skipReason: reason, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /** `WHERE … status = 'QUEUED'` (SR-L-6) — см. `markSent` выше. */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'FAILED', lastError: reason, updatedAt: new Date() })
      .where(and(eq(notificationEmails.id, id), eq(notificationEmails.status, 'QUEUED')))
  }

  /**
   * Вернуть строку в очередь с паузой.
   *
   * `WHERE … status = 'QUEUED'` — не украшение: строку могли похоронить
   * вручную (или это сделает будущая административная операция), пока шёл
   * запрос к провайдеру, и воскрешать её отложенной попыткой было бы
   * неверно.
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
