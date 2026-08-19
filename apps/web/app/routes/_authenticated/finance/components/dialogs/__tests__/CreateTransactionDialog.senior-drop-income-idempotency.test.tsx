/**
 * task-senior-drop-income-idempotency (backlog 73/A-3, security) — mutation-
 * gate coverage for the per-open idempotency-key state
 * (`seniorIncomeIdempotencyKey`/`dropIncomeIdempotencyKey`) added to
 * `CreateTransactionDialog`. Mirrors the SAME contract `usdtIncomeIdempotencyKey`
 * (task-drop-share-override-and-receiver) and `dividendIdempotencyKey` (BIZ-19)
 * already use — a fresh `crypto.randomUUID()` generated once at mount, sent
 * unchanged on every submit within that open session.
 *
 * Backend proof that the SAME key survives sequential double-submit / a
 * concurrent race with exactly ONE row created lives in
 * `senior-drop-income-idempotency.integration.spec.ts` (real DB). This file's
 * job is narrower and purely client-side: prove the key the dialog ACTUALLY
 * SENDS is a real UUID (not `undefined`/empty — the mutation-gate-caught
 * regression a `useState(() => crypto.randomUUID())` → `useState(() =>
 * undefined)` mutant would otherwise slip through silently) and that it is
 * STABLE across two submits in the same session, not regenerated per click.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let currentRole = 'SENIOR'
let currentUserId = 'senior-1'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: { id: currentUserId, role: currentRole, displayName: 'Tester' },
  }),
}))

const PROJECTS = [
  { id: 'proj-senior-1', name: 'Senior FOP Project', seniorId: 'senior-1', paymentType: 'FOP' },
  {
    id: 'proj-drop-1',
    name: 'Drop FOP Project',
    seniorId: 'senior-3',
    dropId: 'drop-1',
    paymentType: 'FOP',
  },
]

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/projects')) return Promise.resolve({ data: PROJECTS })
      if (url.startsWith('/users')) return Promise.resolve({ data: [] })
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/telemetry', () => ({
  trackFeatureClick: vi.fn(),
}))

const createSeniorIncomeMock = vi.fn().mockResolvedValue({})
const createDropIncomeMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    declareUsdtProjectIncome: vi.fn().mockResolvedValue({}),
    createSeniorIncome: (...args: unknown[]) => createSeniorIncomeMock(...args),
    createDropIncome: (...args: unknown[]) => createDropIncomeMock(...args),
    createAdminIncome: vi.fn().mockResolvedValue({}),
    createExpense: vi.fn().mockResolvedValue({}),
    createSalary: vi.fn().mockResolvedValue({}),
    createAdminTransfer: vi.fn().mockResolvedValue({}),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 0 }),
    createDividend: vi.fn().mockResolvedValue({}),
  },
}))

// ── Component (imported AFTER mocks) ────────────────────────────────────────
import { CreateTransactionDialog } from '../CreateTransactionDialog'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CreateTransactionDialog open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

async function fillAndSubmit(projectName: string, amount: string) {
  fireEvent.click(await screen.findByTestId('create-transaction-project-trigger'))
  fireEvent.click(await screen.findByText(projectName))
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } })
  fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
  fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
    target: { value: 'https://example.com/receipt.png' },
  })
  fireEvent.click(screen.getByTestId('create-transaction-submit'))
}

beforeEach(() => {
  createSeniorIncomeMock.mockClear()
  createDropIncomeMock.mockClear()
})

describe('CreateTransactionDialog — SENIOR_INCOME idempotencyKey (backlog 73/A-3)', () => {
  it('sends a real UUID idempotencyKey, not undefined/empty', async () => {
    currentRole = 'SENIOR'
    currentUserId = 'senior-1'
    renderDialog()
    await fillAndSubmit('Senior FOP Project', '150')
    await waitFor(() => expect(createSeniorIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createSeniorIncomeMock.mock.calls[0] as [{ idempotencyKey?: string }]
    expect(payload.idempotencyKey).toBeTruthy()
    expect(payload.idempotencyKey).toMatch(UUID_RE)
  })
})

describe('CreateTransactionDialog — DROP_INCOME idempotencyKey (backlog 73/A-3)', () => {
  it('sends a real UUID idempotencyKey, not undefined/empty', async () => {
    currentRole = 'DROP'
    currentUserId = 'drop-1'
    renderDialog()
    await fillAndSubmit('Drop FOP Project', '150')
    await waitFor(() => expect(createDropIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createDropIncomeMock.mock.calls[0] as [{ idempotencyKey?: string }]
    expect(payload.idempotencyKey).toBeTruthy()
    expect(payload.idempotencyKey).toMatch(UUID_RE)
  })
})
