/**
 * task-project-status-filter-ui, §Что сделать item 3. This panel is DROP's
 * ONLY reachable surface for confirming/rejecting a project — see the
 * component's own doc for why. `usePendingProjectApprovals` is mocked (its
 * own bucketing logic has its own test file); `ProjectApprovalActions`
 * renders for real (a QueryClientProvider wrapper is enough to satisfy its
 * internal `useMutation` calls — its own behaviour is covered by
 * ProjectApprovalActions.test.tsx, not re-tested here).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { PendingProjectApprovalsPanel, card } from '../PendingProjectApprovalsPanel'

let mockState: {
  pending: ProjectDto[]
  isLoading: boolean
  isError: boolean
} = { pending: [], isLoading: false, isError: false }

vi.mock('@/hooks/use-project-approvals', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-project-approvals')>()
  return {
    ...real,
    usePendingProjectApprovals: () => mockState,
  }
})

function project(overrides: Partial<ProjectDto>): ProjectDto {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    name: 'Frontend platform',
    companyName: 'Acme Corp',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: '2026-01-01T00:00:00.000Z',
    seniorId: 'senior-1',
    seniorName: 'Senior One',
    dropId: null,
    dropName: null,
    dropSharePercent: null,
    rate: 3000,
    currency: 'USD',
    seniorSharePercentOverride: null,
    seniorSharePercentDefault: 26,
    members: [],
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    status: 'DRAFT',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PendingProjectApprovalsPanel />
    </QueryClientProvider>,
  )
}

describe('PendingProjectApprovalsPanel — card animation variants', () => {
  it('hidden/show carry the exact fade-up values (mutation gate: ObjectLiteral)', () => {
    expect(card).toEqual({
      hidden: { opacity: 0, y: 12 },
      show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] } },
    })
  })
})

describe('PendingProjectApprovalsPanel', () => {
  it('loading: renders the skeleton, nothing else', () => {
    mockState = { pending: [], isLoading: true, isError: false }
    renderPanel()

    expect(screen.getByTestId('pending-project-approvals-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-project-approvals-panel')).not.toBeInTheDocument()
  })

  it("error: renders nothing at all — the dashboard's own summary card already owns the error message", () => {
    mockState = { pending: [], isLoading: false, isError: true }
    const { container } = renderPanel()

    expect(container).toBeEmptyDOMElement()
  })

  it('empty (nothing pending): renders nothing — no "all clear" noise on every dashboard load', () => {
    mockState = { pending: [], isLoading: false, isError: false }
    const { container } = renderPanel()

    expect(container).toBeEmptyDOMElement()
  })

  it('with pending projects: renders the panel, one row per project, with Confirm/Reject actions', () => {
    const p1 = project({ id: 'p1', companyName: 'Acme Corp', name: 'Platform' })
    const p2 = project({ id: 'p2', companyName: 'Beta LLC', name: 'Migration' })
    mockState = { pending: [p1, p2], isLoading: false, isError: false }
    renderPanel()

    expect(screen.getByTestId('pending-project-approvals-panel')).toBeInTheDocument()
    expect(screen.getByText('Ждёт вашего решения')).toBeInTheDocument()
    expect(screen.getByTestId('pending-project-approval-p1')).toBeInTheDocument()
    expect(screen.getByTestId('pending-project-approval-p2')).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Beta LLC')).toBeInTheDocument()
    expect(screen.getByTestId('project-approval-approve-p1')).toBeInTheDocument()
    expect(screen.getByTestId('project-approval-approve-p2')).toBeInTheDocument()
  })
})
