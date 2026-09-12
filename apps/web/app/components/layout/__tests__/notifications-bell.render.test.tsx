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
const mockDelete = vi.fn()
let items: Notification[] = []

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/hooks/use-notifications-api', () => ({
  useNotificationsList: () => ({ data: { items, unreadCount: 0 }, isLoading: false }),
  useMarkNotificationRead: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNotification: () => ({ mutate: mockDelete, isPending: false }),
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
    subjectArchived: false,
    approvalSuperseded: false,
    approvalDecided: false,
    ...over,
  } as Notification
}

async function openBell() {
  render(<NotificationsBell />)
  await userEvent.click(screen.getByTestId('notifications-bell-trigger'))
}

beforeEach(() => {
  mockNavigate.mockClear()
  mockDelete.mockClear()
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

  // COPY-M-4 (copy-review круг 1, #664): вид объекта уже известен в момент
  // показа («Объекта больше нет» — слово из спеки, не из интерфейса CRM).
  it('исчезнувший объект: честная подпись называет ЕГО ВИД, перехода нет', async () => {
    items = [makeNotification({ subjectMissing: true })]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Проект удалён',
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
// QA-M-1 (manual-qa круг 1, #664) — деградация после подписи, на уровне рендера
// ---------------------------------------------------------------------------

describe('DOCUMENT_SIGN_REQUIRED — честная деградация после подписи (QA-M-1)', () => {
  it('подпись больше не нужна: честная подпись вместо утверждения о факте, кнопка недоступна', async () => {
    items = [
      makeNotification({
        type: 'DOCUMENT_SIGN_REQUIRED',
        subjectType: 'EMPLOYEE_CONTRACT',
        data: { documentTitle: 'Ваш контракт' },
        subjectMissing: true,
      }),
    ]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Подпись больше не требуется',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // COPY-L-7 (copy-review круг 3, #664): деталь этого типа снята — она
  // повторяла заголовок («Контракт на подпись» / «Ваш контракт»). Пустой
  // `<p>` вместо неё был бы тем же дефектом с другой стороны: пустая строка
  // занимает высоту и ритм списка. Проверяется отсутствием самого узла, а не
  // пустым текстом.
  it('деталь не рисуется вовсе — заголовок уже сказал всё, что в ней было', async () => {
    items = [
      makeNotification({
        type: 'DOCUMENT_SIGN_REQUIRED',
        subjectType: 'EMPLOYEE_CONTRACT',
        data: { documentTitle: 'Ваш контракт' },
        subjectMissing: false,
      }),
    ]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-title`)).toHaveTextContent(
      'Контракт на подпись',
    )
    expect(screen.queryByTestId(`notification-item-${UUID}-detail`)).toBeNull()
  })

  it('контракт ещё ждёт подписи: кнопка «Подписать контракт», ведёт в визард', async () => {
    items = [
      makeNotification({
        type: 'DOCUMENT_SIGN_REQUIRED',
        subjectType: 'EMPLOYEE_CONTRACT',
        data: { documentTitle: 'Ваш контракт' },
        subjectMissing: false,
      }),
    ]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Подписать контракт',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/onboarding' })
  })
})

// ---------------------------------------------------------------------------
// Пустое состояние (COPY-M-6 / UX-M-1, copy+design review круг 1, #664)
// ---------------------------------------------------------------------------

describe('пустое состояние отражает актуальный каталог событий', () => {
  it('без уведомлений — подпись не про инвойсы (слово из `_Избегать_`, и диф сделал её ложной)', async () => {
    items = []
    await openBell()

    expect(screen.getByTestId('notifications-empty')).toHaveTextContent(
      'Здесь появятся события по вашим проектам, деньгам и документам',
    )
    expect(screen.getByTestId('notifications-empty')).not.toHaveTextContent('инвойс')
  })
})

// ---------------------------------------------------------------------------
// Числа не прыгают при обновлении (UX-L-1, design review круг 1, #664)
// ---------------------------------------------------------------------------

describe('деталь с суммой набрана моноширинными цифрами (tabular-nums, foundation.md §4)', () => {
  it('строка подробностей несёт `tabular-nums`', async () => {
    items = [
      makeNotification({
        type: 'TRANSACTION_ADDED',
        subjectType: 'TRANSACTION',
        data: { amount: '1500.000000', currency: 'USDT', projectName: null },
      }),
    ]
    await openBell()

    const detail = screen.getByTestId(`notification-item-${UUID}-detail`)
    expect(detail.className).toContain('tabular-nums')
    expect(detail).toHaveTextContent('1 500,00 USDT') // jest-dom normalizeWhitespace collapses NBSP -> regular space before matching
  })

  // COPY-H-6/COPY-M-3: причина отказа — отдельной строкой (`\n` в описании),
  // и `whitespace-pre-wrap` — единственное, что заставляет браузер эту
  // строку и показать как отдельную, а не схлопнуть в пробел.
  it('строка подробностей сохраняет перенос строки (`whitespace-pre-wrap`)', async () => {
    items = [
      makeNotification({
        type: 'APPROVAL_REJECTED',
        subjectType: 'PROJECT',
        data: {
          approverName: 'Иван Петров',
          subjectKind: 'PROJECT',
          subjectTitle: 'Acme',
          reasonPreview: 'Не тот проект',
        },
      }),
    ]
    await openBell()

    const detail = screen.getByTestId(`notification-item-${UUID}-detail`)
    expect(detail.className).toContain('whitespace-pre-wrap')
    expect(detail.textContent).toBe('«Не тот проект»\nИван Петров — проект Acme')
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

/**
 * QA-M-3 / QA-L-2 (manual-qa круг 2, #664) — со стороны экрана.
 *
 * Сервер научился отличать архив от удаления; здесь проверяется, что это
 * доезжает до глаз: подпись называет архив своим словом, кнопка гаснет и
 * клик по строке никуда не ведёт. Без последнего утверждения «недоступна»
 * оставалась бы свойством цвета текста, а не поведения.
 */
describe('архивный объект: своя подпись и никакого перехода (QA-M-3 / QA-L-2)', () => {
  it.each([
    ['PROJECT', 'PROJECT_MEMBER_ADDED', 'Проект в архиве'],
    ['TEAM', 'TEAM_MEMBER_ADDED', 'Команда в архиве'],
    ['USER', 'APPROVAL_CONFIRMED', 'Профиль в архиве'],
  ] as const)('%s → «%s»', async (subjectType, type, label) => {
    items = [
      makeNotification({
        type,
        subjectType,
        data:
          type === 'APPROVAL_CONFIRMED'
            ? { approverName: 'Иван', subjectKind: 'BASE_SHARE', subjectTitle: null }
            : type === 'TEAM_MEMBER_ADDED'
              ? { teamName: 'Alpha' }
              : { projectName: 'Acme' },
        subjectArchived: true,
      }),
    ]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(label)
  })

  it('подпись приглушена и клик по архивной строке не уводит со страницы', async () => {
    items = [makeNotification({ subjectArchived: true })]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`).className).toContain(
      'text-muted-foreground/60',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('«в архиве» не подменяет «удалён»: удалённый объект называется своим словом', async () => {
    items = [makeNotification({ subjectMissing: true })]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Проект удалён',
    )
  })
})

/**
 * Корзина рядом со строкой. Гейт мутаций круга 5 показал, что её обработчик не
 * исполнял ни один тест: `onClick` можно было выпотрошить до пустого тела, и
 * всё оставалось зелёным. Две проверки, и обе нужны: удаление вызвано — и
 * строка при этом НЕ открылась (`stopPropagation`, иначе тап по корзине и
 * удалял бы, и уводил со страницы).
 */
describe('корзина удаляет строку и не открывает её (AC6)', () => {
  it('клик по корзине зовёт удаление ровно с этой строкой', async () => {
    items = [makeNotification({})]
    await openBell()

    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-delete`))

    expect(mockDelete).toHaveBeenCalledWith(UUID)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

/**
 * ORCH-2 (fix-раунд 6, #664). Живой объект, но КОНКРЕТНОЕ предложение по
 * нему больше не актуально — раньше это была та же ложь «Проект удалён», что
 * QA-M-3 нашёл для архива. Клиентская половина: правильный текст показан и
 * клик никуда не ведёт (backend-половина — интеграционный тест на реальном
 * Postgre, `notifications.realdb.integration.spec.ts`).
 */
describe('согласование по живому объекту больше не актуально (ORCH-2)', () => {
  it('погашено: «Решение больше не требуется», кнопка не ведёт никуда', async () => {
    items = [makeNotification({ type: 'SHARE_CONFIRM_REQUIRED', approvalSuperseded: true })]
    await openBell()

    // COPY-M-9 (copy-review круг 3): не «Предложение отозвано» — в это
    // состояние ведут четыре пути, и два из них не отзыв (пересоздали,
    // погасил отказ соседа).
    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Решение больше не требуется',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('уже решено этим же подтверждающим: «Решение уже принято», не «отозвано»', async () => {
    items = [makeNotification({ type: 'PROJECT_CONFIRM_REQUIRED', approvalDecided: true })]
    await openBell()

    expect(screen.getByTestId(`notification-item-${UUID}-action`)).toHaveTextContent(
      'Решение уже принято',
    )
    await userEvent.click(screen.getByTestId(`notification-item-${UUID}-open`))
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
