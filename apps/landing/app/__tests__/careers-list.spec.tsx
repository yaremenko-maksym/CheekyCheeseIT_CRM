/**
 * CareersList — `/careers` list body (task-landing-redesign.md AC5
 * "careers-список (данные/пусто)"). Router setup mirrors
 * apps/web/app/components/users/__tests__/ProfileNameLink.test.tsx — minimal
 * in-memory root route so the inner `VacancyCard` `<Link>` can build a href.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { CareersList } from '@/components/marketing/careers-list'
// Test-only barrel import (fine — not part of the production bundle, see
// `nav.tsx`'s module doc for why production components never do this).
import { getDictionary } from '@/i18n/dictionaries'

const vacancies: PublicVacancy[] = [
  {
    slug: 'senior-ml-engineer',
    title: 'Senior ML Engineer',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote · EU',
    publishedAt: '2026-07-01T00:00:00.000Z',
    isFallback: false,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
  },
  {
    slug: 'backend-engineer-commerce',
    title: 'Backend Engineer, Commerce',
    domain: 'ECOMMERCE',
    seniority: 'SENIOR',
    employmentType: 'CONTRACT',
    location: 'Remote · Global',
    publishedAt: '2026-07-02T00:00:00.000Z',
    isFallback: false,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
  },
]

function renderList(list: PublicVacancy[], locale?: 'ru') {
  const rootRoute = createRootRoute({
    component: () => (
      <CareersList
        vacancies={list}
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

describe('CareersList', () => {
  it('данные — рендерит карточку на каждую вакансию с корректным href', async () => {
    renderList(vacancies)
    expect(await screen.findByRole('heading', { name: 'Senior ML Engineer' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Backend Engineer, Commerce' })).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links.some((l) => l.getAttribute('href') === '/careers/senior-ml-engineer')).toBe(true)
    expect(links.some((l) => l.getAttribute('href') === '/careers/backend-engineer-commerce')).toBe(
      true,
    )
    // No filter/tab controls anywhere (AC2).
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('пусто — empty state с mailto hr@cheekycheese.tech, без карточек', async () => {
    renderList([])
    expect(await screen.findByText('No open roles right now')).toBeTruthy()
    const mailLink = screen.getByRole('link', { name: 'hr@cheekycheese.tech' })
    expect(mailLink.getAttribute('href')).toBe('mailto:hr@cheekycheese.tech')
    expect(screen.queryByRole('heading', { name: 'Senior ML Engineer' })).toBeNull()
  })

  it('task-landing-i18n.md — locale="ru" рендерит локализованный href и empty-state текст', async () => {
    renderList(vacancies, 'ru')
    const links = await screen.findAllByRole('link')
    expect(links.some((l) => l.getAttribute('href') === '/ru/careers/senior-ml-engineer')).toBe(
      true,
    )

    renderList([], 'ru')
    expect(await screen.findByText('Сейчас открытых вакансий нет')).toBeTruthy()
  })

  // task-vacancy-salary-range (AC5) — the salary range shows on the LIST card
  // when filled, and is simply absent for a legacy vacancy without one.
  it('shows the salary range on the card when set, omits it when unset (AC3/AC5)', async () => {
    renderList([
      {
        ...vacancies[0]!,
        salaryMin: '3000',
        salaryMax: '5000',
        salaryCurrency: 'USDT',
        salaryPeriod: 'MONTH',
      },
      vacancies[1]!, // no salary range — stays unset
    ])
    expect(await screen.findByText('3000–5000 USDT · per month')).toBeTruthy()
    // The second card has no salary text anywhere on the page for it.
    const salaryMentions = screen.queryAllByText(/USDT|USD|EUR|UAH/)
    expect(salaryMentions).toHaveLength(1)
  })
})
