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
 * Требуют действия (§7.2) — письмо не отключается.
 *
 * COPY-L-3 (copy-review круг 2, #664): здесь стояло обоснование словесного
 * префикса «Ждёт решения», который сам же copy-review и снял кругом раньше
 * (COPY-H-1) — комментарий велел будущему автору вернуть снятое. Семья
 * узнаётся по общему значку `TypeIcon`, а не по словесному префиксу: предмет
 * стоит первым словом заголовка, а «от вас ждут решения» говорит значок.
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
  // «Принято», не «подтверждено» (правка после COPY-H-2, найдена и
  // задокументирована в этом же раунде, вне первоначального предложения
  // ревьюера — см. «Допущения» PR): «Предложение подтверждено» — 24 знака —
  // не помещается в 202px бюджет строки попапа при непрочитанной точке
  // (204px нужно, единственная строка из десяти, где это вскрылось —
  // `truncate` резал «подтвержде…»). «Принято» короче на 5 знаков (19 —
  // ровно бюджет COPY-H-1) И уже есть в этом же домене как канонический
  // антоним «отклонено» (`use-user-profile.ts`, `seniorShareErrorMessage`:
  // «Решение по этому предложению уже принято») — пара «принято/отклонено»
  // читается яснее, чем «подтверждено/отклонено» (последнее — не прямые
  // антонимы по форме глагола).
  APPROVAL_CONFIRMED: 'Предложение принято',
  APPROVAL_REJECTED: 'Предложение отклонено',
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
    // Превью, а не причина целиком, и ОТСУТСТВИЕ превью допустимо (§10 +
    // SR-H-1): администратор узнаёт ФАКТ отказа и идёт читать причину в CRM.
    // Обязательное поле здесь означало бы, что причина, которую не удалось
    // свести к превью, отменяет и сообщение об отказе.
    reasonPreview: textPreview,
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

/**
 * COPY-H-4 / QA-M-1 (copy-review + manual-qa круг 1, #664): `amount` приезжает
 * из `numeric('amount', { precision: 18, scale: 6 })` как строка вида
 * `1500.000000` — печать её "as is" уже дважды чинили по итогам живого
 * тестирования в других потребителях той же колонки (`format-amount.ts`,
 * `invoices.service.ts#formatAmountForNotification`). Тот же разбор денег,
 * та же локаль (`ru-RU`, два знака, пробел тысяч, запятая) — «1 500,00 USDT»
 * вместо «1500.000000 USDT», без расхождения внутри одного попапа.
 */
function money(d: { amount: string; currency: string }): string {
  const num = Number(d.amount)
  if (!Number.isFinite(num)) return `${d.amount} ${d.currency}`
  return `${num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${d.currency}`
}

/**
 * Сколько текста подробностей человек РЕАЛЬНО видит в попапе.
 *
 * COPY-M-7 (copy-review круг 2) + UX-M-2 (design-review круг 2), #664. Круг 1
 * завёл кавычки-«ёлочки» и перенос строки ради причины отказа — и ни один
 * читатель её не увидел: строка деталей стоит в колонке ≈204 px
 * (`w-80` минус значок, отступы, точка непрочитанного и корзина) при `text-xs`,
 * то есть ~30 знаков в ряд, и `line-clamp-2` показывает ДВА ряда. «Иван Петров
 * — доля по проекту Acme Corporation» — 45 знаков — съедало оба, а причина
 * жила на третьем ряду, которого не существует.
 *
 * Числа здесь — не украшение: из них выводится бюджет цитаты, поэтому
 * усечение считается арифметикой, а не подбирается на глаз. Экспортируются,
 * чтобы тест мерил ровно тем же, чем меряет код.
 */
export const NOTIFICATION_DETAIL_LINE_CHARS = 30
export const NOTIFICATION_DETAIL_LINES = 2

/**
 * Нижний предел цитаты: даже когда всё остальное в строке съело бюджет
 * (сумма в двенадцать разрядов), причина показывается хотя бы началом.
 * Потерять её целиком — ровно тот дефект, который чинит COPY-M-7.
 */
const QUOTE_MIN_CHARS = 8

/**
 * Чужая речь в «ёлочках», гарантированно закрытых В ВИДИМОЙ ЧАСТИ.
 *
 * Два свойства, каждое — отдельная находка круга 2:
 *   - усечение по КОД-ПОИНТАМ с многоточием ВНУТРИ кавычек (UX-M-2): на
 *     скриншотах закрывающая «»» пропадала, и цитата читалась как обрыв
 *     строки, а не как усечённая чужая речь;
 *   - перевод строки внутри причины схлопывается в пробел: человек вправе
 *     написать отказ в три абзаца, а `whitespace-pre-wrap` в попапе отдал бы
 *     каждому абзацу свой ряд клипа — и закрывающая кавычка снова уехала бы
 *     за границу.
 *
 * Серверное превью (`notificationTextPreview`, 200 знаков) этим НЕ заменяется:
 * оно про раскрытие (§10, письмо на личную почту), это — про ширину попапа.
 * Разные потолки у разных поверхностей — не дублирование.
 */
function quoteWithinBudget(text: string, budget: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const inner = Math.max(budget - 2, QUOTE_MIN_CHARS)
  const points = Array.from(flat)
  if (points.length <= inner) return `«${flat}»`
  return `«${points.slice(0, inner - 1).join('')}…»`
}

/**
 * COPY-H-3: единственный вызывающий — `describeNotification('SHARE_CONFIRM_REQUIRED')`,
 * то есть «этот контекст» и есть весь контракт функции. «По умолчанию» здесь
 * сталкивалось бы с тем же словом в `subjectPhrase` («базовая доля» →
 * «доля по умолчанию»): `Доля по умолчанию: по умолчанию → 30%` — одно слово
 * в двух разных ролях в одной строке. «Не задана» разводит смыслы.
 */
function percentText(value: number | null): string {
  return value === null ? 'не задана' : `${value}%`
}

/**
 * COPY-H-3: «базовая доля» — слово, вычищенное copy-review на #648
 * (`OverviewTab.tsx`, банер `pending-base-share-approval-banner`: «доля по
 * умолчанию» — тот же термин, что и `CONTEXT.md` статья «Доля синьора»,
 * «базов*» не встречается больше нигде в `apps/web`). Этот реестр вернул бы
 * его через `@crm/shared`, ничего не зная об уже принятом решении.
 */
function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  title: string | null,
): string {
  if (kind === 'BASE_SHARE') return 'доля по умолчанию'
  const named = title ?? 'без названия'
  return kind === 'PROJECT' ? `проект ${named}` : `доля по проекту ${named}`
}

export function describeNotification<T extends NewNotificationType>(
  type: T,
  data: NotificationDataByType[T],
): string {
  switch (type) {
    case 'TRANSACTION_ADDED': {
      // COPY-H-6: полезное (сумма) вперёд, имя объекта — в хвост, где его не
      // жалко обрезать `line-clamp-2` при длинных именах клиентов (потолок
      // имени — 255 код-поинтов, а бюджет строки в попапе — ~64 знака).
      const d = data as NotificationDataByType['TRANSACTION_ADDED']
      return d.projectName === null ? money(d) : `${money(d)} · проект ${d.projectName}`
    }
    case 'TRANSACTION_STATUS_CHANGED': {
      const d = data as NotificationDataByType['TRANSACTION_STATUS_CHANGED']
      // «Валидация дохода» — термин из CONTEXT.md для перехода
      // `PENDING → VALIDATED`; «проверка транзакции» стоит там же в списке
      // _Избегать_. Это первый текст, который увидят все сотрудники, и он
      // обязан говорить теми же словами, что и остальной интерфейс.
      if (d.status === 'VALIDATED') return `Доход валидирован: ${money(d)}`
      // COPY-M-3: превью причины — слова конкретного человека, а не системы;
      // кавычки-«ёлочки» отделяют чужую речь от интерфейса.
      if (d.rejectionReasonPreview === null) return `Доход отклонён: ${money(d)}`
      // UX-M-2 (design-review круг 2): на живом кадре 320 закрывающая «»»
      // отсутствовала — `line-clamp-2` срезал её вместе с хвостом причины,
      // потому что цитата стояла ПОСЛЕДНЕЙ. Причина уходит вперёд суммы, а её
      // бюджет считается из того, что в этой же строке занято: сумма нужна
      // целиком (COPY-H-4), цитата усекается до остатка.
      const head = 'Доход отклонён: '
      const tail = ` — ${money(d)}`
      const budget =
        NOTIFICATION_DETAIL_LINE_CHARS * NOTIFICATION_DETAIL_LINES - head.length - tail.length
      return `${head}${quoteWithinBudget(d.rejectionReasonPreview, budget)}${tail}`
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
      // COPY-H-6: полезное (кто пришёл) вперёд, имя команды — в хвост.
      const d = data as NotificationDataByType['TEAM_NEW_MEMBER']
      return `${d.memberName} · команда ${d.teamName}`
    }
    case 'PROJECT_CONFIRM_REQUIRED': {
      const d = data as NotificationDataByType['PROJECT_CONFIRM_REQUIRED']
      return `Проект ${d.projectName}`
    }
    case 'SHARE_CONFIRM_REQUIRED': {
      // COPY-H-6 (только PROJECT-scope — оба процента теряются первыми на
      // `line-clamp-2`, имя проекта в хвосте обрезать не так жалко) + COPY-H-3
      // (BASE-scope — «доля по умолчанию», без переворота порядка: тут терять
      // нечего, значение всего одно).
      const d = data as NotificationDataByType['SHARE_CONFIRM_REQUIRED']
      const change = `${percentText(d.previousPercent)} → ${percentText(d.proposedPercent)}`
      return d.scope === 'BASE'
        ? `Доля по умолчанию: ${change}`
        : `${change} · проект ${d.projectName ?? 'без названия'}`
    }
    case 'DOCUMENT_SIGN_REQUIRED': {
      const d = data as NotificationDataByType['DOCUMENT_SIGN_REQUIRED']
      return d.documentTitle
    }
    case 'APPROVAL_CONFIRMED': {
      const d = data as NotificationDataByType['APPROVAL_CONFIRMED']
      return `${d.approverName} — ${subjectPhrase(d.subjectKind, d.subjectTitle)}`
    }
    case 'APPROVAL_REJECTED': {
      // COPY-M-7 (copy-review круг 2) = UX-M-2 (design-review круг 2): причина
      // идёт ПЕРВОЙ строкой, а не последней. Кругом раньше она стояла после
      // «кто — по какому объекту», и на отказе по доле (основной поток
      // #646/#648) эта пара сама по себе занимала оба ряда `line-clamp-2` —
      // причину не видел никто ни разу. Теперь клип режет хвост предмета:
      // имя согласующего админ и так знает, причину — нет.
      //
      // Цитата ограничена ОДНИМ рядом (`\n` начинает новый — отрисовывается
      // `whitespace-pre-wrap` в `notifications-bell.tsx`): будь она длиннее,
      // она съела бы оба ряда и вытеснила предмет целиком, поменяв потерю
      // местами вместо того, чтобы её снять.
      const d = data as NotificationDataByType['APPROVAL_REJECTED']
      const subject = `${d.approverName} — ${subjectPhrase(d.subjectKind, d.subjectTitle)}`
      if (d.reasonPreview === null) return subject
      return `${quoteWithinBudget(d.reasonPreview, NOTIFICATION_DETAIL_LINE_CHARS)}\n${subject}`
    }
    default: {
      // CR-M-1 (код-ревью круг 1): одиннадцатый тип обязан ЛОМАТЬ КОМПИЛЯЦИЮ
      // здесь, а не молча проваливаться в чужую форму данных.
      //
      // Соседи по файлу (`NOTIFICATION_TITLES`, `ACTION_LABELS`,
      // `dataSchemas`) уже не дают забыть новый тип — через
      // `Record<NewNotificationType, …>` и `satisfies`. У `switch` такой
      // страховки не было: добавить тип в `NEW_NOTIFICATION_TYPES` и
      // дописать его форму можно было, НЕ дописав его описание, — и человек
      // увидел бы поля чужого типа вместо ошибки сборки.
      //
      // Деградация НЕИЗВЕСТНОГО типа на клиенте (AC6) — отдельная и живая
      // ветка на границе (`renderNotification`): данные с сервера могут быть
      // старше бандла. Здесь речь о другом — о типе, известном системе типов,
      // но забытом автором. Поэтому бросок, а не запасная форма: до этой
      // строки нельзя доехать, не обманув компилятор.
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
 * «К транзакциям» — предлог, не действие; «Посмотреть и подтвердить» — два
 * глагола (и обещание исхода, которого может не быть — сотрудник вправе
 * отклонить); «Открыть» без объекта — ровно случай, который называет
 * `copywriting`.
 *
 * `APPROVAL_CONFIRMED` / `APPROVAL_REJECTED` сюда НЕ входят: их объект — либо
 * PROJECT, либо USER (см. `approvalNotificationSubject` в API), подпись
 * обязана называть то, что реально откроется, и решается в `actionLabelFor`.
 * Держать для них запись в этой карте значило бы держать текст, который
 * ничто не читает, — и мутационный гейт не увидел бы порчу мёртвой строки.
 */
const ACTION_LABELS: Record<
  Exclude<NewNotificationType, 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'>,
  string
> = {
  TRANSACTION_ADDED: 'Открыть финансы',
  TRANSACTION_STATUS_CHANGED: 'Открыть финансы',
  TEAM_MEMBER_ADDED: 'Открыть команду',
  PROJECT_MEMBER_ADDED: 'Открыть проект',
  TEAM_NEW_MEMBER: 'Открыть команду',
  PROJECT_CONFIRM_REQUIRED: 'Открыть проект',
  SHARE_CONFIRM_REQUIRED: 'Открыть предложение',
  DOCUMENT_SIGN_REQUIRED: 'Подписать контракт',
}

/**
 * Подпись кнопки для «админу» — зависит от вида объекта решения (COPY-M-1):
 * USER — решение по базовой доле сотрудника, ведёт в его профиль; всё
 * остальное (PROJECT) — черновик проекта или доля ПО проекту, ведёт в проект.
 */
function actionLabelFor(type: NewNotificationType, subjectType: NotificationSubjectType): string {
  if (type === 'APPROVAL_CONFIRMED' || type === 'APPROVAL_REJECTED') {
    return subjectType === 'USER' ? 'Открыть профиль' : 'Открыть проект'
  }
  return ACTION_LABELS[type]
}

/**
 * COPY-M-4 (copy-review круг 1, #664): «Объекта больше нет» — слово из спеки,
 * которого нет в интерфейсе CRM. Вид объекта в момент показа уже известен
 * (`n.subjectType`), поэтому честность ничего не теряет от того, чтобы
 * назвать объект конкретно.
 */
const SUBJECT_MISSING_LABELS: Record<NotificationSubjectType, string> = {
  PROJECT: 'Проект удалён',
  TEAM: 'Команда удалена',
  USER: 'Профиль удалён',
  TRANSACTION: 'Транзакция удалена',
  EMPLOYEE_CONTRACT: 'Контракт удалён',
}

function subjectMissingLabel(subjectType: NotificationSubjectType | null): string {
  return subjectType === null ? 'Этого больше нет в CRM' : SUBJECT_MISSING_LABELS[subjectType]
}

/**
 * QA-M-3 / QA-L-2 (manual-qa круг 2, #664): архив — не удаление.
 *
 * Живой прогон: архивированный проект оставлял кнопку активной, и джун, чьё
 * членство завершилось каскадом архивации, приезжал на страницу с текстом
 * «Вас ещё не добавили в проект». Сказать вместо этого «Проект удалён» было
 * бы вторым враньём: проект цел, его видно в архиве. Подпись называет ровно
 * то, что произошло, и никуда не ведёт.
 *
 * Транзакция и контракт сюда не попадают по построению (архива у них нет —
 * см. `loadSubjectStates`), но запись есть у всех пяти видов: `Record` без
 * пропусков — то, что сломает компиляцию на шестом виде объекта.
 */
const SUBJECT_ARCHIVED_LABELS: Record<NotificationSubjectType, string> = {
  PROJECT: 'Проект в архиве',
  TEAM: 'Команда в архиве',
  USER: 'Профиль в архиве',
  TRANSACTION: 'Транзакция в архиве',
  EMPLOYEE_CONTRACT: 'Контракт в архиве',
}

function subjectArchivedLabel(subjectType: NotificationSubjectType | null): string {
  return subjectType === null ? 'Это убрано в архив' : SUBJECT_ARCHIVED_LABELS[subjectType]
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
}

export function notificationActions(n: RenderableNotification): NotificationAction[] {
  // §7.4: уведомление живёт дольше объекта. Честное «объекта больше нет»
  // вместо кнопки в белый экран.
  if (n.subjectMissing === true) {
    // QA-M-1 (manual-qa круг 1, #664): контракт в этой системе не удаляется —
    // `EmployeeContractsService` только меняет статус, поэтому «Контракт
    // удалён» было бы неправдой, и `loadSubjectStates` считает «объект есть»
    // как «статус всё ещё READY_TO_SIGN».
    //
    // COPY-M-8 (copy-review круг 2): но и «Контракт подписан» утверждало
    // факт, которого реестр не знает. Условие — «статус ≠ READY_TO_SIGN», а
    // туда ведут ТРИ перехода: подпись сотрудником, возврат админом в
    // черновик и отмена (`CANCELLED`, терминальная). В двух последних
    // сотрудник читал про свой контракт утверждение, которого не было, —
    // у отменённого навсегда. Сказано ровно то, что известно, и это отвечает
    // на единственный вопрос читателя: от меня ещё чего-то ждут?
    if (n.type === 'DOCUMENT_SIGN_REQUIRED') {
      return [{ label: 'Подпись больше не требуется', href: null, disabled: true }]
    }
    return [{ label: subjectMissingLabel(n.subjectType), href: null, disabled: true }]
  }
  // QA-M-3 / QA-L-2: архив проверяется ПОСЛЕ исчезновения и отдельно от него —
  // у «нет объекта» и «объект в архиве» разные подписи, и путать их значит
  // врать в одну или в другую сторону.
  if (n.subjectArchived === true) {
    return [{ label: subjectArchivedLabel(n.subjectType), href: null, disabled: true }]
  }
  if (isNewNotificationType(n.type) && n.subjectType !== null && n.subjectId !== null) {
    return [
      {
        label: actionLabelFor(n.type, n.subjectType),
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
