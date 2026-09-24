import type { I18n, MessageDescriptor } from '@lingui/core'
import { z } from 'zod'
import { createI18n, formatMoney, type Locale } from '../i18n'

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
 * читателя/получателя через `createI18n(locale)` — не хранится готовой
 * строкой ни в одном языке.
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
  // `INVOICE_SIGN_REQUIRED` семантически «требует действия» (контрагент
  // обязан подписать), но его uk-заголовок («Рахунок очікує підпису», 22
  // знака) не помещается в 19-знаковый бюджет попапа (COPY-H-1), которым
  // проверен именно состав `ACTION_REQUIRED_NOTIFICATION_TYPES` (см. тест
  // «три типа, требующие действия, помещаются в бюджет попапа целиком»).
  // Плюс: для этих трёх типов `subjectType`/`subjectId` производитель не
  // задаёт (остаются `null`) — оставить их «информирующими» не потеряло бы
  // ничего в текущей проводке (`isEmailChannelLocked` на них не завязана).
  // Допущение записано в PR body — блокировку почты для `INVOICE_SIGN_REQUIRED`
  // разнести отдельной бизнес-задачей.
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
 * doc-комментарий на `INFORMING_NOTIFICATION_TYPES` выше (COPY-H-1's 19-знаковый
 * бюджет).
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

export const NEW_NOTIFICATION_TYPES = [
  ...INFORMING_NOTIFICATION_TYPES,
  ...ACTION_REQUIRED_NOTIFICATION_TYPES,
  ...ADMIN_NOTIFICATION_TYPES,
] as const
export type NewNotificationType = (typeof NEW_NOTIFICATION_TYPES)[number]

// ---------------------------------------------------------------------------
// Заголовки — нейтральные, без цифр, пригодные для письма
// ---------------------------------------------------------------------------

/**
 * ЛЕГАСИ. Тип и текст остаются РУССКИМИ для десяти исходных ключей — вне
 * периметра task-i18n-stage4-task6 (SPEC-H-2/SPEC-H-3): шесть производителей
 * (`approvals.service.ts`, `employee-contracts.service.ts`,
 * `transactions.service.ts`, `projects.service.ts`, `teams.service.ts`,
 * `users.service.ts`) пишут этот текст в НЕ читаемую для показа колонку
 * `notifications.title` (см. doc-комментарий над `NOTIFICATION_TITLE_MESSAGES`
 * ниже), плюс `NotificationSettingsTab.tsx` использует его как ярлык ТИПА в
 * списке настроек. Ни один из этих файлов не входит в Task 6 — трогать
 * значения тут для НИХ означало бы менять то, что не читается ни одним путём
 * показа, с риском typecheck вне периметра PR.
 *
 * Три новых ключа (замороженные типы) — компилятор требует их ЗДЕСЬ тоже
 * (`Record` закрыт по `NewNotificationType`): текст УЖЕ украинский (SPEC-H-3
 * fix-раунд 2 — легаси НЕ источник перевода для канона ниже, только
 * историческая точка отсчёта смысла), тот же, что в `NOTIFICATION_TITLE_MESSAGES`,
 * без i18n-обёртки — производители трёх замороженных типов кладут его в
 * `title` НАПРЯМУЮ (Step 5 плана).
 */
export const NOTIFICATION_TITLES: Record<NewNotificationType, string> = {
  // COPY-L-1 (copy-review круг 1, #664): голос группы «вас добавили…» —
  // три из пяти информирующих обращаются к читателю, четвёртый был безличным,
  // хотя адресат по построению — именно получатель денег.
  TRANSACTION_ADDED: 'Вам добавили транзакцию',
  // COPY-M-2: заголовок называл поле («статус изменился»), а не событие.
  // Событие ровно одно — бухгалтер принял или отклонил заявленный доход
  // (`notifyTransactionStatusChanged` вызывается только из `validateTransaction`).
  TRANSACTION_STATUS_CHANGED: 'Решение по доходу',
  TEAM_MEMBER_ADDED: 'Вас добавили в команду',
  PROJECT_MEMBER_ADDED: 'Вас добавили в проект',
  TEAM_NEW_MEMBER: 'В команде новый участник',
  // COPY-H-1: префикс «Ждёт решения: » съедал больше половины 24-символьного
  // бюджета попапа (`w-80`, `truncate`) и обрезался ровно там, где стояло
  // единственное слово, сообщавшее, чего хотят от человека. Предмет — первым,
  // ≤19 знаков, семья узнаётся по общему значку (`TypeIcon`), не по префиксу.
  PROJECT_CONFIRM_REQUIRED: 'Проект ждёт решения',
  // COPY-H-5: «новая доля» утверждала то, чего ещё нет (решение не принято) —
  // и расходилась с экраном самого предложения. COPY-H-1 закрывает вместе.
  SHARE_CONFIRM_REQUIRED: 'Предложение по доле',
  // COPY-M-5: один и тот же документ назывался «документ» / «договор» /
  // «контракт» на пути в один переход — сведено к одному слову.
  DOCUMENT_SIGN_REQUIRED: 'Контракт на подпись',
  // COPY-H-2: «Сотрудник подтвердил/отклонил» — висящий переходный глагол без
  // дополнения (тема письма, куда уходит title, ничего не сообщала) И второе
  // имя одного факта, который #648 уже свёл к «предложению» на пяти
  // поверхностях. Актор остаётся в деталях (`describeNotification`).
  //
  // «Принято», не «подтверждено» — «Предложение подтверждено» (24 знака) не
  // помещается в 202px бюджет строки попапа при непрочитанной точке;
  // «Принято» короче на 5 знаков и уже есть в этом же домене как канонический
  // антоним «отклонено».
  APPROVAL_CONFIRMED: 'Предложение принято',
  APPROVAL_REJECTED: 'Предложение отклонено',
  // task-i18n-stage4-task6, Step 3: три замороженных типа — уже украинский
  // текст, идентичный `NOTIFICATION_TITLE_MESSAGES` ниже.
  INVOICE_SIGNED: 'Рахунок підписано',
  INVOICE_SIGN_REQUIRED: 'Рахунок очікує підпису',
  VACANCY_APPLICATION: 'Новий відгук на вакансію',
}

/**
 * Канон показа — task-i18n-stage4-task6. Все тринадцать записей написаны
 * ЗАНОВО на украинском (по глоссарию `CONTEXT.md`), НЕ скопированы из
 * `NOTIFICATION_TITLES` выше (тот — легаси, справочная точка отсчёта смысла,
 * слова другие, SPEC-H-3). `renderNotification` (ниже) — единственный
 * читающий сайт, который меняется этим PR.
 *
 * `en`-текст — в `packages/shared/src/i18n/locales/en/messages.po`,
 * тем же коммитом (copywriting §5, «два оригинала»).
 */
export const NOTIFICATION_TITLE_MESSAGES: Record<NewNotificationType, MessageDescriptor> = {
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.TRANSACTION_ADDED.title',
    message: 'Вам додали транзакцію',
  },
  TRANSACTION_STATUS_CHANGED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.title',
    message: 'Рішення щодо доходу',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.TEAM_MEMBER_ADDED.title',
    message: 'Вас додали до команди',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.PROJECT_MEMBER_ADDED.title',
    message: 'Вас додали до проєкту',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.TEAM_NEW_MEMBER.title',
    message: 'У команді новий учасник',
  },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.PROJECT_CONFIRM_REQUIRED.title',
    message: 'Проєкт очікує рішення',
  },
  SHARE_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.title',
    message: 'Пропозиція щодо частки',
  },
  DOCUMENT_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.DOCUMENT_SIGN_REQUIRED.title',
    message: 'Контракт на підпис',
  },
  APPROVAL_CONFIRMED: /* i18n */ {
    id: 'notification.APPROVAL_CONFIRMED.title',
    message: 'Пропозицію прийнято',
  },
  APPROVAL_REJECTED: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.title',
    message: 'Пропозицію відхилено',
  },
  INVOICE_SIGNED: /* i18n */ {
    id: 'notification.INVOICE_SIGNED.title',
    message: 'Рахунок підписано',
  },
  INVOICE_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.INVOICE_SIGN_REQUIRED.title',
    message: 'Рахунок очікує підпису',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.VACANCY_APPLICATION.title',
    message: 'Новий відгук на вакансію',
  },
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
 *
 * SR-H-1 (круг 1): потолок — 255, ровно как у КОЛОНОК, откуда это имя
 * снимается (`users.display_name`, `projects.name`, `teams.name` — все
 * `varchar(255)`). Здесь стояло 200, то есть форма уведомления была строже
 * системы записи, и легальное имя проекта в 201 символ роняло разбор данных —
 * а вместе с ним, пока производитель имел право вето, и само событие. Потолок
 * формы данных выводится из потолка сущности, а не назначается отдельно.
 */
const OBJECT_NAME_MAX = 255

/**
 * Длина в КОД-ПОИНТАХ, а не в 16-битных единицах (SR-M-3, security-review
 * круг 2).
 *
 * `String.prototype.length` считает единицы UTF-16, а `varchar(255)` в
 * Postgres — символы. Эмодзи — это одна единица длины для колонки и ДВЕ для
 * `length`, поэтому имя из 200 символов с 60 эмодзи колонку проходит, а
 * `z.string().max(255)` — нет: форма оказывалась строже системы записи ровно
 * там, где круг 1 приводил их к одному потолку. Одна мерка на усечение и на
 * потолок — иначе они расходятся молча.
 */
function codePointLength(value: string): number {
  return Array.from(value).length
}

const objectName = z
  .string()
  .min(1)
  .refine((value) => codePointLength(value) <= OBJECT_NAME_MAX, {
    message: `Object name must be at most ${OBJECT_NAME_MAX} characters`,
  })

/**
 * Сколько текста, написанного человеком, уведомление имеет право нести.
 *
 * §10: уведомление несёт СУТЬ и ССЫЛКУ — полный текст читают в CRM, где
 * работает маскировка и права. Поэтому причина отказа едет сюда превью, а не
 * целиком: это и требование раскрытия (превью уходит в письмо на личную почту
 * вне нашего контура), и снятая связка «длина текста ↔ судьба события».
 */
export const NOTIFICATION_TEXT_PREVIEW_MAX = 200

/**
 * Превью текста, написанного человеком: обрамляющие пробелы снимаются, длинный
 * текст усекается ДО потолка вместе с многоточием (результат — ровно
 * `NOTIFICATION_TEXT_PREVIEW_MAX` символов, не больше).
 *
 * Пустая строка на выходе (текст был из одних пробелов) — это «причины нет»:
 * поля превью нулевые, и производитель кладёт `null`, а не пустую строку.
 */
export function notificationTextPreview(text: string): string {
  const trimmed = text.trim()
  // SR-M-3 (security-review круг 2): режем по КОД-ПОИНТАМ. `slice` режет по
  // 16-битным единицам и на эмодзи, попавшем на границу, оставляет ОДИНОКИЙ
  // суррогат. Такая строка проходит форму (длина в единицах — ровно потолок),
  // но `jsonb` её не принимает: «invalid input syntax for type json — Unicode
  // low surrogate must follow a high surrogate» (воспроизведено на
  // PostgreSQL 16). Ошибка прилетала уже из `INSERT`, то есть за контуром,
  // который круг 1 обезвредил, и откатывала сам отказ согласования.
  const points = Array.from(trimmed)
  if (points.length <= NOTIFICATION_TEXT_PREVIEW_MAX) return trimmed
  return `${points.slice(0, NOTIFICATION_TEXT_PREVIEW_MAX - 1).join('')}…`
}

/** Превью или его отсутствие — форма, общая для всех «причин». */
const textPreview = z
  .string()
  .min(1)
  .refine((value) => codePointLength(value) <= NOTIFICATION_TEXT_PREVIEW_MAX, {
    message: `Preview must be at most ${NOTIFICATION_TEXT_PREVIEW_MAX} characters`,
  })
  .nullable()

const percent = z.number().int().min(0).max(100).nullable()

/**
 * QA-H-1 (manual-qa круг 3, #664). Строка согласования, о которой это
 * уведомление, — именно СТРОКА, а не «согласование по такому-то объекту для
 * такого-то подтверждающего».
 *
 * Разница не формальная: повторное предложение доли не отменяет предыдущее, а
 * открывает НОВОЕ ПОКОЛЕНИЕ строк (`ApprovalsService.proposeInTx` гасит
 * прежние через `supersededAt` и вставляет новые). Пока уведомление
 * опознавалось тройкой «вид + объект + подтверждающий», оба поколения
 * сходились в один ключ, и живой синьор видел два активных «Предложение по
 * доле» с разными процентами, каждое с рабочей кнопкой. Идентификатор строки
 * различает поколения — и погашенное поколение честно деградирует.
 */
const approvalId = z.string().uuid()

const dataSchemas = {
  TRANSACTION_ADDED: z.object({
    ...moneyFields,
    projectName: objectName.nullable(),
  }),
  TRANSACTION_STATUS_CHANGED: z.object({
    ...moneyFields,
    status: z.enum(['VALIDATED', 'REJECTED']),
    rejectionReasonPreview: textPreview,
  }),
  TEAM_MEMBER_ADDED: z.object({ teamName: objectName }),
  PROJECT_MEMBER_ADDED: z.object({ projectName: objectName }),
  TEAM_NEW_MEMBER: z.object({ teamName: objectName, memberName: objectName }),
  PROJECT_CONFIRM_REQUIRED: z.object({ projectName: objectName, approvalId }),
  SHARE_CONFIRM_REQUIRED: z.object({
    scope: z.enum(['PROJECT', 'BASE']),
    projectName: objectName.nullable(),
    previousPercent: percent,
    proposedPercent: percent,
    approvalId,
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
    // Превью, а не причина целиком, и ОТСУТСТВИЕ превью допустимо (§10 +
    // SR-H-1): администратор узнаёт ФАКТ отказа и идёт читать причину в CRM.
    // Обязательное поле здесь означало бы, что причина, которую не удалось
    // свести к превью, отменяет и сообщение об отказе.
    reasonPreview: textPreview,
  }),
  // task-i18n-stage4-task6, Step 4: три замороженных типа — те же потолки
  // защиты (SR-H-1), что у остальных десяти.
  INVOICE_SIGNED: z.object({ counterpartyName: objectName }),
  INVOICE_SIGN_REQUIRED: z.object({ ...moneyFields }),
  VACANCY_APPLICATION: z.object({ vacancyTitle: objectName }),
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
 * Сколько текста подробностей человек РЕАЛЬНО видит в попапе.
 *
 * COPY-M-7 (copy-review круг 2) + UX-M-2 (design-review круг 2), #664. Число
 * ИЗМЕРЕНО на живом стенде под русский текст (см. история находки в PR #664).
 *
 * task-i18n-stage4-task6, Step 9: бюджет НЕ пересчитан под украинский (uk
 * длиннее ru/en на 15-30% по аудиту) — эмпирическая проверка требует живого
 * рендера на 320px, которого у этой задачи нет (design-gate Tier 3, отдельный
 * проход по `apps/web`'s попапу). Зафиксировано как допущение/follow-up в PR
 * body, а не тихо занижено — граница деградирует честно: цитата усекается на
 * символ раньше положенного, но не рвёт разметку.
 */
export const NOTIFICATION_DETAIL_LINE_CHARS = 22
export const NOTIFICATION_DETAIL_LINES = 2

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
 */
function t(i18n: I18n, descriptor: MessageDescriptor, params?: Record<string, unknown>): string {
  // `exactOptionalPropertyTypes`: `MessageDescriptor['message']` is
  // `string | undefined` in the general (annotated-as-`MessageDescriptor`)
  // case, but `MessageOptions['message']` wants `string`, never `undefined`
  // — narrowing through a branch (instead of `{ message: descriptor.message }`
  // unconditionally) keeps this helper correct for every descriptor shape,
  // not just literal-typed ones.
  const message = descriptor.message
  return i18n._(descriptor.id, params, message === undefined ? undefined : { message })
}

/**
 * Локализованное «не задана» / `N%` — COPY-H-3: единственный вызывающий,
 * `SHARE_CONFIRM_REQUIRED`, то есть «этот контекст» и есть весь контракт
 * функции.
 */
const PERCENT_TEXT = /* i18n */ {
  id: 'notification.percentText',
  message: '{value, select, null {не задана} other {{value}%}}',
} satisfies MessageDescriptor

function percentText(value: number | null, i18n: I18n): string {
  return t(i18n, PERCENT_TEXT, { value })
}

/**
 * COPY-H-3: «базова частка» — тот же принятый термин, что и `CONTEXT.md`
 * («Доля синьора» → «базова частка за замовчуванням»), «базов*» вычищено из
 * `apps/web` на #648, этот реестр не должен возвращать его снова.
 */
const SUBJECT_PHRASE = /* i18n */ {
  id: 'notification.subjectPhrase',
  message:
    '{kind, select, ' +
    'PROJECT {проєкт {name, select, null {без назви} other {{name}}}} ' +
    'PROJECT_SHARE {частка за проєктом {name, select, null {без назви} other {{name}}}} ' +
    'other {частка за замовчуванням}}',
} satisfies MessageDescriptor

function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  name: string | null,
  i18n: I18n,
): string {
  return t(i18n, SUBJECT_PHRASE, { kind, name })
}

const DETAIL_MESSAGES = {
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.TRANSACTION_ADDED.detail',
    message: '{projectName, select, null {{money}} other {{money} · проєкт {projectName}}}',
  },
  TRANSACTION_STATUS_CHANGED_VALIDATED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.validated',
    message: 'Валідовано: {money}',
  },
  TRANSACTION_STATUS_CHANGED_REJECTED: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.rejected',
    message: 'Відхилено: {money}',
  },
  TRANSACTION_STATUS_CHANGED_REJECTED_WITH_REASON: /* i18n */ {
    id: 'notification.TRANSACTION_STATUS_CHANGED.rejectedWithReason',
    message: '{quote}\nВідхилено: {money}',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.TEAM_MEMBER_ADDED.detail',
    message: 'Команда {teamName}',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.PROJECT_MEMBER_ADDED.detail',
    message: 'Проєкт {projectName}',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.TEAM_NEW_MEMBER.detail',
    message: '{memberName} · команда {teamName}',
  },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.PROJECT_CONFIRM_REQUIRED.detail',
    message: 'Проєкт {projectName}',
  },
  SHARE_CONFIRM_REQUIRED_BASE: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.base',
    message: 'Частка за замовчуванням: {change}',
  },
  SHARE_CONFIRM_REQUIRED_PROJECT: /* i18n */ {
    id: 'notification.SHARE_CONFIRM_REQUIRED.project',
    message: '{change} · проєкт {projectName, select, null {без назви} other {{projectName}}}',
  },
  APPROVAL_CONFIRMED: /* i18n */ {
    id: 'notification.APPROVAL_CONFIRMED.detail',
    message: '{approverName} — {subjectPhrase}',
  },
  APPROVAL_REJECTED_NO_REASON: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.noReason',
    message: '{approverName} — {subjectPhrase}',
  },
  APPROVAL_REJECTED_WITH_REASON: /* i18n */ {
    id: 'notification.APPROVAL_REJECTED.withReason',
    message: '{quote}\n{approverName} — {subjectPhrase}',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.VACANCY_APPLICATION.detail',
    message: 'Вакансія «{vacancyTitle}»',
  },
} satisfies Record<string, MessageDescriptor>

/**
 * Подробная строка под заголовком — или её ОТСУТСТВИЕ.
 *
 * COPY-L-7 (copy-review круг 3, #664): `null` — полноправный ответ, а не
 * признак ошибки. Попап пустую деталь не рисует (`notifications-bell.tsx`
 * проверяет `view.detail`), поэтому пустого `<p>` не появится.
 *
 * task-i18n-stage4-task6: сигнатура несёт `locale` — все ветки рендерятся
 * через ОДИН `createI18n(locale)`, созданный здесь же (не на каждое поле —
 * тот же приём, что `i18n` параметром в `notification-email-copy.ts`'s
 * `BODIES`, Task 7).
 */
export function describeNotification<T extends NewNotificationType>(
  type: T,
  data: NotificationDataByType[T],
  locale: Locale,
): string | null {
  const i18n = createI18n(locale)
  switch (type) {
    case 'TRANSACTION_ADDED': {
      // COPY-H-6: полезное (сумма) вперёд, имя объекта — в хвост, где его не
      // жалко обрезать `line-clamp-2` при длинных именах клиентов.
      const d = data as NotificationDataByType['TRANSACTION_ADDED']
      return t(i18n, DETAIL_MESSAGES.TRANSACTION_ADDED, {
        money: money(d, locale),
        projectName: d.projectName,
      })
    }
    case 'TRANSACTION_STATUS_CHANGED': {
      const d = data as NotificationDataByType['TRANSACTION_STATUS_CHANGED']
      // «Валідація доходу» — термин из CONTEXT.md для перехода
      // `PENDING → VALIDATED`; «перевірка транзакції» стоит там же в списке
      // _Избегать_.
      if (d.status === 'VALIDATED') {
        return t(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_VALIDATED, {
          money: money(d, locale),
        })
      }
      // COPY-M-3: превью причины — слова конкретного человека, а не системы;
      // кавычки отделяют чужую речь от интерфейса.
      if (d.rejectionReasonPreview === null) {
        return t(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_REJECTED, {
          money: money(d, locale),
        })
      }
      // UX-M-2 (круг 2): причина — СВОИМ рядом (`NOTIFICATION_DETAIL_LINE_CHARS`),
      // факты — вторым. Порядок ТОТ ЖЕ, что у `APPROVAL_REJECTED`.
      return t(i18n, DETAIL_MESSAGES.TRANSACTION_STATUS_CHANGED_REJECTED_WITH_REASON, {
        quote: quoteWithinBudget(d.rejectionReasonPreview, NOTIFICATION_DETAIL_LINE_CHARS, locale),
        money: money(d, locale),
      })
    }
    case 'TEAM_MEMBER_ADDED': {
      const d = data as NotificationDataByType['TEAM_MEMBER_ADDED']
      return t(i18n, DETAIL_MESSAGES.TEAM_MEMBER_ADDED, { teamName: d.teamName })
    }
    case 'PROJECT_MEMBER_ADDED': {
      const d = data as NotificationDataByType['PROJECT_MEMBER_ADDED']
      return t(i18n, DETAIL_MESSAGES.PROJECT_MEMBER_ADDED, { projectName: d.projectName })
    }
    case 'TEAM_NEW_MEMBER': {
      // COPY-H-6: полезное (кто пришёл) вперёд, имя команды — в хвост.
      const d = data as NotificationDataByType['TEAM_NEW_MEMBER']
      return t(i18n, DETAIL_MESSAGES.TEAM_NEW_MEMBER, {
        memberName: d.memberName,
        teamName: d.teamName,
      })
    }
    case 'PROJECT_CONFIRM_REQUIRED': {
      const d = data as NotificationDataByType['PROJECT_CONFIRM_REQUIRED']
      return t(i18n, DETAIL_MESSAGES.PROJECT_CONFIRM_REQUIRED, { projectName: d.projectName })
    }
    case 'SHARE_CONFIRM_REQUIRED': {
      // COPY-H-6 (PROJECT-scope) + COPY-H-3 (BASE-scope — «частка за
      // замовчуванням», без переворота порядка).
      const d = data as NotificationDataByType['SHARE_CONFIRM_REQUIRED']
      const change = `${percentText(d.previousPercent, i18n)} → ${percentText(d.proposedPercent, i18n)}`
      return d.scope === 'BASE'
        ? t(i18n, DETAIL_MESSAGES.SHARE_CONFIRM_REQUIRED_BASE, { change })
        : t(i18n, DETAIL_MESSAGES.SHARE_CONFIRM_REQUIRED_PROJECT, {
            change,
            projectName: d.projectName,
          })
    }
    case 'DOCUMENT_SIGN_REQUIRED': {
      // COPY-L-7 (круг 3): детали НЕТ — она была подмножеством заголовка.
      return null
    }
    case 'APPROVAL_CONFIRMED': {
      const d = data as NotificationDataByType['APPROVAL_CONFIRMED']
      return t(i18n, DETAIL_MESSAGES.APPROVAL_CONFIRMED, {
        approverName: d.approverName,
        subjectPhrase: subjectPhrase(d.subjectKind, d.subjectTitle, i18n),
      })
    }
    case 'APPROVAL_REJECTED': {
      // COPY-M-7 / UX-M-2: причина идёт ПЕРВОЙ строкой, ограничена ОДНИМ рядом.
      const d = data as NotificationDataByType['APPROVAL_REJECTED']
      const params = {
        approverName: d.approverName,
        subjectPhrase: subjectPhrase(d.subjectKind, d.subjectTitle, i18n),
      }
      if (d.reasonPreview === null) {
        return t(i18n, DETAIL_MESSAGES.APPROVAL_REJECTED_NO_REASON, params)
      }
      return t(i18n, DETAIL_MESSAGES.APPROVAL_REJECTED_WITH_REASON, {
        ...params,
        quote: quoteWithinBudget(d.reasonPreview, NOTIFICATION_DETAIL_LINE_CHARS, locale),
      })
    }
    // task-i18n-stage4-task6, Step 1/6: три замороженных типа.
    case 'INVOICE_SIGNED': {
      // §10: контрагент назван РОВНО один раз (не дублируется заголовком —
      // «Рахунок підписано» его не называет) — имя чистое, без обёртки.
      const d = data as NotificationDataByType['INVOICE_SIGNED']
      return d.counterpartyName
    }
    case 'INVOICE_SIGN_REQUIRED': {
      const d = data as NotificationDataByType['INVOICE_SIGN_REQUIRED']
      return money(d, locale)
    }
    case 'VACANCY_APPLICATION': {
      const d = data as NotificationDataByType['VACANCY_APPLICATION']
      return t(i18n, DETAIL_MESSAGES.VACANCY_APPLICATION, { vacancyTitle: d.vacancyTitle })
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
 * COPY-M-1 (copy-review круг 1, #664): подпись кнопки — глагол + объект.
 *
 * `APPROVAL_CONFIRMED` / `APPROVAL_REJECTED` сюда НЕ входят: их объект — либо
 * PROJECT, либо USER, подпись обязана называть то, что реально откроется, и
 * решается в `actionLabelFor`.
 */
const ACTION_LABELS: Record<
  Exclude<NewNotificationType, 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'>,
  MessageDescriptor
> = {
  TRANSACTION_ADDED: /* i18n */ {
    id: 'notification.action.TRANSACTION_ADDED',
    message: 'Відкрити фінанси',
  },
  TRANSACTION_STATUS_CHANGED: /* i18n */ {
    id: 'notification.action.TRANSACTION_STATUS_CHANGED',
    message: 'Відкрити фінанси',
  },
  TEAM_MEMBER_ADDED: /* i18n */ {
    id: 'notification.action.TEAM_MEMBER_ADDED',
    message: 'Відкрити команду',
  },
  PROJECT_MEMBER_ADDED: /* i18n */ {
    id: 'notification.action.PROJECT_MEMBER_ADDED',
    message: 'Відкрити проєкт',
  },
  TEAM_NEW_MEMBER: /* i18n */ {
    id: 'notification.action.TEAM_NEW_MEMBER',
    message: 'Відкрити команду',
  },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.action.PROJECT_CONFIRM_REQUIRED',
    message: 'Відкрити проєкт',
  },
  SHARE_CONFIRM_REQUIRED: /* i18n */ {
    id: 'notification.action.SHARE_CONFIRM_REQUIRED',
    message: 'Відкрити пропозицію',
  },
  DOCUMENT_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.action.DOCUMENT_SIGN_REQUIRED',
    message: 'Підписати контракт',
  },
  INVOICE_SIGNED: /* i18n */ {
    id: 'notification.action.INVOICE_SIGNED',
    message: 'Відкрити рахунок',
  },
  INVOICE_SIGN_REQUIRED: /* i18n */ {
    id: 'notification.action.INVOICE_SIGN_REQUIRED',
    message: 'Підписати рахунок',
  },
  VACANCY_APPLICATION: /* i18n */ {
    id: 'notification.action.VACANCY_APPLICATION',
    message: 'Відкрити вакансію',
  },
}

const ACTION_LABEL_APPROVAL_PROJECT = /* i18n */ {
  id: 'notification.action.approval.project',
  message: 'Відкрити проєкт',
} satisfies MessageDescriptor
const ACTION_LABEL_APPROVAL_PROFILE = /* i18n */ {
  id: 'notification.action.approval.profile',
  message: 'Відкрити профіль',
} satisfies MessageDescriptor

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
    return t(
      i18n,
      subjectType === 'USER' ? ACTION_LABEL_APPROVAL_PROFILE : ACTION_LABEL_APPROVAL_PROJECT,
    )
  }
  return t(
    i18n,
    ACTION_LABELS[type as Exclude<NewNotificationType, 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'>],
  )
}

/**
 * COPY-M-4 (copy-review круг 1, #664): «Объекта больше нет» — слово из спеки,
 * которого нет в интерфейсе CRM. Вид объекта в момент показа уже известен
 * (`n.subjectType`), поэтому честность ничего не теряет от того, чтобы
 * назвать объект конкретно.
 */
const SUBJECT_MISSING_LABELS: Record<NotificationSubjectType, MessageDescriptor> = {
  PROJECT: /* i18n */ { id: 'notification.subjectMissing.PROJECT', message: 'Проєкт видалено' },
  TEAM: /* i18n */ { id: 'notification.subjectMissing.TEAM', message: 'Команду видалено' },
  USER: /* i18n */ { id: 'notification.subjectMissing.USER', message: 'Профіль видалено' },
  TRANSACTION: /* i18n */ {
    id: 'notification.subjectMissing.TRANSACTION',
    message: 'Транзакцію видалено',
  },
  EMPLOYEE_CONTRACT: /* i18n */ {
    id: 'notification.subjectMissing.EMPLOYEE_CONTRACT',
    message: 'Контракт видалено',
  },
}
const SUBJECT_MISSING_FALLBACK = /* i18n */ {
  id: 'notification.subjectMissing.fallback',
  message: 'Цього більше немає в CRM',
} satisfies MessageDescriptor

function subjectMissingLabel(subjectType: NotificationSubjectType | null, i18n: I18n): string {
  return subjectType === null
    ? t(i18n, SUBJECT_MISSING_FALLBACK)
    : t(i18n, SUBJECT_MISSING_LABELS[subjectType])
}

/**
 * QA-M-3 / QA-L-2 (manual-qa круг 2, #664): архив — не удаление.
 *
 * Транзакция и контракт сюда не попадают по построению (архива у них нет —
 * см. `loadSubjectStates`), но запись есть у всех пяти видов: `Record` без
 * пропусков — то, что сломает компиляцию на шестом виде объекта.
 */
const SUBJECT_ARCHIVED_LABELS: Record<NotificationSubjectType, MessageDescriptor> = {
  PROJECT: /* i18n */ { id: 'notification.subjectArchived.PROJECT', message: 'Проєкт в архіві' },
  TEAM: /* i18n */ { id: 'notification.subjectArchived.TEAM', message: 'Команда в архіві' },
  USER: /* i18n */ { id: 'notification.subjectArchived.USER', message: 'Профіль в архіві' },
  TRANSACTION: /* i18n */ {
    id: 'notification.subjectArchived.TRANSACTION',
    message: 'Транзакція в архіві',
  },
  EMPLOYEE_CONTRACT: /* i18n */ {
    id: 'notification.subjectArchived.EMPLOYEE_CONTRACT',
    message: 'Контракт в архіві',
  },
}
const SUBJECT_ARCHIVED_FALLBACK = /* i18n */ {
  id: 'notification.subjectArchived.fallback',
  message: 'Це прибрано в архів',
} satisfies MessageDescriptor

function subjectArchivedLabel(subjectType: NotificationSubjectType | null, i18n: I18n): string {
  return subjectType === null
    ? t(i18n, SUBJECT_ARCHIVED_FALLBACK)
    : t(i18n, SUBJECT_ARCHIVED_LABELS[subjectType])
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
const APPROVAL_SUPERSEDED_LABEL = /* i18n */ {
  id: 'notification.approvalSuperseded',
  message: 'Рішення більше не потрібне',
} satisfies MessageDescriptor
const APPROVAL_DECIDED_LABEL = /* i18n */ {
  id: 'notification.approvalDecided',
  message: 'Рішення вже прийнято',
} satisfies MessageDescriptor

const OPEN_LABEL = /* i18n */ {
  id: 'notification.action.open',
  message: 'Відкрити',
} satisfies MessageDescriptor

const DOCUMENT_SIGN_UNAVAILABLE_LABEL = /* i18n */ {
  id: 'notification.action.documentSignUnavailable',
  message: 'Підпис більше не потрібен',
} satisfies MessageDescriptor

export function notificationActions(
  n: RenderableNotification,
  locale: Locale,
): NotificationAction[] {
  const i18n = createI18n(locale)
  // §7.4: уведомление живёт дольше объекта. Честное «объекта больше нет»
  // вместо кнопки в белый экран.
  if (n.subjectMissing === true) {
    // QA-M-1 (manual-qa круг 1, #664): контракт в этой системе не удаляется —
    // `EmployeeContractsService` только меняет статус.
    //
    // COPY-M-8 (circle 2): «статус ≠ READY_TO_SIGN» ведёт к ТРЁМ переходам —
    // сказано ровно то, что известно.
    if (n.type === 'DOCUMENT_SIGN_REQUIRED') {
      return [{ label: t(i18n, DOCUMENT_SIGN_UNAVAILABLE_LABEL), href: null, disabled: true }]
    }
    return [{ label: subjectMissingLabel(n.subjectType, i18n), href: null, disabled: true }]
  }
  // QA-M-3 / QA-L-2: архив проверяется ПОСЛЕ исчезновения и отдельно от него.
  if (n.subjectArchived === true) {
    return [{ label: subjectArchivedLabel(n.subjectType, i18n), href: null, disabled: true }]
  }
  // ORCH-2 (fix-раунд 6): ПОСЛЕ объекта (missing/archived) и отдельно от него.
  if (n.approvalDecided === true) {
    return [{ label: t(i18n, APPROVAL_DECIDED_LABEL), href: null, disabled: true }]
  }
  if (n.approvalSuperseded === true) {
    return [{ label: t(i18n, APPROVAL_SUPERSEDED_LABEL), href: null, disabled: true }]
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
  if (n.link !== null) {
    return [{ label: t(i18n, OPEN_LABEL), href: n.link, disabled: false }]
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
 * task-i18n-stage4-task6: `locale` — зрителя (`apps/web`) или получателя
 * (письмо, Task 7); никогда глобальный синглтон в модульной константе.
 * `createI18n(locale)` создаётся здесь ОДИН раз для заголовка;
 * `describeNotification`/`notificationActions` создают СВОИ (каждая функция —
 * самостоятельный публичный вызывающий сайт со своим локальным `i18n`).
 */
export function renderNotification(
  n: RenderableNotification,
  locale: Locale,
): RenderedNotification {
  const actions = notificationActions(n, locale)
  if (isNewNotificationType(n.type)) {
    const parsed = dataSchemas[n.type].safeParse(n.data)
    if (parsed.success) {
      const i18n = createI18n(locale)
      return {
        title: t(i18n, NOTIFICATION_TITLE_MESSAGES[n.type]),
        detail: describeNotification(n.type, parsed.data as never, locale),
        actions,
      }
    }
  }
  return { title: n.title, detail: n.body, actions }
}
