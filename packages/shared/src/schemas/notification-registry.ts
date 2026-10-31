/**
 * Реестр тринадцати типов уведомлений — позиция 6 плана
 * (`docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md`
 * §7) + task-i18n-stage4-task6 (реестр как `MessageDescriptor`, локаль зрителя/
 * получателя, три замороженных типа переведены в структурированную форму).
 *
 * Правило, из которого всё следует (§7.1): **в записи лежат тип события и
 * идентификаторы объектов; кнопки и подписи выводит клиент по типу.** Готовые
 * кнопки и тексты в базе отвергнуты — правка подписи потребовала бы правки
 * данных, старые уведомления консервировали бы прошлогодние формулировки, а
 * тексты интерфейса расползлись бы по строкам базы, где их не видит ни один
 * текстовый гейт.
 *
 * Поэтому ВЕСЬ текст живёт здесь, в одном файле, и рендерится на ЛОКАЛИ
 * читателя/получателя через уже построенный `I18n` (`createI18n(locale)` на
 * сервере, активированный синглтон `apps/web/app/lib/i18n.ts` в браузере) —
 * не хранится готовой строкой ни в одном языке.
 *
 * SR-H-1 (fix-раунд 1, PR #714): `describeNotification`/`notificationActions`/
 * `renderNotification` принимают экземпляр `I18n`, а НЕ `locale` и НЕ зовут
 * `createI18n()` сами. `createI18n()` требует `require()` (см. `catalog.ts`),
 * и вызов ЭТОГО файла из браузера (`notifications-bell.tsx`) тянул `require`
 * в веб-бандл — в браузере такого символа нет, попап падал у любого
 * пользователя с уведомлением. Раз этот файл больше НЕ зовёт `createI18n`
 * нигде, символ вытесняется tree-shaking'ом из веб-сборки целиком.
 *
 * Разделение труда с `notifications.ts`:
 *   - `notifications.ts` — DTO (что лежит в строке и что отдаёт API);
 *   - этот файл — что из этой строки видит человек.
 *
 * Раскрытие (§10). `NOTIFICATION_TITLES` — НЕЙТРАЛЬНЫЕ заголовки без сумм и
 * процентов: именно их производитель кладёт в колонку `title`, и именно они
 * безопасны для письма (позиция 7), которое уходит на личную почту вне нашего
 * контура. Цифры живут в `data` и подставляются `describeNotification` —
 * в приложении показывать их можно, в письме нельзя.
 *
 * task-i18n-stage4-task6: `NOTIFICATION_TITLES` (легаси, `Record<…, string>`)
 * остаётся — шесть производителей + `NotificationSettingsTab.tsx` читают его
 * НАПРЯМУЮ и вне периметра этой задачи (см. doc-комментарий на
 * `NOTIFICATION_TITLE_MESSAGES` ниже). Канон показа/рендера — новый экспорт
 * `NOTIFICATION_TITLE_MESSAGES: Record<NewNotificationType, MessageDescriptor>`.
 */

export {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
  isActionRequiredNotificationType,
  notificationSubjectTypeSchema,
  type NewNotificationType,
  type NotificationSubjectType,
} from './notification-registry/types'
export {
  NOTIFICATION_TEXT_PREVIEW_MAX,
  isNewNotificationType,
  notificationDataSchemaFor,
  notificationTextPreview,
  type NotificationDataByType,
  type WeeklySourceRow,
} from './notification-registry/data'
export {
  ACTION_LABELS,
  DETAIL_MESSAGES,
  MISC_MESSAGES,
  NOTIFICATION_DETAIL_LINES,
  NOTIFICATION_DETAIL_LINE_CHARS,
  NOTIFICATION_TITLES,
  NOTIFICATION_TITLE_MESSAGES,
  SUBJECT_ARCHIVED_LABELS,
  SUBJECT_MISSING_LABELS,
} from './notification-registry/messages'
export { formatDay, sourceAlertParams } from './notification-registry/source-health-params'
export {
  describeNotification,
  notificationActions,
  notificationHref,
  renderMessage,
  renderNotification,
  type NotificationAction,
  type RenderableNotification,
  type RenderedNotification,
} from './notification-registry/render'
