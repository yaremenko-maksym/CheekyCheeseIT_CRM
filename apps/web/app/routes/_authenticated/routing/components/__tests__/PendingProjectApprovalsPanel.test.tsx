/**
 * task-project-status-filter-ui, §Что сделать item 3. This panel is DROP's
 * ONLY reachable surface for confirming/rejecting a project — see the
 * component's own doc for why. `usePendingProjectApprovals` is mocked (its
 * own bucketing logic has its own test file); `ProjectApprovalActions`
 * renders for real, with its two mutation hooks mocked the same way
 * `ProjectApprovalActions.test.tsx` mocks them — that file covers the
 * Confirm/Reject mechanics themselves, this one only what the PANEL does
 * once a mutation settles.
 *
 * The "local-dismiss" describe block below mocks `useApproveProjectDraft`/
 * `useRejectProjectDraft` too (same pattern as ProjectApprovalActions.test.tsx)
 * — found live on the real stack while verifying AC3 for DROP: a project
 * with BOTH a senior and a drop invited stays `status: 'DRAFT'` after only
 * ONE of them decides (business spec §4.1 partial agreement), so
 * `usePendingProjectApprovals`'s own DRAFT-only bucketing cannot make the
 * just-acted-on item disappear by itself — these tests pin that the panel
 * hides it locally via `onActed`, without depending on the mocked
 * `pending` array ever changing.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { PendingProjectApprovalsPanel, card } from '../PendingProjectApprovalsPanel'

let mockState: {
  pending: ProjectDto[]
  isLoading: boolean
  isError: boolean
  dataUpdatedAt: number
} = { pending: [], isLoading: false, isError: false, dataUpdatedAt: 0 }

const mockApprove = vi.fn()
const mockReject = vi.fn()

vi.mock('@/hooks/use-project-approvals', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-project-approvals')>()
  return {
    ...real,
    usePendingProjectApprovals: () => mockState,
    useApproveProjectDraft: () => ({
      mutate: mockApprove,
      isPending: false,
      isError: false,
      error: null,
    }),
    useRejectProjectDraft: () => ({
      mutate: mockReject,
      isPending: false,
      isError: false,
      error: null,
    }),
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
    mockState = { pending: [], isLoading: true, isError: false, dataUpdatedAt: 0 }
    renderPanel()

    expect(screen.getByTestId('pending-project-approvals-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-project-approvals-panel')).not.toBeInTheDocument()
  })

  it("error: renders nothing at all — the dashboard's own summary card already owns the error message", () => {
    mockState = { pending: [], isLoading: false, isError: true, dataUpdatedAt: 0 }
    const { container } = renderPanel()

    expect(container).toBeEmptyDOMElement()
  })

  it('empty (nothing pending): renders nothing — no "all clear" noise on every dashboard load', () => {
    mockState = { pending: [], isLoading: false, isError: false, dataUpdatedAt: 0 }
    const { container } = renderPanel()

    expect(container).toBeEmptyDOMElement()
  })

  it('with pending projects: renders the panel, one row per project, with Confirm/Reject actions', () => {
    const p1 = project({ id: 'p1', companyName: 'Acme Corp', name: 'Platform' })
    const p2 = project({ id: 'p2', companyName: 'Beta LLC', name: 'Migration' })
    mockState = { pending: [p1, p2], isLoading: false, isError: false, dataUpdatedAt: 1 }
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

describe('PendingProjectApprovalsPanel — local dismiss on onActed', () => {
  it('hides ONLY the acted-on item immediately, without the mocked `pending` array ever changing', async () => {
    const user = userEvent.setup()
    const p1 = project({ id: 'p1', companyName: 'Acme Corp', name: 'Platform' })
    const p2 = project({ id: 'p2', companyName: 'Beta LLC', name: 'Migration' })
    // Fixed reference — proves the panel does NOT rely on a parent re-fetch
    // (a project with both a senior and a drop invited stays DRAFT, and
    // thus stays in `pending`, after only one of them decides).
    mockState = { pending: [p1, p2], isLoading: false, isError: false, dataUpdatedAt: 1 }
    mockApprove.mockImplementation((_projectId: string, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    )
    renderPanel()

    await user.click(screen.getByTestId('project-approval-approve-p1'))

    expect(screen.queryByTestId('pending-project-approval-p1')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-project-approval-p2')).toBeInTheDocument()
    // The source data the hook reports is untouched — this is a client-only
    // dismiss, not a side effect on the mock.
    expect(mockState.pending).toHaveLength(2)
  })

  it('dismissing the LAST visible item removes the whole card — same "nothing pending" contract as an empty fetch', async () => {
    const user = userEvent.setup()
    const p1 = project({ id: 'p1', companyName: 'Acme Corp', name: 'Platform' })
    mockState = { pending: [p1], isLoading: false, isError: false, dataUpdatedAt: 1 }
    mockApprove.mockImplementation((_projectId: string, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    )
    const { container } = renderPanel()

    await user.click(screen.getByTestId('project-approval-approve-p1'))

    expect(container).toBeEmptyDOMElement()
  })

  it('a fresh fetch (dataUpdatedAt changes) prunes a dismissal for an item no longer in `pending` — a later re-proposal of the same id is not hidden forever', async () => {
    const user = userEvent.setup()
    const p1 = project({ id: 'p1', companyName: 'Acme Corp', name: 'Platform' })
    mockState = { pending: [p1], isLoading: false, isError: false, dataUpdatedAt: 1 }
    mockApprove.mockImplementation((_projectId: string, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    )
    const { rerender } = renderPanel()

    await user.click(screen.getByTestId('project-approval-approve-p1'))
    expect(screen.queryByTestId('pending-project-approval-p1')).not.toBeInTheDocument()

    // The project left `pending` for good (e.g. it went ACTIVE) — a fresh
    // fetch reports it gone, which prunes the now-pointless dismissal...
    mockState = { pending: [], isLoading: false, isError: false, dataUpdatedAt: 2 }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )

    // ...so when the SAME id later comes back (reject → re-propose, business
    // spec re-proposal history), it is shown again, not hidden forever.
    act(() => {
      mockState = { pending: [p1], isLoading: false, isError: false, dataUpdatedAt: 3 }
    })
    rerender(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )

    expect(screen.getByTestId('pending-project-approval-p1')).toBeInTheDocument()
  })
})
