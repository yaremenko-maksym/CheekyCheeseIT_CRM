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
