/**
 * HiringStrip — task-landing-contact-and-hiring-strip.md Часть B / AC6
 * ("при 0 вакансий отсутствует, при N>0 показывает N и ведёт на /careers/;
 * закрытие запоминается; при изменении N показывается снова").
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { HiringStrip } from '@/components/marketing/hiring-strip'
import { getDictionary } from '@/i18n/dictionaries'

const STORAGE_KEY = 'cc-hiring-strip-dismissed-count'

function renderStrip(count: number, locale?: 'ru') {
  const rootRoute = createRootRoute({
    component: () => <HiringStrip count={count} dict={getDictionary(locale ?? 'en')} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('HiringStrip', () => {
  it('count=0 — рендерится null (совсем нет DOM-узла полосы)', () => {
    renderStrip(0)
    expect(screen.queryByText(/hiring/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('count>0 — показывает число и ведёт на /careers/', async () => {
    renderStrip(3)
    const link = await screen.findByRole('link', { name: /We're hiring — 3 open positions/ })
    expect(link.getAttribute('href')).toBe('/careers')
  })

  it('закрытие — крестик скрывает полосу и сохраняет число в localStorage', async () => {
    const user = userEvent.setup()
    renderStrip(3)
    await screen.findByRole('link', { name: /We're hiring/ })

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('link', { name: /We're hiring/ })).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('3')
  })

  it('повторный рендер с ТЕМ ЖЕ count после закрытия — остаётся скрытой (читает localStorage синхронно на первом рендере)', () => {
    window.localStorage.setItem(STORAGE_KEY, '3')
    renderStrip(3)
    expect(screen.queryByRole('link', { name: /We're hiring/ })).toBeNull()
  })

  it('число изменилось (N разное) — полоса показывается снова, даже если старое N было закрыто', async () => {
    window.localStorage.setItem(STORAGE_KEY, '3')
    renderStrip(5)
    const link = await screen.findByRole('link', { name: /We're hiring — 5 open positions/ })
    expect(link).toBeTruthy()
  })

  it('task-landing-i18n.md — locale="ru" рендерит переведённый текст', async () => {
    renderStrip(2, 'ru')
    const link = await screen.findByRole('link', { name: /Мы нанимаем — 2 открытых позиций/ })
    expect(link.getAttribute('href')).toBe('/careers')
  })
})
