/**
 * notification-types.spec.ts — task-notification-types-producers (позиция 6).
 *
 * Попап колокольчика выводит заголовок, подробности и подпись кнопки ПО ТИПУ
 * (спека §7.1), а не читает готовый текст из базы. Спека проверяет ровно то,
 * что нельзя проверить в jsdom:
 *
 *   N1 — известный тип рисуется выведенными строками, сохранённый заголовок
 *        не используется;
 *   N2 — неизвестный тип не роняет попап (AC2);
 *   N3 — исчезнувший объект честно говорит об этом и никуда не ведёт (AC6);
 *   N4 — ни на одной из семи ширин нет горизонтального переполнения (AC7 —
 *        регресс #620 закреплён здесь, потому что переполнение — свойство
 *        РАСКЛАДКИ, и никакой unit-тест его не увидит).
 *
 * Список уведомлений замокан поверх `mockAuthAs` (та отдаёт пустой список) —
 * последний зарегистрированный `page.route` выигрывает.
 */
import { test, expect, API_RE } from './fixtures'
import type { Page } from '@playwright/test'

const KNOWN_ID = '11111111-2222-4333-8444-555555555501'
const MISSING_ID = '11111111-2222-4333-8444-555555555502'
const UNKNOWN_ID = '11111111-2222-4333-8444-555555555503'
const PROJECT_ID = '99999999-2222-4333-8444-555555555599'

const ITEMS = [
  {
    id: KNOWN_ID,
    type: 'PROJECT_CONFIRM_REQUIRED',
    title: 'Сохранённый заголовок, который клиент не должен показывать',
    body: null,
    link: null,
    readAt: null,
    createdAt: '2026-09-07T10:00:00.000Z',
    subjectType: 'PROJECT',
    subjectId: PROJECT_ID,
    secondaryId: null,
    data: { projectName: 'Acme' },
    subjectMissing: false,
  },
  {
    id: MISSING_ID,
    type: 'TEAM_NEW_MEMBER',
    title: 'В команде новый участник',
    body: null,
    link: null,
    readAt: null,
    createdAt: '2026-09-07T09:00:00.000Z',
    subjectType: 'TEAM',
    subjectId: '99999999-2222-4333-8444-5555555555aa',
    secondaryId: null,
    data: { teamName: 'Alpha', memberName: 'Иван Петров' },
    subjectMissing: true,
  },
  {
    id: UNKNOWN_ID,
    // Тип из будущего: клиент этой сборки о нём не знает. Заголовок нарочно
    // длинный — на 320 px именно он раньше растягивал строку и обрезался.
    type: 'SOMETHING_FROM_THE_FUTURE',
    title:
      'Событие, которого клиент ещё не знает, с очень длинным заголовком без пробелов-подсказок',
    body: null,
    link: '/finance',
    readAt: null,
    createdAt: '2026-09-07T08:00:00.000Z',
    subjectType: null,
    subjectId: null,
    secondaryId: null,
    data: null,
    subjectMissing: false,
  },
]

async function mockNotifications(page: Page) {
  await page.route(new RegExp(`${API_RE}/notifications(\\?.*)?$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: ITEMS, unreadCount: ITEMS.length }),
    }),
  )
}

async function openBell(page: Page) {
  await page.getByTestId('notifications-bell-trigger').click()
  await expect(page.getByTestId('notifications-bell-dropdown')).toBeVisible()
}

test.describe('N1–N3 — попап выводит строку по типу', () => {
  test('известный тип: заголовок, подробности и подпись кнопки выведены', async ({ asAdmin }) => {
    await mockNotifications(asAdmin)
    await asAdmin.goto('/')
    await openBell(asAdmin)

    await expect(asAdmin.getByTestId(`notification-item-${KNOWN_ID}-title`)).toHaveText(
      'Ждёт решения: новый проект',
    )
    await expect(asAdmin.getByTestId(`notification-item-${KNOWN_ID}-detail`)).toHaveText(
      'Проект Acme',
    )
    await expect(asAdmin.getByTestId(`notification-item-${KNOWN_ID}-action`)).toHaveText(
      'Открыть проект',
    )
    // Сохранённый заголовок не показан — именно это и означает «подписи
    // выводит клиент», а не «читает из базы».
    await expect(
      asAdmin.getByText('Сохранённый заголовок, который клиент не должен показывать'),
    ).toHaveCount(0)
  })

  test('клик ведёт по адресу, выведенному из вида объекта', async ({ asAdmin }) => {
    await mockNotifications(asAdmin)
    await asAdmin.goto('/')
    await openBell(asAdmin)

    await asAdmin.getByTestId(`notification-item-${KNOWN_ID}-open`).click()
    await expect(asAdmin).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`))
  })

  test('N2 — неизвестный тип не роняет попап', async ({ asAdmin }) => {
    await mockNotifications(asAdmin)
    await asAdmin.goto('/')
    await openBell(asAdmin)

    // Строка на месте, показана сохранённым заголовком, а список цел.
    await expect(asAdmin.getByTestId(`notification-item-${UNKNOWN_ID}-title`)).toBeVisible()
    await expect(asAdmin.getByTestId(`notification-item-${UNKNOWN_ID}-action`)).toHaveText(
      'Открыть',
    )
    await expect(asAdmin.getByTestId('notifications-list')).toBeVisible()
  })

  test('N3 — исчезнувший объект: честная подпись и никакого перехода', async ({ asAdmin }) => {
    await mockNotifications(asAdmin)
    await asAdmin.goto('/')
    await openBell(asAdmin)

    await expect(asAdmin.getByTestId(`notification-item-${MISSING_ID}-action`)).toHaveText(
      'Объекта больше нет',
    )
    await asAdmin.getByTestId(`notification-item-${MISSING_ID}-open`).click()
    // Остались там же, где были: белого экрана и 404 не случилось.
    await expect(asAdmin).toHaveURL(/\/$/)
  })
})

test.describe('N4 — адаптив попапа: ни одной ширины с переполнением', () => {
  const WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920]

  for (const width of WIDTHS) {
    test(`${width}px — список не переполняется по горизонтали`, async ({ asAdmin }) => {
      await mockNotifications(asAdmin)
      await asAdmin.goto('/')
      await asAdmin.setViewportSize({ width, height: 900 })
      await openBell(asAdmin)

      // Две меры, и обе нужны. Страница: `scrollWidth > clientWidth` — это
      // горизонтальная прокрутка всего экрана. Список: то же самое ВНУТРИ
      // попапа, где `overflow-x-hidden` прокрутку прячет, но текст всё равно
      // срезан — переполнение, которое видно только измерением (#620).
      const pageOverflow = await asAdmin.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(pageOverflow, `страница на ${width}px`).toBeLessThanOrEqual(0)

      const listOverflow = await asAdmin.evaluate(() => {
        const list = document.querySelector('[data-testid="notifications-list"]')
        if (!list) throw new Error('notifications-list не найден')
        return list.scrollWidth - list.clientWidth
      })
      expect(listOverflow, `список на ${width}px`).toBeLessThanOrEqual(0)
    })
  }
})
