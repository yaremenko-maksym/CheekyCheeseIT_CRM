/**
 * task-hide-job-sourcing-button — fix-round 2 (CI mutation gate). The gate
 * instruments `JOB_SOURCING_ENTRY_ENABLED` (the constant itself) plus the two
 * `JOB_SOURCING_ENTRY_ENABLED && …` guards it feeds — a `false → true`
 * mutant on the constant and a `&& → ||` mutant on each guard — and found
 * NO test in the whole repo that imports this page, so all five mutants came
 * back `NoCoverage` (`mutation-gate-runbook.md`: a nonzero mutant count with
 * zero related tests is a real gap, not the honest "0 mutants = PASS" case).
 *
 * This file renders the REAL `InterviewsPage` (via `Route.options.component`,
 * the pattern `login-as.spec.tsx`/`pending/__tests__/index.test.tsx` already
 * use for a route whose component isn't exported by name) under an ADMIN
 * viewer (`canCreate === true`, so the gate is the ONLY reason the button
 * could be hidden) and asserts the entry point is gone while its sibling
 * «Новая карточка» button — gated by `canCreate` alone, no
 * `JOB_SOURCING_ENTRY_ENABLED` — still renders. That is exactly what kills
 * `false → true` (the button would reappear) and both `&& → ||` mutants (a
 * `||` on either guard renders unconditionally, independent of `canCreate`/
 * `jobSourcingOpen`).
 *
 * `@tanstack/react-router` is mocked wholesale (not the "capture + delegate"
 * pattern the two precedents use) because this page calls `Route.useSearch()`
 * unconditionally at the top of the component — the real generated hook
 * expects a live router match context this test never builds. A hand-rolled
 * `createFileRoute` stub sidesteps that: it still exposes `.options.component`
 * (all this file needs) and a `.useSearch()` that returns the page's actual
 * default search state instead of throwing.
 *
 * Heavy board children (`KanbanColumn`, the four dialogs) are replaced with
 * lightweight stubs — this test is about the toolbar gate, not the kanban
 * board or any one dialog's own behaviour (each has its own test file where
 * one exists). `JobSuggestionDialog`'s stub is what AC2 checks for absence.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async (orig) => {
  const real = await orig<typeof import('@tanstack/react-router')>()
  return {
    ...real,
    useNavigate: () => mockNavigate,
    // Hand-rolled — NOT the real generated route object. The real
    // `createFileRoute(path)(options).useSearch()` needs an active router
    // match this test never mounts; this stub keeps `.options.component`
    // (what every caller of `Route` in this file actually needs) and
    // answers `useSearch()` with the page's own validated default instead.
    createFileRoute: (_path: string) => (options: Record<string, unknown>) => ({
      options,
      useSearch: () => ({ seniorId: undefined }),
    }),
  }
})

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}))

vi.mock('@/context/auth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('@/hooks/use-active-team', () => ({
  useActiveTeam: () => ({ team: null, isTeamless: false, isLoading: false }),
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}))

vi.mock('@/components/job-sourcing/JobSuggestionDialog', () => ({
  JobSuggestionDialog: () => <div data-testid="job-suggestion-dialog-stub" />,
}))

vi.mock('../components/KanbanColumn', () => ({
  KanbanColumn: () => <div data-testid="kanban-column-stub" />,
  InterviewCardStatic: () => null,
}))

vi.mock('../components/InterviewDetailSheet', () => ({
  InterviewDetailSheet: () => <div data-testid="interview-detail-sheet-stub" />,
}))

vi.mock('../components/CreateInterviewDialog', () => ({
  CreateInterviewDialog: () => <div data-testid="create-interview-dialog-stub" />,
}))

vi.mock('../components/CreateProjectFromHiredDialog', () => ({
  CreateProjectFromHiredDialog: () => <div data-testid="create-project-from-hired-dialog-stub" />,
}))

vi.mock('@/components/users/RejoinTeamDialog', () => ({
  RejoinTeamDialog: () => <div data-testid="rejoin-team-dialog-stub" />,
}))

import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Route } from '../index'

// `createFileRoute(path)(opts)` (our mock above, same shape as the real one
// for this purpose) exposes the component at `Route.options.component` —
// `InterviewsPage` itself isn't exported by name from `../index`.
const InterviewsPage = Route.options.component as React.ComponentType

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <InterviewsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockResolvedValue({ data: [] })
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'admin-uuid-1', role: 'ADMIN' },
    isLoading: false,
  } as ReturnType<typeof useAuth>)
})

describe('/interviews — job-sourcing entry point (paused, task-hide-job-sourcing-button)', () => {
  it('does not render the «Подбор вакансий» button for an ADMIN viewer (canCreate=true)', async () => {
    renderPage()

    expect(await screen.findByTestId('interviews-page')).toBeInTheDocument()
    expect(screen.queryByTestId('open-job-sourcing')).not.toBeInTheDocument()
    expect(screen.queryByText('Подбор вакансий')).not.toBeInTheDocument()
  })

  it('still renders «Новая карточка» — the gate does not take its sibling button down with it', async () => {
    renderPage()

    await screen.findByTestId('interviews-page')
    expect(screen.getByText('Новая карточка')).toBeInTheDocument()
  })

  it('never mounts JobSuggestionDialog, even indirectly — the dialog import stays, its render does not', async () => {
    renderPage()

    await screen.findByTestId('interviews-page')
    expect(screen.queryByTestId('job-suggestion-dialog-stub')).not.toBeInTheDocument()
  })
})
