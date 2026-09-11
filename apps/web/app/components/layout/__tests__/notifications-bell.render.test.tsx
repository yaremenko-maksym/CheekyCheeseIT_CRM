/**
 * task-notification-types-producers (позиция 6) — попап колокольчика рисует
 * строку ПО ТИПУ (§7.1), а не по сохранённому тексту.
 *
 * Три утверждения, ради которых этот файл существует:
 *   1. известный тип показывает выведенные заголовок, подробности и подпись
 *      кнопки — сохранённый заголовок при этом не используется;
 *   2. неизвестный тип не роняет попап, а показывается общим видом (AC2 —
 *      то же семейство, что `searchSchema` на странице входа);
 *   3. исчезнувший объект честно говорит об этом и никуда не ведёт (AC6).
 *
 * Хуки данных замоканы: проверяется рендер, а не сеть.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Notification } from '@crm/shared'
import { NotificationsBell } from '../notifications-bell'

const mockNavigate = vi.fn()
let items: Notification[] = []

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/hooks/use-notifications-api', () => ({
  useNotificationsList: () => ({ data: { items, unreadCount: 0 }, isLoading: false }),
  useMarkNotificationRead: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNotification: () => ({ mutate: vi.fn(), isPending: false }),
}))

const UUID = '11111111-2222-4333-8444-555555555555'

function makeNotification(over: Partial<Notification>): Notification {
  return {
    id: UUID,
    type: 'PROJECT_MEMBER_ADDED',
    title: 'Сохранённый заголовок',
    body: null,
    link: null,
    readAt: null,
    createdAt: '2026-09-07T10:00:00.000Z',
    subjectType: 'PROJECT',
    subjectId: UUID,
    secondaryId: null,
    data: { projectName: 'Acme' },
    subjectMissing: false,
    ...over,
  } as Notification
}

async function openBell() {
  render(<NotificationsBell />)
  await userEvent.click(screen.getByTestId('notifications-bell-trigger'))
}

beforeEach(() => {
  mockNavigate.mockClear()
})

describe('попап рисует строку по типу', () => {
  it('известный тип: заголовок, подробности и подпись кнопки выведены', async () => {
    items = [makeNotification({})]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-title`)).toHaveTextContent(
      'Вас добавили в проект',
    )
    expect(screen.getByTestId(`notification-item-${UUID}-detail`)).toHaveTextContent('Проект Acme')
    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Открыть проект',
    )
    expect(screen.queryByText('Сохранённый заголовок')).toBeNull()
  })

  it('клик ведёт по адресу, выведенному из типа и объекта', async () => {
    items = [makeNotification({})]
    await openBell()
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))

    expect(mockNavigate).toHaveBeenCalledWith({ to: `/projects/${UUID}` })
  })

  it('неизвестный тип не роняет попап — общий вид по сохранённому заголовку', async () => {
    items = [
      makeNotification({
        type: 'SOMETHING_FROM_THE_FUTURE' as Notification['type'],
        title: 'Что-то случилось',
        subjectType: null,
        subjectId: null,
        data: null,
        link: '/finance',
      }),
    ]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-title`)).toHaveTextContent(
      'Что-то случилось',
    )
    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent('Открыть')
  })

  it('исчезнувший объект: честная подпись и никакого перехода', async () => {
    items = [makeNotification({ subjectMissing: true })]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Объекта больше нет',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('старый тип со ссылкой `/crm/...` по-прежнему ведёт в корень', async () => {
    items = [
      makeNotification({
        type: 'INVOICE_SIGN_REQUIRED',
        title: 'Инвойс ожидает вашей подписи',
        subjectType: null,
        subjectId: null,
        data: null,
        link: '/crm/documents?category=INVOICE',
      }),
    ]
    await openBell()
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/documents?category=INVOICE' })
  })
})

// ---------------------------------------------------------------------------
// Значок узнаётся до чтения (AC2)
// ---------------------------------------------------------------------------

/**
 * Значок — единственная часть строки, которую клиент выбирает НЕ по реестру
 * подписей, поэтому и проверяется отдельно от текста.
 *
 * Проверяются ДВА независимых признака, и оба обязательны. Оттенок — то, по
 * чему человек узнаёт класс события боковым зрением. Фигура (`lucide-*`
 * в списке классов) — то, чем «команда» отличается от «проекта»: они делят
 * оттенок, и одного оттенка не хватает, чтобы заметить, что ветка `switch`
 * провалилась в соседнюю. Токены сравниваются целиком, а не подстрокой:
 * `lucide-circle` — начало `lucide-circle-alert`.
 */
function iconTokensOf(id: string): string[] {
  const svg = screen.getByTestId(`notification-item-${id}-open`).querySelector('svg')
  return (svg?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

describe('значок выбирается по типу', () => {
  const cases: [Notification['type'], string, string][] = [
    ['INVOICE_SIGN_REQUIRED', 'text-amber-300', 'lucide-file-pen-line'],
    ['INVOICE_SIGNED', 'text-emerald-300', 'lucide-file-pen-line'],
    ['TRANSACTION_ADDED', 'text-sky-300', 'lucide-wallet'],
    ['TRANSACTION_STATUS_CHANGED', 'text-sky-300', 'lucide-wallet'],
    ['TEAM_MEMBER_ADDED', 'text-violet-300', 'lucide-users'],
    ['TEAM_NEW_MEMBER', 'text-violet-300', 'lucide-users'],
    ['PROJECT_MEMBER_ADDED', 'text-violet-300', 'lucide-folder-plus'],
    ['PROJECT_CONFIRM_REQUIRED', 'text-amber-300', 'lucide-circle-alert'],
    ['SHARE_CONFIRM_REQUIRED', 'text-amber-300', 'lucide-circle-alert'],
    ['DOCUMENT_SIGN_REQUIRED', 'text-amber-300', 'lucide-circle-alert'],
    ['APPROVAL_CONFIRMED', 'text-emerald-300', 'lucide-circle-check'],
    ['APPROVAL_REJECTED', 'text-rose-300', 'lucide-circle-x'],
  ]

  it.each(cases)('%s → %s %s', async (type, tint, shape) => {
    items = [makeNotification({ type, data: null })]
    await openBell()

    const tokens = iconTokensOf(UUID)
    expect(tokens).toContain(tint)
    expect(tokens).toContain(shape)
  })

  it('неизвестный тип получает нейтральный кружок, а не пустое место', async () => {
    items = [
      makeNotification({ type: 'SOMETHING_FROM_THE_FUTURE' as Notification['type'], data: null }),
    ]
    await openBell()

    const tokens = iconTokensOf(UUID)
    expect(tokens).toContain('text-muted-foreground/60')
    expect(tokens).toContain('lucide-circle')
  })
})

// ---------------------------------------------------------------------------
// Прочитанность видна глазом (регресс #620 — строка не должна «схлопываться»)
// ---------------------------------------------------------------------------

describe('непрочитанное отличается от прочитанного', () => {
  it('непрочитанное: подсветка строки, жирный заголовок и точка', async () => {
    items = [makeNotification({ readAt: null })]
    await openBell()

    const row = screen.getByTestId(`notification-item-${UUID}`)
    expect(row.className).toContain('bg-primary/5')
    expect(row.className).toContain('group/notif')
    expect(screen.getByTestId(`notification-item-${UUID}-title`).className).toContain('font-medium')
    expect(screen.getByTestId(`notification-item-${UUID}-title`).className).toContain('truncate')
    expect(row.querySelectorAll('span.rounded-full.bg-primary')).toHaveLength(1)
  })

  it('прочитанное: ни подсветки, ни точки', async () => {
    items = [makeNotification({ readAt: '2026-09-07T11:00:00.000Z' })]
    await openBell()

    const row = screen.getByTestId(`notification-item-${UUID}`)
    expect(row.className).not.toContain('bg-primary/5')
    expect(screen.getByTestId(`notification-item-${UUID}-title`).className).toContain(
      'text-muted-foreground',
    )
    expect(row.querySelectorAll('span.rounded-full.bg-primary')).toHaveLength(0)
  })

  it('у строки есть кнопка удаления со своим адресом', async () => {
    items = [makeNotification({})]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-delete`)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Подпись кнопки: живая ведёт, мёртвая не зовёт (§7.4)
// ---------------------------------------------------------------------------

describe('подпись кнопки отличает живой объект от исчезнувшего', () => {
  it('живой объект: подпись выделена цветом действия', async () => {
    items = [makeNotification({})]
    await openBell()

    const action = screen.getByTestId(`notification-item-${UUID}-action`)
    expect(action.className).toContain('text-primary')
    expect(action.className).toContain('wrap-anywhere')
  })

  it('исчезнувший объект: подпись приглушена, а не выделена', async () => {
    items = [makeNotification({ subjectMissing: true })]
    await openBell()

    const action = screen.getByTestId(`notification-item-${UUID}-action`)
    expect(action.className).toContain('text-muted-foreground/60')
    expect(action.className).not.toContain('text-primary')
  })

  it('уведомление совсем без действия: подписи нет и клик никуда не ведёт', async () => {
    // Ни новый тип (чтобы адрес не вывелся из объекта), ни сохранённая
    // ссылка — реестр честно возвращает пустой список действий. Клик по такой
    // строке обязан пройти без исключения: строка остаётся кликабельной, а
    // вести ей некуда.
    items = [
      makeNotification({
        type: 'SOMETHING_FROM_THE_FUTURE' as Notification['type'],
        subjectType: null,
        subjectId: null,
        data: null,
        link: null,
      }),
    ]
    await openBell()

    expect(screen.queryByTestId(`notification-item-${UUID}-action`)).toBeNull()
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Старые адреса (`/crm/*`) — граница каждого условия
// ---------------------------------------------------------------------------

/** Кликает по единственной строке с сохранённой ссылкой и возвращает адрес перехода. */
async function navigateTargetFor(link: string): Promise<unknown> {
  items = [
    makeNotification({
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ожидает вашей подписи',
      subjectType: null,
      subjectId: null,
      data: null,
      link,
    }),
  ]
  await openBell()
  await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
  return mockNavigate.mock.calls[0]?.[0]
}

describe('сохранённые адреса времён префикса /crm', () => {
  it('ровно «/crm» ведёт в корень, а не в пустую строку', async () => {
    expect(await navigateTargetFor('/crm')).toEqual({ to: '/' })
  })

  it('старый путь до инвойса разворачивается в документы с открытой транзакцией', async () => {
    expect(await navigateTargetFor(`/crm/finance/invoices/${UUID}`)).toEqual({
      to: `/documents?category=INVOICE&openTx=${UUID}`,
    })
  })

  it('тот же путь НЕ в начале строки инвойсом не считается', async () => {
    // Якорь `^`: иначе чужой адрес, внутри которого случайно встретился наш
    // старый путь, увёл бы человека в документы по чужому идентификатору.
    const link = `/external/crm/finance/invoices/${UUID}`
    expect(await navigateTargetFor(link)).toEqual({ to: link })
  })

  it('хвост после идентификатора инвойсом не считается', async () => {
    // Якорь `$`. Ссылка остаётся старой `/crm/*`, поэтому префикс всё же
    // снимается — но идентификатор из неё не выдёргивается.
    expect(await navigateTargetFor(`/crm/finance/invoices/${UUID}/print`)).toEqual({
      to: `/finance/invoices/${UUID}/print`,
    })
  })

  it('огрызок вместо идентификатора инвойсом не считается', async () => {
    // Длина ровно 36 символов: один символ того же алфавита — не идентификатор.
    expect(await navigateTargetFor('/crm/finance/invoices/a')).toEqual({
      to: '/finance/invoices/a',
    })
  })
})
