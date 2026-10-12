/**
 * Handlers that stay in `CreateTransactionDialog` after the section extraction —
 * what a project pick and a type switch reset. Real react-query hooks, API boundary
 * mocked (same harness as `CreateTransactionDialog.usdt-income.test.tsx`).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Tester' } }),
}))

const PROJECTS = [
  { id: 'proj-fop', name: 'FOP Own Project', seniorId: 'admin-1', paymentType: 'FOP' },
]
const ALL_USERS = [
  { id: 'admin-1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'admin-2', displayName: 'Admin Two', role: 'ADMIN' },
]

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/projects')) return Promise.resolve({ data: PROJECTS })
      if (url.startsWith('/users')) return Promise.resolve({ data: ALL_USERS })
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ trackFeatureClick: vi.fn() }))
vi.mock('../../../api', () => ({
  financeApi: {},
  companyAccountApi: { getAccount: vi.fn().mockResolvedValue({ balance: 100 }) },
}))

import { CreateTransactionDialog } from '../CreateTransactionDialog'

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <CreateTransactionDialog open onClose={() => {}} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('project pick', () => {
  it('clears the project error the moment a project is chosen', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(await screen.findByTestId('create-transaction-error-project')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('FOP Own Project'))
    expect(screen.queryByTestId('create-transaction-error-project')).not.toBeInTheDocument()
  })
})

describe('type switch', () => {
  it('forgets the chosen project', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('FOP Own Project'))
    expect(screen.getByTestId('create-transaction-project-trigger')).toHaveTextContent(
      'FOP Own Project',
    )
    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))
    fireEvent.click(screen.getByTestId('create-transaction-type-admin_income'))
    expect(screen.getByTestId('create-transaction-project-trigger')).toHaveTextContent(
      'Виберіть проєкт',
    )
  })

  it('forgets a swapped transfer direction', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_transfer')
    fireEvent.click(screen.getByTestId('create-transaction-type-admin_transfer'))
    const senderCard = async () =>
      (await screen.findAllByTitle('Натисніть, щоб змінити напрямок'))[0]!
    expect(within(await senderCard()).getByText('Admin One')).toBeInTheDocument()
    fireEvent.click(await senderCard())
    expect(within(await senderCard()).getByText('Admin Two')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))
    fireEvent.click(screen.getByTestId('create-transaction-type-admin_transfer'))
    expect(within(await senderCard()).getByText('Admin One')).toBeInTheDocument()
  })
})
