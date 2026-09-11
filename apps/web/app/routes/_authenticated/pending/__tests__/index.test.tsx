/**
 * task-pending-screen (position 7c). `/pending` — AC6 (states) + the parts
 * of AC4 that belong to the PAGE itself (grouping by kind, local-dismiss,
 * the two zones' independent visibility per design spec §3). Individual
 * action components (ProjectApprovalActions, SeniorShareApprovalActions,
 * CancelPendingShareButton) have their own test files — this one mounts
 * them for REAL (under a QueryClient) to prove the page wires kind → row →
 * action correctly, without re-testing each action's own mutation mechanics.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PendingItem } from '@crm/shared'
import { api } from '@/lib/axios'
import { PendingPage } from '../index'

const mockPost = api.post as ReturnType<typeof vi.fn>

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (orig) => {
  const real = await orig<typeof import('@tanstack/react-router')>()
  return { ...real, useNavigate: () => mockNavigate, Link: real.Link }
})

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

let mockState: {
  mine: PendingItem[]
  proposedByMe: PendingItem[]
  isLoading: boolean
  isError: boolean
  dataUpdatedAt: number
  refetch: () => void
} = {
  mine: [],
  proposedByMe: [],
  isLoading: false,
  isError: false,
  dataUpdatedAt: 0,
  refetch: vi.fn(),
}

vi.mock('@/hooks/use-pending-items', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-pending-items')>()
  return { ...real, usePendingItems: () => mockState }
})

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectType: 'PROJECT',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    proposedBy: 'Admin One',
    createdAt: new Date().toISOString(),
    actions: ['approve', 'reject', 'open'],
    link: '/projects/subj-1',
    ...overrides,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PendingPage />
    </QueryClientProvider>,
  )
}

const refetchSpy = vi.fn()

beforeEach(() => {
  mockState = {
    mine: [],
    proposedByMe: [],
    isLoading: false,
    isError: false,
    dataUpdatedAt: 0,
    refetch: refetchSpy,
  }
  refetchSpy.mockReset()
})

describe('/pending — AC6 states', () => {
  it('loading: shows the skeleton, not the page content', () => {
    mockState = { ...mockState, isLoading: true }
    renderPage()
    expect(screen.getByTestId('pending-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
  })

  it('error: shows the message + Повторить, which calls refetch', () => {
    mockState = { ...mockState, isError: true }
    renderPage()
    expect(screen.getByTestId('pending-error')).toBeInTheDocument()
    // Accessible name is the `aria-label` ("Повторить загрузку" — same
    // DropBalanceCard.tsx precedent), not the shorter visible text.
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }))
    expect(refetchSpy).toHaveBeenCalledTimes(1)
  })

  it('both zones empty: shows the global empty state with the exact copy', () => {
    renderPage()
    expect(screen.getByTestId('pending-empty')).toBeInTheDocument()
    expect(screen.getByText('Ничего не ждёт вашего решения')).toBeInTheDocument()
  })

  it('mine empty but proposedByMe non-empty (ADMIN with nothing of their own): shows ONLY «Ждут решения других», not the global empty state', () => {
    mockState = {
      ...mockState,
      proposedByMe: [
        item({
          kind: 'SHARE_APPROVAL',
          waitingFor: ['Some Senior'],
          pendingPercent: 30,
          actions: ['cancel'],
        }),
      ],
    }
    renderPage()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
    expect(screen.getByText('Ждут решения других')).toBeInTheDocument()
    expect(screen.queryByText('Ждут вашего решения')).not.toBeInTheDocument()
  })
})

describe('/pending — grouping by kind', () => {
  it('mine with all three kinds: sections render in Проекты → Доли → Контракты order', () => {
    mockState = {
      ...mockState,
      mine: [
        item({
          kind: 'CONTRACT_TO_SIGN',
          subjectId: 'c1',
          title: 'Контракт сотрудника',
          actions: ['open'],
        }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectId: 's1',
          title: 'Доля по умолчанию',
          pendingPercent: 30,
        }),
        item({ kind: 'PROJECT_APPROVAL', subjectId: 'p1', title: 'Acme Corp' }),
      ],
    }
    renderPage()
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Проекты', 'Доли', 'Контракты'])
  })

  it('an item whose kind matches none of the three known kinds renders under a «Другое» fallback section, not silently dropped', () => {
    mockState = {
      ...mockState,
      mine: [{ ...item({}), kind: 'SOMETHING_NEW' } as unknown as PendingItem],
    }
    renderPage()
    expect(screen.getByText('Другое')).toBeInTheDocument()
  })
})

describe('/pending — AC4: end-to-end local dismiss through a REAL action component', () => {
  it('confirming a project from the page removes the row without waiting for a refetch', async () => {
    const user = userEvent.setup()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: { status: 'ACTIVE' } })
    mockState = { ...mockState, mine: [item({ subjectId: 'p1', title: 'Acme Corp' })] }
    renderPage()

    expect(screen.getByText('Acme Corp')).toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
  })
})
