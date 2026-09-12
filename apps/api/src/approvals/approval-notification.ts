/**
 * task-notification-types-producers (позиция 6) — два типа «админу»:
 * «сотрудник подтвердил» и «сотрудник отклонил, с причиной». Без них об отказе
 * узнают, только зайдя посмотреть (§7.2).
 *
 * ПОЧЕМУ ЗДЕСЬ, а не в вызывающих модулях. `ApprovalsService` заводился как
 * основание, которое «не знает про проекты и доли», и этот файл эту границу
 * слегка сдвигает: ниже перечислены три вида объектов. Обмен сознательный.
 * Иначе производителя пришлось бы дописывать в ШЕСТЬ мест —
 * `approveDraft` / `rejectDraft`, `approve|rejectSeniorShareChange` в
 * `ProjectsService` и их близнецов в `UsersService`, — а спека §10 прямо
 * называет это главным риском позиции: «объём, на котором „обнови везде“
 * теряет одно место». Один шов на оба решения и на все виды объектов дешевле
 * и проверяется целиком.
 *
 * Граница сдвинута минимально: знание сведено к ДВУМ чистым функциям в этом
 * файле — какому виду уведомления соответствует вид согласования и нужно ли
 * ему название объекта. Сам сервис остаётся без `if (subjectType === …)`.
 */
import type { NotificationSubjectType } from '@crm/shared'

/** Вид объекта в терминах уведомления. `null` = такой вид описать нечем. */
export type ApprovalNotificationKind = 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE'

/**
 * Виды согласований, заведённые позициями 4 и 5. Значения совпадают с
 * `ProjectsService.APPROVAL_SUBJECT_TYPE` / `SENIOR_SHARE_SUBJECT_TYPE` и
 * `UsersService.SENIOR_SHARE_SUBJECT_TYPE` — это те же три строки.
 *
 * Неизвестный вид даёт `null`, и уведомление НЕ создаётся. Это честнее
 * подстановки «проект»: сказать администратору про объект, вид которого мы не
 * понимаем, — значит сказать неправду о том, что он подтвердил.
 */
export function approvalNotificationKind(subjectType: string): ApprovalNotificationKind | null {
  if (subjectType === 'PROJECT') return 'PROJECT'
  if (subjectType === 'PROJECT_SENIOR_SHARE') return 'PROJECT_SHARE'
  if (subjectType === 'USER_SENIOR_SHARE') return 'BASE_SHARE'
  return null
}

/**
 * Куда ведёт кнопка администратора и нужно ли для подписи название объекта.
 * У базовой доли объект — сам сотрудник, и название ему не нужно: подпись
 * читается «базовая доля».
 */
export function approvalNotificationSubject(kind: ApprovalNotificationKind): {
  subjectType: NotificationSubjectType
  needsProjectName: boolean
} {
  if (kind === 'BASE_SHARE') return { subjectType: 'USER', needsProjectName: false }
  return { subjectType: 'PROJECT', needsProjectName: true }
}
