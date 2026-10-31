import { z } from 'zod'

// ---------------------------------------------------------------------------
// Вид объекта, к которому относится уведомление
// ---------------------------------------------------------------------------

/**
 * Закрытый набор — в отличие от `approvalSubjectTypeSchema`, который намеренно
 * свободная строка. Разница не в стиле, а в том, кто владеет значением: у
 * согласований вид объекта задаёт вызывающий модуль, а здесь по нему строится
 * МАРШРУТ в интерфейсе, то есть значение обязан знать клиент. Неизвестный вид
 * = некуда вести кнопку.
 */
export const notificationSubjectTypeSchema = z.enum([
  'PROJECT',
  'TEAM',
  'USER',
  'TRANSACTION',
  'EMPLOYEE_CONTRACT',
])
export type NotificationSubjectType = z.infer<typeof notificationSubjectTypeSchema>

// ---------------------------------------------------------------------------
// Тринадцать типов (десять исходных + три замороженных, task-i18n-stage4-task6)
// ---------------------------------------------------------------------------

/** Информируют (§7.2) — настраиваются свободно. */
export const INFORMING_NOTIFICATION_TYPES = [
  'TRANSACTION_ADDED',
  'TRANSACTION_STATUS_CHANGED',
  'TEAM_MEMBER_ADDED',
  'PROJECT_MEMBER_ADDED',
  'TEAM_NEW_MEMBER',
  // task-i18n-stage4-task6 (Step 3 плана): два из трёх замороженных типов
  // (инвойсы, вакансии) — сюда, а не в `ACTION_REQUIRED_NOTIFICATION_TYPES`.
  //
  // COPY-M-2 (copy-review круг 1, #714): здесь стояло обоснование «19-знаковый
  // бюджет попапа», и оно было неверным — измерено пикселями, а не знаками:
  // `INVOICE_SIGN_REQUIRED` помещается в тот же бюджет попапа, что и заголовки
  // `ACTION_REQUIRED_NOTIFICATION_TYPES` (см. COPY-M-1, заголовок сокращён до
  // «Рахунок на підпис»). `INVOICE_SIGN_REQUIRED` семантически «требует
  // действия» (контрагент обязан подписать), но кнопка письма у
  // `ACTION_REQUIRED_NOTIFICATION_TYPES` ведёт на `/pending` — экран, где
  // рахунків нет вовсе (там показываются только согласования). Переносить тип
  // в эту группу значило бы либо заводить для рахунків отдельный маршрут на
  // `/pending`, либо давать письму кнопку, ведущую в никуда — обе развилки
  // архитектурные, не текстовые. Запирать ли канал почты для
  // `INVOICE_SIGN_REQUIRED` (§3, `isEmailChannelLocked`) — тоже вопрос
  // владельцу, не copy-review. В ЭТОМ PR почта для всех трёх замороженных
  // типов исключена целиком (CR-M-1/SR-M-1) — вопрос маршрута/запирания
  // остаётся открытым до отдельной бизнес-задачи.
  'VACANCY_APPLICATION',
  'INVOICE_SIGN_REQUIRED',
] as const

/**
 * Требуют действия (§7.2) — письмо не отключается.
 *
 * COPY-L-3 (copy-review круг 2, #664): здесь стояло обоснование словесного
 * префикса «Ждёт решения», который сам же copy-review и снял кругом раньше
 * (COPY-H-1) — комментарий велел будущему автору вернуть снятое. Семья
 * узнаётся по общему значку `TypeIcon`, а не по словесному префиксу: предмет
 * стоит первым словом заголовка, а «от вас ждут решения» говорит значок.
 *
 * task-i18n-stage4-task6: состав НЕ расширен тремя замороженными типами — см.
 * doc-комментарий на `INFORMING_NOTIFICATION_TYPES` выше (COPY-M-2, #714:
 * маршрут кнопки письма на `/pending`, не бюджет попапа — бюджет позволял бы).
 */
export const ACTION_REQUIRED_NOTIFICATION_TYPES = [
  'PROJECT_CONFIRM_REQUIRED',
  'SHARE_CONFIRM_REQUIRED',
  'DOCUMENT_SIGN_REQUIRED',
] as const

/**
 * От читателя ждут ОТВЕТА — не «посмотреть», а решить.
 *
 * Отдельный предикат, потому что этим свойством типа пользуются два разных
 * решения, и путать их нельзя: кнопка письма ведёт таким типам на `/pending`
 * (экран, где ответ вообще можно дать), а настройка почты у них заперта (§3).
 * Второе выводится из первого — `isEmailChannelLocked` зовёт эту функцию, а не
 * повторяет список, — но обратное неверно: запрут когда-нибудь канал у
 * информирующего типа, и маршрут кнопки от этого измениться не должен.
 */
export function isActionRequiredNotificationType(type: string): boolean {
  return (ACTION_REQUIRED_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

/**
 * Админу (§7.2) — без этого об отказе узнают, только зайдя посмотреть.
 *
 * task-i18n-stage4-task6: `INVOICE_SIGNED` добавлен сюда — «ADMIN tracking»
 * (комментарий на `notificationTypeSchema`), тот же смысл, что у
 * `APPROVAL_CONFIRMED`/`APPROVAL_REJECTED`: админа информируют о факте,
 * который сделал кто-то другой.
 */
export const ADMIN_NOTIFICATION_TYPES = [
  'APPROVAL_CONFIRMED',
  'APPROVAL_REJECTED',
  'INVOICE_SIGNED',
] as const

/**
 * Operational alerts for ADMIN users only (source fetch strategy U5a, ADR 2026-10-25 section 11):
 * a job source entering a bad health state, and the Monday report. Deliberately NOT in
 * `ADMIN_NOTIFICATION_TYPES`: that group is "decisions on your proposals" in the settings tab,
 * and these are neither a proposal nor configurable there. The producer sends them to active
 * ADMIN users only; the type itself carries no recipient rule.
 */
export const OPERATIONS_NOTIFICATION_TYPES = [
  'SOURCE_HEALTH_ALERT',
  'SOURCE_HEALTH_WEEKLY_REPORT',
] as const

export const NEW_NOTIFICATION_TYPES = [
  ...INFORMING_NOTIFICATION_TYPES,
  ...ACTION_REQUIRED_NOTIFICATION_TYPES,
  ...ADMIN_NOTIFICATION_TYPES,
  ...OPERATIONS_NOTIFICATION_TYPES,
] as const
export type NewNotificationType = (typeof NEW_NOTIFICATION_TYPES)[number]
