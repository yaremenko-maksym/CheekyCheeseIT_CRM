/**
 * Каркас исходящего письма — один на все письма, которые шлёт CRM.
 *
 * Спека §12 («Почтовые клиенты — не браузеры»): таблицы вместо блоков,
 * встроенные стили вместо классов, `viewport`-мета и `max-width:480px`, потому
 * что письмо читают с телефона, а фиксированная ширина даёт там горизонтальную
 * прокрутку. Всё это невозможно проверить, не отправив письмо, — поэтому
 * разметка живёт в ОДНОМ месте и закреплена дословными эталонами у обоих
 * вызывающих.
 *
 * **Почему общий модуль, а не копия.** Приглашение на личный адрес
 * (`personal-email-invite-mailer.service.ts`) и десять писем уведомлений
 * (`notification-email-copy.ts`) собирали одну и ту же таблицу двумя копиями
 * (SPEC-M-2, spec-review PR #673 круг 1: задание требовало «каркас письма
 * вынести в общий хелпер и переиспользовать, не копировать»). Цена копии не
 * в строках, а в том, что «письма от нас выглядят одним отправителем» —
 * свойство, на котором §12 строит доставляемость, — держалось бы на том, что
 * два файла правят синхронно.
 *
 * **Экранирование — на вызывающем, и это намеренно.** Хелпер принимает уже
 * готовый HTML абзаца: приглашению нужен `<strong>` внутри последней строки, а
 * письмам уведомлений — `escapeHtml` на каждой подстановке. Хелпер, который
 * экранировал бы сам, сделал бы первое невозможным; хелпер, который принимает
 * готовый HTML, оставляет решение там, где известно, что именно подставляют.
 * Оба вызывающих закрыты тестом на подстановку с `<script>`.
 *
 * **Слот принимает `EscapedHtml`, а не сырой `string` (SR-L-8, security-review
 * PR #673 круг 2).** До этой правки `html: string` принимал что угодно, и
 * третий вызывающий, забывший `escapeHtml` на пользовательских данных, узнал
 * бы об этом только от почтового клиента получателя. `EscapedHtml` — бренд:
 * его даёт либо `escapeHtml(value)` (данные), либо `trustedHtml(value)`
 * (литеральная разметка, которую пишет разработчик — кнопка, `<strong>` в
 * оговорке). Голая строка на месте `html`/`footer` теперь не компилируется.
 */
import { escapeHtml, type EscapedHtml } from './escape-html'

/** Абзац письма и отступ ПОД ним, в пикселях. */
export interface EmailBlock {
  /** Уже безопасный HTML строки: `escapeHtml` для данных, `trustedHtml` для литеральной разметки (см. заголовок файла). */
  html: EscapedHtml
  spaceAfter: number
}

export interface EmailLayoutInput {
  /** Абзацы ДО кнопки, сверху вниз. */
  blocks: readonly EmailBlock[]
  /** Единственная кнопка письма — §11: «Одна кнопка на письмо». */
  button: { href: string; label: string }
  /**
   * Абзац ПОСЛЕ кнопки, с отступом сверху. Нужен приглашению (защитная
   * оговорка «если письмо пришло по ошибке…»), у писем уведомлений его нет.
   */
  footer?: EscapedHtml
}

function paragraph(html: string, margin: string): string {
  return `              <p style="margin:${margin};font-size:16px;line-height:24px;color:#18181b;">
                ${html}
              </p>`
}

/**
 * Собрать письмо целиком.
 *
 * `href` и подпись кнопки экранируются ЗДЕСЬ — в отличие от абзацев, разметки в
 * них не бывает по определению, а адрес приходит из данных (ссылка на объект) и
 * попадает в атрибут, где кавычка ломает разметку.
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const paragraphs = input.blocks
    .map((b) => paragraph(b.html, `0 0 ${b.spaceAfter}px 0`))
    .join('\n')
  const footer = input.footer === undefined ? '' : `\n${paragraph(input.footer, '24px 0 0 0')}`

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
                    <a href="${escapeHtml(input.button.href)}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">${escapeHtml(input.button.label)}</a>
                  </td>
                </tr>
              </table>${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
