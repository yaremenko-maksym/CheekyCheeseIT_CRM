/**
 * Письма уведомлений — позиция 7a, спека §11 («Тексты писем») и §10
 * («уведомления о деньгах — это раскрытие»); i18n-письма PR1: язык ПОЛУЧАТЕЛЯ.
 *
 * Каждая фраза — целое сообщение каталога (`EMAIL_NOTIFICATION_MESSAGES` в
 * `@crm/shared`, явные id `email.notification.*`, `uk` — исходник, `en` — второй
 * оригинал в `.po`). Письмо собирается ПО ЛОКАЛИ ПОЛУЧАТЕЛЯ (`users.locale`,
 * читается кроном в момент отправки) через `createI18n(locale)` НА КАЖДЫЙ вызов:
 * ни глобального `i18n.activate`, ни модульного инстанса — в кроне между письмами
 * много `await`, и глобаль сменила бы язык посреди сборки. Ничего не склеивается
 * из фрагментов: варианты «с названием / без», «базовая / проектная доля» — это
 * отдельные целые сообщения, которые выбирает вызывающий.
 *
 * Текст НЕ хранится в базе (§7.1): правка формулировки не должна быть правкой
 * данных. Сохранённые `title`/`body` строки уведомления — ДАННЫЕ, а не каталог:
 * для типа, которого шаблон не знает, они печатаются как есть в обеих локалях.
 *
 * Правило, которому подчиняются все тринадцать и которое механически проверяет
 * `notification-email-copy.spec.ts` (в обеих локалях):
 *
 *   **письмо называет ОБЪЕКТ (проект, команда, контракт, вакансия) и не называет
 *   ни людей, ни цифр.**
 *
 * Первая половина — из §11: темы там прямо содержат «{название}», и без имени
 * объекта читатель не понимает, к чему письмо. Вторая — из §10: письмо уходит
 * на ЛИЧНУЮ почту, вне нашего контура, поэтому ни сумма, ни процент, ни имя
 * коллеги туда не едут. Всё это открывается по кнопке, в CRM.
 *
 * Остальные правила §11, каждое отражено тестом:
 *   - **одна кнопка** («„Открыть“ и „Отклонить“ рядом означало бы, что отказ
 *     можно дать не заходя, — а нам нужен след в системе с причиной»);
 *   - **ни благодарностей, ни вежливой рамки** («транзакционное письмо,
 *     которое благодарит, читается как рассылка и попадает в „Промоакции“»);
 *   - **единый префикс «Запит на …» / «Request to …»** у всего, что требует
 *     ответа, — он сообщает, что это предложение, а не свершившийся факт, ещё до
 *     открытия;
 *   - **в письме о смене частки вторая строка снимает испуг** — действует
 *     прежняя частка, новая вступит в силу только после согласия.
 *
 * Вёрстка — ОБЩИЙ каркас `common/email-layout.ts`, тот же объект, которым
 * собирается приглашение (`personal-email-invite-mailer.service.ts`): «письма
 * от нас выглядят одним отправителем, на котором почта учится» (§12).
 *
 * **Словарь.** Объект решения о деньгах называется ЧАСТКОЮ / «share» — так его
 * называют попап, `/pending`, профиль и `CONTEXT.md` (где «процент дропа» стоит в
 * `_Избегать_`). Прежнее русское исключение «процент» в теме запроса о доле ПО
 * ПРОЕКТУ не пережило миграцию: в языке, где глоссарный термин обязателен,
 * исключению нет основания (допущение A1 плана, copy-reviewer может оспорить).
 */
import type { I18n } from '@lingui/core'
import {
  ACTION_LABELS,
  createI18n,
  EMAIL_NOTIFICATION_MESSAGES as M,
  isActionRequiredNotificationType,
  isNewNotificationType,
  MISC_MESSAGES,
  notificationDataSchemaFor,
  notificationHref,
  NOTIFICATION_TITLE_MESSAGES,
  renderMessage,
  type Locale,
  type NewNotificationType,
  type NotificationDataByType,
  type NotificationSubjectType,
} from '@crm/shared'
import { renderEmailLayout } from '../common/email-layout'
import { escapeHtml } from '../common/escape-html'
import { stripCrlf } from '../common/strip-crlf'

/**
 * Экран, где на запрос можно ОТВЕТИТЬ (позиция 7c, #667).
 *
 * Ссылка письма для трёх типов, требующих действия, ведёт сюда, а не на объект:
 * на `/projects/:id` кнопок подтверждения нет, и письмо «Запрос на добавление
 * проекта» приводило бы читателя туда, где ответить нечем (SPEC-H-3 / CR-H-4).
 */
const PENDING_PATH = '/pending'

/** Строка уведомления в том объёме, который нужен письму. */
export interface NotificationEmailSource {
  type: string
  title: string
  body: string | null
  link: string | null
  subjectType: NotificationSubjectType | null
  subjectId: string | null
  data: unknown
}

export interface RenderedNotificationEmail {
  subject: string
  text: string
  html: string
  /** Абсолютный адрес единственной кнопки. */
  buttonHref: string
  buttonLabel: string
}

interface RenderOptions {
  /** Корень CRM без хвостового слэша (`FRONTEND_URL`). */
  frontendUrl: string
  /**
   * Язык ПОЛУЧАТЕЛЯ. Обязателен и без дефолта: забытый вызывающий обязан упасть на
   * typecheck, а не молча отправить `uk`. Рендерер сам строит `createI18n(locale)`,
   * поэтому передать ему чужой активированный инстанс нельзя.
   */
  locale: Locale
}

/** Тело письма: одна-две строки. Вторая существует только там, где она снимает испуг. */
interface Body {
  subject: string
  lines: string[]
}

/**
 * Заголовок и строки по типу события.
 *
 * Каждая функция получает УЖЕ разобранные данные своей формы. Разбор — на
 * вызывающем (`renderNotificationEmail`), чтобы неразобравшаяся строка
 * деградировала в общий вид, а не роняла отправку: письмо зовёт в CRM, и
 * потерять единственный канал, доходящий до закрытой вкладки, дороже, чем
 * отправить письмо без имени проекта.
 */
const BODIES: {
  [K in NewNotificationType]: (d: NotificationDataByType[K], i18n: I18n) => Body
} = {
  TRANSACTION_ADDED: (d, i18n) => ({
    // Имя проекта — с 24-го знака, а не с 35-го (COPY-L-2): в списке входящих
    // на телефоне видно около сорока, и обрезается ровно то единственное, чем
    // два таких письма различаются.
    subject:
      d.projectName === null
        ? renderMessage(i18n, M.transactionAddedSubject)
        : renderMessage(i18n, M.transactionAddedSubjectProject, { projectName: d.projectName }),
    lines: [renderMessage(i18n, M.transactionAddedLine)],
  }),

  TRANSACTION_STATUS_CHANGED: (d, i18n) => ({
    // Статус — не сумма и не процент, и он единственное, ради чего письмо
    // читают. Прятать его значило бы слать письмо «случилось что-то».
    //
    // Актор НЕ назван (COPY-H-2): валидацию дохода делает бухгалтер ИЛИ админ
    // (`@Roles('ADMIN', 'ACCOUNTANT')` на `PATCH :id/validate`), а в `data`
    // этого типа актора нет вовсе.
    subject:
      d.status === 'VALIDATED'
        ? renderMessage(i18n, M.statusValidatedSubject)
        : renderMessage(i18n, M.statusRejectedSubject),
    lines:
      d.status === 'VALIDATED'
        ? [renderMessage(i18n, M.sharedAmountAndDetailsLine)]
        : [renderMessage(i18n, M.statusRejectedLine)],
  }),

  TEAM_MEMBER_ADDED: (d, i18n) => ({
    // Тело НЕ пересказывает тему (COPY-M-1): человек, открывший письмо и не
    // узнавший ничего нового, так и учится не открывать следующие.
    subject: renderMessage(i18n, M.teamMemberAddedSubject, { teamName: d.teamName }),
    lines: [renderMessage(i18n, M.teamMemberAddedLine)],
  }),

  PROJECT_MEMBER_ADDED: (d, i18n) => ({
    subject: renderMessage(i18n, M.projectMemberAddedSubject, { projectName: d.projectName }),
    lines: [renderMessage(i18n, M.projectMemberAddedLine)],
  }),

  TEAM_NEW_MEMBER: (d, i18n) => ({
    // Имя новичка остаётся в CRM: письмо не называет людей (§10 — объём
    // того, что уходит на личную почту, держим минимальным).
    subject: renderMessage(i18n, M.teamNewMemberSubject, { teamName: d.teamName }),
    lines: [renderMessage(i18n, M.teamNewMemberLine)],
  }),

  PROJECT_CONFIRM_REQUIRED: (d, i18n) => ({
    subject: renderMessage(i18n, M.projectConfirmSubject, { projectName: d.projectName }),
    lines: [
      renderMessage(i18n, M.projectConfirmLine1, { projectName: d.projectName }),
      renderMessage(i18n, M.projectConfirmLine2),
    ],
  }),

  SHARE_CONFIRM_REQUIRED: (d, i18n) => {
    // Вид доли решает, а не только имя проекта: форма данных допускает пару
    // «BASE + уцелевшее имя», и читай мы одно имя, базовое предложение
    // представилось бы проектным. Достаточно ЛЮБОЙ из двух причин обойтись без
    // имени (`scope === 'BASE'` ИЛИ `projectName === null`): тема «по проекту «»» —
    // мусор.
    const projectName = d.scope === 'BASE' ? null : d.projectName
    return {
      subject:
        projectName === null
          ? renderMessage(i18n, M.shareConfirmSubjectBase)
          : renderMessage(i18n, M.shareConfirmSubjectProject, { projectName }),
      lines: [
        projectName === null
          ? renderMessage(i18n, M.shareConfirmLine1Base)
          : renderMessage(i18n, M.shareConfirmLine1Project, { projectName }),
        // §11: «Без этого человек, увидев тему, решает, что у него уже что-то
        // изменили».
        renderMessage(i18n, M.shareConfirmLine2),
      ],
    }
  },

  DOCUMENT_SIGN_REQUIRED: (_d, i18n) => ({
    // §11 предлагал «{тип документа} за {период}», но период в данных
    // отсутствует: производитель кладёт `documentKind: 'EMPLOYEE_CONTRACT'`
    // (`employee-contracts.service.ts`) — у договора с сотрудником периода
    // нет. Двоеточие с одним словом после него читается как недозаполненный
    // шаблон (COPY-L-4), поэтому слот убран, а префикс «Запит на …» —
    // остался: он и сообщает, что ждут ответа.
    subject: renderMessage(i18n, M.documentSignSubject),
    lines: [renderMessage(i18n, M.documentSignLine)],
  }),

  APPROVAL_CONFIRMED: (d, i18n) => ({
    subject: renderMessage(i18n, M.approvalConfirmedSubject),
    lines: [acceptedLine(d.subjectKind, d.subjectTitle, i18n)],
  }),

  APPROVAL_REJECTED: (d, i18n) => ({
    subject: renderMessage(i18n, M.approvalRejectedSubject),
    // Причина отказа — в CRM: это слова конкретного человека о деньгах,
    // и уходить на личную почту им незачем (§10).
    lines: [
      rejectedLine(d.subjectKind, d.subjectTitle, i18n),
      renderMessage(i18n, M.approvalReasonLine),
    ],
  }),

  // Инвойсы и вакансии: письма не уходят на личную почту
  // (`notification-email-outbox.ts`, `LEGACY_TYPE`), но `BODIES` обязан нести запись
  // для каждого `NewNotificationType`, и прямой вызов рендерера обязан работать.
  // §10/§11: ни PII, ни цифр — название вакансии это имя объекта, а не человек.
  INVOICE_SIGNED: (_d, i18n) => ({
    subject: renderMessage(i18n, M.invoiceSignedSubject),
    lines: [renderMessage(i18n, M.sharedDetailsLine)],
  }),

  INVOICE_SIGN_REQUIRED: (_d, i18n) => ({
    subject: renderMessage(i18n, M.invoiceSignRequiredSubject),
    lines: [renderMessage(i18n, M.sharedAmountAndDetailsLine)],
  }),

  VACANCY_APPLICATION: (d, i18n) => ({
    subject: renderMessage(i18n, M.vacancyApplicationSubject, { vacancyTitle: d.vacancyTitle }),
    lines: [renderMessage(i18n, M.sharedDetailsLine)],
  }),
}

type ApprovalSubjectKind = 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE'

/** Пара целых предложений: с названием объекта и без него (снимок его не сохранил). */
interface ApprovalPair {
  titled: typeof M.acceptedProject
  untitled: typeof M.acceptedProjectUntitled
}

/**
 * Два письма админу — ДВЕ карты предложений и два входа (`acceptedLine` /
 * `rejectedLine`), а не одна функция с параметром решения.
 *
 * Так сделано ради наблюдаемости, и это не догадка: параметр из двух значений
 * порождает мутанта, которого нельзя убить по построению. Ветвление
 * `decision === 'ACCEPTED' ? … : …` даёт одну и ту же строку для ЛЮБОГО
 * не-`'ACCEPTED'` значения, поэтому литерал `'REJECTED'` на месте вызова можно
 * заменить пустой строкой, и ни один тест этого не заметит — гейт мутаций так и
 * доложил. Входы остаются двумя, различие несёт сама карта.
 *
 * Каждое предложение — ЦЕЛОЕ сообщение каталога: прежняя склейка фрагментов
 * («в проекте» + «X» …) заменена выбором готовой фразы, потому что фрагмент
 * нельзя перевести отдельно от предложения, в которое он вставлен.
 *
 * Сотрудник не назван по имени (то же правило, что и везде), назван ОБЪЕКТ
 * решения — по нему админ и понимает, о каком из своих предложений речь.
 * Глагол получил свой объект (COPY-M-3): принимают ПРЕДЛОЖЕНИЕ, а «принял
 * проект» в этой предметной области значит «утвердил проект целиком», что
 * делает админ, а не тот, кого в проект позвали.
 */
const ACCEPTED: Record<ApprovalSubjectKind, ApprovalPair> = {
  PROJECT: { titled: M.acceptedProject, untitled: M.acceptedProjectUntitled },
  PROJECT_SHARE: { titled: M.acceptedProjectShare, untitled: M.acceptedProjectShareUntitled },
  // У базовой доли названия нет по построению: обе ветки — одна и та же фраза.
  BASE_SHARE: { titled: M.acceptedBaseShare, untitled: M.acceptedBaseShare },
}

const REJECTED: Record<ApprovalSubjectKind, ApprovalPair> = {
  PROJECT: { titled: M.rejectedProject, untitled: M.rejectedProjectUntitled },
  PROJECT_SHARE: { titled: M.rejectedProjectShare, untitled: M.rejectedProjectShareUntitled },
  BASE_SHARE: { titled: M.rejectedBaseShare, untitled: M.rejectedBaseShare },
}

function approvalLine(
  pairs: Record<ApprovalSubjectKind, ApprovalPair>,
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  const pair = pairs[subjectKind]
  return subjectTitle === null
    ? renderMessage(i18n, pair.untitled)
    : renderMessage(i18n, pair.titled, { subjectTitle })
}

function acceptedLine(
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  return approvalLine(ACCEPTED, subjectKind, subjectTitle, i18n)
}

function rejectedLine(
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  return approvalLine(REJECTED, subjectKind, subjectTitle, i18n)
}

/**
 * Подпись кнопки письма. Информирующие типы берут ту же подпись, что и попап
 * (`ACTION_LABELS` — один словарь на оба канала, раньше письмо держало
 * замороженную копию); решения админу различают вид объекта: USER — решение по
 * базовой доле сотрудника (профиль), иначе — проект; всё остальное — общее
 * «Відкрити» / «Open».
 */
function emailActionLabelFor(
  type: string,
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
  if (
    type === 'TRANSACTION_ADDED' ||
    type === 'TRANSACTION_STATUS_CHANGED' ||
    type === 'TEAM_MEMBER_ADDED' ||
    type === 'PROJECT_MEMBER_ADDED' ||
    type === 'TEAM_NEW_MEMBER'
  ) {
    return renderMessage(i18n, ACTION_LABELS[type])
  }
  // Незарегистрированный (легаси) тип с адресом объекта — общее «Открыть».
  return renderMessage(i18n, MISC_MESSAGES.open)
}

/**
 * Кнопка письма — маршрут через `notificationHref` (чистая функция, локали не
 * знает), подпись — через `emailActionLabelFor`. Структура ровно прежняя: НЕ
 * `notificationActions()` реестра — тот для легаси-типов предпочитает `link`
 * паре `subjectType/subjectId` и поменял бы адреса (закреплено структурными
 * пинами `buttonHref` в спеке).
 */
function emailAction(
  source: NotificationEmailSource,
  i18n: I18n,
): { href: string; label: string } | null {
  if (source.subjectType !== null && source.subjectId !== null) {
    return {
      href: notificationHref(source.subjectType, source.subjectId),
      label: emailActionLabelFor(source.type, source.subjectType, i18n),
    }
  }
  // Stryker disable next-line ConditionalExpression: `source.link` at this point is only ever `null` or a string — forcing this branch always-true when `source.link` is null returns `{ href: null, label: <open> }`, and the caller's own `action?.href ?? '/'` / `action?.href == null ? <open CRM> : ...` fallbacks make that byte-identical to returning `null` here (see "без ссылки кнопка называется «Open the CRM»" in the spec) — no observable difference either way.
  if (source.link !== null) {
    return { href: source.link, label: renderMessage(i18n, MISC_MESSAGES.open) }
  }
  return null
}

/**
 * Собрать письмо из строки уведомления на языке получателя.
 *
 * Никогда не возвращает `null`: тип, которого шаблон не знает, и данные не
 * той формы дают письмо по сохранённым заголовку и ссылке. Отправка — это
 * канал, а не пересказ события; молча не отправить хуже, чем отправить
 * короче.
 */
export function renderNotificationEmail(
  source: NotificationEmailSource,
  opts: RenderOptions,
): RenderedNotificationEmail {
  const root = opts.frontendUrl.replace(/\/$/, '')
  // Свой инстанс на каждое письмо — никакого общего состояния между получателями.
  const i18n = createI18n(opts.locale)

  // Три типа, требующих ответа, ведут на `/pending` — экран, где ответ вообще
  // можно дать (задание, п.4 и «Уточнения оркестратора»; SPEC-H-3 / CR-H-4).
  // Круг 1 звал `notificationActions()` без различения и получал путь к
  // ОБЪЕКТУ: для `PROJECT_CONFIRM_REQUIRED` это `/projects/:id`, где кнопок
  // подтверждения нет вовсе, а для `DOCUMENT_SIGN_REQUIRED` — `/onboarding`.
  //
  // Подпись — «Відповісти на запит» (COPY-L-5): «Відкрити проєкт» на кнопке,
  // ведущей на список запросов, называла бы не то, что откроется.
  const action = isActionRequiredNotificationType(source.type)
    ? { href: PENDING_PATH, label: renderMessage(i18n, M.sharedRespondButton) }
    : emailAction(source, i18n)
  // Кнопка одна, и вести ей есть куда всегда: объекту 15 секунд от роду, а
  // состояния «объекта больше нет» письмо по построению не застаёт. Корень
  // CRM — запасной путь для старого типа без сохранённой ссылки.
  const buttonHref = `${root}${action?.href ?? '/'}`
  const buttonLabel =
    action?.href == null ? renderMessage(i18n, M.sharedOpenCrmButton) : action.label

  const body = composeBody(source, i18n)

  return {
    // `stripCrlf`: тема уезжает в ЗАГОЛОВОК письма, а имя объекта приходит из
    // пользовательского ввода, где `z.string().max(255)` перевод строки
    // разрешает (SR-M-1, та же защита и та же причина, что в
    // `contact.service.ts`). Тело этого не требует — там перевод строки
    // законен.
    subject: stripCrlf(body.subject),
    // Подпись кнопки перед адресом (COPY-L-1): в html читатель видит
    // подпись, в text — голый адрес, и одна подпись делает текстовую версию
    // равной по внятности.
    text: [...body.lines, '', `${buttonLabel}: ${buttonHref}`].join('\n'),
    html: renderEmailLayout({
      blocks: body.lines.map((line, i) => ({
        html: escapeHtml(line),
        // У последней строки отступ больше — она отделяет текст от кнопки.
        spaceAfter: i === body.lines.length - 1 ? 24 : 16,
      })),
      button: { href: buttonHref, label: buttonLabel },
      lang: opts.locale,
    }),
    buttonHref,
    buttonLabel,
  }
}

function composeBody(source: NotificationEmailSource, i18n: I18n): Body {
  if (isNewNotificationType(source.type)) {
    const parsed = notificationDataSchemaFor(source.type).safeParse(source.data)
    if (parsed.success) {
      const build = BODIES[source.type] as (d: unknown, i18n: I18n) => Body
      return build(parsed.data, i18n)
    }
    // Форма данных изменилась, а строка осталась старой. Заголовок типа —
    // нейтральный по построению (`NOTIFICATION_TITLE_MESSAGES`), поэтому он
    // безопасен и как тема, и как единственная строка.
    return {
      subject: renderMessage(i18n, NOTIFICATION_TITLE_MESSAGES[source.type]),
      lines: [renderMessage(i18n, M.sharedDetailsLine)],
    }
  }
  // Тип, которого шаблон ещё не знает: сохранённые `title`/`body` — ДАННЫЕ,
  // печатаются как есть в любой локали; общая заглушка — из каталога.
  return {
    subject: source.title,
    lines: [source.body ?? renderMessage(i18n, M.sharedDetailsLine)],
  }
}
