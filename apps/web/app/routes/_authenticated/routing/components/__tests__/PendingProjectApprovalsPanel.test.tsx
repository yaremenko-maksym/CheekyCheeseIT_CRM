/**
 * task-pending-screen (SR-L-6, #646 security review round 4). Was mocking
 * `usePendingProjectApprovals` (full `ProjectDto[]` from `GET /projects`,
 * viewer-role/share-percent rendering baked into the widget itself) — now
 * mocks `usePendingItems` (`GET /pending`, already scoped/masked server-side
 * per SR-L-6's own doc in the component file). The old "visiblePending
 * viewer-role gate" / share-percent describe blocks are GONE along with the
 * code they tested — `mine` from `GET /pending` is per-viewer by
 * construction (`ApprovalsService.listPendingForApprover`), and
 * `PendingItem` for `PROJECT_APPROVAL` carries no share field at all (see
 * the component's own "ASSUMPTION / KNOWN REGRESSION" doc).
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PendingItem } from '@crm/shared'
import { PendingProjectApprovalsPanel, card } from '../PendingProjectApprovalsPanel'

let mockState: {
  mine: PendingItem[]
  isLoading: boolean
  isError: boolean
  dataUpdatedAt: number
} = { mine: [], isLoading: false, isError: false, dataUpdatedAt: 0 }

const mockApprove = vi.fn()
const mockReject = vi.fn()

vi.mock('@/hooks/use-pending-items', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-pending-items')>()
  return {
    ...real,
    usePendingItems: () => mockState,
  }
})

vi.mock('@/hooks/use-project-approvals', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-project-approvals')>()
  return {
    ...real,
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

// SR-L-3 (PR #667 fix-round 2): `pendingItemSchema` is now a
// `z.discriminatedUnion('kind', ...)` — the `kind: 'SHARE_APPROVAL'` override
// below (line ~122, deliberately WITHOUT currentPercent/pendingPercent —
// this test only checks that the widget filters non-PROJECT_APPROVAL rows
// out) does not satisfy `Partial<PendingItem>` any more. Permissive override
// type + a cast on the return, same pattern as PendingItemRow.test.tsx /
// pending/__tests__/index.test.tsx.
interface PendingItemOverrides {
  kind?: PendingItem['kind']
  subjectType?: PendingItem['subjectType']
  subjectId?: string
  title?: string
  proposedBy?: string
  waitingFor?: string[]
  createdAt?: string
  actions?: PendingItem['actions']
  link?: string
  approvalId?: string
  viewerSharePercent?: number | null
  seniorName?: string | null
  currentPercent?: number
  pendingPercent?: number
}

function pendingItem(overrides: PendingItemOverrides): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectType: 'PROJECT',
    subjectId: '00000000-0000-0000-0000-0000000000a1',
    title: 'Acme Corp',
    proposedBy: 'Олексій Коваленко',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvalId: '00000000-0000-4000-8000-0000000000a1',
    viewerSharePercent: 26,
    seniorName: null,
    actions: ['approve', 'reject', 'open'],
    link: '/projects/00000000-0000-0000-0000-0000000000a1',
    ...overrides,
  } as unknown as PendingItem
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PendingProjectApprovalsPanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockState = { mine: [], isLoading: false, isError: false, dataUpdatedAt: 0 }
  mockApprove.mockReset()
  mockReject.mockReset()
})

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
    mockState = { ...mockState, isLoading: true }
    renderPanel()
    expect(screen.getByTestId('pending-project-approvals-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-project-approvals-panel')).not.toBeInTheDocument()
  })

  it('error: shows a one-line message instead of silently rendering nothing — a DROP who can never see /projects had no other way to learn the check failed', () => {
    mockState = { ...mockState, isError: true }
    renderPanel()
    expect(screen.getByTestId('pending-project-approvals-error')).toHaveTextContent(
      'Не удалось проверить, ждёт ли вас решение по проекту.',
    )
  })

  it('empty (nothing pending): renders nothing — no "all clear" noise on every dashboard load', () => {
    mockState = { ...mockState, mine: [] }
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it('items whose kind is NOT PROJECT_APPROVAL are filtered out (mine may also carry SHARE_APPROVAL/CONTRACT_TO_SIGN — this widget is projects-only)', () => {
    mockState = {
      ...mockState,
      mine: [pendingItem({ kind: 'SHARE_APPROVAL', subjectId: 'share-1' })],
    }
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it('with pending items: renders the panel, one row per item, with Confirm/Reject actions', () => {
    mockState = {
      ...mockState,
      mine: [
        pendingItem({ subjectId: 'p1', title: 'Acme Corp' }),
        pendingItem({ subjectId: 'p2', title: 'TechFlow Solutions', proposedBy: 'Ірина Савенко' }),
      ],
    }
    renderPanel()

    expect(screen.getByTestId('pending-project-approvals-panel')).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('TechFlow Solutions')).toBeInTheDocument()
    expect(screen.getByText('Предложил Ірина Савенко')).toBeInTheDocument()
    expect(screen.getByTestId('project-approval-approve-p1')).toBeInTheDocument()
    expect(screen.getByTestId('project-approval-reject-p1')).toBeInTheDocument()
    // Row container carries its OWN testid (keyed on subjectId), independent
    // of ProjectApprovalActions' own — a stable hook for anything that needs
    // "the whole row for id X", not just its action buttons.
    expect(screen.getByTestId('pending-project-approval-p1')).toBeInTheDocument()
    expect(screen.getByTestId('pending-project-approval-p2')).toBeInTheDocument()
  })

  it('an item with no `proposedBy` renders no "Предложил …" line (fail-safe — should not happen for this kind, but does not crash)', () => {
    // `exactOptionalPropertyTypes` rejects an explicit `undefined` value —
    // destructuring it off is what actually omits the key.
    const { proposedBy: _unused, ...withoutProposedBy } = pendingItem({})
    mockState = { ...mockState, mine: [withoutProposedBy] }
    renderPanel()
    expect(screen.queryByText(/^Предложил/)).not.toBeInTheDocument()
  })

  it('the widget mount never hides the Confirm/Reject labels — no `compact` prop, at any width', () => {
    mockState = { ...mockState, mine: [pendingItem({})] }
    renderPanel()
    // ProjectApprovalActions' `compact` prop hides the text label at `lg:`
    // via `lg:hidden xl:inline` — asserting the plain, unconditional class
    // (no responsive hide) proves this mount point never passes `compact`.
    const approveLabel = screen.getByText('Подтвердить')
    expect(approveLabel.className).not.toMatch(/lg:hidden/)
  })
})

describe('PendingProjectApprovalsPanel — local dismiss on onActed', () => {
  it('hides ONLY the acted-on item immediately, without the mocked `mine` array ever changing', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [
        pendingItem({ subjectId: 'p1', title: 'Acme Corp' }),
        pendingItem({ subjectId: 'p2', title: 'TechFlow' }),
      ],
    }
    renderPanel()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    // approve mutate was called with a success callback — invoke it the way
    // ProjectApprovalActions itself does, to observe the panel's onActed.
    const [, options] = mockApprove.mock.calls[0] as [string, { onSuccess?: (d: unknown) => void }]
    act(() => options.onSuccess?.({ status: 'ACTIVE', dropApprovalPending: false }))

    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
    expect(screen.getByText('TechFlow')).toBeInTheDocument()
  })

  it('dismissing the LAST visible item removes the whole card — same "nothing pending" contract as an empty fetch', async () => {
    const user = userEvent.setup()
    mockState = { ...mockState, mine: [pendingItem({ subjectId: 'p1' })] }
    const { container } = renderPanel()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })
    const [, options] = mockApprove.mock.calls[0] as [string, { onSuccess?: (d: unknown) => void }]
    act(() => options.onSuccess?.({ status: 'ACTIVE' }))

    expect(container).toBeEmptyDOMElement()
  })

  it('a fresh fetch (dataUpdatedAt changes) prunes a dismissal for an item no longer in `mine` — a later re-proposal of the same id is not hidden forever', () => {
    mockState = { ...mockState, mine: [pendingItem({ subjectId: 'p1' })], dataUpdatedAt: 1 }
    const { rerender } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )
    // Simulate: item was dismissed, then vanished from a fresh fetch, then
    // (re-proposal) came back under a NEW dataUpdatedAt — the effect should
    // have pruned the stale dismissal on the empty-fetch step, so the
    // returning item is visible again, not hidden forever.
    mockState = { ...mockState, mine: [], dataUpdatedAt: 2 }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )
    mockState = {
      ...mockState,
      mine: [pendingItem({ subjectId: 'p1', title: 'Acme Corp' })],
      dataUpdatedAt: 3,
    }
    rerender(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('does NOT prune a dismissal for an item that is STILL in `mine` on a fresh fetch — only a VANISHED id should be pruned', async () => {
    const user = userEvent.setup()
    mockState = {
      mine: [
        pendingItem({ subjectId: 'p1', title: 'Acme Corp' }),
        pendingItem({ subjectId: 'p2', title: 'TechFlow Solutions' }),
      ],
      isLoading: false,
      isError: false,
      dataUpdatedAt: 1,
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })
    const [, options] = mockApprove.mock.calls[0] as [string, { onSuccess?: (d: unknown) => void }]
    act(() => options.onSuccess?.({ status: 'ACTIVE' }))
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()

    // A fresh fetch lands (dataUpdatedAt changes) — p1 is STILL in `mine`
    // (e.g. waiting on the OTHER invited approver). The dismissal must
    // survive this fetch (SAME component instance, via `rerender`, so
    // `dismissedIds` state is preserved): p1 stays hidden, it does not
    // reappear just because a refetch happened.
    mockState = { ...mockState, dataUpdatedAt: 2 }
    rerender(
      <QueryClientProvider client={qc}>
        <PendingProjectApprovalsPanel />
      </QueryClientProvider>,
    )

    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
    expect(screen.getByText('TechFlow Solutions')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Integration decision 2 (2026-09-11): the share line is back, fed by the
// server's own per-viewer fields instead of by the client picking a figure
// out of a DTO that carried both sides'. The three cases below are the same
// three the pre-SR-L-6 widget had (drop / senior / missing figure), rewritten
// against `PendingItem`.
// ---------------------------------------------------------------------------
describe('PendingProjectApprovalsPanel — viewer share line', () => {
  it("renders the DROP viewer's own share together with the senior's name", () => {
    mockState = {
      mine: [pendingItem({ viewerSharePercent: 9, seniorName: 'Олексій Коваленко' })],
      isLoading: false,
      isError: false,
      dataUpdatedAt: 1,
    }
    renderPanel()
    expect(screen.getByText('Ваша доля: 9% · синьор: Олексій Коваленко')).toBeInTheDocument()
  })

  it("renders a SENIOR viewer's own share with no senior name appended (they are the senior)", () => {
    mockState = {
      mine: [pendingItem({ viewerSharePercent: 26, seniorName: null })],
      isLoading: false,
      isError: false,
      dataUpdatedAt: 1,
    }
    renderPanel()
    expect(screen.getByText('Ваша доля: 26%')).toBeInTheDocument()
    expect(screen.queryByText(/синьор:/)).not.toBeInTheDocument()
  })

  it('falls back to the whole "Доля неизвестна" sentence when the server sent no figure', () => {
    mockState = {
      mine: [pendingItem({ viewerSharePercent: null, seniorName: null })],
      isLoading: false,
      isError: false,
      dataUpdatedAt: 1,
    }
    renderPanel()
    expect(screen.getByText('Доля неизвестна. Обновите страницу.')).toBeInTheDocument()
    expect(screen.queryByText(/Ваша доля/)).not.toBeInTheDocument()
  })
})

// SR-L-6's "widget never requests /projects" claim is structural, not just
// tested in isolation: this component only ever calls `usePendingItems()`
// (proven throughout this file — every render above goes through the SAME
// mocked hook) — see `use-pending-items.test.ts` for the hook itself only
// ever calling `api.get('/pending')`, and `pending.spec.ts` (E2E) for the
// live-network version of this exact assertion on the DROP dashboard.
