import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  NOTIFICATION_TITLES,
  describeNotification,
  notificationActions,
  notificationDataSchemaFor,
  notificationSubjectTypeSchema,
  notificationTextPreview,
  renderNotification,
} from './notification-registry'
import { notificationTypeSchema } from './notifications'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-09-07T10:00:00.000Z'

const base = {
  id: uuid,
  title: 'Сохранённый заголовок',
  body: null,
  link: null,
  readAt: null,
  createdAt: datetime,
  subjectType: null,
  subjectId: null,
  secondaryId: null,
  data: null,
  subjectMissing: false,
}

describe('десять типов — реестр', () => {
  it('enum несёт ровно десять новых типов поверх трёх старых', () => {
    expect(notificationTypeSchema.options).toEqual([
      'INVOICE_SIGN_REQUIRED',
      'INVOICE_SIGNED',
      'VACANCY_APPLICATION',
      'TRANSACTION_ADDED',
      'TRANSACTION_STATUS_CHANGED',
      'TEAM_MEMBER_ADDED',
      'PROJECT_MEMBER_ADDED',
      'TEAM_NEW_MEMBER',
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
      'APPROVAL_CONFIRMED',
      'APPROVAL_REJECTED',
    ])
  })

  it('у каждого из десяти есть заголовок без точки на конце', () => {
    const titles = Object.entries(NOTIFICATION_TITLES)
    expect(titles).toHaveLength(10)
    for (const [type, title] of titles) {
      expect(title.length, type).toBeGreaterThan(0)
      expect(title.endsWith('.'), type).toBe(false)
    }
  })

  it('три типа, требующие действия, названы одним семейством «Ждёт решения»', () => {
    expect([...ACTION_REQUIRED_NOTIFICATION_TYPES]).toEqual([
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ])
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TITLES[type].startsWith('Ждёт решения:'), type).toBe(true)
    }
  })

  it('subjectType — закрытый набор', () => {
    expect(notificationSubjectTypeSchema.options).toEqual([
      'PROJECT',
      'TEAM',
      'USER',
      'TRANSACTION',
      'EMPLOYEE_CONTRACT',
    ])
  })
})

describe('describeNotification — подробности из данных, не из базы', () => {
  it('доля по проекту: 26% → 30%', () => {
    const data = notificationDataSchemaFor('SHARE_CONFIRM_REQUIRED').parse({
      scope: 'PROJECT',
      projectName: 'Acme',
      previousPercent: 26,
      proposedPercent: 30,
    })
    expect(describeNotification('SHARE_CONFIRM_REQUIRED', data)).toBe('Проект Acme: 26% → 30%')
  })

  it('отклонение несёт причину', () => {
    const data = notificationDataSchemaFor('APPROVAL_REJECTED').parse({
      approverName: 'Иван Петров',
      subjectTitle: 'Acme',
      subjectKind: 'PROJECT',
      reasonPreview: 'Доля не та',
    })
    expect(describeNotification('APPROVAL_REJECTED', data)).toBe(
      'Иван Петров — проект Acme: Доля не та',
    )
  })
})

describe('renderNotification — клиент выводит подписи и кнопки по типу', () => {
  it('известный тип: заголовок и кнопка выведены, сохранённый заголовок не используется', () => {
    const rendered = renderNotification({
      ...base,
      type: 'PROJECT_CONFIRM_REQUIRED',
      subjectType: 'PROJECT',
      subjectId: uuid,
      data: { projectName: 'Acme' },
    })
    expect(rendered.title).toBe('Ждёт решения: новый проект')
    expect(rendered.detail).toBe('Проект Acme')
    expect(rendered.actions).toEqual([
      { label: 'Открыть проект', href: `/projects/${uuid}`, disabled: false },
    ])
  })

  it('неизвестный тип не роняет попап — общий вид по сохранённому заголовку', () => {
    const rendered = renderNotification({
      ...base,
      type: 'SOMETHING_FROM_THE_FUTURE' as never,
      title: 'Что-то случилось',
      link: '/finance',
    })
    expect(rendered.title).toBe('Что-то случилось')
    expect(rendered.actions).toEqual([{ label: 'Открыть', href: '/finance', disabled: false }])
  })

  it('битые данные известного типа тоже дают общий вид, а не исключение', () => {
    const rendered = renderNotification({
      ...base,
      type: 'PROJECT_MEMBER_ADDED',
      subjectType: 'PROJECT',
      subjectId: uuid,
      data: { projectName: 42 },
      title: 'Вас добавили в проект',
    })
    expect(rendered.title).toBe('Вас добавили в проект')
    expect(rendered.detail).toBeNull()
  })

  it('объект исчез — кнопка честно говорит об этом и никуда не ведёт', () => {
    const rendered = renderNotification({
      ...base,
      type: 'PROJECT_MEMBER_ADDED',
      subjectType: 'PROJECT',
      subjectId: uuid,
      data: { projectName: 'Acme' },
      subjectMissing: true,
    })
    expect(rendered.actions).toEqual([{ label: 'Объекта больше нет', href: null, disabled: true }])
  })
})

describe('notificationActions — маршрут выводится из subjectType', () => {
  it.each([
    ['PROJECT', `/projects/${uuid}`],
    ['TEAM', `/team/${uuid}`],
    ['USER', `/profile/${uuid}`],
    ['TRANSACTION', '/finance'],
    ['EMPLOYEE_CONTRACT', '/onboarding'],
  ] as const)('%s → %s', (subjectType, href) => {
    const actions = notificationActions({
      ...base,
      type: 'APPROVAL_CONFIRMED',
      subjectType,
      subjectId: uuid,
      data: { approverName: 'И', subjectTitle: 'A', subjectKind: 'PROJECT' },
    })
    expect(actions[0]?.href).toBe(href)
  })
})

describe('describeNotification — все ветки, чтобы гейт мутаций видел каждую', () => {
  it.each([
    [
      'TRANSACTION_ADDED',
      { amount: '1200.00', currency: 'USD', projectName: 'Acme' },
      'Проект Acme: 1200.00 USD',
    ],
    ['TRANSACTION_ADDED', { amount: '1200.00', currency: 'USD', projectName: null }, '1200.00 USD'],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'VALIDATED', rejectionReasonPreview: null },
      'Доход валидирован: 10.00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReasonPreview: null },
      'Доход отклонён: 10.00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReasonPreview: 'Нет чека' },
      'Доход отклонён: 10.00 USD — Нет чека',
    ],
    ['TEAM_MEMBER_ADDED', { teamName: 'Alpha' }, 'Команда Alpha'],
    ['PROJECT_MEMBER_ADDED', { projectName: 'Acme' }, 'Проект Acme'],
    ['TEAM_NEW_MEMBER', { teamName: 'Alpha', memberName: 'Иван' }, 'Alpha: Иван'],
    ['PROJECT_CONFIRM_REQUIRED', { projectName: 'Acme' }, 'Проект Acme'],
    [
      'SHARE_CONFIRM_REQUIRED',
      { scope: 'BASE', projectName: null, previousPercent: null, proposedPercent: 30 },
      'Базовая доля: по умолчанию → 30%',
    ],
    [
      'SHARE_CONFIRM_REQUIRED',
      { scope: 'PROJECT', projectName: null, previousPercent: 26, proposedPercent: null },
      'Проект без названия: 26% → по умолчанию',
    ],
    ['DOCUMENT_SIGN_REQUIRED', { documentTitle: 'Договор с сотрудником' }, 'Договор с сотрудником'],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'BASE_SHARE', subjectTitle: null },
      'Иван — базовая доля',
    ],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'PROJECT_SHARE', subjectTitle: 'Acme' },
      'Иван — доля по проекту Acme',
    ],
    [
      'APPROVAL_CONFIRMED',
      { approverName: 'Иван', subjectKind: 'PROJECT', subjectTitle: null },
      'Иван — проект без названия',
    ],
  ] as const)('%s', (type, raw, expected) => {
    const data = notificationDataSchemaFor(type).parse(raw)
    expect(describeNotification(type, data as never)).toBe(expected)
  })
})

describe('подписи кнопок — по одной на тип, и каждая проверена', () => {
  // Гейт мутаций 2026-09-07: девять подписей из десяти пережили замену на
  // пустую строку. Тест «кнопка появилась» ничего не говорит о том, ЧТО на ней
  // написано, а подпись — это текст для сотрудника, то есть предмет ревью
  // текста ровно так же, как заголовок.
  it.each([
    ['TRANSACTION_ADDED', 'TRANSACTION', 'К транзакциям'],
    ['TRANSACTION_STATUS_CHANGED', 'TRANSACTION', 'К транзакциям'],
    ['TEAM_MEMBER_ADDED', 'TEAM', 'Открыть команду'],
    ['TEAM_NEW_MEMBER', 'TEAM', 'Открыть команду'],
    ['PROJECT_MEMBER_ADDED', 'PROJECT', 'Открыть проект'],
    ['PROJECT_CONFIRM_REQUIRED', 'PROJECT', 'Открыть проект'],
    ['SHARE_CONFIRM_REQUIRED', 'PROJECT', 'Посмотреть и подтвердить'],
    ['DOCUMENT_SIGN_REQUIRED', 'EMPLOYEE_CONTRACT', 'Подписать'],
    ['APPROVAL_CONFIRMED', 'PROJECT', 'Открыть'],
    ['APPROVAL_REJECTED', 'PROJECT', 'Открыть'],
  ] as const)('%s → «%s»', (type, subjectType, label) => {
    const actions = notificationActions({
      ...base,
      type,
      subjectType,
      subjectId: uuid,
      data: null,
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]?.label).toBe(label)
  })
})

describe('subjectKind — обе формы согласования знают все три вида', () => {
  it.each(['APPROVAL_CONFIRMED', 'APPROVAL_REJECTED'] as const)('%s', (type) => {
    for (const subjectKind of ['PROJECT', 'PROJECT_SHARE', 'BASE_SHARE'] as const) {
      const raw = {
        approverName: 'Иван',
        subjectKind,
        subjectTitle: 'Acme',
        ...(type === 'APPROVAL_REJECTED' ? { reasonPreview: 'Причина' } : {}),
      }
      expect(() => notificationDataSchemaFor(type).parse(raw)).not.toThrow()
    }
    const bad = {
      approverName: 'Иван',
      subjectKind: 'SOMETHING_ELSE',
      subjectTitle: 'Acme',
      reasonPreview: 'Причина',
    }
    expect(() => notificationDataSchemaFor(type).parse(bad)).toThrow()
  })
})

describe('notificationActions — крайние случаи', () => {
  // Три условия в одном `if` — три отдельных случая. Гейт мутаций показал, что
  // без них любое из трёх можно заменить на `true` незаметно.
  it('известный тип БЕЗ вида объекта, но с идентификатором — общий путь', () => {
    expect(
      notificationActions({
        ...base,
        type: 'PROJECT_MEMBER_ADDED',
        subjectType: null,
        subjectId: uuid,
        data: { projectName: 'Acme' },
        link: '/projects',
      }),
    ).toEqual([{ label: 'Открыть', href: '/projects', disabled: false }])
  })

  it('известный тип С видом объекта, но БЕЗ идентификатора — общий путь', () => {
    expect(
      notificationActions({
        ...base,
        type: 'PROJECT_MEMBER_ADDED',
        subjectType: 'PROJECT',
        subjectId: null,
        data: { projectName: 'Acme' },
        link: '/projects',
      }),
    ).toEqual([{ label: 'Открыть', href: '/projects', disabled: false }])
  })

  it('НЕизвестный тип с полным адресом объекта всё равно идёт общим путём', () => {
    expect(
      notificationActions({
        ...base,
        type: 'SOMETHING_FROM_THE_FUTURE' as never,
        subjectType: 'PROJECT',
        subjectId: uuid,
        data: null,
        link: '/finance',
      }),
    ).toEqual([{ label: 'Открыть', href: '/finance', disabled: false }])
  })

  it('известный тип без идентификатора объекта и без ссылки не даёт кнопок', () => {
    expect(notificationActions({ ...base, type: 'TEAM_MEMBER_ADDED', data: null })).toEqual([])
  })

  it('известный тип без идентификатора объекта падает на сохранённую ссылку', () => {
    expect(
      notificationActions({ ...base, type: 'TEAM_MEMBER_ADDED', data: null, link: '/team' }),
    ).toEqual([{ label: 'Открыть', href: '/team', disabled: false }])
  })

  it('исчезнувший объект гасит кнопку даже у типа со ссылкой', () => {
    expect(
      notificationActions({
        ...base,
        type: 'TEAM_MEMBER_ADDED',
        subjectType: 'TEAM',
        subjectId: uuid,
        data: { teamName: 'Alpha' },
        subjectMissing: true,
      }),
    ).toEqual([{ label: 'Объекта больше нет', href: null, disabled: true }])
  })
})

/**
 * CR-M-1 (код-ревью PR #664, круг 1). Одиннадцатый тип обязан ломать сборку в
 * `describeNotification`, а не рендерить данные чужой формы.
 *
 * Сама проверка исчерпанности — свойство КОМПИЛЯЦИИ (`const _: never = type`),
 * и тестом её не увидеть: если она работает, программа с одиннадцатым типом не
 * собирается. Тест закрепляет вторую половину — что будет, если компилятор
 * всё-таки обманули (приведение типа, данные из чужого бандла, вызов из JS):
 * громкий отказ с НАЗВАНИЕМ типа в сообщении, а не тихая чужая форма.
 */
describe('CR-M-1 — неописанный тип не проваливается в чужую форму', () => {
  it('падает с названием типа, а не показывает поля отказа', () => {
    expect(() => describeNotification('SOMETHING_FROM_THE_FUTURE' as never, {} as never)).toThrow(
      /неописанный тип уведомления SOMETHING_FROM_THE_FUTURE/,
    )
  })
})

/**
 * SR-H-1 (security-review PR #664, круг 1). Потолок разбора данных был уже
 * потолка записи: имя объекта `max(200)` против колонок `varchar(255)`,
 * причина отказа `max(1000)` в записи против входной схемы, у которой на
 * момент находки верхней границы не было вовсе. Производитель при этом сидит
 * ВНУТРИ транзакции события — значит легальное длинное значение отменяло
 * само событие.
 *
 * Здесь проверяется первая половина исправления: потолки сведены с сущностями,
 * а полный текст причины в уведомление не кладётся вовсе (§10 — уведомление
 * несёт суть и ссылку, причину читают в CRM).
 */
describe('SR-H-1 — потолки формы совпадают с потолками записи', () => {
  it('имя объекта в 255 символов — ровно колонка varchar(255) — форму проходит', () => {
    const name = 'я'.repeat(255)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).not.toThrow()
    expect(() =>
      notificationDataSchemaFor('TEAM_MEMBER_ADDED').parse({ teamName: name }),
    ).not.toThrow()
    expect(() =>
      notificationDataSchemaFor('TEAM_NEW_MEMBER').parse({ teamName: name, memberName: name }),
    ).not.toThrow()
  })

  it('имя длиннее колонки (256) форму не проходит — потолок остаётся потолком', () => {
    const tooLong = 'я'.repeat(256)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: tooLong }),
    ).toThrow()
  })

  it('превью ровно в 200 символов остаётся собой — ни усечения, ни многоточия', () => {
    const exact = 'я'.repeat(200)
    expect(notificationTextPreview(exact)).toBe(exact)
  })

  it('201 символ усекается ровно до 200 — последний символ многоточие', () => {
    const preview = notificationTextPreview('я'.repeat(201))
    expect(preview).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.slice(0, 199)).toBe('я'.repeat(199))
  })

  it('пять тысяч символов тоже сводятся к двумстам', () => {
    expect(notificationTextPreview('я'.repeat(5000))).toHaveLength(200)
  })

  /**
   * SR-M-3 (security-review круг 2). Длина мерялась в 16-битных единицах, а
   * усечение шло `slice` — по ним же. Эмодзи на позициях 198–199 оставляло на
   * срезе ОДИНОКИЙ СУРРОГАТ: форму такая строка проходила (ровно 200 единиц),
   * а Postgres отвергал её уже на `INSERT` в `jsonb`. То есть длина текста,
   * написанного человеком, снова решала судьбу события — в обход `refuse()`.
   *
   * `encodeURIComponent` бросает `URIError` ровно на одиноком суррогате — это
   * та же проверка, что `String.prototype.isWellFormed()`, но без зависимости
   * от версии lib в tsconfig.
   */
  it('эмодзи на границе не разрывается — превью остаётся корректной строкой', () => {
    const withEmojiOnBoundary = `${'a'.repeat(198)}😀${'b'.repeat(50)}`
    const preview = notificationTextPreview(withEmojiOnBoundary)

    expect(() => encodeURIComponent(preview)).not.toThrow()
    // Ровно потолок — но в СИМВОЛАХ, как их считает и колонка, и Postgres.
    expect(Array.from(preview)).toHaveLength(200)
    expect(preview.endsWith('…')).toBe(true)
    // Эмодзи доехало ЦЕЛИКОМ: 198 букв + оно = 199 символов, ровно потолок
    // без многоточия. Половины от него не осталось — старый `slice` по
    // единицам оставлял здесь один старший суррогат.
    expect(preview).toContain('😀')
  })

  it('двести эмодзи — это двести символов, а не четыреста: превью не трогает их', () => {
    const exact = '😀'.repeat(200)
    expect(notificationTextPreview(exact)).toBe(exact)
  })

  it('двести один эмодзи усекается до двухсот СИМВОЛОВ', () => {
    const preview = notificationTextPreview('😀'.repeat(201))
    expect(Array.from(preview)).toHaveLength(200)
    expect(Array.from(preview).slice(0, 199).join('')).toBe('😀'.repeat(199))
    expect(preview.endsWith('…')).toBe(true)
    expect(() => encodeURIComponent(preview)).not.toThrow()
  })

  it('превью из эмодзи ровно по потолку форму проходит — мерка у формы та же', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    expect(() =>
      schema.parse({
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: '😀'.repeat(200),
      }),
    ).not.toThrow()
  })

  it('превью на символ длиннее потолка форму не проходит', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    expect(() =>
      schema.parse({
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: '😀'.repeat(201),
      }),
    ).toThrow()
  })

  /**
   * SR-M-3(б): потолок имени выводится из КОЛОНКИ (`varchar(255)`), а колонка
   * считает символы. Имя из 255 эмодзи в базу влезает — значит, и в форму
   * обязано: иначе легальное имя молча пропускало бы уведомление с ERROR в
   * журнале.
   */
  it('имя из 255 эмодзи форму проходит — колонка их принимает', () => {
    const name = '😀'.repeat(255)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).not.toThrow()
  })

  it('имя из 256 эмодзи форму не проходит — потолок остаётся потолком', () => {
    const name = '😀'.repeat(256)
    expect(() =>
      notificationDataSchemaFor('PROJECT_MEMBER_ADDED').parse({ projectName: name }),
    ).toThrow()
  })

  it('обрамляющие пробелы снимаются до подсчёта длины', () => {
    expect(notificationTextPreview('  причина  ')).toBe('причина')
    expect(notificationTextPreview(`  ${'я'.repeat(200)}  `)).toBe('я'.repeat(200))
  })

  it('текст из одних пробелов даёт пустую строку — производителю это «без причины»', () => {
    expect(notificationTextPreview('   ')).toBe('')
  })

  it('«сотрудник отклонил» принимает превью и его отсутствие, но не полный текст', () => {
    const schema = notificationDataSchemaFor('APPROVAL_REJECTED')
    const withReason = { approverName: 'Иван', subjectKind: 'PROJECT', subjectTitle: 'Acme' }
    expect(() => schema.parse({ ...withReason, reasonPreview: 'Доля не та' })).not.toThrow()
    expect(() => schema.parse({ ...withReason, reasonPreview: null })).not.toThrow()
    expect(() => schema.parse({ ...withReason, reasonPreview: 'я'.repeat(201) })).toThrow()
  })

  it('«статус транзакции изменился» несёт превью причины, не полный текст', () => {
    const schema = notificationDataSchemaFor('TRANSACTION_STATUS_CHANGED')
    const rejected = { amount: '10.00', currency: 'USD', status: 'REJECTED' }
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: 'Нет чека' })).not.toThrow()
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: null })).not.toThrow()
    expect(() => schema.parse({ ...rejected, rejectionReasonPreview: 'я'.repeat(201) })).toThrow()
  })

  it('отказ без причины описывается без обрыва строки', () => {
    expect(
      describeNotification('APPROVAL_REJECTED', {
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: null,
      }),
    ).toBe('Иван — проект Acme')
  })

  it('отказ с превью причины дописывает её после двоеточия', () => {
    expect(
      describeNotification('APPROVAL_REJECTED', {
        approverName: 'Иван',
        subjectKind: 'PROJECT',
        subjectTitle: 'Acme',
        reasonPreview: 'Доля не та',
      }),
    ).toBe('Иван — проект Acme: Доля не та')
  })
})
