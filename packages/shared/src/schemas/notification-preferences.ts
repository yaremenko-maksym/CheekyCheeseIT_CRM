import { z } from 'zod'
import {
  isActionRequiredNotificationType,
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
 * составе типов, требующих действия, пришлось бы дублировать миграцией, и
 * два источника правды разошлись бы на первом же несовпадении.
 */

/**
 * Типы, у которых настройка почты существует. Три старых (инвойсы, вакансии)
 * письма не имеют вовсе.
 *
 * Сообщение своё, а не дефолтное от Zod: дефолт перечисляет допустимые
 * значения по-английски («Invalid option: expected one of …»), и это первое,
 * что человек увидит, если 7b пошлёт устаревший тип из старого бандла.
 */
export const configurableNotificationTypeSchema = z.enum(NEW_NOTIFICATION_TYPES, {
  message: 'Неизвестный тип уведомления',
})
export type ConfigurableNotificationType = z.infer<typeof configurableNotificationTypeSchema>

/**
 * Письмо этого типа выключить нельзя. Выводится из состава
 * `isActionRequiredNotificationType` — одного источника правды на весь реестр
 * (см. заголовок файла). Запертость выводится из «ждут ответа», а не наоборот:
 * маршрут кнопки письма читает то же свойство и не должен поехать за настройкой.
 */
export function isEmailChannelLocked(type: NewNotificationType): boolean {
  return isActionRequiredNotificationType(type)
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
    // Тексты РУССКИЕ, и это не вкусовщина: `ZodExceptionFilter` отдаёт
    // `issues[].message` клиенту дословно на всех маршрутах вне
    // `FINANCE_CRITICAL_PREFIXES`, а `/api/notifications/preferences` в этом
    // списке нет. То есть строка ниже — то самое, что человек прочтёт, когда
    // переключатель не поддастся (§5 задания, `russian-language.md`).
    // Круг 1 отдавал здесь английскую фразу со ссылкой на «spec §3» — ссылку на
    // внутренний документ читателю интерфейса сообщать нечего.
    .refine((items) => new Set(items.map((i) => i.type)).size === items.length, {
      message: 'Каждый тип уведомления можно указать только один раз',
    })
    .refine((items) => items.every((i) => i.emailEnabled || !isEmailChannelLocked(i.type)), {
      message: 'Письма о запросах на подтверждение и подпись отключить нельзя',
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
