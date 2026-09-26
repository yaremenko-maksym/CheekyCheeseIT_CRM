/**
 * task-i18n-stage3c-pr2 (CI-MUT, fix-round A) — `VacanciesListPage` interaction
 * tests. Not previously covered by any test file at all (`route-guard.test.tsx`
 * only exercises the RBAC redirect with an empty vacancy list) — the mutation
 * gate found 31 surviving mutants here: filter-label counters, the two
 * `ariaLabel`s, and the "no vacancies at all" vs "no vacancies with this
 * status" branch.
 *
 * Same mocking convention as `route-guard.test.tsx`: `useVacancies` mocked
 * directly (no react-query wiring needed), `@tanstack/react-router` mocked to
 * a callable `createFileRoute` stand-in + a plain-anchor `Link` (VacancyCard
 * renders one for the title).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Vacancy } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN' }, isLoading: false }),
}))

let vacanciesMock: Vacancy[] = []
vi.mock('@/hooks/use-vacancies', () => ({
  useVacancies: () => ({ data: vacanciesMock, isLoading: false }),
  useCreateVacancy: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateVacancy: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteVacancy: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

import { VacanciesListPage } from '../index'

function makeVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
  return {
    id: 'vac-1',
    slug: 'senior-react-developer',
    title: 'Senior React Developer',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote',
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
    salaryMin: '3000.00',
    salaryMax: '5000.00',
    salaryCurrency: 'USDT',
    salaryPeriod: 'MONTH',
    ...overrides,
  }
}

function renderPage() {
  return render(
    <I18nTestProvider>
      <VacanciesListPage />
    </I18nTestProvider>,
  )
}

describe('VacanciesListPage — empty states (task-i18n-stage3c-pr2)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('no vacancies at all: "Поки немає вакансій" + create-first CTA', () => {
    vacanciesMock = []
    renderPage()
    expect(screen.getByText('Поки немає вакансій')).toBeInTheDocument()
    expect(
      screen.getByText('Створіть першу вакансію, щоб почати приймати відгуки кандидатів.', {
        exact: false,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Створити першу вакансію')).toBeInTheDocument()
  })

  it('vacancies exist but the active filter matches none: different message, no create-first CTA', () => {
    vacanciesMock = [makeVacancy({ status: 'PUBLISHED' })]
    renderPage()
    // Default filter is ALL (shows the one PUBLISHED vacancy) — switch to the
    // CLOSED tab (desktop label «Закриті (0)», unique text vs the mobile
    // variant's «Закр. (0)») to reach the "filtered to zero" branch.
    fireEvent.click(screen.getByText('Закриті (0)'))
    expect(screen.getByText('Немає вакансій із таким статусом')).toBeInTheDocument()
    expect(screen.queryByText('Створити першу вакансію')).not.toBeInTheDocument()
  })
})

describe('VacanciesListPage — filter counters (COPY-L-proj-20 canon, CI-MUT)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders every counter with the real per-status count, desktop + mobile variants', () => {
    vacanciesMock = [
      makeVacancy({ id: 'v1', status: 'DRAFT' }),
      makeVacancy({ id: 'v2', status: 'PUBLISHED' }),
      makeVacancy({ id: 'v3', status: 'PUBLISHED' }),
      makeVacancy({ id: 'v4', status: 'CLOSED' }),
    ]
    renderPage()
    // «Усі (N)» is the SAME string in both the desktop and mobile variant
    // (canon table) — the other three differ (full word vs abbreviation).
    expect(screen.getAllByText('Усі (4)')).toHaveLength(2)
    expect(screen.getByText('Опубліковані (2)')).toBeInTheDocument()
    expect(screen.getByText('Чернетки (1)')).toBeInTheDocument()
    expect(screen.getByText('Закриті (1)')).toBeInTheDocument()
    // Mobile (abbreviated labels) — same counts, different words per canon
    expect(screen.getByText('Опубл. (2)')).toBeInTheDocument()
    expect(screen.getByText('Черн. (1)')).toBeInTheDocument()
    expect(screen.getByText('Закр. (1)')).toBeInTheDocument()
  })

  it('clicking each filter tab actually filters by ITS OWN status, not a shared/blank value', () => {
    vacanciesMock = [
      makeVacancy({ id: 'v-draft', status: 'DRAFT' }),
      makeVacancy({ id: 'v-published', status: 'PUBLISHED' }),
      makeVacancy({ id: 'v-closed', status: 'CLOSED' }),
    ]
    renderPage()
    // ALL: every card visible.
    expect(screen.getByTestId('vacancy-card-v-draft')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-published')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-closed')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Опубліковані (1)'))
    expect(screen.getByTestId('vacancy-card-v-published')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-draft')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-closed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Чернетки (1)'))
    expect(screen.getByTestId('vacancy-card-v-draft')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-published')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Закриті (1)'))
    expect(screen.getByTestId('vacancy-card-v-closed')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-draft')).not.toBeInTheDocument()

    // Back to ALL via the DESKTOP toggle specifically: every card visible
    // again (round-trip, not stuck on ''). `filterOptionsMobile` (line 70)
    // renders FIRST in the DOM (see the JSX below), so `getAllByText(...)[0]`
    // would silently exercise the MOBILE 'ALL' literal instead of the
    // DESKTOP one at line 60 — [1] is the desktop instance.
    fireEvent.click(screen.getAllByText('Усі (3)')[1]!)
    expect(screen.getByTestId('vacancy-card-v-draft')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-published')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-closed')).toBeInTheDocument()

    // The MOBILE variant is a SEPARATE options array (its own `value:`
    // literals) — exercise it too, including its own round-trip back to
    // 'ALL' via getAllByText(...)[0] (the mobile instance), so a mutant on
    // EITHER array's entries can't hide behind the other's assertions.
    fireEvent.click(screen.getByText('Черн. (1)'))
    expect(screen.getByTestId('vacancy-card-v-draft')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-published')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Закр. (1)'))
    expect(screen.getByTestId('vacancy-card-v-closed')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-draft')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Опубл. (1)'))
    expect(screen.getByTestId('vacancy-card-v-published')).toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-card-v-closed')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByText('Усі (3)')[0]!)
    expect(screen.getByTestId('vacancy-card-v-draft')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-published')).toBeInTheDocument()
    expect(screen.getByTestId('vacancy-card-v-closed')).toBeInTheDocument()
  })

  it('both status-filter toggles carry the catalog aria-label, not the old Russian one', () => {
    vacanciesMock = []
    renderPage()
    // Two variants (mobile + desktop) are both rendered, only one visible via CSS.
    const toggles = screen.getAllByRole('tablist', { name: 'Фільтр вакансій за статусом' })
    expect(toggles).toHaveLength(2)
  })
})
