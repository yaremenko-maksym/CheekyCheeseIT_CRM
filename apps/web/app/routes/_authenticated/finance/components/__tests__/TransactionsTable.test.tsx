/**
 * TransactionsTable — pins the filter / sort / empty-state behaviour that used
 * to live inline in `finance/index.tsx` (extracted verbatim, pure move).
 *
 * `TransactionRow` is stubbed to a bare `<tr>` so the assertions are about the
 * table's own filtering, sorting and chrome, not the row's per-role actions.
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, within, act, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
  // Radix Select needs these pointer/scroll APIs, which jsdom does not provide.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

afterEach(async () => {
  await loadCatalog('uk')
})

function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const animatePresenceProps = vi.hoisted(() => vi.fn())
vi.mock('framer-motion', () => ({
  AnimatePresence: (props: { children: React.ReactNode }) => {
    animatePresenceProps(props)
    return props.children
  },
}))

const trackFeatureClick = vi.fn()
vi.mock('@/lib/telemetry', () => ({
  trackFeatureClick: (...args: unknown[]) => trackFeatureClick(...args),
}))

vi.mock('../TransactionRow', () => ({
  TransactionRow: ({
    tx,
    onClick,
    currentUserId,
  }: {
    tx: TransactionDto
    onClick: (tx: TransactionDto) => void
    currentUserId: string | null
  }) => (
    <tr
      data-testid={`row-${tx.id}`}
      data-current-user={String(currentUserId)}
      onClick={() => onClick(tx)}
    >
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

type TableProps = React.ComponentProps<typeof TransactionsTable>

function renderTable(transactions: TransactionDto[], extra: Partial<TableProps> = {}) {
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

async function chooseOption(comboboxIndex: number, optionName: string) {
  await userEvent.click(screen.getAllByRole('combobox')[comboboxIndex]!)
  await userEvent.click(await screen.findByRole('option', { name: optionName }))
}

const COLUMN_HEADERS = ['Тип', 'Учасник / Проєкт', 'Сума', 'Дата', 'Статус', 'Дії']

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

  beforeEach(() => {
    trackFeatureClick.mockClear()
  })

  it('defaults to date-descending order', () => {
    renderTable([a, b, c])
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
  })

  it('sorts by date and by amount independently, flipping direction on a repeat click', async () => {
    // Dates and amounts are deliberately anti-correlated so the two sort keys
    // can never be confused for one another.
    const x = tx({ id: 'x', amount: '500', txDate: '2026-06-01T00:00:00.000Z' })
    const y = tx({ id: 'y', amount: '100', txDate: '2026-06-05T00:00:00.000Z' })
    const z = tx({ id: 'z', amount: '300', txDate: '2026-06-03T00:00:00.000Z' })
    renderTable([x, y, z])
    expect(rowOrder()).toEqual(['y', 'z', 'x'])

    await userEvent.click(screen.getByRole('button', { name: 'Дата' }))
    expect(rowOrder()).toEqual(['x', 'z', 'y'])
    await userEvent.click(screen.getByRole('button', { name: 'Дата' }))
    expect(rowOrder()).toEqual(['y', 'z', 'x'])

    // Switching key resets the direction to descending.
    await userEvent.click(screen.getByRole('button', { name: 'Сума' }))
    expect(rowOrder()).toEqual(['x', 'z', 'y'])
    await userEvent.click(screen.getByRole('button', { name: 'Сума' }))
    expect(rowOrder()).toEqual(['y', 'z', 'x'])

    // Back to date: direction is reset to descending again.
    await userEvent.click(screen.getByRole('button', { name: 'Дата' }))
    expect(rowOrder()).toEqual(['y', 'z', 'x'])
    await userEvent.click(screen.getByRole('button', { name: 'Дата' }))
    expect(rowOrder()).toEqual(['x', 'z', 'y'])
  })

  it('marks the active sort button, shows the chevron only on it and rotates it for ascending', async () => {
    renderTable([a, b, c])
    const date = screen.getByRole('button', { name: 'Дата' })
    const amount = screen.getByRole('button', { name: 'Сума' })

    expect(date).toHaveClass(
      'rounded-md',
      'h-8',
      'border-primary/40',
      'bg-primary/10',
      'text-primary',
    )
    expect(amount).toHaveClass(
      'rounded-md',
      'h-8',
      'border-border',
      'bg-muted/30',
      'text-muted-foreground',
    )
    expect(date.innerHTML).toContain('lucide-chevron-down')
    expect(date.innerHTML).toContain('transition-transform')
    expect(date.innerHTML).not.toContain('rotate-180')
    expect(amount.innerHTML).not.toContain('lucide-chevron-down')

    await userEvent.click(date)
    expect(date.innerHTML).toContain('rotate-180')

    await userEvent.click(amount)
    expect(amount).toHaveClass('text-primary')
    expect(date).toHaveClass('text-muted-foreground')
    expect(date.innerHTML).not.toContain('lucide-chevron-down')
    expect(amount.innerHTML).toContain('lucide-chevron-down')
    expect(amount.innerHTML).not.toContain('rotate-180')
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

  it('joins the searchable fields with exactly one space and skips empty ones', async () => {
    renderTable([a, b, c])
    const input = screen.getByPlaceholderText('Пошук…')
    // senderName + projectName of `a` are adjacent after empty fields are dropped.
    await userEvent.type(input, 'sender alpha')
    expect(rowOrder()).toEqual(['a'])
    await userEvent.clear(input)
    await userEvent.type(input, 'sender  alpha')
    expect(screen.queryAllByTestId(/^row-/)).toHaveLength(0)
    await userEvent.clear(input)
    await userEvent.type(input, 'senderalpha')
    expect(screen.queryAllByTestId(/^row-/)).toHaveLength(0)
  })

  it('filters by type and by status through the selects and reports telemetry', async () => {
    renderTable([a, b, c])
    await chooseOption(0, 'Витрата')
    expect(rowOrder()).toEqual(['b'])
    expect(trackFeatureClick).toHaveBeenCalledWith('finance-filter-change')

    await chooseOption(0, 'Усі типи')
    expect(rowOrder()).toEqual(['b', 'c', 'a'])

    trackFeatureClick.mockClear()
    await chooseOption(1, 'Підтверджено')
    expect(rowOrder()).toEqual(['a'])
    expect(trackFeatureClick).toHaveBeenCalledWith('finance-filter-change')

    await chooseOption(1, 'Очікує валідації')
    expect(rowOrder()).toEqual(['b', 'c'])
  })

  it('combines the type and status filters and «Скинути» resets both', async () => {
    renderTable([a, b, c])
    await chooseOption(0, 'Дохід адміна')
    await chooseOption(1, 'Очікує валідації')
    expect(rowOrder()).toEqual(['c'])
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
    const [typeSelect, statusSelect] = screen.getAllByRole('combobox')
    expect(typeSelect).toHaveTextContent('Усі типи')
    expect(statusSelect).toHaveTextContent('Усі статуси')
  })

  it('shows «Скинути» for a type-only, status-only or search-only filter', async () => {
    renderTable([a, b, c])
    expect(screen.queryByRole('button', { name: /Скинути/ })).not.toBeInTheDocument()
    await chooseOption(0, 'Витрата')
    expect(screen.getByRole('button', { name: /Скинути/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    await chooseOption(1, 'Підтверджено')
    expect(screen.getByRole('button', { name: /Скинути/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    await userEvent.type(screen.getByPlaceholderText('Пошук…'), 'x')
    expect(screen.getByRole('button', { name: /Скинути/ })).toBeInTheDocument()
  })

  it('lists every type / status option plus the «all» entry under the placeholder', async () => {
    renderTable([a])
    const [typeSelect, statusSelect] = screen.getAllByRole('combobox')
    expect(typeSelect).toHaveTextContent('Усі типи')
    expect(statusSelect).toHaveTextContent('Усі статуси')

    await userEvent.click(typeSelect!)
    const typeOptions = await screen.findAllByRole('option')
    expect(typeOptions[0]).toHaveTextContent('Усі типи')
    expect(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Витрата' }),
    ).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(statusSelect!)
    const statusOptions = await screen.findAllByRole('option')
    expect(statusOptions[0]).toHaveTextContent('Усі статуси')
    expect(statusOptions).toHaveLength(8)
  })

  it('keeps AnimatePresence initial={false} so first-mount rows do not replay the enter animation', () => {
    animatePresenceProps.mockClear()
    renderTable([a])
    expect(animatePresenceProps).toHaveBeenCalled()
    expect(animatePresenceProps.mock.calls[0]![0]).toMatchObject({ initial: false, mode: 'sync' })
  })

  it('re-translates the type / status option labels when the locale switches without a remount', async () => {
    renderTable([a])
    const [typeSelect, statusSelect] = screen.getAllByRole('combobox')

    await userEvent.click(typeSelect!)
    expect(await screen.findByRole('option', { name: 'Витрата' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(statusSelect!)
    expect(await screen.findByRole('option', { name: 'Підтверджено' })).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await act(async () => {
      await loadCatalog('en')
    })

    await userEvent.click(screen.getAllByRole('combobox')[0]!)
    expect(await screen.findByRole('option', { name: 'Expense' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Витрата' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getAllByRole('combobox')[1]!)
    expect(await screen.findByRole('option', { name: 'Validated' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Підтверджено' })).not.toBeInTheDocument()
  })

  it('shows the filtered empty state, then «Скинути» restores the rows', async () => {
    renderTable([a, b, c])
    await userEvent.type(screen.getByPlaceholderText('Пошук…'), 'zzz')
    expect(screen.getByText('Нічого не знайдено — скиньте фільтри')).toBeInTheDocument()
    expect(
      screen.queryByText('Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»'),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
    expect(screen.queryByRole('button', { name: /Скинути/ })).not.toBeInTheDocument()
  })

  it('shows the unfiltered empty state when there are no transactions at all', () => {
    renderTable([])
    expect(
      screen.getByText('Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Нічого не знайдено — скиньте фільтри')).not.toBeInTheDocument()
  })

  it('seeds the status filter from initialStatus and exposes «Скинути»', async () => {
    renderTable([a, b, c], { initialStatus: 'PENDING' })
    expect(rowOrder()).toEqual(['b', 'c'])
    expect(screen.getAllByRole('combobox')[1]).toHaveTextContent('Очікує валідації')
    await userEvent.click(screen.getByRole('button', { name: /Скинути/ }))
    expect(rowOrder()).toEqual(['b', 'c', 'a'])
  })

  it('renders the column headers in the data table', () => {
    renderTable([a])
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(COLUMN_HEADERS)
  })

  it('renders skeleton rows with the column headers (and no data rows) while loading', () => {
    renderTable([a], { loading: true })
    expect(screen.queryByTestId('row-a')).not.toBeInTheDocument()
    // 1 header row + 6 skeleton rows
    expect(screen.getAllByRole('row')).toHaveLength(7)
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(COLUMN_HEADERS)
    expect(
      screen.queryByText('Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»'),
    ).not.toBeInTheDocument()
  })

  it('shows the pagination summary only when not loading and there is more than one page', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      tx({
        id: `m${i}`,
        txDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    )
    const { unmount } = renderTable(many)
    expect(screen.getByText('1–50 з 51')).toBeInTheDocument()
    unmount()
    renderTable(many, { loading: true })
    expect(screen.queryByText('1–50 з 51')).not.toBeInTheDocument()
  })

  it('passes the clicked transaction to onDetail', async () => {
    const onDetail = vi.fn()
    renderTable([a], { onDetail })
    await userEvent.click(screen.getByTestId('row-a'))
    expect(onDetail).toHaveBeenCalledWith(a)
  })

  it('hands the current user id (or null when absent) to each row', () => {
    const { unmount } = renderTable([a], { currentUserId: 'user-7' })
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-current-user', 'user-7')
    unmount()
    renderTable([a])
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-current-user', 'null')
  })

  it('renders the show-deleted toggle only when a handler is passed and reflects aria-pressed', async () => {
    const { rerender } = renderTable([a])
    expect(screen.queryByTestId('finance-toggle-show-deleted')).not.toBeInTheDocument()

    const onToggle = vi.fn()
    const props = {
      transactions: [a],
      loading: false,
      role: 'ADMIN',
      rates: undefined,
      onDetail: noop,
      ...handlers,
      onToggleShowDeleted: onToggle,
    }
    rerender(<TransactionsTable {...props} />)
    const off = screen.getByTestId('finance-toggle-show-deleted')
    expect(off).toHaveAttribute('aria-pressed', 'false')
    expect(off).toHaveTextContent('Показати видалені')
    expect(off).toHaveClass('rounded-md', 'h-8', 'border-border', 'text-muted-foreground')
    expect(off).not.toHaveClass('text-destructive')

    rerender(<TransactionsTable {...props} showDeleted />)
    const toggle = screen.getByTestId('finance-toggle-show-deleted')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveClass('border-destructive/40', 'bg-destructive/10', 'text-destructive')
    expect(toggle).not.toHaveClass('text-muted-foreground')
    await userEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(trackFeatureClick).toHaveBeenCalledWith('finance-filter-change')
  })
})
