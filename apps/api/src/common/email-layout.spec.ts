import { describe, expect, it } from 'vitest'
import { renderEmailLayout } from './email-layout'

/**
 * Каркас письма — теперь один на двух вызывающих (приглашение и десять писем
 * уведомлений, SPEC-M-2). Именно поэтому у него свой страж: правка ради одного
 * письма иначе молча меняла бы второе, а увидеть это можно только в чужом
 * почтовом клиенте, когда письмо уже ушло.
 *
 * Эталон дословный. Почтовые клиенты не прощают ни таблицы без
 * `role="presentation"`, ни `max-width` мимо внешней таблицы, ни отсутствия
 * `viewport` — и ни одно из этих правил не проверяется ничем, кроме этого
 * файла.
 */
describe('renderEmailLayout', () => {
  it('письмо из двух строк с кнопкой собирается ровно так', () => {
    expect(
      renderEmailLayout({
        blocks: [
          { html: 'Первая строка.', spaceAfter: 16 },
          { html: 'Вторая строка.', spaceAfter: 24 },
        ],
        button: { href: 'https://app.cheekycheese.tech/pending', label: 'Ответить на запрос' },
      }),
    ).toBe(`<!DOCTYPE html>
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
              <p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#18181b;">
                Первая строка.
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Вторая строка.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="https://app.cheekycheese.tech/pending" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Ответить на запрос</a>
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
</html>`)
  })

  it('без абзаца после кнопки за таблицей кнопки сразу идёт закрытие', () => {
    // Ровно то, чем письма уведомлений отличаются от приглашения. Пустая
    // строка на месте отсутствующего абзаца выглядела бы в клиенте как лишний
    // отступ.
    const html = renderEmailLayout({
      blocks: [{ html: 'Одна строка.', spaceAfter: 24 }],
      button: { href: 'https://app.cheekycheese.tech/', label: 'Открыть CRM' },
    })
    expect(html).toContain('              </table>\n            </td>')
    expect(html.match(/<p /g)).toHaveLength(1)
  })

  it('абзац после кнопки получает отступ СВЕРХУ, а не снизу', () => {
    const html = renderEmailLayout({
      blocks: [{ html: 'Строка.', spaceAfter: 24 }],
      button: { href: 'https://x.example/', label: 'Кнопка' },
      footer: 'Оговорка.',
    })
    expect(html).toContain('<p style="margin:24px 0 0 0;')
    expect(html).toContain('              </table>\n              <p style="margin:24px 0 0 0;')
  })

  it('готовая разметка абзаца доезжает как разметка', () => {
    // Приглашению нужен `<strong>` в защитной оговорке. Хелпер, экранирующий
    // абзацы сам, сделал бы это невозможным — поэтому экранирование на
    // вызывающем (см. заголовок модуля).
    const html = renderEmailLayout({
      blocks: [{ html: 'Текст со <strong>акцентом</strong>.', spaceAfter: 24 }],
      button: { href: 'https://x.example/', label: 'Кнопка' },
    })
    expect(html).toContain('<strong>акцентом</strong>')
  })

  it('адрес и подпись кнопки экранируются ЗДЕСЬ', () => {
    // В отличие от абзацев: разметки в них не бывает, а кавычка в адресе
    // разрывает атрибут и делает всё за ним частью разметки.
    const html = renderEmailLayout({
      blocks: [{ html: 'Строка.', spaceAfter: 24 }],
      button: { href: 'https://x.example/?a="><script>alert(1)</script>', label: 'Кнопка & Co' },
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).toContain('Кнопка &amp; Co')
  })

  it('одна кнопка и ровно одна ссылка — §11', () => {
    const html = renderEmailLayout({
      blocks: [{ html: 'Строка.', spaceAfter: 24 }],
      button: { href: 'https://x.example/', label: 'Кнопка' },
      footer: 'Оговорка со ссылкой писать нельзя.',
    })
    expect(html.match(/<a\s/g)).toHaveLength(1)
  })

  it('отступ берётся из блока, а не из его позиции', () => {
    // Иначе «последний абзац отделяет текст от кнопки» превратилось бы в
    // правило хелпера, и приглашение (16 / 4 / 24) его бы нарушало.
    const html = renderEmailLayout({
      blocks: [
        { html: 'Раз.', spaceAfter: 16 },
        { html: 'Два.', spaceAfter: 4 },
        { html: 'Три.', spaceAfter: 24 },
      ],
      button: { href: 'https://x.example/', label: 'Кнопка' },
    })
    expect(html).toContain('margin:0 0 16px 0')
    expect(html).toContain('margin:0 0 4px 0')
    expect(html).toContain('margin:0 0 24px 0')
  })
})
