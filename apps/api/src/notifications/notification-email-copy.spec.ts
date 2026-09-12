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

/**
 * Эталон десяти писем — тема, текст и подпись кнопки дословно.
 *
 * Свойства (ни цифр, ни имён, одна кнопка) проверены выше; они НЕ закрывают
 * сам текст: письмо, у которого тело стало пустой строкой, все проверки
 * свойств проходит. А текст здесь и есть предмет задачи — §11 утверждён
 * владельцем, и молча разойтись с утверждённым он не должен.
 *
 * Ожидаемое взято из §11 и задания, а не вычислено тем же кодом, что и
 * реализация: иначе проверка была бы тавтологией и прошла бы по построению.
 * Правка формулировки обязана падать здесь — это не хрупкость, а гейт на
 * текст, который читает `copy-reviewer`.
 */
const GOLDEN: Record<NewNotificationType, { subject: string; text: string; button: string }> = {
  TRANSACTION_ADDED: {
    subject: 'Вам добавили транзакцию по проекту «Мобильный банк»',
    text: 'В ваших финансах новая транзакция. Сумма и детали — в CRM.',
    button: 'Открыть финансы',
  },
  TRANSACTION_STATUS_CHANGED: {
    subject: 'Доход отклонён',
    text: 'Бухгалтер отклонил заявленный доход. Причина — в CRM.',
    button: 'Открыть финансы',
  },
  TEAM_MEMBER_ADDED: {
    subject: 'Вас добавили в команду «Ядро платформы»',
    text: 'Теперь вы участник команды «Ядро платформы».',
    button: 'Открыть команду',
  },
  PROJECT_MEMBER_ADDED: {
    subject: 'Вас добавили в проект «Мобильный банк»',
    text: 'Теперь вы участник проекта «Мобильный банк».',
    button: 'Открыть проект',
  },
  TEAM_NEW_MEMBER: {
    subject: 'В команде «Ядро платформы» новый участник',
    text: 'К команде «Ядро платформы» присоединился новый участник. Кто — в CRM.',
    button: 'Открыть команду',
  },
  PROJECT_CONFIRM_REQUIRED: {
    subject: 'Запрос на добавление проекта «Мобильный банк»',
    text: 'Вас предлагают в проект «Мобильный банк».\nПроект не начнётся, пока участники не ответят.',
    button: 'Открыть проект',
  },
  SHARE_CONFIRM_REQUIRED: {
    subject: 'Запрос на смену процента по проекту «Мобильный банк»',
    text: 'Вам предлагают изменить процент по проекту «Мобильный банк».\nСейчас действует прежний процент. Новый вступит в силу только после вашего согласия.',
    button: 'Открыть предложение',
  },
  DOCUMENT_SIGN_REQUIRED: {
    subject: 'Запрос на подпись: контракт',
    text: 'Ваш контракт готов и ждёт подписи.',
    button: 'Подписать контракт',
  },
  APPROVAL_CONFIRMED: {
    subject: 'Ваше предложение принято',
    text: 'Сотрудник принял проект «Мобильный банк».',
    button: 'Открыть проект',
  },
  APPROVAL_REJECTED: {
    subject: 'Ваше предложение отклонено',
    text: 'Сотрудник отклонил смену процента по проекту «Мобильный банк».\nПричина — в CRM.',
    button: 'Открыть проект',
  },
}

describe('эталон: тема, текст и кнопка дословно', () => {
  it.each(NEW_NOTIFICATION_TYPES)('%s', (type) => {
    const mail = render(type)
    const want = GOLDEN[type]
    expect(mail.subject).toBe(want.subject)
    // Текст = строки тела, пустая строка, адрес. Сверяется тело: адрес уже
    // проверен отдельно, и держать его в эталоне значило бы ломать эталон при
    // смене тестового адреса.
    expect(mail.text).toBe(`${want.text}\n\n${mail.buttonHref}`)
    expect(mail.buttonLabel).toBe(want.button)
  })
})

describe('эталон: ветки, которых в таблице выше быть не может', () => {
  it('смена БАЗОВОГО процента — своя тема и своё тело', () => {
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
    expect(mail.text).toBe(
      'Вам предлагают изменить базовый процент.\n' +
        'Сейчас действует прежний процент. Новый вступит в силу только после вашего согласия.\n\n' +
        `${mail.buttonHref}`,
    )
  })

  it('валидированный доход — своя тема и своё тело', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('TRANSACTION_STATUS_CHANGED'),
        data: {
          amount: '1500.000000',
          currency: 'USDT',
          status: 'VALIDATED',
          rejectionReasonPreview: null,
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Доход валидирован')
    expect(mail.text).toBe(`Бухгалтер подтвердил заявленный доход.\n\n${mail.buttonHref}`)
  })

  it('БАЗОВЫЙ процент с уцелевшим именем проекта — всё равно базовый', () => {
    // Вид доли решает, а имя проекта — нет. Форма данных допускает эту пару
    // (`projectName` просто nullable), и если бы читалось только имя, базовое
    // предложение представилось бы проектным — то есть человеку сообщили бы
    // не про ту долю, которую меняют.
    const mail = renderNotificationEmail(
      {
        ...sourceFor('SHARE_CONFIRM_REQUIRED'),
        subjectType: 'USER',
        data: {
          scope: 'BASE',
          projectName: PROJECT,
          previousPercent: 26,
          proposedPercent: 30,
          approvalId: '22222222-2222-4222-8222-222222222222',
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Запрос на смену базового процента')
    expect(mail.text.startsWith('Вам предлагают изменить базовый процент.')).toBe(true)
    expect(mail.subject).not.toContain(PROJECT)
  })

  it('процент ПО ПРОЕКТУ, но имя проекта не снято — говорим как про базовый', () => {
    // Две независимые причины обойтись без имени: базовая доля (`scope`) и
    // потерянное имя (`projectName === null`). Достаточно ЛЮБОЙ: тема «по
    // проекту «»» — мусор. Этот случай отличает «или» от «и».
    const mail = renderNotificationEmail(
      {
        ...sourceFor('SHARE_CONFIRM_REQUIRED'),
        data: {
          scope: 'PROJECT',
          projectName: null,
          previousPercent: 26,
          proposedPercent: 30,
          approvalId: '22222222-2222-4222-8222-222222222222',
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Запрос на смену базового процента')
    expect(mail.text.startsWith('Вам предлагают изменить базовый процент.')).toBe(true)
    expect(mail.subject).not.toContain('«»')
  })

  it('транзакция без проекта — тема без имени проекта', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('TRANSACTION_ADDED'),
        data: { amount: '1500.000000', currency: 'USDT', projectName: null },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).toBe('Вам добавили транзакцию')
  })

  it('решение по базовой доле — «смену базового процента», а не проект', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('APPROVAL_CONFIRMED'),
        subjectType: 'USER',
        data: { approverName: PERSON, subjectKind: 'BASE_SHARE', subjectTitle: null },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text).toBe(`Сотрудник принял смену базового процента.\n\n${mail.buttonHref}`)
    expect(mail.buttonLabel).toBe('Открыть профиль')
  })

  it('решение по проекту без названия — «проект» без кавычек', () => {
    // `subjectTitle` допускает `null` (объект переименовали, снимок не сняли).
    // Дырка «проект «»» читалась бы как поломка.
    const mail = renderNotificationEmail(
      {
        ...sourceFor('APPROVAL_REJECTED'),
        data: {
          approverName: PERSON,
          subjectKind: 'PROJECT',
          subjectTitle: null,
          reasonPreview: null,
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text.startsWith('Сотрудник отклонил проект.')).toBe(true)
    expect(mail.text).not.toContain('«»')
  })

  it('решение по проценту проекта без названия — тоже без пустых кавычек', () => {
    const mail = renderNotificationEmail(
      {
        ...sourceFor('APPROVAL_CONFIRMED'),
        data: { approverName: PERSON, subjectKind: 'PROJECT_SHARE', subjectTitle: null },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text.startsWith('Сотрудник принял смену процента по проекту.')).toBe(true)
    expect(mail.text).not.toContain('«»')
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

  it('тип с неразбираемыми данными говорит, что подробности в CRM', () => {
    // Текст запасного пути — тоже текст: письмо «» ушло бы как пустое.
    const mail = renderNotificationEmail(
      { ...sourceFor('SHARE_CONFIRM_REQUIRED'), data: { scope: 'WRONG' } },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text).toBe(`Подробности — в CRM.\n\n${mail.buttonHref}`)
  })

  it('старый тип без сохранённого тела тоже зовёт в CRM', () => {
    const mail = renderNotificationEmail(
      {
        type: 'INVOICE_SIGNED',
        title: 'Инвойс подписан',
        body: null,
        link: '/finance/invoices/abc',
        subjectType: null,
        subjectId: null,
        data: null,
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text).toBe(`Подробности — в CRM.\n\n${mail.buttonHref}`)
  })

  it('старый тип с сохранённым телом печатает ЕГО, а не заглушку', () => {
    const mail = renderNotificationEmail(
      {
        type: 'VACANCY_APPLICATION',
        title: 'Отклик на вакансию',
        body: 'Пришёл отклик на вакансию React-разработчика',
        link: '/vacancies',
        subjectType: null,
        subjectId: null,
        data: null,
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.text).toBe(`Пришёл отклик на вакансию React-разработчика\n\n${mail.buttonHref}`)
  })

  it('без ссылки кнопка называется «Открыть CRM»', () => {
    // Подпись «Открыть команду» на кнопке, ведущей в корень, врала бы о том,
    // что откроется.
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
    expect(mail.buttonLabel).toBe('Открыть CRM')
  })

  it('адрес берётся из настройки, а не из константы', () => {
    const mail = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://other.example',
    })
    expect(mail.buttonHref.startsWith('https://other.example/')).toBe(true)
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

  it('хвостовой слэш адреса срезается, а не заменяется чем попало', () => {
    // Адрес сверяется ЦЕЛИКОМ: «нет двойного слэша» выполняется и для
    // адреса, склеенного как попало, — а ведёт такая ссылка в никуда.
    const mail = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://app.cheekycheese.tech/',
    })
    expect(mail.buttonHref).toBe(`https://app.cheekycheese.tech/projects/${SUBJECT_ID}`)
  })

  it('адрес без хвостового слэша остаётся как есть', () => {
    const mail = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://app.cheekycheese.tech',
    })
    expect(mail.buttonHref).toBe(`https://app.cheekycheese.tech/projects/${SUBJECT_ID}`)
  })
})

describe('каркас письма (§12: почтовые клиенты — не браузеры)', () => {
  it('двухстрочное письмо собирается ровно так', () => {
    // Эталон разметки целиком. Дословно — потому что почтовый клиент не
    // прощает ни таблиц без `role="presentation"`, ни `max-width` мимо
    // внешней таблицы, а увидеть это можно только в чужом клиенте, когда
    // письмо уже ушло. Правка вёрстки обязана падать здесь.
    const mail = render('PROJECT_CONFIRM_REQUIRED')
    expect(mail.html).toBe(`<!DOCTYPE html>
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
                Вас предлагают в проект «${PROJECT}».
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Проект не начнётся, пока участники не ответят.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${mail.buttonHref}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Открыть проект</a>
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

  it('у последней строки отступ больше — она отделяет текст от кнопки', () => {
    // Односрочное письмо: единственная строка ОДНОВРЕМЕННО первая и
    // последняя, и отступ у неё обязан быть «последний» (24), а не «первый»
    // (16). Именно этим односрочное письмо отличает правильную границу от
    // сдвинутой на единицу.
    const mail = render('DOCUMENT_SIGN_REQUIRED')
    expect(mail.html).toContain('margin:0 0 24px 0')
    expect(mail.html).not.toContain('margin:0 0 16px 0')
  })

  it('в двухстрочном письме ровно один «последний» отступ', () => {
    const mail = render('SHARE_CONFIRM_REQUIRED')
    expect(mail.html.match(/margin:0 0 24px 0/g)).toHaveLength(1)
    expect(mail.html.match(/margin:0 0 16px 0/g)).toHaveLength(1)
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
