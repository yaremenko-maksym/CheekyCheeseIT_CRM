import { z } from 'zod'

/**
 * Реестр десяти типов уведомлений — позиция 6 плана
 * (`docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md`
 * §7).
 *
 * Правило, из которого всё следует (§7.1): **в записи лежат тип события и
 * идентификаторы объектов; кнопки и подписи выводит клиент по типу.** Готовые
 * кнопки и тексты в базе отвергнуты — правка подписи потребовала бы правки
 * данных, старые уведомления консервировали бы прошлогодние формулировки, а
 * тексты интерфейса расползлись бы по строкам базы, где их не видит ни один
 * текстовый гейт.
 *
 * Поэтому ВЕСЬ текст десяти типов живёт здесь, в одном файле: `copy-reviewer`
 * читает десять заголовков и десять подробностей в одном месте, а не собирает
 * их по пяти модулям-производителям.
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
 */

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
// Десять типов
// ---------------------------------------------------------------------------

/** Информируют (§7.2) — настраиваются свободно. */
export const INFORMING_NOTIFICATION_TYPES = [
  'TRANSACTION_ADDED',
  'TRANSACTION_STATUS_CHANGED',
  'TEAM_MEMBER_ADDED',
  'PROJECT_MEMBER_ADDED',
  'TEAM_NEW_MEMBER',
] as const

/**
 * Требуют действия (§7.2) — письмо не отключается. Одно имя одного факта:
 * все три несут семейный префикс «Ждёт решения», чтобы сотрудник узнавал
 * класс события по первому слову, а не по концу строки.
 */
export const ACTION_REQUIRED_NOTIFICATION_TYPES = [
  'PROJECT_CONFIRM_REQUIRED',
  'SHARE_CONFIRM_REQUIRED',
  'DOCUMENT_SIGN_REQUIRED',
] as const

/** Админу (§7.2) — без этого об отказе узнают, только зайдя посмотреть. */
export const ADMIN_NOTIFICATION_TYPES = ['APPROVAL_CONFIRMED', 'APPROVAL_REJECTED'] as const

export const NEW_NOTIFICATION_TYPES = [
  ...INFORMING_NOTIFICATION_TYPES,
  ...ACTION_REQUIRED_NOTIFICATION_TYPES,
  ...ADMIN_NOTIFICATION_TYPES,
] as const
export type NewNotificationType = (typeof NEW_NOTIFICATION_TYPES)[number]

// ---------------------------------------------------------------------------
// Заголовки — нейтральные, без цифр, пригодные для письма
// ---------------------------------------------------------------------------

export const NOTIFICATION_TITLES: Record<NewNotificationType, string> = {
  TRANSACTION_ADDED: 'Добавлена транзакция',
  TRANSACTION_STATUS_CHANGED: 'Статус транзакции изменился',
  TEAM_MEMBER_ADDED: 'Вас добавили в команду',
  PROJECT_MEMBER_ADDED: 'Вас добавили в проект',
  TEAM_NEW_MEMBER: 'В команде новый участник',
  PROJECT_CONFIRM_REQUIRED: 'Ждёт решения: новый проект',
  SHARE_CONFIRM_REQUIRED: 'Ждёт решения: новая доля',
  DOCUMENT_SIGN_REQUIRED: 'Ждёт решения: документ на подпись',
  APPROVAL_CONFIRMED: 'Сотрудник подтвердил',
  APPROVAL_REJECTED: 'Сотрудник отклонил',
}

// ---------------------------------------------------------------------------
// Данные — то, что производитель кладёт в запись вместо текста
// ---------------------------------------------------------------------------

const moneyFields = {
  amount: z.string().min(1).max(40),
  currency: z.string().min(1).max(10),
}

/**
 * Название объекта снимается В МОМЕНТ события, а не читается по ссылке при
 * показе: уведомление живёт дольше объекта (§7.4), и запись о том, что было,
 * не должна становиться безымянной, когда проект архивировали.
 */
const objectName = z.string().min(1).max(200)

const percent = z.number().int().min(0).max(100).nullable()

const dataSchemas = {
  TRANSACTION_ADDED: z.object({
    ...moneyFields,
    projectName: objectName.nullable(),
  }),
  TRANSACTION_STATUS_CHANGED: z.object({
    ...moneyFields,
    status: z.enum(['VALIDATED', 'REJECTED']),
    rejectionReason: z.string().min(1).max(1000).nullable(),
  }),
  TEAM_MEMBER_ADDED: z.object({ teamName: objectName }),
  PROJECT_MEMBER_ADDED: z.object({ projectName: objectName }),
  TEAM_NEW_MEMBER: z.object({ teamName: objectName, memberName: objectName }),
  PROJECT_CONFIRM_REQUIRED: z.object({ projectName: objectName }),
  SHARE_CONFIRM_REQUIRED: z.object({
    scope: z.enum(['PROJECT', 'BASE']),
    projectName: objectName.nullable(),
    previousPercent: percent,
    proposedPercent: percent,
  }),
  DOCUMENT_SIGN_REQUIRED: z.object({ documentTitle: objectName }),
  APPROVAL_CONFIRMED: z.object({
    approverName: objectName,
    subjectKind: z.enum(['PROJECT', 'PROJECT_SHARE', 'BASE_SHARE']),
    subjectTitle: objectName.nullable(),
  }),
  APPROVAL_REJECTED: z.object({
    approverName: objectName,
    subjectKind: z.enum(['PROJECT', 'PROJECT_SHARE', 'BASE_SHARE']),
    subjectTitle: objectName.nullable(),
    reason: z.string().min(1).max(1000),
  }),
} satisfies Record<NewNotificationType, z.ZodType>

export type NotificationDataByType = {
  [K in NewNotificationType]: z.infer<(typeof dataSchemas)[K]>
}

export function notificationDataSchemaFor<T extends NewNotificationType>(
  type: T,
): (typeof dataSchemas)[T] {
  return dataSchemas[type]
}

export function isNewNotificationType(type: string): type is NewNotificationType {
  return (NEW_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

// ---------------------------------------------------------------------------
// Подробности — «что произошло и что от вас нужно» (§7.3)
// ---------------------------------------------------------------------------

function money(d: { amount: string; currency: string }): string {
  return `${d.amount} ${d.currency}`
}

function percentText(value: number | null): string {
  return value === null ? 'по умолчанию' : `${value}%`
}

function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  title: string | null,
): string {
  if (kind === 'BASE_SHARE') return 'базовая доля'
  const named = title ?? 'без названия'
  return kind === 'PROJECT' ? `проект ${named}` : `доля по проекту ${named}`
}

export function describeNotification<T extends NewNotificationType>(
  type: T,
  data: NotificationDataByType[T],
): string {
  switch (type) {
    case 'TRANSACTION_ADDED': {
      const d = data as NotificationDataByType['TRANSACTION_ADDED']
      return d.projectName === null ? money(d) : `Проект ${d.projectName}: ${money(d)}`
    }
    case 'TRANSACTION_STATUS_CHANGED': {
      const d = data as NotificationDataByType['TRANSACTION_STATUS_CHANGED']
      if (d.status === 'VALIDATED') return `Проверена: ${money(d)}`
      return d.rejectionReason === null
        ? `Отклонена: ${money(d)}`
        : `Отклонена: ${money(d)} — ${d.rejectionReason}`
    }
    case 'TEAM_MEMBER_ADDED': {
      const d = data as NotificationDataByType['TEAM_MEMBER_ADDED']
      return `Команда ${d.teamName}`
    }
    case 'PROJECT_MEMBER_ADDED': {
      const d = data as NotificationDataByType['PROJECT_MEMBER_ADDED']
      return `Проект ${d.projectName}`
    }
    case 'TEAM_NEW_MEMBER': {
      const d = data as NotificationDataByType['TEAM_NEW_MEMBER']
      return `${d.teamName}: ${d.memberName}`
    }
    case 'PROJECT_CONFIRM_REQUIRED': {
      const d = data as NotificationDataByType['PROJECT_CONFIRM_REQUIRED']
      return `Проект ${d.projectName}`
    }
    case 'SHARE_CONFIRM_REQUIRED': {
      const d = data as NotificationDataByType['SHARE_CONFIRM_REQUIRED']
      const change = `${percentText(d.previousPercent)} → ${percentText(d.proposedPercent)}`
      return d.scope === 'BASE'
        ? `Базовая доля: ${change}`
        : `Проект ${d.projectName ?? 'без названия'}: ${change}`
    }
    case 'DOCUMENT_SIGN_REQUIRED': {
      const d = data as NotificationDataByType['DOCUMENT_SIGN_REQUIRED']
      return d.documentTitle
    }
    case 'APPROVAL_CONFIRMED': {
      const d = data as NotificationDataByType['APPROVAL_CONFIRMED']
      return `${d.approverName} — ${subjectPhrase(d.subjectKind, d.subjectTitle)}`
    }
    default: {
      const d = data as NotificationDataByType['APPROVAL_REJECTED']
      return `${d.approverName} — ${subjectPhrase(d.subjectKind, d.subjectTitle)}: ${d.reason}`
    }
  }
}

// ---------------------------------------------------------------------------
// Кнопки — выводятся из типа и вида объекта, не хранятся
// ---------------------------------------------------------------------------

export type NotificationAction = {
  label: string
  /** `null` = вести некуда: объекта больше нет (§7.4). */
  href: string | null
  disabled: boolean
}

const ACTION_LABELS: Record<NewNotificationType, string> = {
  TRANSACTION_ADDED: 'К транзакциям',
  TRANSACTION_STATUS_CHANGED: 'К транзакциям',
  TEAM_MEMBER_ADDED: 'Открыть команду',
  PROJECT_MEMBER_ADDED: 'Открыть проект',
  TEAM_NEW_MEMBER: 'Открыть команду',
  PROJECT_CONFIRM_REQUIRED: 'Открыть проект',
  SHARE_CONFIRM_REQUIRED: 'Посмотреть и подтвердить',
  DOCUMENT_SIGN_REQUIRED: 'Подписать',
  APPROVAL_CONFIRMED: 'Открыть',
  APPROVAL_REJECTED: 'Открыть',
}

/** Маршрут объекта. У транзакции и договора своей страницы нет — ведём в список. */
export function notificationHref(subjectType: NotificationSubjectType, subjectId: string): string {
  switch (subjectType) {
    case 'PROJECT':
      return `/projects/${subjectId}`
    case 'TEAM':
      return `/team/${subjectId}`
    case 'USER':
      return `/profile/${subjectId}`
    case 'TRANSACTION':
      return '/finance'
    default:
      return '/onboarding'
  }
}

/** То, что рендереру нужно от строки уведомления. Совпадает по форме с DTO. */
export type RenderableNotification = {
  type: string
  title: string
  body: string | null
  link: string | null
  subjectType: NotificationSubjectType | null
  subjectId: string | null
  data: unknown
  subjectMissing?: boolean
}

export function notificationActions(n: RenderableNotification): NotificationAction[] {
  // §7.4: уведомление живёт дольше объекта. Честное «объекта больше нет»
  // вместо кнопки в белый экран.
  if (n.subjectMissing === true) {
    return [{ label: 'Объекта больше нет', href: null, disabled: true }]
  }
  if (isNewNotificationType(n.type) && n.subjectType !== null && n.subjectId !== null) {
    return [
      {
        label: ACTION_LABELS[n.type],
        href: notificationHref(n.subjectType, n.subjectId),
        disabled: false,
      },
    ]
  }
  // Старые три типа (и любой тип из будущего) ведут по сохранённой ссылке.
  if (n.link !== null) {
    return [{ label: 'Открыть', href: n.link, disabled: false }]
  }
  return []
}

export type RenderedNotification = {
  title: string
  detail: string | null
  actions: NotificationAction[]
}

/**
 * AC2. Неизвестный тип (или известный тип с данными, которые не разбираются)
 * рендерится как ОБЫЧНОЕ уведомление по сохранённым заголовку и телу — попап
 * не падает. То же семейство, что `searchSchema` на странице входа:
 * перечисление не должно ронять экран.
 */
export function renderNotification(n: RenderableNotification): RenderedNotification {
  const actions = notificationActions(n)
  if (isNewNotificationType(n.type)) {
    const parsed = dataSchemas[n.type].safeParse(n.data)
    if (parsed.success) {
      return {
        title: NOTIFICATION_TITLES[n.type],
        detail: describeNotification(n.type, parsed.data as never),
        actions,
      }
    }
  }
  return { title: n.title, detail: n.body, actions }
}
