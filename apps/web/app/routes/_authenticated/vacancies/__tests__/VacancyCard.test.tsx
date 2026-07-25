/**
 * task-crm-vacancies-ui — `VacancyCard` (AC4 + spec §4.1.1) interaction tests.
 * Delete-gate matrix updated by task-vacancy-delete-closed (owner report:
 * couldn't delete a test CLOSED vacancy with 0 applications).
 *
 * Pins the backend-truth action matrix (NOT the static macet, which shows the
 * delete icon active unconditionally — spec §11 п.3/4):
 *   DRAFT + 0 applications   → delete ENABLED
 *   DRAFT + N applications   → delete DISABLED + Tooltip ("есть отклики")
 *   PUBLISHED                → NO delete button at all (list card hides it —
 *                               close first; full-variant Danger Zone tooltip
 *                               is covered in `$vacancyId.tsx`)
 *   CLOSED + 0 applications  → delete ENABLED
 *   CLOSED + N applications  → delete DISABLED + Tooltip ("есть отклики")
 *
 * Strategy: real TanStack Query (mutations mocked at the `api` boundary).
 * `<Link>` (PUBLISHED → «Отклики») is mocked to a plain anchor so no full
 * app route tree is needed — same approach as `route-guard.test.tsx`.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vacancy } from '@crm/shared'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}))

const apiGet = vi.fn()
const apiPatch = vi.fn().mockResolvedValue({ data: {} })
const apiDelete = vi.fn().mockResolvedValue({ data: {} })
vi.mock('@/lib/axios', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
}))

import { VacancyCard } from '../components/VacancyCard'

function makeVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
  return {
    id: 'vac-1',
    slug: 'senior-react-developer',
    title: 'Senior React Developer',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Киев · Удалённо',
    publishedAt: null,
    descriptionMd: 'Some description',
    status: 'DRAFT',
    closedAt: null,
    applicationsCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    translations: null,
    skills: null,
    experienceMonths: null,
    qualifications: null,
    responsibilities: null,
    jobBenefits: null,
    workHours: null,
    ...overrides,
  }
}

function renderCard(vacancy: Vacancy) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VacancyCard vacancy={vacancy} onEdit={() => {}} />
    </QueryClientProvider>,
  )
}

describe('VacancyCard — status action matrix (§4.1.1)', () => {
  beforeEach(() => {
    apiPatch.mockClear()
    apiDelete.mockClear()
  })

  it('DRAFT + 0 applications: delete ENABLED, publish visible, no close/reopen', async () => {
    renderCard(makeVacancy({ status: 'DRAFT', applicationsCount: 0 }))
    expect(screen.getByTestId('vacancy-publish-vac-1')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-delete-vac-1')).toBeEnabled()
    expect(screen.queryByTestId('vacancy-delete-disabled-vac-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-close-vac-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-reopen-vac-1')).not.toBeInTheDocument()
  })

  it('DRAFT + N applications: delete DISABLED with a Tooltip explaining why', async () => {
    renderCard(makeVacancy({ status: 'DRAFT', applicationsCount: 3 }))
    const btn = screen.getByTestId('vacancy-delete-disabled-vac-1')
    expect(btn).toBeDisabled()
    // Radix Tooltip: fireEvent.focus (not hover — happy-dom doesn't emulate
    // pointer hover reliably) opens it; the tooltip text is rendered TWICE
    // (visible content + visually-hidden accessible span), so use
    // getAllByText, not getByText (which throws on >1 match).
    fireEvent.focus(btn)
    await waitFor(() =>
      expect(screen.getAllByText('Нельзя удалить вакансию с откликами').length).toBeGreaterThan(0),
    )
  })

  it('PUBLISHED: no delete button (icon or disabled) rendered at all', () => {
    renderCard(makeVacancy({ status: 'PUBLISHED', applicationsCount: 5 }))
    expect(screen.queryByTestId('vacancy-delete-vac-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-delete-disabled-vac-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('vacancy-applications-vac-1')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-close-vac-1')).toBeInTheDocument()
  })

  it('CLOSED + 0 applications: delete ENABLED (task-vacancy-delete-closed)', async () => {
    renderCard(makeVacancy({ status: 'CLOSED', applicationsCount: 0 }))
    expect(screen.getByTestId('vacancy-delete-vac-1')).toBeEnabled()
    expect(screen.queryByTestId('vacancy-delete-disabled-vac-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('vacancy-reopen-vac-1')).toBeInTheDocument()
  })

  it('CLOSED + N applications: delete DISABLED with a Tooltip explaining why', async () => {
    renderCard(makeVacancy({ status: 'CLOSED', applicationsCount: 2 }))
    const btn = screen.getByTestId('vacancy-delete-disabled-vac-1')
    expect(btn).toBeDisabled()
    expect(screen.getByTestId('vacancy-reopen-vac-1')).toBeInTheDocument()
    fireEvent.focus(btn)
    await waitFor(() =>
      expect(screen.getAllByText('Нельзя удалить вакансию с откликами').length).toBeGreaterThan(0),
    )
  })

  it('CLOSED + 0 applications delete confirm dialog calls DELETE /vacancies/:id', async () => {
    renderCard(makeVacancy({ status: 'CLOSED', applicationsCount: 0 }))
    fireEvent.click(screen.getByTestId('vacancy-delete-vac-1'))
    fireEvent.click(screen.getByTestId('vacancy-delete-confirm-vac-1'))
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/vacancies/vac-1'))
  })

  it('DRAFT delete confirm dialog calls DELETE /vacancies/:id', async () => {
    renderCard(makeVacancy({ status: 'DRAFT', applicationsCount: 0 }))
    fireEvent.click(screen.getByTestId('vacancy-delete-vac-1'))
    fireEvent.click(screen.getByTestId('vacancy-delete-confirm-vac-1'))
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/vacancies/vac-1'))
  })

  it('publish button PATCHes status: PUBLISHED', async () => {
    renderCard(makeVacancy({ status: 'DRAFT' }))
    fireEvent.click(screen.getByTestId('vacancy-publish-vac-1'))
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/vacancies/vac-1', { status: 'PUBLISHED' }),
    )
  })

  it('reopen button (CLOSED) PATCHes status: PUBLISHED', async () => {
    renderCard(makeVacancy({ status: 'CLOSED' }))
    fireEvent.click(screen.getByTestId('vacancy-reopen-vac-1'))
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/vacancies/vac-1', { status: 'PUBLISHED' }),
    )
  })

  it('close button (PUBLISHED) PATCHes status: CLOSED', async () => {
    renderCard(makeVacancy({ status: 'PUBLISHED' }))
    fireEvent.click(screen.getByTestId('vacancy-close-vac-1'))
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/vacancies/vac-1', { status: 'CLOSED' }),
    )
  })
})
