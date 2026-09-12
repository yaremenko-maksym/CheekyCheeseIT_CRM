import { z } from 'zod'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
  type NewNotificationType,
} from './notification-registry'

/**
 * Настройки каналов — позиция 7a плана уведомлений
 * (`docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md`
 * §3 решение 6: «каналы настраивает сам сотрудник»).
 *
 * Канал ровно один — почта. Колокольчик настройкой не управляется: запись в
 * базе создаётся всегда, и выключать её означало бы терять след события,
 * а не приглушать его. Поэтому в DTO нет `inAppEnabled` — поля, которое
 * никогда не могло бы быть `false`.
 *
 * **Запрет односторонний.** У трёх типов, требующих действия, письмо
 * отключить нельзя (§3, «Допущения, принятые мной»): «иначе процесс встаёт
 * молча — проект висит в черновике, потому что галочку сняли год назад».
 * Приглушить (не открывать письмо, увести фильтром) читатель по-прежнему
 * волен — это его почтовый клиент, не наша настройка.
 *
 * Почему `locked` вычисляется, а не хранится: это свойство ТИПА, а не
 * пользователя. Храни мы его строкой в базе, добавление типа в
 * `ACTION_REQUIRED_NOTIFICATION_TYPES` пришлось бы дублировать миграцией, и
 * два источника правды разошлись бы на первом же несовпадении.
 */

/** Типы, у которых настройка почты существует. Три старых (инвойсы, вакансии) письма не имеют вовсе. */
export const configurableNotificationTypeSchema = z.enum(NEW_NOTIFICATION_TYPES)
export type ConfigurableNotificationType = z.infer<typeof configurableNotificationTypeSchema>

/**
 * Письмо этого типа выключить нельзя. Выводится из состава
 * `ACTION_REQUIRED_NOTIFICATION_TYPES` — одного источника правды на весь
 * реестр (см. заголовок файла).
 */
export function isEmailChannelLocked(type: NewNotificationType): boolean {
  return (ACTION_REQUIRED_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

const preferenceItem = z.object({
  type: configurableNotificationTypeSchema,
  emailEnabled: z.boolean(),
})

/**
 * Тело `PUT /api/notifications/preferences`.
 *
 * Разбор — последний рубеж перед базой и ПЕРВЫЙ, который видит клиент: обе
 * стороны читают один и тот же запрет, поэтому 7b не сможет нарисовать
 * переключатель, который сервер потом отвергнет.
 */
export const updateNotificationPreferencesSchema = z.object({
  items: z
    .array(preferenceItem)
    .min(1)
    .max(NEW_NOTIFICATION_TYPES.length)
    .refine((items) => new Set(items.map((i) => i.type)).size === items.length, {
      message: 'Each notification type may appear at most once',
    })
    .refine((items) => items.every((i) => i.emailEnabled || !isEmailChannelLocked(i.type)), {
      message:
        'Email for approval and signature requests cannot be switched off (spec §3) — it can be muted in the mail client, not disabled here',
    }),
})
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>

const preferenceView = preferenceItem.extend({
  /** Вычислен сервером (`isEmailChannelLocked`) — клиент рисует переключатель неактивным. */
  locked: z.boolean(),
})

/**
 * Ответ `GET /api/notifications/preferences` — ВСЕ десять типов, а не только
 * те, у кого есть строка в базе. Отсутствие строки означает «по умолчанию»,
 * и заставлять клиента знать умолчание значило бы завести второе место, где
 * оно записано.
 */
export const notificationPreferencesResponseSchema = z.object({
  items: z
    .array(preferenceView)
    .refine((items) => items.every((i) => i.locked === isEmailChannelLocked(i.type)), {
      message: '`locked` must be derived from the type, not sent independently',
    })
    .refine((items) => items.every((i) => i.emailEnabled || !i.locked), {
      message: 'A locked type can never report email as disabled',
    }),
})
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>
