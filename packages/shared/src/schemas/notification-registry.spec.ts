import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  NOTIFICATION_TITLES,
  describeNotification,
  notificationActions,
  notificationDataSchemaFor,
  notificationSubjectTypeSchema,
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
      reason: 'Доля не та',
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
      { amount: '10.00', currency: 'USD', status: 'VALIDATED', rejectionReason: null },
      'Проверена: 10.00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReason: null },
      'Отклонена: 10.00 USD',
    ],
    [
      'TRANSACTION_STATUS_CHANGED',
      { amount: '10.00', currency: 'USD', status: 'REJECTED', rejectionReason: 'Нет чека' },
      'Отклонена: 10.00 USD — Нет чека',
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
        ...(type === 'APPROVAL_REJECTED' ? { reason: 'Причина' } : {}),
      }
      expect(() => notificationDataSchemaFor(type).parse(raw)).not.toThrow()
    }
    const bad = {
      approverName: 'Иван',
      subjectKind: 'SOMETHING_ELSE',
      subjectTitle: 'Acme',
      reason: 'Причина',
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
