import { describe, expect, it } from 'vitest'
import { i18n as globalI18n } from '@lingui/core'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
  NOTIFICATION_TITLES,
} from '@crm/shared'
import type { Locale, NewNotificationType } from '@crm/shared'

import { renderNotificationEmail, type NotificationEmailSource } from './notification-email-copy'

/**
 * Страж тринадцати писем — §11 («Тексты писем») + §10 («уведомления о деньгах —
 * это раскрытие»), в ОБЕИХ локалях получателя (`uk`, `en`).
 *
 * Письмо уходит на ЛИЧНУЮ почту, вне нашего контура. Поэтому правило, которое
 * этот файл проверяет механически, а не надеждой на внимательность автора:
 *
 *   **письмо называет ОБЪЕКТ (проект, команда, контракт) и не называет ни
 *   людей, ни цифр.**
 *
 * Обе половины проверяются подстановкой: в каждый образец кладутся суммы,
 * проценты и имя человека, а от результата требуется, чтобы ни одной цифры и
 * ни одного имени в нём не осталось. Эталоны текста — дословные литералы,
 * написанные руками из задания, а не вычисленные тем же кодом, что и
 * реализация (иначе тест проходил бы по построению — тавтология).
 *
 * Имена объектов в образцах — ASCII: так любая кириллица в английском письме
 * может прийти только из каталога, то есть означает протёкший русский/украинский.
 */

/** Имя третьего лица. Ни одно письмо не имеет права его напечатать. */
const PERSON = 'Ivan Petrov'
/** Имена объектов БЕЗ цифр — чтобы любая цифра в выводе означала утечку из шаблона. */
const PROJECT = 'Mobile Bank'
const TEAM = 'Platform Core'

const FRONTEND = 'https://app.cheekycheese.tech'

const LOCALES = ['uk', 'en'] as const

const DATA: Record<NewNotificationType, unknown> = {
  TRANSACTION_ADDED: { amount: '1500.000000', currency: 'USDT', projectName: PROJECT },
  TRANSACTION_STATUS_CHANGED: {
    amount: '1500.000000',
    currency: 'USDT',
    status: 'REJECTED',
    rejectionReasonPreview: 'no receipt',
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
  DOCUMENT_SIGN_REQUIRED: { documentTitle: 'Your contract' },
  APPROVAL_CONFIRMED: {
    approverName: PERSON,
    subjectKind: 'PROJECT',
    subjectTitle: PROJECT,
  },
  APPROVAL_REJECTED: {
    approverName: PERSON,
    subjectKind: 'PROJECT_SHARE',
    subjectTitle: PROJECT,
    reasonPreview: 'too low',
  },
  // COPY-M-4 (PR #714): `dataSchemas.INVOICE_SIGNED` requires `...moneyFields` — without them
  // `notificationDataSchemaFor('INVOICE_SIGNED').safeParse(...)` fails in `composeBody` and this
  // fixture would exercise the "data didn't parse" fallback instead of `BODIES.INVOICE_SIGNED`.
  INVOICE_SIGNED: { counterpartyName: PERSON, amount: '1500.000000', currency: 'USDT' },
  INVOICE_SIGN_REQUIRED: { amount: '1500.000000', currency: 'USDT' },
  VACANCY_APPLICATION: { vacancyTitle: 'Senior Frontend Engineer' },
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
  // Реальные производители (invoices.service.ts, applications.service.ts) не задают
  // `subjectType`/`subjectId` для этих трёх типов — кнопка идёт по сохранённой `link`.
  INVOICE_SIGNED: null,
  INVOICE_SIGN_REQUIRED: null,
  VACANCY_APPLICATION: null,
}

const SUBJECT_ID = '33333333-3333-4333-8333-333333333333'

/**
 * Ссылка, которую реально кладут производители трёх типов — без `&`, чтобы не путать этот тест
 * с HTML-экранированием (`mail.html` несёт `&amp;`, а `mail.buttonHref` — нет).
 */
const LINK: Partial<Record<NewNotificationType, string>> = {
  INVOICE_SIGNED: '/documents/tx-1',
  INVOICE_SIGN_REQUIRED: '/documents/tx-1',
  VACANCY_APPLICATION: '/vacancies/vac-1',
}

function sourceFor(type: NewNotificationType): NotificationEmailSource {
  return {
    type,
    title: NOTIFICATION_TITLES[type],
    body: null,
    link: LINK[type] ?? null,
    subjectType: SUBJECT_TYPE[type],
    subjectId: SUBJECT_TYPE[type] === null ? null : SUBJECT_ID,
    data: DATA[type],
  }
}

function render(type: NewNotificationType, locale: Locale) {
  return renderNotificationEmail(sourceFor(type), { frontendUrl: FRONTEND, locale })
}

function renderWith(source: NotificationEmailSource, locale: Locale) {
  return renderNotificationEmail(source, { frontendUrl: FRONTEND, locale })
}

/** Грубое снятие разметки — остаётся то, что увидит человек. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
}

/** Бывшая кириллица-в-английском проверка: любой украинский/русский знак. */
const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/

// ---------------------------------------------------------------------------
// Структурные пины (Task 1.1): маршрут и каркас, не язык. Пережили миграцию без правок.
// ---------------------------------------------------------------------------

describe('структурные пины — маршрут и каркас не зависят от языка', () => {
  it('ровно тринадцать типов: четырнадцатый обязан упасть здесь, а не молча уйти без шаблона', () => {
    expect(NEW_NOTIFICATION_TYPES).toHaveLength(13)
  })

  const HREF: Record<NewNotificationType, string> = {
    TRANSACTION_ADDED: `${FRONTEND}/finance`,
    TRANSACTION_STATUS_CHANGED: `${FRONTEND}/finance`,
    TEAM_MEMBER_ADDED: `${FRONTEND}/team/${SUBJECT_ID}`,
    PROJECT_MEMBER_ADDED: `${FRONTEND}/projects/${SUBJECT_ID}`,
    TEAM_NEW_MEMBER: `${FRONTEND}/team/${SUBJECT_ID}`,
    PROJECT_CONFIRM_REQUIRED: `${FRONTEND}/pending`,
    SHARE_CONFIRM_REQUIRED: `${FRONTEND}/pending`,
    DOCUMENT_SIGN_REQUIRED: `${FRONTEND}/pending`,
    APPROVAL_CONFIRMED: `${FRONTEND}/projects/${SUBJECT_ID}`,
    APPROVAL_REJECTED: `${FRONTEND}/projects/${SUBJECT_ID}`,
    INVOICE_SIGNED: `${FRONTEND}/documents/tx-1`,
    INVOICE_SIGN_REQUIRED: `${FRONTEND}/documents/tx-1`,
    VACANCY_APPLICATION: `${FRONTEND}/vacancies/vac-1`,
  }

  describe.each(LOCALES)('%s', (locale) => {
    it.each(NEW_NOTIFICATION_TYPES)(
      '%s: buttonHref, одна ссылка, тема без CR/LF, хвост text',
      (type) => {
        const mail = render(type, locale)
        expect(mail.buttonHref).toBe(HREF[type])
        expect(mail.html.match(/<a href=/g)).toHaveLength(1)
        expect(mail.subject).not.toMatch(/[\r\n]/)
        expect(mail.text.split('\n').at(-1)).toBe(`${mail.buttonLabel}: ${mail.buttonHref}`)
      },
    )
  })

  it('без ссылки и без объекта кнопка ведёт в корень', () => {
    const mail = renderWith(
      {
        type: 'VACANCY_APPLICATION',
        title: 't',
        body: null,
        link: null,
        subjectType: null,
        subjectId: null,
        data: null,
      },
      'uk',
    )
    expect(mail.buttonHref).toBe(`${FRONTEND}/`)
  })
})

// ---------------------------------------------------------------------------
// Страж §10/§11 — в обеих локалях
// ---------------------------------------------------------------------------

describe.each(LOCALES)('%s: тринадцать писем — страж §11', (locale) => {
  it.each(NEW_NOTIFICATION_TYPES)('%s: есть тема, текст и разметка', (type) => {
    const mail = render(type, locale)
    expect(mail.subject.length).toBeGreaterThan(0)
    expect(mail.text.length).toBeGreaterThan(0)
    expect(mail.html).toContain('<!DOCTYPE html>')
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ни одной цифры — ни суммы, ни процента', (type) => {
    const mail = render(type, locale)
    // Данные образца НЕСУТ и сумму, и проценты (см. DATA выше). Любая цифра в выводе означает,
    // что шаблон их подставил, — то, что §11 запрещает прямым текстом.
    expect(mail.subject).not.toMatch(/[0-9]/)
    // Из текстовой версии убирается сам адрес: в нём цифры законны (идентификатор объекта).
    expect(mail.text.replace(mail.buttonHref, '')).not.toMatch(/[0-9]/)
    // В разметке цифры законны (цвета, пиксели, ссылка) — проверяется только ВИДИМЫЙ текст.
    expect(visibleText(mail.html)).not.toMatch(/[0-9]/)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: не называет людей', (type) => {
    const mail = render(type, locale)
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain(PERSON)
    // Имя целиком не единственная форма утечки — фамилия отдельно тоже имя.
    expect(`${mail.subject} ${mail.text}`).not.toContain('Petrov')
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ровно одна кнопка', (type) => {
    const mail = render(type, locale)
    // §11: «Одна кнопка на письмо. „Открыть“ и „Отклонить“ рядом означало бы, что отказ можно
    // дать не заходя, — а нам нужен след в системе с причиной».
    const anchors = mail.html.match(/<a\s/g) ?? []
    expect(anchors).toHaveLength(1)
    expect(mail.html).toContain(mail.buttonHref)
    expect(mail.buttonLabel.length).toBeGreaterThan(0)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ссылка абсолютная и ведёт в наш CRM', (type) => {
    const mail = render(type, locale)
    expect(mail.buttonHref.startsWith(`${FRONTEND}/`)).toBe(true)
    // Текстовая версия несёт тот же адрес — иначе читатель без HTML остаётся без выхода.
    expect(mail.text).toContain(mail.buttonHref)
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: ни благодарностей, ни вежливой рамки', (type) => {
    const mail = render(type, locale)
    // §11: «Транзакционное письмо, которое благодарит, читается как рассылка и попадает в
    // „Промоакции“ вместе с ней».
    const forbidden = [
      'Дякуємо',
      'Дякую',
      'З повагою',
      'Доброго дня',
      'Вітаємо',
      'Thank',
      'Dear',
      'Hello',
      'Best regards',
      'Kind regards',
    ]
    for (const word of forbidden) {
      expect(`${mail.subject} ${mail.text}`, `нашлось «${word}»`).not.toContain(word)
    }
  })

  it.each(NEW_NOTIFICATION_TYPES)('%s: в тексте нет артефакта ICU-апострофа', (type) => {
    const mail = render(type, locale)
    expect(`${mail.subject} ${mail.text}`).not.toMatch(/'/)
  })
})

describe('en: ни одного украинского/русского знака (кроме данных)', () => {
  it.each(NEW_NOTIFICATION_TYPES)('%s', (type) => {
    const mail = render(type, 'en')
    expect(`${mail.subject}\n${mail.text}\n${visibleText(mail.html)}`).not.toMatch(CYRILLIC)
  })
})

// ---------------------------------------------------------------------------
// Эталоны — тема, текст и подпись кнопки дословно, uk И en
// ---------------------------------------------------------------------------

type Golden = Record<NewNotificationType, { subject: string; text: string; button: string }>

const GOLDEN: Record<Locale, Golden> = {
  uk: {
    TRANSACTION_ADDED: {
      subject: 'Транзакція за проєктом «Mobile Bank»',
      text: 'У ваших фінансах нова транзакція. Сума й деталі — у CRM.',
      button: 'Відкрити фінанси',
    },
    TRANSACTION_STATUS_CHANGED: {
      // Актора нет: его нет и в данных, а решает бухгалтер ИЛИ админ (COPY-H-2).
      subject: 'Дохід відхилено',
      text: 'Причина відмови — у CRM.',
      button: 'Відкрити фінанси',
    },
    TEAM_MEMBER_ADDED: {
      subject: 'Вас додали до команди «Platform Core»',
      text: 'Склад команди — у CRM.',
      button: 'Відкрити команду',
    },
    PROJECT_MEMBER_ADDED: {
      subject: 'Вас додали до проєкту «Mobile Bank»',
      text: 'Деталі проєкту та його склад — у CRM.',
      button: 'Відкрити проєкт',
    },
    TEAM_NEW_MEMBER: {
      subject: 'У команді «Platform Core» новий учасник',
      text: 'Хто саме — у CRM.',
      button: 'Відкрити команду',
    },
    PROJECT_CONFIRM_REQUIRED: {
      subject: 'Запит на додавання проєкту «Mobile Bank»',
      text: 'Вам пропонують участь у проєкті «Mobile Bank».\nПроєкт не стартує, доки учасники не відповіли.',
      // Ведёт на `/pending` — значит и называет то, что там делают (COPY-L-5).
      button: 'Відповісти на запит',
    },
    SHARE_CONFIRM_REQUIRED: {
      // «частка», а не «процент»: глоссарий CONTEXT.md обязателен в обоих языках.
      subject: 'Запит на зміну частки за проєктом «Mobile Bank»',
      text: 'Вам пропонують змінити вашу частку за проєктом «Mobile Bank».\nЗараз діє попередня частка. Нова набуде чинності лише після вашої згоди.',
      button: 'Відповісти на запит',
    },
    DOCUMENT_SIGN_REQUIRED: {
      subject: 'Запит на підпис контракту',
      text: 'Ваш контракт готовий і чекає на підпис.',
      button: 'Відповісти на запит',
    },
    APPROVAL_CONFIRMED: {
      subject: 'Вашу пропозицію прийнято',
      text: 'Співробітник погодився взяти участь у проєкті «Mobile Bank».',
      button: 'Відкрити проєкт',
    },
    APPROVAL_REJECTED: {
      subject: 'Вашу пропозицію відхилено',
      text: 'Співробітник відмовився від зміни частки за проєктом «Mobile Bank».\nПричина — у CRM.',
      button: 'Відкрити проєкт',
    },
    // Эти три типа без `subjectType`: кнопка идёт по сохранённой `link`, подпись — общее
    // «Відкрити» (`emailAction()` для типа без записи среди пяти информирующих).
    INVOICE_SIGNED: {
      subject: 'Рахунок підписано',
      text: 'Деталі — у CRM.',
      button: 'Відкрити',
    },
    INVOICE_SIGN_REQUIRED: {
      subject: 'Рахунок очікує підпису',
      text: 'Сума й деталі — у CRM.',
      button: 'Відкрити',
    },
    VACANCY_APPLICATION: {
      subject: 'Новий відгук на вакансію «Senior Frontend Engineer»',
      text: 'Деталі — у CRM.',
      button: 'Відкрити',
    },
  },
  en: {
    TRANSACTION_ADDED: {
      subject: 'Transaction on project “Mobile Bank”',
      text: 'There is a new transaction in your finances. The amount and details are in the CRM.',
      button: 'Open Finance',
    },
    TRANSACTION_STATUS_CHANGED: {
      subject: 'Income rejected',
      text: 'The reason is in the CRM.',
      button: 'Open Finance',
    },
    TEAM_MEMBER_ADDED: {
      subject: 'You were added to the team “Platform Core”',
      text: 'The team roster is in the CRM.',
      button: 'Open team',
    },
    PROJECT_MEMBER_ADDED: {
      subject: 'You were added to the project “Mobile Bank”',
      text: 'Project details and its members are in the CRM.',
      button: 'Open project',
    },
    TEAM_NEW_MEMBER: {
      subject: 'New member in the team “Platform Core”',
      text: 'Who it is — in the CRM.',
      button: 'Open team',
    },
    PROJECT_CONFIRM_REQUIRED: {
      subject: 'Request to add the project “Mobile Bank”',
      text: 'You are being offered a place on the project “Mobile Bank”.\nThe project will not start until the participants respond.',
      button: 'Respond to the request',
    },
    SHARE_CONFIRM_REQUIRED: {
      subject: 'Request to change your share on the project “Mobile Bank”',
      text: 'You are being asked to change your share on the project “Mobile Bank”.\nYour previous share still applies. The new one takes effect only after you agree.',
      button: 'Respond to the request',
    },
    DOCUMENT_SIGN_REQUIRED: {
      subject: 'Request to sign your contract',
      text: 'Your contract is ready and waiting for your signature.',
      button: 'Respond to the request',
    },
    APPROVAL_CONFIRMED: {
      subject: 'Your proposal was accepted',
      text: 'The employee agreed to take part in the project “Mobile Bank”.',
      button: 'Open project',
    },
    APPROVAL_REJECTED: {
      subject: 'Your proposal was declined',
      text: 'The employee declined the change of their share on the project “Mobile Bank”.\nThe reason is in the CRM.',
      button: 'Open project',
    },
    INVOICE_SIGNED: {
      subject: 'Invoice signed',
      text: 'Details are in the CRM.',
      button: 'Open',
    },
    INVOICE_SIGN_REQUIRED: {
      subject: 'Invoice awaiting your signature',
      text: 'The amount and details are in the CRM.',
      button: 'Open',
    },
    VACANCY_APPLICATION: {
      subject: 'New application for the vacancy “Senior Frontend Engineer”',
      text: 'Details are in the CRM.',
      button: 'Open',
    },
  },
}

describe.each(LOCALES)('%s: эталон — тема, текст и кнопка дословно', (locale) => {
  it.each(NEW_NOTIFICATION_TYPES)('%s', (type) => {
    const mail = render(type, locale)
    const want = GOLDEN[locale][type]
    expect(mail.subject).toBe(want.subject)
    // Текст = строки тела, пустая строка, ПОДПИСЬ КНОПКИ и адрес (COPY-L-1). Адрес в эталоне не
    // хранится: он проверен отдельно выше.
    expect(mail.text).toBe(`${want.text}\n\n${want.button}: ${mail.buttonHref}`)
    expect(mail.buttonLabel).toBe(want.button)
  })
})

// Ветки, которых в таблице выше быть не может. Каждая — целым предложением на обоих языках.

const BASE_SHARE_DATA = {
  scope: 'BASE',
  projectName: null,
  previousPercent: 26,
  proposedPercent: 30,
  approvalId: '22222222-2222-4222-8222-222222222222',
}

const SHARE_BASE: Record<
  Locale,
  { subject: string; line1: string; line2: string; button: string }
> = {
  uk: {
    subject: 'Запит на зміну частки за замовчуванням',
    line1: 'Вам пропонують змінити частку за замовчуванням.',
    line2: 'Зараз діє попередня частка. Нова набуде чинності лише після вашої згоди.',
    button: 'Відповісти на запит',
  },
  en: {
    subject: 'Request to change your default share',
    line1: 'You are being asked to change your default share.',
    line2: 'Your previous share still applies. The new one takes effect only after you agree.',
    button: 'Respond to the request',
  },
}

describe.each(LOCALES)('%s: ветки, которых в таблице эталонов быть не может', (locale) => {
  it('смена БАЗОВОЙ доли — своя тема и своё тело', () => {
    const mail = renderWith(
      { ...sourceFor('SHARE_CONFIRM_REQUIRED'), subjectType: 'USER', data: BASE_SHARE_DATA },
      locale,
    )
    const want = SHARE_BASE[locale]
    expect(mail.subject).toBe(want.subject)
    expect(mail.text).toBe(`${want.line1}\n${want.line2}\n\n${want.button}: ${mail.buttonHref}`)
  })

  it('валидированный доход — своя тема и своё тело', () => {
    const mail = renderWith(
      {
        ...sourceFor('TRANSACTION_STATUS_CHANGED'),
        data: {
          amount: '1500.000000',
          currency: 'USDT',
          status: 'VALIDATED',
          rejectionReasonPreview: null,
        },
      },
      locale,
    )
    const want = {
      uk: {
        subject: 'Дохід валідовано',
        line: 'Сума й деталі — у CRM.',
        button: 'Відкрити фінанси',
      },
      en: {
        subject: 'Income validated',
        line: 'The amount and details are in the CRM.',
        button: 'Open Finance',
      },
    }[locale]
    expect(mail.subject).toBe(want.subject)
    expect(mail.text).toBe(`${want.line}\n\n${want.button}: ${mail.buttonHref}`)
  })

  it('БАЗОВАЯ доля с уцелевшим именем проекта — всё равно базовая', () => {
    // Вид доли решает, а имя проекта — нет. Форма данных допускает эту пару (`projectName`
    // просто nullable): если бы читалось только имя, базовое предложение представилось бы
    // проектным.
    const mail = renderWith(
      {
        ...sourceFor('SHARE_CONFIRM_REQUIRED'),
        subjectType: 'USER',
        data: { ...BASE_SHARE_DATA, projectName: PROJECT },
      },
      locale,
    )
    const want = SHARE_BASE[locale]
    expect(mail.subject).toBe(want.subject)
    expect(mail.text.startsWith(want.line1)).toBe(true)
    expect(mail.subject).not.toContain(PROJECT)
  })

  it('доля ПО ПРОЕКТУ, но имя проекта не снято — говорим как про базовую', () => {
    // Две независимые причины обойтись без имени: вид доли (`scope`) и потерянное имя
    // (`projectName === null`). Достаточно ЛЮБОЙ. Этот случай отличает «или» от «и».
    const mail = renderWith(
      {
        ...sourceFor('SHARE_CONFIRM_REQUIRED'),
        data: { ...BASE_SHARE_DATA, scope: 'PROJECT', projectName: null },
      },
      locale,
    )
    const want = SHARE_BASE[locale]
    expect(mail.subject).toBe(want.subject)
    expect(mail.text.startsWith(want.line1)).toBe(true)
    expect(mail.subject).not.toMatch(/«»|“”/)
  })

  it('транзакция без проекта — тема без имени проекта', () => {
    const mail = renderWith(
      {
        ...sourceFor('TRANSACTION_ADDED'),
        data: { amount: '1500.000000', currency: 'USDT', projectName: null },
      },
      locale,
    )
    expect(mail.subject).toBe(
      { uk: 'Вам додали транзакцію', en: 'A transaction was added for you' }[locale],
    )
  })
})

/**
 * Двенадцать решений админу: {принято, отказано} × {PROJECT, PROJECT_SHARE, BASE_SHARE} ×
 * {с названием, без}. Каждое — ЦЕЛЫМ предложением: именно это доказывает, что склейка
 * фрагментов («в проекте» + ««X»» …) ушла. Для BASE_SHARE названия нет по построению, и оба
 * варианта дают одну и ту же фразу.
 */
const APPROVAL_CASES: ReadonlyArray<{
  decision: 'APPROVAL_CONFIRMED' | 'APPROVAL_REJECTED'
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE'
  title: string | null
  uk: string
  en: string
}> = [
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'PROJECT',
    title: PROJECT,
    uk: 'Співробітник погодився взяти участь у проєкті «Mobile Bank».',
    en: 'The employee agreed to take part in the project “Mobile Bank”.',
  },
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'PROJECT',
    title: null,
    uk: 'Співробітник погодився взяти участь у проєкті.',
    en: 'The employee agreed to take part in the project.',
  },
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'PROJECT_SHARE',
    title: PROJECT,
    uk: 'Співробітник погодився на зміну частки за проєктом «Mobile Bank».',
    en: 'The employee agreed to the change of their share on the project “Mobile Bank”.',
  },
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'PROJECT_SHARE',
    title: null,
    uk: 'Співробітник погодився на зміну частки за проєктом.',
    en: 'The employee agreed to the change of their share on the project.',
  },
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'BASE_SHARE',
    title: null,
    uk: 'Співробітник погодився на зміну частки за замовчуванням.',
    en: 'The employee agreed to the change of their default share.',
  },
  {
    decision: 'APPROVAL_CONFIRMED',
    kind: 'BASE_SHARE',
    title: PROJECT,
    uk: 'Співробітник погодився на зміну частки за замовчуванням.',
    en: 'The employee agreed to the change of their default share.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'PROJECT',
    title: PROJECT,
    uk: 'Співробітник відмовився від участі у проєкті «Mobile Bank».',
    en: 'The employee declined to take part in the project “Mobile Bank”.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'PROJECT',
    title: null,
    uk: 'Співробітник відмовився від участі у проєкті.',
    en: 'The employee declined to take part in the project.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'PROJECT_SHARE',
    title: PROJECT,
    uk: 'Співробітник відмовився від зміни частки за проєктом «Mobile Bank».',
    en: 'The employee declined the change of their share on the project “Mobile Bank”.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'PROJECT_SHARE',
    title: null,
    uk: 'Співробітник відмовився від зміни частки за проєктом.',
    en: 'The employee declined the change of their share on the project.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'BASE_SHARE',
    title: null,
    uk: 'Співробітник відмовився від зміни частки за замовчуванням.',
    en: 'The employee declined the change of their default share.',
  },
  {
    decision: 'APPROVAL_REJECTED',
    kind: 'BASE_SHARE',
    title: PROJECT,
    uk: 'Співробітник відмовився від зміни частки за замовчуванням.',
    en: 'The employee declined the change of their default share.',
  },
]

describe.each(LOCALES)('%s: решения админу — предложение целиком', (locale) => {
  it.each(APPROVAL_CASES)(
    '$decision × $kind × title=$title',
    ({ decision, kind, title, uk, en }) => {
      const mail = renderWith(
        {
          ...sourceFor(decision),
          subjectType: kind === 'BASE_SHARE' ? 'USER' : 'PROJECT',
          data: {
            approverName: PERSON,
            subjectKind: kind,
            subjectTitle: title,
            ...(decision === 'APPROVAL_REJECTED' ? { reasonPreview: null } : {}),
          },
        },
        locale,
      )
      const sentence = locale === 'uk' ? uk : en
      const reason =
        decision === 'APPROVAL_REJECTED'
          ? locale === 'uk'
            ? '\nПричина — у CRM.'
            : '\nThe reason is in the CRM.'
          : ''
      const button =
        kind === 'BASE_SHARE'
          ? locale === 'uk'
            ? 'Відкрити профіль'
            : 'Open profile'
          : locale === 'uk'
            ? 'Відкрити проєкт'
            : 'Open project'
      expect(mail.text).toBe(`${sentence}${reason}\n\n${button}: ${mail.buttonHref}`)
      expect(mail.buttonLabel).toBe(button)
      expect(mail.text).not.toMatch(/«»|“”/)
    },
  )
})

// ---------------------------------------------------------------------------
// Темы
// ---------------------------------------------------------------------------

describe.each(LOCALES)('%s: темы — единый префикс запроса у того, что требует ответа', (locale) => {
  const PREFIX = { uk: 'Запит на', en: 'Request to' }[locale]

  it('проект называет себя по имени', () => {
    expect(render('PROJECT_CONFIRM_REQUIRED', locale).subject).toBe(
      {
        uk: 'Запит на додавання проєкту «Mobile Bank»',
        en: 'Request to add the project “Mobile Bank”',
      }[locale],
    )
  })

  it('смена доли по проекту называет проект и не называет процент', () => {
    const subject = render('SHARE_CONFIRM_REQUIRED', locale).subject
    expect(subject).toBe(
      {
        uk: 'Запит на зміну частки за проєктом «Mobile Bank»',
        en: 'Request to change your share on the project “Mobile Bank”',
      }[locale],
    )
    expect(subject).not.toMatch(/[0-9%]/)
  })

  it('подпись — тоже запрос', () => {
    expect(render('DOCUMENT_SIGN_REQUIRED', locale).subject.startsWith(PREFIX)).toBe(true)
  })

  it('информирующее письмо запросом НЕ притворяется', () => {
    // Префикс сообщает, что от читателя ждут ответа. Поставить его там, где ответа не ждут, —
    // обесценить его везде.
    for (const type of ['TRANSACTION_ADDED', 'TEAM_MEMBER_ADDED', 'APPROVAL_CONFIRMED'] as const) {
      expect(render(type, locale).subject.startsWith(PREFIX)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Кнопка
// ---------------------------------------------------------------------------

describe.each(LOCALES)(
  '%s: кнопка ведёт туда, где действие возможно (SPEC-H-3 / CR-H-4)',
  (locale) => {
    it('все три «требующих действия» ведут на /pending и называются «ответить»', () => {
      for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
        const mail = render(type, locale)
        expect(mail.buttonHref, `${type} ведёт не на /pending`).toBe(`${FRONTEND}/pending`)
        expect(mail.buttonLabel).toBe(
          { uk: 'Відповісти на запит', en: 'Respond to the request' }[locale],
        )
        // Адрес объекта в письме не появляется ВООБЩЕ — иначе рядом с кнопкой оказалось бы два
        // пути, и §11 «одна кнопка» перестало бы что-то значить.
        expect(mail.text).not.toContain(`${FRONTEND}/projects/`)
      }
    })

    it('информирующие и админские по-прежнему ведут на ОБЪЕКТ', () => {
      for (const type of [...INFORMING_NOTIFICATION_TYPES, ...ADMIN_NOTIFICATION_TYPES]) {
        const mail = render(type, locale)
        expect(mail.buttonHref, `${type} уехал на /pending`).not.toBe(`${FRONTEND}/pending`)
        expect(mail.buttonHref.startsWith(`${FRONTEND}/`)).toBe(true)
      }
    })

    it('маршрут «требующих действия» не зависит от вида объекта', () => {
      const base = renderWith(
        { ...sourceFor('SHARE_CONFIRM_REQUIRED'), subjectType: 'USER', data: BASE_SHARE_DATA },
        locale,
      )
      expect(base.buttonHref).toBe(`${FRONTEND}/pending`)
    })

    it('хвостовой слэш адреса не даёт двойного слэша и в /pending', () => {
      const mail = renderNotificationEmail(sourceFor('DOCUMENT_SIGN_REQUIRED'), {
        frontendUrl: 'https://app.cheekycheese.tech/',
        locale,
      })
      expect(mail.buttonHref).toBe('https://app.cheekycheese.tech/pending')
    })
  },
)

describe.each(LOCALES)('%s: письмо о смене доли снимает испуг второй строкой', (locale) => {
  it('говорит, что действует прежняя ДОЛЯ, и что новая — только после согласия', () => {
    // §11: «Без этого человек, увидев тему, решает, что у него уже что-то изменили».
    const mail = render('SHARE_CONFIRM_REQUIRED', locale)
    const want = {
      uk: ['попередня частка', 'лише після вашої згоди'],
      en: ['previous share still applies', 'only after you agree'],
    }[locale]
    for (const fragment of want) expect(mail.text).toContain(fragment)
  })
})

// ---------------------------------------------------------------------------
// Деградация
// ---------------------------------------------------------------------------

const FUTURE_LINK_ONLY: NotificationEmailSource = {
  type: 'SOME_FUTURE_TYPE',
  title: 'Stored legacy title',
  body: null,
  link: '/finance/invoices/abc',
  subjectType: null,
  subjectId: null,
  data: null,
}

describe.each(LOCALES)('%s: деградация', (locale) => {
  it('данные не той формы не мешают письму уйти — тема из каталога типа', () => {
    // Разбор `data` может не удаться (форма типа изменилась, строка старая). Письмо всё равно
    // обязано уйти: оно зовёт в CRM, а не пересказывает событие.
    const mail = renderWith(
      { ...sourceFor('PROJECT_CONFIRM_REQUIRED'), data: { totally: 'wrong' } },
      locale,
    )
    expect(mail.subject).toBe(
      { uk: 'Проєкт чекає рішення', en: 'Project awaiting decision' }[locale],
    )
    expect(mail.text).toContain(FRONTEND)
  })

  it('тип, которого шаблон не знает, ведёт по сохранённой ссылке и печатает сохранённый заголовок', () => {
    const mail = renderWith(FUTURE_LINK_ONLY, locale)
    // Сохранённый заголовок — ДАННЫЕ, а не каталог: в обеих локалях печатается как есть.
    expect(mail.subject).toBe('Stored legacy title')
    expect(mail.buttonHref).toBe(`${FRONTEND}/finance/invoices/abc`)
  })

  it('тип с неразбираемыми данными говорит, что подробности в CRM', () => {
    const mail = renderWith(
      { ...sourceFor('SHARE_CONFIRM_REQUIRED'), data: { scope: 'WRONG' } },
      locale,
    )
    const want = {
      uk: { line: 'Деталі — у CRM.', button: 'Відповісти на запит' },
      en: { line: 'Details are in the CRM.', button: 'Respond to the request' },
    }[locale]
    // Тип требует действия — кнопка ведёт на `/pending` и называется так же, как у разобравшихся
    // данных: деградирует ТЕКСТ, а не маршрут.
    expect(mail.text).toBe(`${want.line}\n\n${want.button}: ${mail.buttonHref}`)
    expect(mail.buttonHref).toBe(`${FRONTEND}/pending`)
  })

  it('старый тип без сохранённого тела тоже зовёт в CRM', () => {
    const mail = renderWith(FUTURE_LINK_ONLY, locale)
    const want = {
      uk: { line: 'Деталі — у CRM.', button: 'Відкрити' },
      en: { line: 'Details are in the CRM.', button: 'Open' },
    }[locale]
    expect(mail.text).toBe(`${want.line}\n\n${want.button}: ${mail.buttonHref}`)
  })

  it('старый тип с сохранённым телом печатает ЕГО дословно, а не заглушку', () => {
    const mail = renderWith(
      { ...FUTURE_LINK_ONLY, body: 'Stored body of a legacy notification', link: '/vacancies' },
      locale,
    )
    const button = { uk: 'Відкрити', en: 'Open' }[locale]
    expect(mail.text).toBe(`Stored body of a legacy notification\n\n${button}: ${mail.buttonHref}`)
  })

  it('без ссылки кнопка называется «Відкрити CRM» / «Open the CRM»', () => {
    // Подпись «Открыть команду» на кнопке, ведущей в корень, врала бы о том, что откроется.
    const mail = renderWith(
      {
        type: 'VACANCY_APPLICATION',
        title: 'Vacancy application',
        body: null,
        link: null,
        subjectType: null,
        subjectId: null,
        data: null,
      },
      locale,
    )
    expect(mail.buttonLabel).toBe({ uk: 'Відкрити CRM', en: 'Open the CRM' }[locale])
  })

  // `emailAction`'s `subjectType !== null && subjectId !== null` — ни один из тринадцати типов не
  // даёт ЧАСТИЧНО заполненную пару, поэтому оба «частичных» случая конструируются вручную.
  it('subjectType задан, subjectId — нет: кнопка падает на ссылку, не на маршрут объекта', () => {
    const mail = renderWith(
      {
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Title',
        body: null,
        link: '/some/legacy/path',
        subjectType: 'PROJECT',
        subjectId: null,
        data: null,
      },
      locale,
    )
    expect(mail.buttonHref).toBe(`${FRONTEND}/some/legacy/path`)
    expect(mail.buttonLabel).toBe({ uk: 'Відкрити', en: 'Open' }[locale])
  })

  it('subjectId задан, subjectType — нет: кнопка падает на ссылку, не на маршрут объекта', () => {
    const mail = renderWith(
      {
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Title',
        body: null,
        link: '/some/legacy/path',
        subjectType: null,
        subjectId: SUBJECT_ID,
        data: null,
      },
      locale,
    )
    expect(mail.buttonHref).toBe(`${FRONTEND}/some/legacy/path`)
    expect(mail.buttonLabel).toBe({ uk: 'Відкрити', en: 'Open' }[locale])
  })

  // Защитное «Відкрити» в конце `emailActionLabelFor` недостижимо через ЛЮБОЙ из тринадцати типов;
  // тип ВНЕ реестра с заполненным subjectType/subjectId — единственный путь к нему.
  it('тип вне реестра с адресом объекта — общее «Відкрити» / «Open»', () => {
    const mail = renderWith(
      {
        type: 'SOME_FUTURE_TYPE_NOT_IN_REGISTRY',
        title: 'Title',
        body: null,
        link: null,
        subjectType: 'PROJECT',
        subjectId: SUBJECT_ID,
        data: null,
      },
      locale,
    )
    expect(mail.buttonLabel).toBe({ uk: 'Відкрити', en: 'Open' }[locale])
    expect(mail.buttonHref).toBe(`${FRONTEND}/projects/${SUBJECT_ID}`)
  })

  it('адрес берётся из настройки, а не из константы', () => {
    const mail = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://other.example',
      locale,
    })
    expect(mail.buttonHref.startsWith('https://other.example/')).toBe(true)
  })

  it('без ссылки ведёт в корень CRM, а не в никуда', () => {
    const mail = renderWith(
      {
        type: 'VACANCY_APPLICATION',
        title: 'Vacancy application',
        body: null,
        link: null,
        subjectType: null,
        subjectId: null,
        data: null,
      },
      locale,
    )
    expect(mail.buttonHref).toBe(`${FRONTEND}/`)
  })

  it('хвостовой слэш адреса срезается, а адрес без слэша остаётся как есть', () => {
    // Адрес сверяется ЦЕЛИКОМ: «нет двойного слэша» выполняется и для адреса, склеенного как
    // попало, — а ведёт такая ссылка в никуда.
    const withSlash = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://app.cheekycheese.tech/',
      locale,
    })
    const without = renderNotificationEmail(sourceFor('PROJECT_MEMBER_ADDED'), {
      frontendUrl: 'https://app.cheekycheese.tech',
      locale,
    })
    expect(withSlash.buttonHref).toBe(`https://app.cheekycheese.tech/projects/${SUBJECT_ID}`)
    expect(without.buttonHref).toBe(`https://app.cheekycheese.tech/projects/${SUBJECT_ID}`)
  })
})

// ---------------------------------------------------------------------------
// Каркас
// ---------------------------------------------------------------------------

describe('каркас письма (§12: почтовые клиенты — не браузеры)', () => {
  it('двухстрочное письмо собирается ровно так (uk, lang="uk")', () => {
    // Эталон разметки целиком. Дословно — потому что почтовый клиент не прощает ни таблиц без
    // `role="presentation"`, ни `max-width` мимо внешней таблицы. Правка вёрстки обязана падать
    // здесь. Единственное отличие от прежнего эталона — `lang` по локали получателя.
    const mail = render('PROJECT_CONFIRM_REQUIRED', 'uk')
    expect(mail.html).toBe(`<!DOCTYPE html>
<html lang="uk">
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
                Вам пропонують участь у проєкті «${PROJECT}».
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Проєкт не стартує, доки учасники не відповіли.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${mail.buttonHref}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Відповісти на запит</a>
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

  it('en: тот же каркас, lang="en", текст и подпись по-английски', () => {
    const mail = render('PROJECT_CONFIRM_REQUIRED', 'en')
    expect(mail.html).toContain('<html lang="en">')
    expect(mail.html).not.toContain('lang="uk"')
    expect(mail.html).toContain(
      `                You are being offered a place on the project “${PROJECT}”.\n`,
    )
    expect(mail.html).toContain(
      `                The project will not start until the participants respond.\n`,
    )
    expect(mail.html).toContain(`font-weight:bold;">Respond to the request</a>`)
  })

  it.each(LOCALES)(
    '%s: у последней строки отступ больше — она отделяет текст от кнопки',
    (locale) => {
      // Односрочное письмо: единственная строка ОДНОВРЕМЕННО первая и последняя, и отступ у неё
      // обязан быть «последний» (24), а не «первый» (16).
      const mail = render('DOCUMENT_SIGN_REQUIRED', locale)
      expect(mail.html).toContain('margin:0 0 24px 0')
      expect(mail.html).not.toContain('margin:0 0 16px 0')
    },
  )

  it.each(LOCALES)('%s: в двухстрочном письме ровно один «последний» отступ', (locale) => {
    const mail = render('SHARE_CONFIRM_REQUIRED', locale)
    expect(mail.html.match(/margin:0 0 24px 0/g)).toHaveLength(1)
    expect(mail.html.match(/margin:0 0 16px 0/g)).toHaveLength(1)
  })
})

describe.each(LOCALES)('%s: подстановка в разметку обезврежена', (locale) => {
  it('имя объекта с угловыми скобками не становится разметкой', () => {
    // Тип выбран тот, у которого имя проекта попадает В ТЕЛО письма.
    const mail = renderWith(
      {
        ...sourceFor('PROJECT_CONFIRM_REQUIRED'),
        data: {
          projectName: '<script>alert("x")</script>',
          approvalId: '11111111-1111-4111-8111-111111111111',
        },
      },
      locale,
    )
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
    // Тема письма — не HTML, экранировать её нельзя: почтовый клиент покажет «&lt;» буквально.
    expect(mail.subject).toContain('<script>')
  })

  it('перевод строки в имени объекта не разрывает тему', () => {
    // SR-M-1: тема уезжает в заголовок письма, а `projectName` приходит из ввода, где
    // `z.string().max(255)` перевод строки разрешает.
    const mail = renderWith(
      {
        ...sourceFor('PROJECT_CONFIRM_REQUIRED'),
        data: {
          projectName: 'Bank\r\nBcc: attacker@example.com',
          approvalId: '11111111-1111-4111-8111-111111111111',
        },
      },
      locale,
    )
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject).toBe(
      {
        uk: 'Запит на додавання проєкту «Bank Bcc: attacker@example.com»',
        en: 'Request to add the project “Bank Bcc: attacker@example.com”',
      }[locale],
    )
  })

  it('кавычки и апостроф в имени объекта доезжают как данные, без артефактов ICU', () => {
    const mail = renderWith(
      {
        ...sourceFor('TEAM_MEMBER_ADDED'),
        data: { teamName: "O'Brien {x} 'quoted'" },
      },
      locale,
    )
    expect(mail.subject).toBe(
      {
        uk: "Вас додали до команди «O'Brien {x} 'quoted'»",
        en: "You were added to the team “O'Brien {x} 'quoted'”",
      }[locale],
    )
  })
})

// ---------------------------------------------------------------------------
// Изоляция локали: per-call, никакого глобального состояния
// ---------------------------------------------------------------------------

describe('изоляция локали между вызовами', () => {
  it('чередование en/uk/en/uk на одном источнике — каждый вызов говорит на своём языке', () => {
    const source = sourceFor('TEAM_MEMBER_ADDED')
    const subjects = (['en', 'uk', 'en', 'uk'] as const).map(
      (locale) => renderWith(source, locale).subject,
    )
    expect(subjects).toEqual([
      'You were added to the team “Platform Core”',
      'Вас додали до команди «Platform Core»',
      'You were added to the team “Platform Core”',
      'Вас додали до команди «Platform Core»',
    ])
  })

  it('глобальный синглтон @lingui/core не трогается (никакого i18n.activate на сервере)', () => {
    const before = globalI18n.locale
    renderWith(sourceFor('TEAM_MEMBER_ADDED'), 'en')
    renderWith(sourceFor('TEAM_MEMBER_ADDED'), 'uk')
    expect(globalI18n.locale).toBe(before)
  })

  it('вызов без locale не компилируется (locale обязателен, дефолта нет)', () => {
    // Забытый вызывающий обязан упасть на typecheck, а не молча отправить `uk`. Если требование
    // уберут, `@ts-expect-error` окажется ненужным, и `tsc` сам провалит файл.
    const call = () =>
      // @ts-expect-error — `locale` обязателен в RenderOptions
      renderNotificationEmail(sourceFor('TEAM_MEMBER_ADDED'), { frontendUrl: FRONTEND })
    expect(typeof call).toBe('function')
  })
})
