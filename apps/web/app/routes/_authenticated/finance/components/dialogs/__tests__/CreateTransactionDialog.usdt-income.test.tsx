/**
 * task-drop-share-override-and-receiver — Surface B (admin-USDT income
 * declaration) interaction tests for `CreateTransactionDialog`.
 *
 * Pins:
 * 1. `USDT_INCOME` type-card is ADMIN-only (ACCOUNTANT does NOT get it — ADR
 *    Q4).
 * 2. Project pool for `USDT_INCOME` is ANY active USDT-payment project (ADR
 *    D3) — not gated by seniorId/dropId.
 * 3. Receiver Select is grouped («Админы» + «Счёт компании»); opening/
 *    selecting an option commits the value; no default pre-selection.
 * 4. Submit without a receiver blocks (`usdt-income-error-receiver`), submit
 *    without a project blocks too (`create-transaction-error-project`);
 *    submitting with both calls `financeApi.declareUsdtProjectIncome` with
 *    the expected payload (receiverId as the raw uuid OR the
 *    'COMPANY_ACCOUNT' sentinel).
 * 5. SENIOR/DROP — USDT-payment projects are excluded from their own income
 *    pools; a gate-hint appears only when ALL of their projects are USDT; a
 *    mixed portfolio silently filters USDT out with no hint.
 * 6. `createDropIncome` never receives a `receiverId` (ADR C14 revert).
 *
 * Strategy: keep the REAL `@tanstack/react-query` hooks (wrapped in a fresh
 * `QueryClientProvider` per render) so `mutation.mutate()` genuinely invokes
 * the component's own `mutationFn` — mocking `useMutation` globally is unsafe
 * here because `ReceiptInput` also calls `useMutation` internally
 * (`useUploadDocument`), and a single captured-fn stub cannot distinguish the
 * two instances. Only the API boundary (`@/lib/axios` + `../../../api`) is
 * mocked, discriminated by URL.
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ── Mutable auth persona ─────────────────────────────────────────────────────
let currentRole = 'ADMIN'
let currentUserId = 'admin-1'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: { id: currentUserId, role: currentRole, displayName: 'Tester' },
  }),
}))

// Fixture: senior-1 owns a USDT project + a FOP project (mixed portfolio).
// drop-1 owns ONLY a USDT project (all-USDT, triggers the gate-hint); drop-2
// owns a FOP project (eligible, no hint) — used by the "createDropIncome
// never carries a receiver" case.
const PROJECTS = [
  { id: 'proj-usdt-1', name: 'USDT Project One', seniorId: 'senior-1', paymentType: 'USDT' },
  { id: 'proj-fop-1', name: 'FOP Project', seniorId: 'senior-1', paymentType: 'FOP' },
  {
    id: 'proj-usdt-2',
    name: 'USDT Drop Project',
    seniorId: 'senior-2',
    dropId: 'drop-1',
    paymentType: 'USDT',
  },
  {
    id: 'proj-fop-drop',
    name: 'FOP Drop Project',
    seniorId: 'senior-3',
    dropId: 'drop-2',
    paymentType: 'FOP',
  },
]

const ADMIN_USERS = [
  { id: 'admin-1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'admin-2', displayName: 'Admin Two', role: 'ADMIN' },
]

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/projects')) return Promise.resolve({ data: PROJECTS })
      if (url.startsWith('/users')) return Promise.resolve({ data: ADMIN_USERS })
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const declareUsdtProjectIncomeMock = vi.fn().mockResolvedValue({})
const createDropIncomeMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    declareUsdtProjectIncome: (...args: unknown[]) => declareUsdtProjectIncomeMock(...args),
    createDropIncome: (...args: unknown[]) => createDropIncomeMock(...args),
    createSeniorIncome: vi.fn().mockResolvedValue({}),
    createAdminIncome: vi.fn().mockResolvedValue({}),
    createExpense: vi.fn().mockResolvedValue({}),
    createSalary: vi.fn().mockResolvedValue({}),
    createAdminTransfer: vi.fn().mockResolvedValue({}),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 1234 }),
    createDividend: vi.fn().mockResolvedValue({}),
  },
}))

// ── Component (imported AFTER mocks) ────────────────────────────────────────
import { CreateTransactionDialog } from '../CreateTransactionDialog'

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CreateTransactionDialog open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

function clickTypeCard(testId: string) {
  fireEvent.click(screen.getByTestId(testId))
}

describe('CreateTransactionDialog — USDT_INCOME type availability', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
    currentUserId = 'admin-1'
    declareUsdtProjectIncomeMock.mockClear()
    createDropIncomeMock.mockClear()
  })

  it('ADMIN sees the USDT_INCOME type-card', async () => {
    renderDialog()
    expect(await screen.findByTestId('create-transaction-type-usdt_income')).toBeInTheDocument()
  })

  it('ACCOUNTANT does NOT see the USDT_INCOME type-card (ADR Q4)', async () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(await screen.findByTestId('create-transaction-type-admin_income')).toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-type-usdt_income')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — USDT_INCOME project pool (ADR D3)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
    currentUserId = 'admin-1'
  })

  it('project Select lists ANY USDT-payment project, excludes FOP projects', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('USDT Project One')).toBeInTheDocument()
    expect(within(listbox).getByText('USDT Drop Project')).toBeInTheDocument()
    expect(within(listbox).queryByText('FOP Project')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — USDT_INCOME receiver Select (grouped)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
    currentUserId = 'admin-1'
  })

  it('groups «Админы» + «Счёт компании», selecting an admin commits the value', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(await screen.findByTestId('usdt-income-receiver-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('Админы')).toBeInTheDocument()
    expect(within(listbox).getByText('Admin One')).toBeInTheDocument()
    expect(within(listbox).getByText('Admin Two')).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: 'Счёт компании' })).toBeInTheDocument()

    fireEvent.click(within(listbox).getByText('Admin Two'))
    expect(screen.getByTestId('usdt-income-receiver-trigger')).toHaveTextContent('Admin Two')
  })

  it('selecting «Счёт компании» commits the COMPANY_ACCOUNT sentinel', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(screen.getByTestId('usdt-income-receiver-trigger'))
    const listbox = screen.getByRole('listbox')
    fireEvent.click(await within(listbox).findByRole('option', { name: 'Счёт компании' }))
    expect(screen.getByTestId('usdt-income-receiver-trigger')).toHaveTextContent('Счёт компании')
  })

  it('does NOT pre-select a receiver by default', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    expect(screen.getByTestId('usdt-income-receiver-trigger')).toHaveTextContent(
      'Выберите получателя',
    )
  })
})

describe('CreateTransactionDialog — USDT_INCOME validation + submit', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
    currentUserId = 'admin-1'
    declareUsdtProjectIncomeMock.mockClear()
  })

  it('blocks submit and shows the receiver error when no receiver is chosen', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('USDT Project One'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('usdt-income-error-receiver')).toBeInTheDocument()
    expect(declareUsdtProjectIncomeMock).not.toHaveBeenCalled()
  })

  it('blocks submit when no project is chosen', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(await screen.findByTestId('usdt-income-receiver-trigger'))
    fireEvent.click(await screen.findByText('Admin Two'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-project')).toBeInTheDocument()
    expect(declareUsdtProjectIncomeMock).not.toHaveBeenCalled()
  })

  it('submits declareUsdtProjectIncome with the expected payload (admin receiver)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('USDT Project One'))
    fireEvent.click(screen.getByTestId('usdt-income-receiver-trigger'))
    fireEvent.click(await screen.findByText('Admin Two'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(declareUsdtProjectIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = declareUsdtProjectIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      projectId: 'proj-usdt-1',
      amount: 500,
      currency: 'USDT',
      receiverId: 'admin-2',
    })
  })

  it('submits with receiverId="COMPANY_ACCOUNT" when «Счёт компании» is chosen', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('USDT Drop Project'))
    fireEvent.click(screen.getByTestId('usdt-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(declareUsdtProjectIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = declareUsdtProjectIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ receiverId: 'COMPANY_ACCOUNT' })
  })

  it('currency is locked to USDT for USDT_INCOME (currency Select disabled)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-usdt_income')
    clickTypeCard('create-transaction-type-usdt_income')
    const currencyTrigger = screen
      .getAllByRole('combobox')
      .find((el) => el.textContent?.includes('USDT'))
    expect(currencyTrigger).toBeDisabled()
  })
})

describe('CreateTransactionDialog — SENIOR/DROP gate-hint on USDT-only projects (ADR D2)', () => {
  beforeEach(() => {
    declareUsdtProjectIncomeMock.mockClear()
    createDropIncomeMock.mockClear()
  })

  it('SENIOR with a mixed FOP/USDT portfolio sees NO hint; the FOP project stays in the pool', async () => {
    currentRole = 'SENIOR'
    currentUserId = 'senior-1'
    renderDialog()
    await screen.findByTestId('create-transaction-project-trigger')
    expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('FOP Project')).toBeInTheDocument()
    expect(within(listbox).queryByText('USDT Project One')).not.toBeInTheDocument()
  })

  it('DROP sees the gate-hint when ALL their projects are USDT', async () => {
    currentRole = 'DROP'
    currentUserId = 'drop-1'
    renderDialog()
    expect(await screen.findByTestId('drop-income-usdt-gate-hint')).toBeInTheDocument()
  })

  it('DROP with a FOP project sees NO hint (eligible portfolio)', async () => {
    currentRole = 'DROP'
    currentUserId = 'drop-2'
    renderDialog()
    await screen.findByTestId('create-transaction-project-trigger')
    expect(screen.queryByTestId('drop-income-usdt-gate-hint')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — DROP_INCOME never carries a receiver (ADR C14 revert)', () => {
  beforeEach(() => {
    createDropIncomeMock.mockClear()
  })

  it('createDropIncome payload has no receiverId key', async () => {
    currentRole = 'DROP'
    currentUserId = 'drop-2'
    renderDialog()
    fireEvent.click(await screen.findByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('FOP Drop Project'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '300' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createDropIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createDropIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).not.toHaveProperty('receiverId')
  })
})

describe('CreateTransactionDialog — Escape closes the dialog (standard interaction)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
    currentUserId = 'admin-1'
  })

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <CreateTransactionDialog open onClose={onClose} />
      </QueryClientProvider>,
    )
    await screen.findByTestId('create-transaction-dialog')
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
