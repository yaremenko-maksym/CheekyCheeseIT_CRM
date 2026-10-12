import { z } from 'zod'
import { NEW_NOTIFICATION_TYPES, type NewNotificationType } from './types'

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

export const dataSchemas = {
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
  // i18n server-text PR2: the producer ships a code, not the Russian string
  // «Ваш контракт». The legacy `documentTitle` shape stays parseable ONLY for
  // rows already stored in `notifications.data`; nothing writes it any more.
  DOCUMENT_SIGN_REQUIRED: z.union([
    z.object({ documentKind: z.literal('EMPLOYEE_CONTRACT') }),
    z.object({ documentTitle: objectName }),
  ]),
  // i18n server-text PR4 (S4): `approverName` is `null` when the approver's row
  // is gone at decision time — the producer no longer writes the Russian
  // «Сотрудник»; the renderer substitutes `MISC_MESSAGES.approverUnknown`.
  // Rows already stored keep their literal name and stay parseable.
  APPROVAL_CONFIRMED: z.object({
    approverName: objectName.nullable(),
    subjectKind: z.enum(['PROJECT', 'PROJECT_SHARE', 'BASE_SHARE']),
    subjectTitle: objectName.nullable(),
  }),
  APPROVAL_REJECTED: z.object({
    approverName: objectName.nullable(),
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
  //
  // COPY-M-4 (copy-review круг 1, #714): `...moneyFields` — сумма підписаного
  // рахунку, деталь без неї не розрізняла кілька рахунків одного контрагента.
  INVOICE_SIGNED: z.object({ counterpartyName: objectName, ...moneyFields }),
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
