/**
 * Тексты десяти писем — позиция 7a, спека §11 («Тексты писем») и §10
 * («уведомления о деньгах — это раскрытие»).
 *
 * ВЕСЬ текст писем живёт в одном файле по той же причине, по которой весь
 * текст уведомлений живёт в `notification-registry.ts`: `copy-reviewer`
 * читает десять писем в одном месте, а не собирает их по пяти модулям. И по
 * той же причине текст НЕ хранится в базе (§7.1): правка формулировки не
 * должна быть правкой данных.
 *
 * Правило, которому подчиняются все десять и которое механически проверяет
 * `notification-email-copy.spec.ts`:
 *
 *   **письмо называет ОБЪЕКТ (проект, команда, контракт) и не называет ни
 *   людей, ни цифр.**
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
 *   - **единый префикс «Запрос на …»** у всего, что требует ответа, — он
 *     сообщает, что это предложение, а не свершившийся факт, ещё до открытия;
 *   - **в письме о смене доли вторая строка снимает испуг** — действует
 *     прежний процент, новый вступит в силу только после согласия.
 *
 * Вёрстка — таблицами и встроенными стилями (§12: «почтовые клиенты — не
 * браузеры»), тот же каркас, что у приглашения
 * (`personal-email-invite-mailer.service.ts`), чтобы письма от нас выглядели
 * одним отправителем, на котором почта учится (§12).
 */
import {
  isNewNotificationType,
  notificationActions,
  notificationDataSchemaFor,
  NOTIFICATION_TITLES,
  type NewNotificationType,
  type NotificationDataByType,
  type NotificationSubjectType,
} from '@crm/shared'
import { escapeHtml } from '../common/escape-html'

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
  [K in NewNotificationType]: (d: NotificationDataByType[K]) => Body
} = {
  TRANSACTION_ADDED: (d) => ({
    subject:
      d.projectName === null
        ? 'Вам добавили транзакцию'
        : `Вам добавили транзакцию по проекту «${d.projectName}»`,
    lines: ['В ваших финансах новая транзакция. Сумма и детали — в CRM.'],
  }),

  TRANSACTION_STATUS_CHANGED: (d) => ({
    // Статус — не сумма и не процент, и он единственное, ради чего письмо
    // читают. Прятать его значило бы слать письмо «случилось что-то».
    subject: d.status === 'VALIDATED' ? 'Доход валидирован' : 'Доход отклонён',
    lines:
      d.status === 'VALIDATED'
        ? ['Бухгалтер подтвердил заявленный доход.']
        : ['Бухгалтер отклонил заявленный доход. Причина — в CRM.'],
  }),

  TEAM_MEMBER_ADDED: (d) => ({
    subject: `Вас добавили в команду «${d.teamName}»`,
    lines: [`Теперь вы участник команды «${d.teamName}».`],
  }),

  PROJECT_MEMBER_ADDED: (d) => ({
    subject: `Вас добавили в проект «${d.projectName}»`,
    lines: [`Теперь вы участник проекта «${d.projectName}».`],
  }),

  TEAM_NEW_MEMBER: (d) => ({
    // Имя новичка остаётся в CRM: письмо не называет людей (§10 — объём
    // того, что уходит на личную почту, держим минимальным).
    subject: `В команде «${d.teamName}» новый участник`,
    lines: [`К команде «${d.teamName}» присоединился новый участник. Кто — в CRM.`],
  }),

  PROJECT_CONFIRM_REQUIRED: (d) => ({
    subject: `Запрос на добавление проекта «${d.projectName}»`,
    lines: [
      `Вас предлагают в проект «${d.projectName}».`,
      'Проект не начнётся, пока участники не ответят.',
    ],
  }),

  SHARE_CONFIRM_REQUIRED: (d) => ({
    subject:
      d.scope === 'BASE' || d.projectName === null
        ? 'Запрос на смену базового процента'
        : `Запрос на смену процента по проекту «${d.projectName}»`,
    lines: [
      d.scope === 'BASE' || d.projectName === null
        ? 'Вам предлагают изменить базовый процент.'
        : `Вам предлагают изменить процент по проекту «${d.projectName}».`,
      // §11: «Без этого человек, увидев тему, решает, что у него уже что-то
      // изменили».
      'Сейчас действует прежний процент. Новый вступит в силу только после вашего согласия.',
    ],
  }),

  DOCUMENT_SIGN_REQUIRED: () => ({
    // §11 предлагал «{тип документа} за {период}», но период в данных
    // отсутствует: производитель кладёт `documentTitle: 'Ваш контракт'`
    // (`employee-contracts.service.ts`) — у договора с сотрудником периода
    // нет. Тема называет то, что система знает.
    subject: 'Запрос на подпись: контракт',
    lines: ['Ваш контракт готов и ждёт подписи.'],
  }),

  APPROVAL_CONFIRMED: (d) => ({
    subject: 'Ваше предложение принято',
    lines: [approvalLine(d.subjectKind, d.subjectTitle, 'принял')],
  }),

  APPROVAL_REJECTED: (d) => ({
    subject: 'Ваше предложение отклонено',
    // Причина отказа — в CRM: это слова конкретного человека о деньгах,
    // и уходить на личную почту им незачем (§10).
    lines: [approvalLine(d.subjectKind, d.subjectTitle, 'отклонил'), 'Причина — в CRM.'],
  }),
}

/**
 * Общая строка двух писем админу. Сотрудник не назван по имени (то же
 * правило, что и везде), назван ОБЪЕКТ решения — по нему админ и понимает, о
 * каком из своих предложений речь.
 */
function approvalLine(
  subjectKind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  subjectTitle: string | null,
  verb: 'принял' | 'отклонил',
): string {
  const what =
    subjectKind === 'PROJECT'
      ? subjectTitle === null
        ? 'проект'
        : `проект «${subjectTitle}»`
      : subjectKind === 'PROJECT_SHARE'
        ? subjectTitle === null
          ? 'смену процента по проекту'
          : `смену процента по проекту «${subjectTitle}»`
        : 'смену базового процента'
  return `Сотрудник ${verb} ${what}.`
}

/**
 * Собрать письмо из строки уведомления.
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
  const action = notificationActions({
    type: source.type,
    title: source.title,
    body: source.body,
    link: source.link,
    subjectType: source.subjectType,
    subjectId: source.subjectId,
    data: source.data,
  })[0]
  // Кнопка одна, и вести ей есть куда всегда: объекту 15 секунд от роду, а
  // состояния «объекта больше нет» письмо по построению не застаёт. Корень
  // CRM — запасной путь для старого типа без сохранённой ссылки.
  const buttonHref = `${root}${action?.href ?? '/'}`
  const buttonLabel = action?.href == null ? 'Открыть CRM' : action.label

  const body = composeBody(source)

  return {
    subject: body.subject,
    text: [...body.lines, '', buttonHref].join('\n'),
    html: layout(body.lines, buttonHref, buttonLabel),
    buttonHref,
    buttonLabel,
  }
}

function composeBody(source: NotificationEmailSource): Body {
  if (isNewNotificationType(source.type)) {
    const parsed = notificationDataSchemaFor(source.type).safeParse(source.data)
    if (parsed.success) {
      const build = BODIES[source.type] as (d: unknown) => Body
      return build(parsed.data)
    }
    // Форма данных изменилась, а строка осталась старой. Заголовок типа —
    // нейтральный по построению (`NOTIFICATION_TITLES`), поэтому он безопасен
    // и как тема, и как единственная строка.
    return {
      subject: NOTIFICATION_TITLES[source.type],
      lines: ['Подробности — в CRM.'],
    }
  }
  // Три старых типа (инвойсы, вакансии) и всё, чего шаблон ещё не знает.
  return { subject: source.title, lines: [source.body ?? 'Подробности — в CRM.'] }
}

/**
 * Каркас письма — таблицы и встроенные стили (§12). Повторяет приглашение
 * (`personal-email-invite-mailer.service.ts`) намеренно: один постоянный
 * отправитель с узнаваемым письмом — то немногое, на что мы можем повлиять в
 * доставляемости.
 *
 * `max-width:480px` + `viewport` — письмо читают с телефона, и 320 пикселей
 * та ширина, на которой лишняя фиксированная ширина даёт горизонтальную
 * прокрутку.
 */
function layout(lines: string[], href: string, label: string): string {
  const paragraphs = lines
    .map(
      (line, i) =>
        `              <p style="margin:0 0 ${
          i === lines.length - 1 ? 24 : 16
        }px 0;font-size:16px;line-height:24px;color:#18181b;">\n                ${escapeHtml(
          line,
        )}\n              </p>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px 32px;">
${paragraphs}
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">${escapeHtml(label)}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
