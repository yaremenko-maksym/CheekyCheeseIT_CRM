/**
 * TransactionsTable — pins the filter / sort / empty-state behaviour that used
 * to live inline in `finance/index.tsx` (extracted verbatim, pure move).
 *
 * `TransactionRow` is stubbed to a bare `<tr>` so the assertions are about the
 * table's own filtering, sorting and chrome, not the row's per-role actions.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render as rtlRender, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
})

function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

const trackFeatureClick = vi.fn()
vi.mock('@/lib/telemetry', () => ({
  trackFeatureClick: (...args: unknown[]) => trackFeatureClick(...args),
}))

vi.mock('../TransactionRow', () => ({
  TransactionRow: ({
    tx,
    onClick,
  }: {
    tx: TransactionDto
    onClick: (tx: TransactionDto) => void
  }) => (
    <tr data-testid={`row-${tx.id}`} onClick={() => onClick(tx)}>
      <td>{tx.id}</td>
    </tr>
  ),
}))

import { TransactionsTable } from '../TransactionsTable'

function tx(overrides: Partial<TransactionDto>): TransactionDto {
  return {
    id: 'tx-1',
    type: 'ADMIN_INCOME',
    status: 'VALIDATED',
    senderName: null,
    receiverName: null,
    senderLabel: null,
    receiverLabel: null,
    projectName: null,
    amount: '100',
    currency: 'USD',
    txDate: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as unknown as TransactionDto
}

const noop = () => {}
const handlers = {
  onValidate: noop,
  onEdit: noop,
  onAdminEdit: noop,
  onDelete: noop,
  onPaySalary: noop,
  onAddSalaryPart: noop,
  onSettleSeniorPayout: noop,
  onOpenPayoutDetail: noop,
  onConfirmPayout: noop,
}

function renderTable(
  transactions: TransactionDto[],
  extra: Partial<React.ComponentProps<typeof TransactionsTable>> = {},
) {
  return render(
    <TransactionsTable
      transactions={transactions}
      loading={false}
      role="ADMIN"
      rates={undefined}
      onDetail={noop}
      {...handlers}
      {...extra}
    />,
  )
}

function rowOrder(): string[] {
  return screen.getAllByTestId(/^row-/).map((r) => r.getAttribute('data-testid')!.slice(4))
}

describe('TransactionsTable', () => {
  const a = tx({
    id: 'a',
    senderName: 'Alice Sender',
    projectName: 'Alpha',
    amount: '100',
    txDate: '2026-06-01T00:00:00.000Z',
    type: 'ADMIN_INCOME',
    status: 'VALIDATED',
  })
  const b = tx({
    id: 'b',
    receiverName: 'Bob Receiver',
    amount: '300',
    txDate: '2026-06-03T00:00:00.000Z',
    type: 'EXPENSE',
    status: 'PENDING',
  })
  const c = tx({
    id: 'c',
    senderLabel: 'Carol Label',
    amount: '200',
    txDate: '2026-06-02T00:00:00.000Z',
    type: 'ADMIN_INCOME',
    status: 'PENDING',
  })

  it('defaults to date-descending order', () => {
    renderTable([a, b, c])
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
  })

  it('toggles the date direction on a second click and sorts by amount on «Сума»', async () => {
    renderTable([a, b, c])
    const sortBar = screen.getByRole('button', { name: 'Дата' })
    await userEvent.click(sortBar)
    expect(rowOrder()).toEqual(['a', 'c', 'b'])
    await userEvent.click(sortBar)
    expect(rowOrder()).toEqual(['b', 'c', 'a'])

    await userEvent.click(screen.getByRole('button', { name: 'Сума' }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
    await userEvent.click(screen.getByRole('button', { name: 'Сума' }))
    expect(rowOrder()).toEqual(['a', 'c', 'b'])
  })

  it('filters by search across sender/receiver/label/project names, case-insensitively', async () => {
    renderTable([a, b, c])
    const input = screen.getByPlaceholderText('Пошук…')
    await userEvent.type(input, 'ALICE')
    expect(rowOrder()).toEqual(['a'])
    await userEvent.clear(input)
    await userEvent.type(input, 'bob')
    expect(rowOrder()).toEqual(['b'])
    await userEvent.clear(input)
    await userEvent.type(input, 'carol')
    expect(rowOrder()).toEqual(['c'])
    await userEvent.clear(input)
    await userEvent.type(input, 'alpha')
    expect(rowOrder()).toEqual(['a'])
  })

  it('shows the filtered empty state, then «Скинути» restores the rows', async () => {
    renderTable([a, b, c])
    await userEvent.type(screen.getByPlaceholderText('Пошук…'), 'zzz')
    expect(screen.getByText('Нічого не знайдено — скиньте фільтри')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
    expect(screen.queryByRole('button', { name: /Скинути/ })).not.toBeInTheDocument()
  })

  it('shows the unfiltered empty state when there are no transactions at all', () => {
    renderTable([])
    expect(
      screen.getByText('Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»'),
    ).toBeInTheDocument()
  })

  it('seeds the status filter from initialStatus and exposes «Скинути»', async () => {
    renderTable([a, b, c], { initialStatus: 'PENDING' })
    expect(rowOrder()).toEqual(['b', 'c'])
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
  })

  it('renders skeleton rows (and no pagination, no data rows) while loading', () => {
    renderTable([a], { loading: true })
    expect(screen.queryByTestId('row-a')).not.toBeInTheDocument()
    // 1 header row + 6 skeleton rows
    expect(screen.getAllByRole('row')).toHaveLength(7)
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
  })

  it('passes the clicked transaction to onDetail', async () => {
    const onDetail = vi.fn()
    renderTable([a], { onDetail })
    await userEvent.click(screen.getByTestId('row-a'))
    expect(onDetail).toHaveBeenCalledWith(a)
  })

  it('renders the show-deleted toggle only when a handler is passed and reflects aria-pressed', async () => {
    const { rerender } = renderTable([a])
    expect(screen.queryByTestId('finance-toggle-show-deleted')).not.toBeInTheDocument()

    const onToggle = vi.fn()
    rerender(
      <TransactionsTable
        transactions={[a]}
        loading={false}
        role="ADMIN"
        rates={undefined}
        onDetail={noop}
        {...handlers}
        showDeleted
        onToggleShowDeleted={onToggle}
      />,
    )
    const toggle = screen.getByTestId('finance-toggle-show-deleted')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    trackFeatureClick.mockClear()
    await userEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(trackFeatureClick).toHaveBeenCalledWith('finance-filter-change')
  })
})
