import { describe, expect, it } from 'vitest'
import { NEW_NOTIFICATION_TYPES, NOTIFICATION_TITLES } from '@crm/shared'
import type { NewNotificationType } from '@crm/shared'

import { renderNotificationEmail, type NotificationEmailSource } from './notification-email-copy'

/**
 * Страж десяти писем — §11 («Тексты писем») + §10 («уведомления о деньгах —
 * это раскрытие»).
 *
 * Письмо уходит на ЛИЧНУЮ почту, вне нашего контура. Поэтому правило, которое
 * этот файл проверяет механически, а не надеждой на внимательность автора:
 *
 *   **письмо называет ОБЪЕКТ (проект, команда, контракт) и не называет ни
 *   людей, ни цифр.**
 *
 * Обе половины проверяются подстановкой: в каждый образец кладутся суммы,
 * проценты и имя человека, а от результата требуется, чтобы ни одной цифры и
 * ни одного имени в нём не осталось. Тест, который вместо этого перечислял бы
 * ожидаемые строки, проходил бы по построению — он повторял бы шаблон, а не
 * проверял его (тавтология).
 */

/** Имя третьего лица. Ни одно письмо не имеет права его напечатать. */
const PERSON = 'Иван Петров'
/** Имена объектов БЕЗ цифр — чтобы любая цифра в выводе означала утечку из шаблона. */
const PROJECT = 'Мобильный банк'
const TEAM = 'Ядро платформы'

const FRONTEND = 'https://app.cheekycheese.tech'

const DATA: Record<NewNotificationType, unknown> = {
  TRANSACTION_ADDED: { amount: '1500.000000', currency: 'USDT', projectName: PROJECT },
  TRANSACTION_STATUS_CHANGED: {
    amount: '1500.000000',
    currency: 'USDT',
    status: 'REJECTED',
    rejectionReasonPreview: 'нет чека',
  },
  TEAM_MEMBER_ADDED: { teamName: TEAM },
  PROJECT_MEMBER_ADDED: { projectName: PROJECT },
  TEAM_NEW_MEMBER: { teamName: TEAM, memberName: PERSON },
  PROJECT_CONFIRM_REQUIRED: {
    projectName: PROJECT,
    approvalId: '11111111-1111-4111-8111-111111111111',
  },
  SHARE_CONFIRM_REQUIRED: {
    scope: 'PROJECT',
    projectName: PROJECT,
    previousPercent: 26,
    proposedPercent: 30,
    approvalId: '22222222-2222-4222-8222-222222222222',
  },
  DOCUMENT_SIGN_REQUIRED: { documentTitle: 'Ваш контракт' },
  APPROVAL_CONFIRMED: {
    approverName: PERSON,
    subjectKind: 'PROJECT',
    subjectTitle: PROJECT,
  },
  APPROVAL_REJECTED: {
    approverName: PERSON,
    subjectKind: 'PROJECT_SHARE',
    subjectTitle: PROJECT,
    reasonPreview: 'мало',
  },
}

const SUBJECT_TYPE: Record<NewNotificationType, NotificationEmailSource['subjectType']> = {
  TRANSACTION_ADDED: 'TRANSACTION',
  TRANSACTION_STATUS_CHANGED: 'TRANSACTION',
  TEAM_MEMBER_ADDED: 'TEAM',
  PROJECT_MEMBER_ADDED: 'PROJECT',
  TEAM_NEW_MEMBER: 'TEAM',
  PROJECT_CONFIRM_REQUIRED: 'PROJECT',
  SHARE_CONFIRM_REQUIRED: 'PROJECT',
  DOCUMENT_SIGN_REQUIRED: 'EMPLOYEE_CONTRACT',
  APPROVAL_CONFIRMED: 'PROJECT',
  APPROVAL_REJECTED: 'PROJECT',
}

const SUBJECT_ID = '33333333-3333-4333-8333-333333333333'

function sourceFor(type: NewNotificationType): NotificationEmailSource {
  return {
    type,
    title: NOTIFICATION_TITLES[type],
    body: null,
    link: null,
    subjectType: SUBJECT_TYPE[type],
    subjectId: SUBJECT_ID,
    data: DATA[type],
  }
}

function render(type: NewNotificationType) {
  return renderNotificationEmail(sourceFor(type), { frontendUrl: FRONTEND })
}

describe('десять писем — страж §11', () => {
  it.each(NEW_NOTIFICATION_TYPES)('%s: есть тема, текст и разметка', (type) => {
    const mail = render(type)
    expect(mail.subject.length).toBeGreaterThan(0)
    expect(mail.text.length).toBeGreaterThan(0)
    expect(mail.html).toContain('<!DOCTYPE html>')
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ни одной цифры — ни суммы, ни процента', (type) => {
    const mail = render(type)
    // Данные образца НЕСУТ и сумму, и проценты (см. DATA выше). Любая цифра в
    // выводе означает, что шаблон их подставил, — то, что §11 запрещает
    // прямым текстом: «письмо не содержит сумм и процентов».
    expect(mail.subject).not.toMatch(/[0-9]/)
    // Из текстовой версии убирается сам адрес: в нём цифры законны
    // (идентификатор объекта), и запрет к ним не относится. Проверяется
    // ПРОЗА — та, куда подставились бы сумма и процент.
    expect(mail.text.replace(mail.buttonHref, '')).not.toMatch(/[0-9]/)
    // В разметке цифры законны (цвета, пиксели, ссылка) — проверяется только
    // ВИДИМЫЙ текст: разметка вычищается, остаётся то, что прочтёт человек.
    expect(visibleText(mail.html)).not.toMatch(/[0-9]/)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: не называет людей', (type) => {
    const mail = render(type)
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain(PERSON)
    // Имя целиком не единственная форма утечки — фамилия отдельно тоже имя.
    expect(`${mail.subject} ${mail.text}`).not.toContain('Петров')
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ровно одна кнопка', (type) => {
    const mail = render(type)
    // §11: «Одна кнопка на письмо. „Открыть“ и „Отклонить“ рядом означало бы,
    // что отказ можно дать не заходя, — а нам нужен след в системе с причиной».
    const anchors = mail.html.match(/<a\s/g) ?? []
    expect(anchors).toHaveLength(1)
    expect(mail.html).toContain(mail.buttonHref)
    expect(mail.buttonLabel.length).toBeGreaterThan(0)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ссылка абсолютная и ведёт в наш CRM', (type) => {
    const mail = render(type)
    expect(mail.buttonHref.startsWith(`${FRONTEND}/`)).toBe(true)
    // Текстовая версия несёт тот же адрес — иначе читатель без HTML остаётся
    // с письмом, из которого некуда пойти.
    expect(mail.text).toContain(mail.buttonHref)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ни благодарностей, ни вежливой рамки', (type) => {
    const mail = render(type)
    // §11: «Транзакционное письмо, которое благодарит, читается как рассылка
    // и попадает в „Промоакции“ вместе с ней».
    const forbidden = [
      'Спасибо',
      'спасибо',
      'С уважением',
      'Всего доброго',
      'Здравствуйте',
      'Добрый день',
      'Хорошего дня',
    ]
    for (const word of forbidden) {
      expect(`${mail.subject} ${mail.text}`, `нашлось «${word}»`).not.toContain(word)
    }
  })
})

describe('темы — единый префикс «Запрос на …» у того, что требует ответа', () => {
  it('проект называет себя по имени', () => {
    expect(render('PROJECT_CONFIRM_REQUIRED').subject).toBe(
      `Запрос на добавление проекта «${PROJECT}»`,
    )
  })

  it('смена процента по проекту называет проект и не называет процент', () => {
    expect(render('SHARE_CONFIRM_REQUIRED').subject).toBe(
      `Запрос на смену процента по проекту «${PROJECT}»`,
    )
  })

  it('смена базового процента обходится без проекта — его там нет', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('SHARE_CONFIRM_REQUIRED'),
        subjectType: 'USER',
        data: {
          scope: 'BASE',
          projectName: null,
          previousPercent: 26,
          proposedPercent: 30,
          approvalId: '22222222-2222-4222-8222-222222222222',
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Запрос на смену базового процента')
    expect(mail.subject).not.toContain('«»')
  })

  it('подпись — тоже запрос', () => {
    expect(render('DOCUMENT_SIGN_REQUIRED').subject.startsWith('Запрос на подпись')).toBe(true)
  })

  it('информирующее письмо запросом НЕ притворяется', () => {
    // Префикс сообщает, что от читателя ждут ответа. Поставить его там, где
    // ответа не ждут, — обесценить его везде.
    for (const type of ['TRANSACTION_ADDED', 'TEAM_MEMBER_ADDED', 'APPROVAL_CONFIRMED'] as const) {
      expect(render(type).subject.startsWith('Запрос на')).toBe(false)
    }
  })
})

describe('письмо о смене доли снимает испуг второй строкой', () => {
  it('говорит, что действует прежняя доля', () => {
    // §11: «Без этого человек, увидев тему, решает, что у него уже что-то
    // изменили».
    const mail = render('SHARE_CONFIRM_REQUIRED')
    expect(mail.text).toContain('прежний процент')
    expect(mail.text).toContain('только после вашего согласия')
  })
})

describe('деградация', () => {
  it('данные не той формы не мешают письму уйти', () => {
    // Разбор `data` может не удаться (форма типа изменилась, строка старая).
    // Письмо всё равно обязано уйти: оно зовёт в CRM, а не пересказывает
    // событие. Молча не отправить — потерять единственный канал, который
    // доходит до закрытой вкладки.
    const mail = renderNotificationEmail(
      { ...sourceFor('PROJECT_CONFIRM_REQUIRED'), data: { totally: 'wrong' } },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe(NOTIFICATION_TITLES.PROJECT_CONFIRM_REQUIRED)
    expect(mail.text).toContain(FRONTEND)
  })

  it('тип, которого шаблон не знает, ведёт по сохранённой ссылке', () => {
    const mail = renderNotificationEmail(
      {
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'Инвойс ждёт подписи',
        body: null,
        link: '/finance/invoices/abc',
        subjectType: null,
        subjectId: null,
        data: null,
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Инвойс ждёт подписи')
    expect(mail.buttonHref).toBe(`${FRONTEND}/finance/invoices/abc`)
  })

  it('без ссылки ведёт в корень CRM, а не в никуда', () => {
    const mail = renderNotificationEmail(
      {
        type: 'VACANCY_APPLICATION',
        title: 'Отклик на вакансию',
        body: null,
        link: null,
        subjectType: null,
        subjectId: null,
        data: null,
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.buttonHref).toBe(`${FRONTEND}/`)
  })

  it('хвостовой слэш адреса не удваивается', () => {
    const mail = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://app.cheekycheese.tech/',
    })
    expect(mail.buttonHref).not.toContain('tech//')
  })
})

describe('подстановка в разметку обезврежена', () => {
  it('имя объекта с угловыми скобками не становится разметкой', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('PROJECT_MEMBER_ADDED'),
        data: { projectName: '<script>alert("x")</script>' },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
    // Тема письма — не HTML, экранировать её нельзя: почтовый клиент покажет
    // «&lt;» буквально. Она уезжает в заголовок как есть.
    expect(mail.subject).toContain('<script>')
  })
})

/** Грубое снятие разметки — остаётся то, что увидит человек. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
}
