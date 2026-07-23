/**
 * task-crm-vacancies-ui (AC2) — RBAC route guard on `/vacancies`.
 *
 * SENIOR/JUNIOR/ACCOUNTANT/DROP hitting the page directly (URL, not nav
 * link) must be redirected — the sidebar hides the nav item too, but that
 * alone is not a security boundary (a denied role can still type the URL).
 *
 * Strategy: mock `useAuth` + `useNavigate` (same pattern as
 * `UserProfileShell.drop-redirect.test.tsx`) so `useRoleGuard` — the SAME
 * hook every other CRM page uses — resolves deterministically without a
 * full router. `useVacancies` is mocked too so an ALLOWED role doesn't need
 * a real API/query-client wiring for this narrow guard assertion.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navigateMock = vi.fn()
let viewerRole: string | null = 'ADMIN'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  Link: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  // `index.tsx` also evaluates `export const Route = createFileRoute(...)({...})`
  // at module-load time — the mock must provide a callable stand-in so that
  // import doesn't throw, even though this test never touches `Route` itself.
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: viewerRole ? { id: 'viewer-1', role: viewerRole } : null,
    isLoading: false,
  }),
}))

vi.mock('@/hooks/use-vacancies', () => ({
  useVacancies: () => ({ data: [], isLoading: false }),
  // `VacancySheet` (always mounted, even while closed) also needs these —
  // it's rendered unconditionally by `VacanciesListPage`. `vi.mock` factories
  // are hoisted above module-level consts, so the stub is inlined per-export.
  useCreateVacancy: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateVacancy: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

// Import AFTER mocks are registered.
import { VacanciesListPage } from '../index'

describe('/vacancies — RBAC guard (AC2)', () => {
  beforeEach(() => {
    navigateMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  for (const role of ['SENIOR', 'ACCOUNTANT', 'DROP']) {
    it(`${role} → redirected to / (role home), page content NOT rendered`, () => {
      viewerRole = role
      render(<VacanciesListPage />)
      expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true })
      expect(screen.queryByTestId('vacancies-page')).not.toBeInTheDocument()
    })
  }

  it('JUNIOR → redirected to /project (own hub), page content NOT rendered', () => {
    viewerRole = 'JUNIOR'
    render(<VacanciesListPage />)
    expect(navigateMock).toHaveBeenCalledWith({ to: '/project', replace: true })
    expect(screen.queryByTestId('vacancies-page')).not.toBeInTheDocument()
  })

  for (const role of ['ADMIN', 'HR']) {
    it(`${role} → NOT redirected, page renders`, () => {
      viewerRole = role
      render(<VacanciesListPage />)
      expect(navigateMock).not.toHaveBeenCalled()
      expect(screen.getByTestId('vacancies-page')).toBeInTheDocument()
    })
  }
})
