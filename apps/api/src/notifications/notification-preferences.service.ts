/**
 * Настройки каналов — позиция 7a, §3 решение 6 («каналы настраивает сам
 * сотрудник»).
 *
 * RBAC здесь ровно один и он структурный: **каждый метод берёт `userId` из
 * сессии и ничем другим не параметризован.** Идентификатора пользователя нет
 * ни в пути, ни в теле запроса, поэтому чужие настройки нельзя ни прочитать,
 * ни записать — не потому, что проверка это запрещает, а потому, что назвать
 * чужого некому (`security-review`, паттерн 2: авторизация живёт в теле
 * сервиса, и судить о ней по контроллеру нельзя — здесь судить не о чем).
 *
 * Ролевых различий нет намеренно: настройка своей почты — не привилегия. Все
 * шесть ролей (`ADMIN`, `SENIOR`, `JUNIOR`, `HR`, `ACCOUNTANT`, `DROP`)
 * работают с ней одинаково, что и проверяется живьём в
 * `notification-preferences.rbac.integration.spec.ts`.
 */
import { Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import {
  isEmailChannelLocked,
  NEW_NOTIFICATION_TYPES,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesInput,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { notificationPreferences } from '../database/schema'

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Все десять типов, а не только те, у кого есть строка.
   *
   * Клиент не должен знать умолчание: знай он его, оно было бы записано в
   * двух местах и однажды разошлось бы.
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
      items: NEW_NOTIFICATION_TYPES.map((type) => {
        const locked = isEmailChannelLocked(type)
        return {
          type,
          // Запертый тип отдаётся включённым ВСЕГДА, даже если в базе лежит
          // «выключено» (строка от прежней версии или вписанная руками).
          // Иначе человек видел бы выключенный переключатель и продолжал
          // получать письма — то есть интерфейс врал бы о состоянии системы.
          emailEnabled: locked ? true : (stored.get(type) ?? true),
          locked,
        }
      }),
    }
  }

  /**
   * Записать отличия от умолчания и вернуть новое состояние целиком.
   *
   * Разбор (`updateNotificationPreferencesSchema`) уже отверг попытку
   * выключить запертый тип — до этого метода такой запрос не доходит. Здесь
   * поэтому нет второй проверки того же: две проверки одного правила в разных
   * местах расходятся молча, а чтение (`listForUser`) и постановка в очередь
   * (`shouldQueueEmail`) и так игнорируют «выключено» у запертого типа.
   */
  async updateForUser(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferencesResponse> {
    if (input.items.length > 0) {
      await this.db.db
        .insert(notificationPreferences)
        .values(input.items.map((i) => ({ userId, type: i.type, emailEnabled: i.emailEnabled })))
        // Одна строка на пару (пользователь, тип) — индекс
        // `uq_notification_preferences_user_type`. Повторная правка
        // перезаписывает, а не плодит.
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.type],
          set: {
            // `excluded` — значение из отвергнутой вставки, то есть то, что
            // прислал клиент.
            emailEnabled: sql`excluded.email_enabled`,
            updatedAt: new Date(),
          },
        })
    }
    return this.listForUser(userId)
  }
}
