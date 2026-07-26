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

function renderStrip(count: number, locale?: 'ru' | 'uk' | 'es' | 'pt') {
  const rootRoute = createRootRoute({
    // `exactOptionalPropertyTypes` — omit `locale` entirely rather than pass
    // `locale={undefined}` (same pattern as ContactForm's optional `company`).
    component: () => (
      <HiringStrip
        count={count}
        {...(locale ? { locale } : {})}
        dict={getDictionary(locale ?? 'en')}
      />
    ),
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

  it('task-landing-i18n.md — locale="ru" рендерит переведённый текст (правильная плюрализация: few)', async () => {
    renderStrip(2, 'ru')
    const link = await screen.findByRole('link', { name: /Мы нанимаем — 2 открытые позиции/ })
    expect(link.getAttribute('href')).toBe('/ru/careers')
  })

  // review round 1 MED-1 — component-level pin (not just the pure
  // `selectPluralForm` unit in plural.spec.ts): `locale` must actually reach
  // `Intl.PluralRules` through the component, not just the dictionary text.
  // 11 is the CLDR "teen exception" (many, NOT few, despite ending in "1").
  it('review round 1 MED-1 — locale="ru" count=11 selects "many" (teen exception), NOT "few"', async () => {
    renderStrip(11, 'ru')
    const link = await screen.findByRole('link', { name: /Мы нанимаем — 11 открытых позиций/ })
    expect(link).toBeTruthy()
  })

  it('review round 1 MED-1 — locale="ru" count=1 selects "one" (singular noun form)', async () => {
    renderStrip(1, 'ru')
    const link = await screen.findByRole('link', { name: /Мы нанимаем — 1 открытая позиция/ })
    expect(link).toBeTruthy()
  })

  it('review round 1 MED-1 — locale="uk" рендерит переведённый текст (few)', async () => {
    renderStrip(3, 'uk')
    const link = await screen.findByRole('link', { name: /Ми наймаємо — 3 відкриті позиції/ })
    expect(link.getAttribute('href')).toBe('/uk/careers')
  })

  // design round 1 MED-2 — hit-area bumped from 28×28px (`size-7`) to the
  // project's own ≥44px standalone-control standard (`size-11`). Tailwind
  // classes are the only observable signal in happy-dom (no real CSS layout
  // engine to read computed pixel sizes from) — same convention as the rest
  // of this test suite's class-based assertions.
  it('design round 1 MED-2 — close button carries the size-11 (44px) hit-area class, not the old size-7 (28px)', async () => {
    renderStrip(3)
    const closeButton = await screen.findByRole('button', { name: 'Dismiss' })
    expect(closeButton.className).toContain('size-11')
    expect(closeButton.className).not.toContain('size-7')
  })
})
