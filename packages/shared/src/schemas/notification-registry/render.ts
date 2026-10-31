import type { I18n, MessageDescriptor } from '@lingui/core'
import { formatMoney, type Locale } from '../../i18n'
import { dataSchemas, isNewNotificationType, type NotificationDataByType } from './data'
import {
  ACTION_LABELS,
  DETAIL_MESSAGES,
  MISC_MESSAGES,
  NOTIFICATION_DETAIL_LINE_CHARS,
  NOTIFICATION_TITLE_MESSAGES,
  SUBJECT_ARCHIVED_LABELS,
  SUBJECT_MISSING_LABELS,
} from './messages'
import type { NewNotificationType, NotificationSubjectType } from './types'

// ---------------------------------------------------------------------------
// Подробности — «что произошло и что от вас нужно» (§7.3)
// ---------------------------------------------------------------------------

/**
 * COPY-H-4 / QA-M-1 (copy-review + manual-qa круг 1, #664): `amount` приезжает
 * из `numeric('amount', { precision: 18, scale: 6 })` как строка вида
 * `1500.000000` — печать её "as is" уже дважды чинили по итогам живого
 * тестирования в других потребителях той же колонки.
 *
 * task-i18n-stage4-task6, Step 7: `toLocaleString('ru-RU', …)` → `formatMoney`
 * из `../i18n/format` — та же форма (два знака, разделитель тысяч), но по
 * локали читателя/получателя, не жёстко `ru-RU`.
 */
function money(d: { amount: string; currency: string }, locale: Locale): string {
  const num = Number(d.amount)
  if (!Number.isFinite(num)) return `${d.amount} ${d.currency}`
  return formatMoney(d.amount, d.currency as 'USDT' | 'USD' | 'EUR' | 'UAH', locale)
}

/**
 * Нижний предел цитаты: даже когда всё остальное в строке съело бюджет
 * (сумма в двенадцать разрядов), причина показывается хотя бы началом.
 * Потерять её целиком — ровно тот дефект, который чинит COPY-M-7.
 */
const QUOTE_MIN_CHARS = 8

/**
 * Кавычки чужой речи — локаль-зависимая типографика (task-i18n-stage4-task6,
 * Step 10, COPY «Типографика зашита в шаблоны»): `uk` — «ёлочки», `en` —
 * закрывающие двойные типографские кавычки (не прямые `"…"`).
 */
const QUOTE_CHARS: Record<Locale, readonly [string, string]> = {
  uk: ['«', '»'],
  en: ['“', '”'],
}

/**
 * Чужая речь в кавычках, гарантированно закрытых В ВИДИМОЙ ЧАСТИ.
 *
 * Два свойства, каждое — отдельная находка круга 2 (#664):
 *   - усечение по КОД-ПОИНТАМ с многоточием ВНУТРИ кавычек (UX-M-2);
 *   - перевод строки внутри причины схлопывается в пробел.
 *
 * Серверное превью (`notificationTextPreview`, 200 знаков) этим НЕ заменяется:
 * оно про раскрытие (§10, письмо на личную почту), это — про ширину попапа.
 */
function quoteWithinBudget(text: string, budget: number, locale: Locale): string {
  const [open, close] = QUOTE_CHARS[locale]
  const flat = text.replace(/\s+/gu, ' ').trim()
  const inner = Math.max(budget - 2, QUOTE_MIN_CHARS)
  const points = Array.from(flat)
  if (points.length <= inner) return `${open}${flat}${close}`
  return `${open}${points.slice(0, inner - 1).join('')}…${close}`
}

/**
 * Рендер одного сообщения реестра на уже созданном `I18n` — тонкая обёртка
 * над `i18n._()`, чтобы каждый читающий сайт не повторял третий аргумент
 * (`{ message: descriptor.message }`) — тот же приём, что `interpolate()` в
 * `apps/api/src/common/api-error.ts`.
 *
 * fix-round 2 (SPEC-H-2, PR #714): экспортирован — `apps/web`'s
 * `NotificationSettingsTab.tsx` `rowTitle()` дублировал ровно этот же
 * `message === undefined ? …` тернарный манёвр inline, и Stryker'у
 * (`Mutation Gate (@crm/web)`) внутри `apps/web` он был не суппрешен и не
 * убит тестом — 4 survived. Переиспользование убирает дублирующую
 * defensive-ветку из `apps/web` целиком (reuse-first, не suppression),
 * а не воспроизводит suppression ниже в новом месте.
 */
export function renderMessage(
  i18n: I18n,
  descriptor: MessageDescriptor,
  params?: Record<string, unknown>,
): string {
  // `exactOptionalPropertyTypes`: `MessageDescriptor['message']` is
  // `string | undefined` in the general (annotated-as-`MessageDescriptor`)
  // case, but `MessageOptions['message']` wants `string`, never `undefined`
  // — narrowing through a branch (instead of `{ message: descriptor.message }`
  // unconditionally) keeps this helper correct for every descriptor shape,
  // not just literal-typed ones.
  const message = descriptor.message
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: every call site — in this file (MISC_MESSAGES/DETAIL_MESSAGES/ACTION_LABELS/NOTIFICATION_TITLE_MESSAGES/SUBJECT_*_LABELS below) AND in apps/web's NotificationSettingsTab.tsx rowTitle() (fix-round 2, SPEC-H-2) — passes a literal `/* i18n */ { id, message }` object; `message` is never actually undefined through any real descriptor, so this branch is unreachable defensive code for the general `MessageDescriptor` type, not a real decision any caller's tests can observe.
  return i18n._(descriptor.id, params, message === undefined ? undefined : { message })
}

function percentText(value: number | null, i18n: I18n): string {
  return renderMessage(i18n, MISC_MESSAGES.percentText, { value })
}

function approverLabel(name: string | null, i18n: I18n): string {
  return name ?? renderMessage(i18n, MISC_MESSAGES.approverUnknown)
}

function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  name: string | null,
  i18n: I18n,
): string {
  // SR-L-1: `hasName` selects the branch, `name` is substitution-only — see
  // the doc comment on `MISC_MESSAGES.subjectPhrase`.
  return renderMessage(i18n, MISC_MESSAGES.subjectPhrase, {
    kind,
    // Stryker disable next-line StringLiteral: same equivalent-mutant reason as TRANSACTION_ADDED's hasProject — ICU only branches on hasName === 'no'.
    hasName: name === null ? 'no' : 'yes',
    name,
  })
}

/**
 * Подробная строка под заголовком — или её ОТСУТСТВИЕ.
 *
 * COPY-L-7 (copy-review круг 3, #664): `null` — полноправный ответ, а не
 * признак ошибки. Попап пустую деталь не рисует (`notifications-bell.tsx`
 * проверяет `view.detail`), поэтому пустого `<p>` не появится.
 *
 * task-i18n-stage4-task6: сигнатура несёт `i18n` (SR-H-1, fix-раунд 1 — НЕ
 * `locale`, вызывающий строит `I18n` сам: сервер через `createI18n(locale)`,
 * веб — свой активированный синглтон). `locale` для `money()`/цитат
 * выводится из `i18n.locale`.
 */
export function describeNotification<T extends NewNotificationType>(
  type: T,
  data: NotificationDataByType[T],
  i18n: I18n,
): string | null {
  const locale = i18n.locale as Locale
  switch (type) {
    case 'TRANSACTION_ADDED': {
      // COPY-H-6: полезное (сумма) вперёд, имя объекта — в хвост, где его не
      // жалко обрезать `line-clamp-2` при длинных именах клиентов.
      const d = data as NotificationDataByType['TRANSACTION_ADDED']
      return renderMessage(i18n, DETAIL_MESSAGES.TRANSACTION_ADDED, {
        money: money(d, locale),
        // Stryker disable next-line StringLiteral: the ICU template only branches on hasProject === 'no' vs anything else — any non-'no' value is unobservable, mutating 'yes' cannot change rendered output.
        hasProject: d.projectName === null ? 'no' : 'yes',
        projectName: d.projectName,
      })
    }
    case 'TRANSACTION_STATUS_CHANGED': {
      const d = data as NotificationDataByType['TRANSACTION_STATUS_CHANGED']
      // «Валідація доходу» — термин из CONTEXT.md для перехода
      // `PENDING → VALIDATED`; «перевірка транзакції» стоит там же в списке
      // _Избегать_.
      if (d.status === 'VALIDATED') {
        return renderMessage(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_VALIDATED, {
          money: money(d, locale),
        })
      }
      // COPY-M-3: превью причины — слова конкретного человека, а не системы;
      // кавычки отделяют чужую речь от интерфейса.
      if (d.rejectionReasonPreview === null) {
        return renderMessage(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_REJECTED, {
          money: money(d, locale),
        })
      }
      // UX-M-2 (круг 2): причина — СВОИМ рядом (`NOTIFICATION_DETAIL_LINE_CHARS`),
      // факты — вторым. Порядок ТОТ ЖЕ, что у `APPROVAL_REJECTED`.
      return renderMessage(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_REJECTED_WITH_REASON, {
        quote: quoteWithinBudget(d.rejectionReasonPreview, NOTIFICATION_DETAIL_LINE_CHARS, locale),
        money: money(d, locale),
      })
    }
    case 'TEAM_MEMBER_ADDED': {
      const d = data as NotificationDataByType['TEAM_MEMBER_ADDED']
      return renderMessage(i18n, DETAIL_MESSAGES.TEAM_MEMBER_ADDED, { teamName: d.teamName })
    }
    case 'PROJECT_MEMBER_ADDED': {
      const d = data as NotificationDataByType['PROJECT_MEMBER_ADDED']
      return renderMessage(i18n, DETAIL_MESSAGES.PROJECT_MEMBER_ADDED, {
        projectName: d.projectName,
      })
    }
    case 'TEAM_NEW_MEMBER': {
      // COPY-H-6: полезное (кто пришёл) вперёд, имя команды — в хвост.
      const d = data as NotificationDataByType['TEAM_NEW_MEMBER']
      return renderMessage(i18n, DETAIL_MESSAGES.TEAM_NEW_MEMBER, {
        memberName: d.memberName,
        teamName: d.teamName,
      })
    }
    case 'PROJECT_CONFIRM_REQUIRED': {
      const d = data as NotificationDataByType['PROJECT_CONFIRM_REQUIRED']
      return renderMessage(i18n, DETAIL_MESSAGES.PROJECT_CONFIRM_REQUIRED, {
        projectName: d.projectName,
      })
    }
    case 'SHARE_CONFIRM_REQUIRED': {
      // COPY-H-6 (PROJECT-scope) + COPY-H-3 (BASE-scope — «частка за
      // замовчуванням», без переворота порядка).
      const d = data as NotificationDataByType['SHARE_CONFIRM_REQUIRED']
      const change = `${percentText(d.previousPercent, i18n)} → ${percentText(d.proposedPercent, i18n)}`
      return d.scope === 'BASE'
        ? renderMessage(i18n, DETAIL_MESSAGES.SHARE_CONFIRM_REQUIRED_BASE, { change })
        : renderMessage(i18n, DETAIL_MESSAGES.SHARE_CONFIRM_REQUIRED_PROJECT, {
            change,
            // Stryker disable next-line StringLiteral: same equivalent-mutant reason as TRANSACTION_ADDED above — ICU only branches on hasProject === 'no'.
            hasProject: d.projectName === null ? 'no' : 'yes',
            projectName: d.projectName,
          })
    }
    case 'DOCUMENT_SIGN_REQUIRED': {
      // COPY-L-7 (круг 3): детали НЕТ — она была подмножеством заголовка.
      return null
    }
    case 'APPROVAL_CONFIRMED': {
      const d = data as NotificationDataByType['APPROVAL_CONFIRMED']
      return renderMessage(i18n, DETAIL_MESSAGES.APPROVAL_CONFIRMED, {
        approverName: approverLabel(d.approverName, i18n),
        subjectPhrase: subjectPhrase(d.subjectKind, d.subjectTitle, i18n),
      })
    }
    case 'APPROVAL_REJECTED': {
      // COPY-M-7 / UX-M-2: причина идёт ПЕРВОЙ строкой, ограничена ОДНИМ рядом.
      const d = data as NotificationDataByType['APPROVAL_REJECTED']
      const params = {
        approverName: approverLabel(d.approverName, i18n),
        subjectPhrase: subjectPhrase(d.subjectKind, d.subjectTitle, i18n),
      }
      if (d.reasonPreview === null) {
        return renderMessage(i18n, DETAIL_MESSAGES.APPROVAL_REJECTED_NO_REASON, params)
      }
      return renderMessage(i18n, DETAIL_MESSAGES.APPROVAL_REJECTED_WITH_REASON, {
        ...params,
        quote: quoteWithinBudget(d.reasonPreview, NOTIFICATION_DETAIL_LINE_CHARS, locale),
      })
    }
    // task-i18n-stage4-task6, Step 1/6: три замороженных типа.
    case 'INVOICE_SIGNED': {
      // §10: контрагент назван РОВНО один раз (не дублируется заголовком —
      // «Рахунок підписано» его не называет) — имя чистое, без обёртки.
      //
      // COPY-M-4 (copy-review круг 1, #714): сума додана — у контрагента з
      // кількома рахунками деталь раніше не розрізняла, ЯКИЙ саме підписано.
      const d = data as NotificationDataByType['INVOICE_SIGNED']
      return renderMessage(i18n, DETAIL_MESSAGES.INVOICE_SIGNED, {
        counterpartyName: d.counterpartyName,
        money: money(d, locale),
      })
    }
    case 'INVOICE_SIGN_REQUIRED': {
      const d = data as NotificationDataByType['INVOICE_SIGN_REQUIRED']
      return money(d, locale)
    }
    case 'VACANCY_APPLICATION': {
      const d = data as NotificationDataByType['VACANCY_APPLICATION']
      return renderMessage(i18n, DETAIL_MESSAGES.VACANCY_APPLICATION, {
        vacancyTitle: d.vacancyTitle,
      })
    }
    case 'SOURCE_HEALTH_ALERT': {
      const d = data as NotificationDataByType['SOURCE_HEALTH_ALERT']
      return renderMessage(i18n, DETAIL_MESSAGES.SOURCE_HEALTH_ALERT, {
        source: d.sourceName,
        state: d.state,
      })
    }
    case 'SOURCE_HEALTH_WEEKLY_REPORT': {
      const d = data as NotificationDataByType['SOURCE_HEALTH_WEEKLY_REPORT']
      return renderMessage(i18n, DETAIL_MESSAGES.SOURCE_HEALTH_WEEKLY_REPORT, {
        weekStart: d.weekStart,
        total: d.sources.length,
        changed: d.sources.filter((s) => s.transitions > 0).length,
      })
    }
    default: {
      // CR-M-1 (код-ревью круг 1): одиннадцатый (теперь — четырнадцатый) тип
      // обязан ЛОМАТЬ КОМПИЛЯЦИЮ здесь, а не молча проваливаться в чужую форму.
      const exhaustive: never = type
      throw new Error(`describeNotification: неописанный тип уведомления ${String(exhaustive)}`)
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

/**
 * Подпись кнопки для «админу» — зависит от вида объекта решения (COPY-M-1):
 * USER — решение по базовой доле сотрудника, ведёт в его профиль; всё
 * остальное (PROJECT) — черновик проекта или доля ПО проекту, ведёт в проект.
 */
function actionLabelFor(
  type: NewNotificationType,
  subjectType: NotificationSubjectType,
  i18n: I18n,
): string {
  if (type === 'APPROVAL_CONFIRMED' || type === 'APPROVAL_REJECTED') {
    return renderMessage(
      i18n,
      subjectType === 'USER'
        ? MISC_MESSAGES.actionApprovalProfile
        : MISC_MESSAGES.actionApprovalProject,
    )
  }
  return renderMessage(
    i18n,
    ACTION_LABELS[type as Exclude<NewNotificationType, 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'>],
  )
}

/**
 * Подпись кнопки для ветки «по сохранённой ссылке» (COPY-M-3, copy-review
 * круг 1, #714). Зарегистрированный тип (кроме `APPROVAL_*` — у них своя
 * подпись через `actionLabelFor`, эта ветка их не достигает по построению:
 * `notificationActions` проверяет `subjectType`/`subjectId` раньше, а у
 * `APPROVAL_CONFIRMED`/`APPROVAL_REJECTED` они всегда заданы) получает СВОЮ
 * подпись из `ACTION_LABELS`, а не общее «Відкрити»/«Open» — иначе, например,
 * заголовок «Рахунок на підпис» показывал бы кнопку без глагола ровно там,
 * где от человека ждут действия (пример обновлён fix-round 2, copy-review
 * круг 2: заголовок сам переименован из «Рахунок очікує підпису» ещё в
 * COPY-M-1, круг 1, — этот пример здесь просто не поспевал за тем текстом).
 * Незнакомый тип (легаси-десятка до реестра, тип из будущего) по-прежнему
 * получает общее `MISC_MESSAGES.open`.
 */
function actionLabelForLink(type: string, i18n: I18n): string {
  if (
    isNewNotificationType(type) &&
    type !== 'APPROVAL_CONFIRMED' &&
    type !== 'APPROVAL_REJECTED'
  ) {
    return renderMessage(i18n, ACTION_LABELS[type])
  }
  return renderMessage(i18n, MISC_MESSAGES.open)
}

function subjectMissingLabel(subjectType: NotificationSubjectType | null, i18n: I18n): string {
  return subjectType === null
    ? renderMessage(i18n, MISC_MESSAGES.subjectMissingFallback)
    : renderMessage(i18n, SUBJECT_MISSING_LABELS[subjectType])
}

function subjectArchivedLabel(subjectType: NotificationSubjectType | null, i18n: I18n): string {
  return subjectType === null
    ? renderMessage(i18n, MISC_MESSAGES.subjectArchivedFallback)
    : renderMessage(i18n, SUBJECT_ARCHIVED_LABELS[subjectType])
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
  subjectArchived?: boolean
  /** ORCH-2 (fix-раунд 6, #664) — см. `notificationSchema` для полного описания. */
  approvalSuperseded?: boolean
  approvalDecided?: boolean
}

/**
 * ORCH-2 (fix-раунд 6, #664). Фиксированный текст, один на оба лейбла:
 * подпись описывает СОГЛАСОВАНИЕ, а не вид объекта, поэтому карты по
 * `NotificationSubjectType` здесь не нужно.
 *
 * COPY-M-9 (круг 3): «Решение больше не требуется» / «Решение уже принято» —
 * не «отозвано»: состояние выводится из «живой строки согласования для ЭТОГО
 * подтверждающего больше нет», а туда ведут четыре пути, и два из них — не
 * отзыв.
 */
export function notificationActions(n: RenderableNotification, i18n: I18n): NotificationAction[] {
  // §7.4: уведомление живёт дольше объекта. Честное «объекта больше нет»
  // вместо кнопки в белый экран.
  if (n.subjectMissing === true) {
    // QA-M-1 (manual-qa круг 1, #664): контракт в этой системе не удаляется —
    // `EmployeeContractsService` только меняет статус.
    //
    // COPY-M-8 (circle 2): «статус ≠ READY_TO_SIGN» ведёт к ТРЁМ переходам —
    // сказано ровно то, что известно.
    if (n.type === 'DOCUMENT_SIGN_REQUIRED') {
      return [
        {
          label: renderMessage(i18n, MISC_MESSAGES.documentSignUnavailable),
          href: null,
          disabled: true,
        },
      ]
    }
    return [{ label: subjectMissingLabel(n.subjectType, i18n), href: null, disabled: true }]
  }
  // QA-M-3 / QA-L-2: архив проверяется ПОСЛЕ исчезновения и отдельно от него.
  if (n.subjectArchived === true) {
    return [{ label: subjectArchivedLabel(n.subjectType, i18n), href: null, disabled: true }]
  }
  // ORCH-2 (fix-раунд 6): ПОСЛЕ объекта (missing/archived) и отдельно от него.
  if (n.approvalDecided === true) {
    return [
      { label: renderMessage(i18n, MISC_MESSAGES.approvalDecided), href: null, disabled: true },
    ]
  }
  if (n.approvalSuperseded === true) {
    return [
      { label: renderMessage(i18n, MISC_MESSAGES.approvalSuperseded), href: null, disabled: true },
    ]
  }
  if (isNewNotificationType(n.type) && n.subjectType !== null && n.subjectId !== null) {
    return [
      {
        label: actionLabelFor(n.type, n.subjectType, i18n),
        href: notificationHref(n.subjectType, n.subjectId),
        disabled: false,
      },
    ]
  }
  // Старые типы (и любой тип из будущего) ведут по сохранённой ссылке.
  //
  // COPY-M-3 (copy-review круг 1, #714): три замороженных типа (инвойсы,
  // вакансии) не несут `subjectType`/`subjectId` (производитель их не
  // задаёт — см. doc-комментарий на `INFORMING_NOTIFICATION_TYPES`), поэтому
  // раньше ЛЮБОЙ зарегистрированный тип с одной лишь ссылкой попадал в общий
  // «Відкрити»/«Open» — хотя `ACTION_LABELS` уже несёт для них подпись по
  // делу («Підписати рахунок», «Відкрити рахунок», «Відкрити вакансію»).
  // Незнакомый тип (легаси-десятка ДО реестра, или тип из будущего) по-прежнему
  // получает общее «Відкрити»: `ACTION_LABELS` для него нет записи вовсе.
  if (n.link !== null) {
    return [{ label: actionLabelForLink(n.type, i18n), href: n.link, disabled: false }]
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
 * не падает.
 *
 * task-i18n-stage4-task6: `i18n` (SR-H-1, fix-раунд 1) — зрителя (`apps/web`,
 * свой активированный синглтон) или получателя (письмо, Task 7,
 * `createI18n(recipientLocale)`); никогда глобальный синглтон в модульной
 * константе шаблонов, и никогда `createI18n()` внутри ЭТОГО файла —
 * см. doc-комментарий вверху файла (SR-H-1). Один и тот же `i18n` передаётся
 * во все три читающих сайта (`notificationActions`, `describeNotification`,
 * заголовок здесь) — им незачем каждому строить свой.
 */
export function renderNotification(n: RenderableNotification, i18n: I18n): RenderedNotification {
  const actions = notificationActions(n, i18n)
  if (isNewNotificationType(n.type)) {
    const parsed = dataSchemas[n.type].safeParse(n.data)
    if (parsed.success) {
      return {
        title: renderMessage(i18n, NOTIFICATION_TITLE_MESSAGES[n.type]),
        detail: describeNotification(n.type, parsed.data as never, i18n),
        actions,
      }
    }
  }
  return { title: n.title, detail: n.body, actions }
}
