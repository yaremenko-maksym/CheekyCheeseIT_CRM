/**
 * Mikado leaf 6 ($projectId.tsx decomposition) — characterization of the finance-tab
 * component moved into `ProjectTransactions.tsx`.
 *
 * Pins the CURRENT behaviour: the queries it fires, loading / empty / table states,
 * what it hands to its row/dialog/share/distribution children, and the role gate for
 * the drop-distribution panel and the pending-share cancel flag. Children are stubbed
 * as thin prop-echo components: their own behaviour is covered by their own tests.
 * Expected values are hand-written literals.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetailDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ProjectTransactions } from '../ProjectTransactions'

const mocks = vi.hoisted(() => ({
  user: null as null | { id: string; role: string },
  getTransactions: vi.fn(),
  apiGet: vi.fn(),
}))

vi.mock('@/context/auth', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('@/lib/axios', () => ({ api: { get: mocks.apiGet } }))
vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: { getTransactions: mocks.getTransactions },
}))
vi.mock('@/routes/_authenticated/finance/components/TransactionRow', () => ({
  TransactionRow: (p: {
    tx: { id: string }
    role: string
    rates?: { usdToUah?: number }
    currentUserId: string
    onClick: (tx: { id: string }) => void
  }) => (
    <tr data-testid={`row-${p.tx.id}`}>
      <td>
        <button
          type="button"
          data-testid={`row-btn-${p.tx.id}`}
          data-role={p.role}
          data-user={p.currentUserId}
          data-rate={String(p.rates?.usdToUah)}
          onClick={() => p.onClick(p.tx)}
        >
          open
        </button>
      </td>
    </tr>
  ),
}))
vi.mock('@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog', () => ({
  TransactionDetailDialog: (p: { tx: { id: string } | null; onClose: () => void }) => (
    <div data-testid="detail-dialog" data-tx={p.tx?.id ?? 'none'}>
      <button type="button" data-testid="detail-close" onClick={p.onClose}>
        close
      </button>
    </div>
  ),
}))
vi.mock('../ProjectInfoRows', () => ({
  ProjectShareInfo: (p: Record<string, unknown>) => (
    <div
      data-testid="share-info"
      data-variant={String(p.variant)}
      data-test-id={String(p.testId)}
      data-badge-test-id={String(p.badgeTestId)}
      data-can-cancel={String(p.canCancelPendingShare)}
      data-viewer={String(p.viewerId)}
    />
  ),
}))
vi.mock('../ProjectTeamCards', () => ({
  ProjectDropDistribution: () => <div data-testid="drop-distribution" />,
}))

const PROJECT_ID = 'b0000000-0000-4000-8000-000000000001'
const SENIOR_ID = 'u0000000-0000-4000-8000-000000000002'
const DROP_ID = 'u0000000-0000-4000-8000-000000000003'

function project(overrides: Record<string, unknown> = {}): ProjectDetailDto {
  return {
    id: PROJECT_ID,
    seniorId: SENIOR_ID,
    dropId: DROP_ID,
    ...overrides,
  } as unknown as ProjectDetailDto
}

const TXS = [{ id: 'tx-1' }, { id: 'tx-2' }]

function renderIt(p: ProjectDetailDto = project()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ProjectTransactions projectId={PROJECT_ID} project={p} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  mocks.user = { id: 'viewer-1', role: 'ADMIN' }
  mocks.getTransactions.mockReset()
  mocks.getTransactions.mockResolvedValue(TXS)
  mocks.apiGet.mockReset()
  mocks.apiGet.mockResolvedValue({ data: { usdToUah: 41.5 } })
})

describe('ProjectTransactions', () => {
  it('renders nothing and fires no transactions query without a session', () => {
    mocks.user = null
    const { container } = renderIt()
    expect(container).toBeEmptyDOMElement()
    expect(mocks.getTransactions).not.toHaveBeenCalled()
  })

  it('queries transactions filtered by the project id and fetches today exchange rate', async () => {
    renderIt()
    await waitFor(() => expect(screen.getByTestId('row-tx-1')).toBeInTheDocument())
    expect(mocks.getTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.getTransactions).toHaveBeenCalledWith({ projectId: PROJECT_ID })
    expect(mocks.apiGet).toHaveBeenCalledWith('/finance/exchange-rate')
  })

  it('shows the card title and three skeleton rows while loading', () => {
    mocks.getTransactions.mockReturnValue(new Promise(() => {}))
    const { container } = renderIt()
    expect(screen.getByText('Фінанси по проєкту')).toBeInTheDocument()
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelectorAll('.space-y-2 > .h-10')).toHaveLength(3)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('Транзакцій по проєкту ще немає')).not.toBeInTheDocument()
  })

  it('shows the empty message when there are no transactions', async () => {
    mocks.getTransactions.mockResolvedValue([])
    renderIt()
    expect(await screen.findByText('Транзакцій по проєкту ще немає')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders the table headers in order and one row per transaction', async () => {
    renderIt()
    expect(await screen.findByRole('table')).toBeInTheDocument()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Тип', 'Сторони', 'Сума', 'Дата', 'Статус', ''])
    expect(screen.getByTestId('row-tx-1')).toBeInTheDocument()
    expect(screen.getByTestId('row-tx-2')).toBeInTheDocument()
    expect(screen.queryByText('Транзакцій по проєкту ще немає')).not.toBeInTheDocument()
  })

  it('hands role, current user id and loaded rates to every row', async () => {
    mocks.user = { id: 'viewer-9', role: 'ACCOUNTANT' }
    renderIt()
    const btn = await screen.findByTestId('row-btn-tx-2')
    expect(btn).toHaveAttribute('data-role', 'ACCOUNTANT')
    expect(btn).toHaveAttribute('data-user', 'viewer-9')
    await waitFor(() => expect(btn).toHaveAttribute('data-rate', '41.5'))
  })

  it('opens the detail dialog for the clicked row and clears it on close', async () => {
    renderIt()
    expect(screen.getByTestId('detail-dialog')).toHaveAttribute('data-tx', 'none')
    await userEvent.click(await screen.findByTestId('row-btn-tx-2'))
    expect(screen.getByTestId('detail-dialog')).toHaveAttribute('data-tx', 'tx-2')
    await userEvent.click(screen.getByTestId('detail-close'))
    expect(screen.getByTestId('detail-dialog')).toHaveAttribute('data-tx', 'none')
  })

  it('renders the inline share info with its testids and the viewer id', async () => {
    renderIt()
    expect(screen.getByTestId('project-transactions-share-row')).toBeInTheDocument()
    const share = screen.getByTestId('share-info')
    expect(share).toHaveAttribute('data-variant', 'inline')
    expect(share).toHaveAttribute('data-test-id', 'project-transactions-senior-share')
    expect(share).toHaveAttribute(
      'data-badge-test-id',
      'project-transactions-senior-share-override-badge',
    )
    expect(share).toHaveAttribute('data-viewer', 'viewer-1')
    await screen.findByTestId('row-tx-1')
  })

  it.each([
    ['ADMIN', 'true'],
    ['ACCOUNTANT', 'true'],
    ['SENIOR', 'false'],
    ['DROP', 'false'],
  ])('canCancelPendingShare for %s is %s', async (role, expected) => {
    mocks.user = { id: 'viewer-1', role }
    renderIt()
    expect(screen.getByTestId('share-info')).toHaveAttribute('data-can-cancel', expected)
    await screen.findByTestId('row-tx-1')
  })

  describe('drop distribution panel visibility', () => {
    it.each([['ADMIN'], ['ACCOUNTANT']])(
      'visible to %s when the project has a drop',
      async (role) => {
        mocks.user = { id: 'viewer-1', role }
        renderIt()
        expect(screen.getByTestId('drop-distribution')).toBeInTheDocument()
        await screen.findByTestId('row-tx-1')
      },
    )

    it('visible to the project own SENIOR', async () => {
      mocks.user = { id: SENIOR_ID, role: 'SENIOR' }
      renderIt()
      expect(screen.getByTestId('drop-distribution')).toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })

    it('hidden from a SENIOR who is not the project senior', async () => {
      mocks.user = { id: 'other', role: 'SENIOR' }
      renderIt()
      expect(screen.queryByTestId('drop-distribution')).not.toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })

    it('visible to the project own DROP', async () => {
      mocks.user = { id: DROP_ID, role: 'DROP' }
      renderIt()
      expect(screen.getByTestId('drop-distribution')).toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })

    it('hidden from a DROP who is not the project drop', async () => {
      mocks.user = { id: 'other', role: 'DROP' }
      renderIt()
      expect(screen.queryByTestId('drop-distribution')).not.toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })

    it('a SENIOR id never grants DROP visibility and vice versa', async () => {
      mocks.user = { id: DROP_ID, role: 'SENIOR' }
      renderIt()
      expect(screen.queryByTestId('drop-distribution')).not.toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })

    it('hidden from everyone when the project has no drop', async () => {
      mocks.user = { id: 'viewer-1', role: 'ADMIN' }
      renderIt(project({ dropId: null }))
      expect(screen.queryByTestId('drop-distribution')).not.toBeInTheDocument()
      await screen.findByTestId('row-tx-1')
    })
  })
})
