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
import { notificationEmails, notifications, userEmails } from '../database/schema'
import type { NotificationSubjectType } from '@crm/shared'
import { backoffMs, type AddressRow } from './notification-email-outbox'
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

  async addressesFor(userId: string): Promise<AddressRow[]> {
    const rows = await this.db.db
      .select({ email: userEmails.email, kind: userEmails.kind })
      .from(userEmails)
      .where(eq(userEmails.userId, userId))
    return rows
  }

  async markSent(id: string, email: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'SENT', sentAt: new Date(), sentToEmail: email, updatedAt: new Date() })
      .where(eq(notificationEmails.id, id))
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.db
      .update(notificationEmails)
      .set({ status: 'FAILED', lastError: reason, updatedAt: new Date() })
      .where(eq(notificationEmails.id, id))
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
