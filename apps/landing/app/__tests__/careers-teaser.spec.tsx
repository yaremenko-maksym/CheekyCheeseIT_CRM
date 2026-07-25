/**
 * CareersTeaser — Home "Careers" section body (task-landing-redesign.md AC5
 * "тизер (данные/пусто)", AC2: caps at 3, section never hidden on empty).
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
import { CareersTeaser } from '@/components/marketing/careers-teaser'

function makeVacancy(slug: string, title: string): PublicVacancy {
  return {
    slug,
    title,
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote · EU',
    publishedAt: '2026-07-01T00:00:00.000Z',
    isFallback: false,
  }
}

function renderTeaser(list: PublicVacancy[], locale?: 'ru') {
  const rootRoute = createRootRoute({
    component: () => <CareersTeaser vacancies={list} {...(locale ? { locale } : {})} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('CareersTeaser', () => {
  it('данные — рендерит до 3 вакансий даже если пришло больше (AC2 лимит тизера)', async () => {
    const four = [
      makeVacancy('a', 'Role A'),
      makeVacancy('b', 'Role B'),
      makeVacancy('c', 'Role C'),
      makeVacancy('d', 'Role D'),
    ]
    renderTeaser(four)
    expect(await screen.findByRole('heading', { name: 'Role A' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Role B' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Role C' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Role D' })).toBeNull()
  })

  it('пусто — CTA-карточка вместо скрытия секции, mailto hr@cheekycheese.tech', async () => {
    renderTeaser([])
    expect(await screen.findByText('No open roles right now')).toBeTruthy()
    const mailLink = screen.getByRole('link', { name: 'hr@cheekycheese.tech' })
    expect(mailLink.getAttribute('href')).toBe('mailto:hr@cheekycheese.tech')
  })

  it('task-landing-i18n.md — locale="ru" рендерит локализованный href', async () => {
    renderTeaser([makeVacancy('a', 'Role A')], 'ru')
    const links = await screen.findAllByRole('link')
    expect(links.some((l) => l.getAttribute('href') === '/ru/careers/a')).toBe(true)
  })
})
