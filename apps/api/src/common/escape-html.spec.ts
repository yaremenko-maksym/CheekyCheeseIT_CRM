import { describe, expect, it } from 'vitest'
import { emphasize, escapeHtml } from './escape-html'

/**
 * Вынесённый общий хелпер. До позиции 7a он существовал ДВАЖДЫ — в
 * `contact.service.ts` и в `personal-email-invite-mailer.service.ts`, — и
 * третий потребитель (письма уведомлений) сделал бы копию третьей. Копии
 * расходятся молча: достаточно, чтобы одна из них однажды забыла про
 * апостроф.
 *
 * Тесты пиннингуют ровно то поведение, которое было у обеих копий, — они
 * совпадали посимвольно, поэтому вынос ничего не меняет ни для одного из
 * двух прежних вызывающих.
 */
describe('escapeHtml', () => {
  it('экранирует все пять значащих символов', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('амперсанд экранируется ПЕРВЫМ — иначе получится двойное экранирование', () => {
    // Порядок в реализации значим: замени `&` после `<`, и `&lt;` превратится
    // в `&amp;lt;`. Именно этот мутант должен умирать здесь.
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('обезвреживает тег целиком', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
  })

  it('заменяет ВСЕ вхождения, а не первое', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c')
  })

  it('обычный текст не трогает', () => {
    expect(escapeHtml('Мобильный банк')).toBe('Мобильный банк')
  })

  it('пустая строка остаётся пустой', () => {
    expect(escapeHtml('')).toBe('')
  })
})

/**
 * `emphasize` — единственное место, где письмо несёт разметку внутри
 * предложения (оговорка приглашения: `<strong>` на предупреждении, COPY-M-5).
 * Предложение рендерится целиком (порядок слов разный в uk и en), и только
 * потом известная фраза каталога заворачивается в тег — предложение не
 * собирается из фрагментов.
 */
describe('emphasize', () => {
  it('оборачивает фразу в <strong>, окружающий текст остаётся на месте', () => {
    expect(
      emphasize(
        'If this email reached you by mistake, do not follow the link.',
        'do not follow the link',
      ),
    ).toBe('If this email reached you by mistake, <strong>do not follow the link</strong>.')
  })

  it('фраза в начале и в конце предложения', () => {
    expect(emphasize('abc def', 'abc')).toBe('<strong>abc</strong> def')
    expect(emphasize('abc def', 'def')).toBe('abc <strong>def</strong>')
  })

  it('экранирует и текст вокруг, и саму фразу', () => {
    expect(emphasize('a < b, <i>x</i> & do "this"', 'do "this"')).toBe(
      'a &lt; b, &lt;i&gt;x&lt;/i&gt; &amp; <strong>do &quot;this&quot;</strong>',
    )
    expect(emphasize('go <b>now</b> please', '<b>now</b>')).toBe(
      'go <strong>&lt;b&gt;now&lt;/b&gt;</strong> please',
    )
  })

  it('фразы нет в предложении: экранированное предложение без тега, без исключения', () => {
    expect(emphasize('a < b', 'zzz')).toBe('a &lt; b')
  })

  it('пустая фраза не оборачивает ничего', () => {
    expect(emphasize('a < b', '')).toBe('a &lt; b')
  })

  it('оборачивается только ПЕРВОЕ вхождение', () => {
    expect(emphasize('x y x', 'x')).toBe('<strong>x</strong> y x')
  })

  it('украинская оговорка приглашения: фраза внутри предложения', () => {
    expect(
      emphasize(
        'Якщо лист прийшов помилково, не переходьте за посиланням.',
        'не переходьте за посиланням',
      ),
    ).toBe('Якщо лист прийшов помилково, <strong>не переходьте за посиланням</strong>.')
  })
})
