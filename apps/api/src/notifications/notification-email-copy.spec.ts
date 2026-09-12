import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
  NOTIFICATION_TITLES,
} from '@crm/shared'
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
    subject: 'Транзакция по проекту «Мобильный банк»',
    text: 'В ваших финансах новая транзакция. Сумма и детали — в CRM.',
    button: 'Открыть финансы',
  },
  TRANSACTION_STATUS_CHANGED: {
    subject: 'Доход отклонён',
    // Актора нет: его нет и в данных, а решает бухгалтер ИЛИ админ (COPY-H-2).
    text: 'Причина отказа — в CRM.',
    button: 'Открыть финансы',
  },
  TEAM_MEMBER_ADDED: {
    subject: 'Вас добавили в команду «Ядро платформы»',
    text: 'Состав команды — в CRM.',
    button: 'Открыть команду',
  },
  PROJECT_MEMBER_ADDED: {
    subject: 'Вас добавили в проект «Мобильный банк»',
    text: 'Детали проекта и его состав — в CRM.',
    button: 'Открыть проект',
  },
  TEAM_NEW_MEMBER: {
    subject: 'В команде «Ядро платформы» новый участник',
    text: 'Кто именно — в CRM.',
    button: 'Открыть команду',
  },
  PROJECT_CONFIRM_REQUIRED: {
    subject: 'Запрос на добавление проекта «Мобильный банк»',
    text: 'Вам предлагают участие в проекте «Мобильный банк».\nПроект не начнётся, пока участники не ответят.',
    // Ведёт на `/pending` — значит и называет то, что там делают (COPY-L-5).
    button: 'Ответить на запрос',
  },
  SHARE_CONFIRM_REQUIRED: {
    // Тема — §11 дословно, решение владельца (COPY-L-3); тело — «доля».
    subject: 'Запрос на смену процента по проекту «Мобильный банк»',
    text: 'Вам предлагают изменить вашу долю по проекту «Мобильный банк».\nСейчас действует прежняя доля. Новая вступит в силу только после вашего согласия.',
    button: 'Ответить на запрос',
  },
  DOCUMENT_SIGN_REQUIRED: {
    subject: 'Запрос на подпись контракта',
    text: 'Ваш контракт готов и ждёт подписи.',
    button: 'Ответить на запрос',
  },
  APPROVAL_CONFIRMED: {
    subject: 'Ваше предложение принято',
    text: 'Сотрудник согласился участвовать в проекте «Мобильный банк».',
    button: 'Открыть проект',
  },
  APPROVAL_REJECTED: {
    subject: 'Ваше предложение отклонено',
    text: 'Сотрудник отказался от смены доли по проекту «Мобильный банк».\nПричина — в CRM.',
    button: 'Открыть проект',
  },
}

describe('эталон: тема, текст и кнопка дословно', () => {
  it.each(NEW_NOTIFICATION_TYPES)('%s', (type) => {
    const mail = render(type)
    const want = GOLDEN[type]
    expect(mail.subject).toBe(want.subject)
    // Текст = строки тела, пустая строка, ПОДПИСЬ КНОПКИ и адрес. Подпись
    // перед ссылкой — COPY-L-1: в html читатель видит «Ответить на запрос», в
    // text без неё оставался голый адрес. Адрес в эталоне не хранится: он уже
    // проверен отдельно, и держать его здесь значило бы ломать эталон при
    // смене тестового адреса.
    expect(mail.text).toBe(`${want.text}\n\n${want.button}: ${mail.buttonHref}`)
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
    expect(mail.subject).toBe('Запрос на смену доли по умолчанию')
    expect(mail.text).toBe(
      'Вам предлагают изменить долю по умолчанию.\n' +
        'Сейчас действует прежняя доля. Новая вступит в силу только после вашего согласия.\n\n' +
        `Ответить на запрос: ${mail.buttonHref}`,
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
    expect(mail.text).toBe(`Сумма и детали — в CRM.\n\nОткрыть финансы: ${mail.buttonHref}`)
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
    expect(mail.subject).toBe('Запрос на смену доли по умолчанию')
    expect(mail.text.startsWith('Вам предлагают изменить долю по умолчанию.')).toBe(true)
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
    expect(mail.subject).toBe('Запрос на смену доли по умолчанию')
    expect(mail.text.startsWith('Вам предлагают изменить долю по умолчанию.')).toBe(true)
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
    expect(mail.text).toBe(
      `Сотрудник согласился на смену доли по умолчанию.\n\nОткрыть профиль: ${mail.buttonHref}`,
    )
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
    expect(mail.text.startsWith('Сотрудник отказался участвовать в проекте.')).toBe(true)
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
    expect(mail.text.startsWith('Сотрудник согласился на смену доли по проекту.')).toBe(true)
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

  it('смена доли по умолчанию обходится без проекта — его там нет', () => {
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
    expect(mail.subject).toBe('Запрос на смену доли по умолчанию')
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

describe('кнопка ведёт туда, где действие возможно (SPEC-H-3 / CR-H-4)', () => {
  it('все три «требующих действия» ведут на /pending', () => {
    // Задание, п.4 дословно: «Кнопка „требующих действия“ ведёт на
    // ${FRONTEND_URL}/pending». Круг 1 звал `notificationActions()` без
    // различения и получал путь к ОБЪЕКТУ: `/projects/:id` (где кнопок
    // подтверждения нет вовсе) и `/onboarding` для подписи. То есть письмо
    // «Запрос на …» приводило туда, где на запрос не ответишь.
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      const mail = render(type)
      expect(mail.buttonHref, `${type} ведёт не на /pending`).toBe(`${FRONTEND}/pending`)
      expect(mail.buttonLabel).toBe('Ответить на запрос')
      // Адрес объекта в письме не появляется ВООБЩЕ — иначе рядом с кнопкой
      // оказалось бы два пути, и §11 «одна кнопка» перестало бы что-то значить.
      expect(mail.text).not.toContain(`${FRONTEND}/projects/`)
    }
  })

  it('информирующие и админские по-прежнему ведут на ОБЪЕКТ', () => {
    // Обратная сторона правила: `/pending` показывает то, что ждёт ответа, и
    // письмо «вас добавили в команду» привело бы на пустой экран.
    for (const type of [...INFORMING_NOTIFICATION_TYPES, ...ADMIN_NOTIFICATION_TYPES]) {
      const mail = render(type)
      expect(mail.buttonHref, `${type} уехал на /pending`).not.toBe(`${FRONTEND}/pending`)
      expect(mail.buttonHref.startsWith(`${FRONTEND}/`)).toBe(true)
    }
  })

  it('маршрут «требующих действия» не зависит от вида объекта', () => {
    // Базовая доля живёт на `USER`, проектная — на `PROJECT`; у обеих ответ
    // дают на одном экране, и ветка по виду объекта здесь была бы лишней.
    const base = renderNotificationEmail(
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
    expect(base.buttonHref).toBe(`${FRONTEND}/pending`)
  })

  it('хвостовой слэш адреса не даёт двойного слэша и в /pending', () => {
    const mail = renderNotificationEmail(sourceFor('DOCUMENT_SIGN_REQUIRED'), {
      frontendUrl: 'https://app.cheekycheese.tech/',
    })
    expect(mail.buttonHref).toBe('https://app.cheekycheese.tech/pending')
  })
})

describe('письмо о смене доли снимает испуг второй строкой', () => {
  it('говорит, что действует прежняя ДОЛЯ', () => {
    // §11: «Без этого человек, увидев тему, решает, что у него уже что-то
    // изменили». Слово «доля», а не «процент» (COPY-H-1): сотрудник, получивший
    // письмо про «базовый процент», зайдёт и увидит «Доля по умолчанию».
    const mail = render('SHARE_CONFIRM_REQUIRED')
    expect(mail.text).toContain('прежняя доля')
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
    // Тип требует действия — кнопка ведёт на `/pending` и называется так же,
    // как у разобравшихся данных: деградирует ТЕКСТ, а не маршрут.
    expect(mail.text).toBe(`Подробности — в CRM.\n\nОтветить на запрос: ${mail.buttonHref}`)
    expect(mail.buttonHref).toBe(`${FRONTEND}/pending`)
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
    expect(mail.text).toBe(`Подробности — в CRM.\n\nОткрыть: ${mail.buttonHref}`)
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
    expect(mail.text).toBe(
      `Пришёл отклик на вакансию React-разработчика\n\nОткрыть: ${mail.buttonHref}`,
    )
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
                Вам предлагают участие в проекте «${PROJECT}».
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Проект не начнётся, пока участники не ответят.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${mail.buttonHref}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Ответить на запрос</a>
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
    // Тип выбран тот, у которого имя проекта попадает В ТЕЛО письма: после
    // COPY-M-1 информирующие письма имя объекта в теле не повторяют, и проверка
    // на них ничего бы не проверяла.
    const mail = renderNotificationEmail(
      {
        ...sourceFor('PROJECT_CONFIRM_REQUIRED'),
        data: {
          projectName: '<script>alert("x")</script>',
          approvalId: '11111111-1111-4111-8111-111111111111',
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
    // Тема письма — не HTML, экранировать её нельзя: почтовый клиент покажет
    // «&lt;» буквально. Она уезжает в заголовок как есть.
    expect(mail.subject).toContain('<script>')
  })

  it('перевод строки в имени объекта не разрывает тему', () => {
    // SR-M-1: тема уезжает в заголовок письма, а `projectName` приходит из
    // ввода, где `z.string().max(255)` перевод строки разрешает. Тело при этом
    // переводы строк не запрещает — там они законны.
    const mail = renderNotificationEmail(
      {
        ...sourceFor('PROJECT_CONFIRM_REQUIRED'),
        data: {
          projectName: 'Банк\r\nBcc: attacker@example.com',
          approvalId: '11111111-1111-4111-8111-111111111111',
        },
      },
      { frontendUrl: FRONTEND },
    )
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject).toBe('Запрос на добавление проекта «Банк Bcc: attacker@example.com»')
  })
})

/** Грубое снятие разметки — остаётся то, что увидит человек. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
}
