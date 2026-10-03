/**
 * FinanceTab search matches the company account by the text the operator SEES
 * («Рахунок компанії» in uk), never by the raw `COMPANY` code the server stores.
 * Expected strings are literals from the uk catalog, not recomputed from code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const TARGET_ID = 'fe000000-0000-4000-8000-000000000003'

const getMock = vi.fn()

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer-1', role: 'ADMIN' } }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/axios', () => ({
  api: { get: (url: string) => getMock(url) },
}))
vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: { getTransactions: () => Promise.resolve([]) },
}))
vi.mock('@/routes/_authenticated/finance/components/TransactionRow', () => ({
  TransactionRow: ({ tx }: { tx: { id: string } }) => <div data-testid={`row-${tx.id}`} />,
}))
vi.mock('@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog', () => ({
  TransactionDetailDialog: () => null,
}))

import { FinanceTab } from '../FinanceTab'

function row(id: string, over: Record<string, unknown>) {
  return {
    id,
    type: 'SALARY',
    status: 'PAID',
    amount: '10',
    currency: 'USDT',
    senderId: null,
    receiverId: TARGET_ID,
    senderName: null,
    receiverName: null,
    senderLabel: null,
    receiverLabel: null,
    projectName: null,
    notes: null,
    txDate: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FinanceTab userId={TARGET_ID} targetRole="SENIOR" />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('FinanceTab — search by company-account display name', () => {
  beforeEach(async () => {
    getMock.mockReset()
    await loadCatalog('uk')
    getMock.mockImplementation((url: string) => {
      if (url.includes('/balances/total-earned/'))
        return Promise.resolve({ data: { total: 0, breakdown: {} } })
      if (url.endsWith('/transactions'))
        return Promise.resolve({
          data: [
            row('company-sender', { senderLabel: 'COMPANY' }),
            row('company-receiver', { type: 'COMPANY_DEPOSIT', receiverLabel: 'COMPANY' }),
            row('expense-category', { type: 'EXPENSE', receiverLabel: 'COMPANY' }),
            row('other', { senderLabel: 'Acme' }),
          ],
        })
      return Promise.resolve({ data: { usdUah: '41.5', eurUah: '44.8' } })
    })
  })
  afterEach(() => vi.clearAllMocks())

  async function search(q: string) {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('row-other')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Пошук…'), { target: { value: q } })
  }

  it('finds the company account by the visible uk name, on both sides', async () => {
    await search('рахунок компанії')
    await waitFor(() => expect(screen.queryByTestId('row-other')).not.toBeInTheDocument())
    expect(screen.getByTestId('row-company-sender')).toBeInTheDocument()
    expect(screen.getByTestId('row-company-receiver')).toBeInTheDocument()
  })

  it('does not match the raw COMPANY code on counterparty sides', async () => {
    await search('company')
    await waitFor(() => expect(screen.queryByTestId('row-company-sender')).not.toBeInTheDocument())
    expect(screen.queryByTestId('row-company-receiver')).not.toBeInTheDocument()
    expect(screen.queryByTestId('row-other')).not.toBeInTheDocument()
    // EXPENSE receiverLabel is a free-text category — stays raw and searchable.
    expect(screen.getByTestId('row-expense-category')).toBeInTheDocument()
  })
})
