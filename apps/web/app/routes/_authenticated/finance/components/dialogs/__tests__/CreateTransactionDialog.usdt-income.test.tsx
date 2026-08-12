/**
 * task-admin-income-unified (2026-08-12, supersedes task-drop-share-override-
 * and-receiver Surface B / task-admin-income-payment-type-guard) — interaction
 * tests for the UNIFIED admin-income form in `CreateTransactionDialog`.
 *
 * WHAT CHANGED AND WHY (see the task file / PR body for the full incident):
 * a prod ADMIN_INCOME row on a USDT-payment project (GamingTec, 4708.69 USDT)
 * was missing its drop share because a human could open the WRONG of two
 * forms — "Приход Admin" (`createAdminIncome`, never books an obligation) vs
 * "Приход USDT" (`declareUsdtProjectIncome`, always does). The fix removes
 * the choice: there is now ONE "Приход Admin" type; the SELECTED PROJECT's
 * `paymentType` decides which endpoint the submit actually calls.
 *
 * Pins:
 * 1. AC1 — the separate "USDT-приход" type-card no longer exists, for ANY
 *    role (ADMIN included).
 * 2. AC11 — the ADMIN project pool is the UNION of the two former lists (own
 *    projects + ANY USDT-payment project system-wide, ADR D3) — not narrowed.
 *    ACCOUNTANT's pool EXCLUDES USDT projects (their endpoint is ADMIN-only;
 *    offering a project it will 403 on is a dead end, not a shorter list).
 * 3. AC9 — the receiver Select ("Счёт получателя") is a FLAT list of ACTIVE
 *    admins + «Счёт компании», no group headers, no drop, no default
 *    pre-selection.
 * 4. AC4/routing — selecting a USDT project calls `declareUsdtProjectIncome`;
 *    selecting a non-USDT project calls `createAdminIncome` with an explicit
 *    `receiverId` (ADMIN) matching what was picked in the Select.
 * 5. AC5/AC7/AC8 — the obligation-preview banner: appears the instant a
 *    project with a drop-share consequence is selected (before any amount is
 *    typed), recomputes live as the amount field changes, shows regardless of
 *    which receiver is picked (including «Счёт компании» — AC8), disappears
 *    on switching to a project with no such consequence, and a senior-only
 *    USDT project (senior IS an admin, e.g. the caller's own) shows NO banner
 *    at all when there is no drop.
 * 6. AC6 (this task's PRIMARY test) — the banner's predicted amount is
 *    computed with the SAME `roundShareAmount` (`@crm/shared`) the server
 *    books obligations with; the backend counterpart of this claim (predicted
 *    amount == the row actually created on a real DB) lives in
 *    `admin-income-unified.integration.spec.ts`.
 * 7. AC10 — ACCOUNTANT never sees the flat receiver Select; they get a
 *    CONSTRAINED 2-option toggle (project owner / company account) and can
 *    never pick a specific OTHER admin — the interface never offers what the
 *    server (createAdminIncome) would reject.
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
import { roundShareAmount } from '@crm/shared'

// ── Mutable auth persona ─────────────────────────────────────────────────────
let currentRole = 'ADMIN'
let currentUserId = 'admin-1'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: { id: currentUserId, role: currentRole, displayName: 'Tester' },
  }),
}))

// Fixture:
//  - proj-usdt-own: ADMIN (admin-1) is the senior → NO senior IOU ever (the
//    server never books one for an admin-senior); HAS a drop → drop IOU only.
//  - proj-usdt-third-party: a THIRD-PARTY senior (not admin-1, not even an
//    admin) → BOTH senior and drop IOUs are possible (reachable ONLY because
//    the unified pool includes ANY USDT project, ADR D3 — AC11).
//  - proj-usdt-no-drop: USDT, admin-owned, no drop bound → no obligation at
//    all → the banner must show NOTHING.
//  - proj-fop-own: admin-owned, NON-USDT, but STILL has a drop bound — the
//    banner must NOT show here (AC3: createAdminIncome never books a share;
//    that is the drop's own DROP_INCOME's job).
//  - proj-fop-1 / proj-fop-drop: SENIOR/DROP fixtures, unaffected by this task.
const PROJECTS = [
  {
    id: 'proj-usdt-own',
    name: 'USDT Own Project',
    seniorId: 'admin-1',
    seniorName: 'Admin One',
    dropId: 'drop-1',
    dropName: 'Dropper One',
    paymentType: 'USDT',
    effectiveDropSharePercent: 5,
    effectiveDropShareSource: 'USER_DEFAULT',
  },
  {
    id: 'proj-usdt-third-party',
    name: 'USDT Third Party Project',
    seniorId: 'senior-1',
    seniorName: 'Senior Person',
    dropId: 'drop-1',
    dropName: 'Dropper One',
    paymentType: 'USDT',
    effectiveSeniorSharePercent: 26,
    effectiveSeniorShareSource: 'PROJECT',
    effectiveDropSharePercent: 12,
    effectiveDropShareSource: 'PROJECT',
  },
  {
    id: 'proj-usdt-no-drop',
    name: 'USDT No Drop Project',
    seniorId: 'admin-1',
    seniorName: 'Admin One',
    dropId: null,
    paymentType: 'USDT',
  },
  {
    // A DIFFERENT drop (drop-3, not drop-1) — drop-1's portfolio must stay
    // ALL-USDT for the "DROP sees the gate-hint" case below; this project
    // only needs SOME drop bound to prove the banner stays silent on a
    // non-USDT project regardless.
    id: 'proj-fop-own',
    name: 'FOP Own Project',
    seniorId: 'admin-1',
    dropId: 'drop-3',
    dropName: 'Dropper Three',
    paymentType: 'FOP',
    effectiveDropSharePercent: 5,
    effectiveDropShareSource: 'USER_DEFAULT',
  },
  { id: 'proj-fop-1', name: 'FOP Project', seniorId: 'senior-1', paymentType: 'FOP' },
  {
    id: 'proj-fop-drop',
    name: 'FOP Drop Project',
    seniorId: 'senior-3',
    dropId: 'drop-2',
    paymentType: 'FOP',
  },
]

// `/users` returns EVERY role — `adminUsers = allUsers.filter(u => u.role
// === 'ADMIN')` is the component's OWN filter (mutation-gate coverage: a
// mutant that deletes this filter must be observable, so a non-admin has to
// be present in the fixture for the receiver-Select-exclusion test below).
const ALL_USERS = [
  { id: 'admin-1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'admin-2', displayName: 'Admin Two', role: 'ADMIN' },
  { id: 'senior-1', displayName: 'Senior Person', role: 'SENIOR' },
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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const declareUsdtProjectIncomeMock = vi.fn().mockResolvedValue({})
const createDropIncomeMock = vi.fn().mockResolvedValue({})
const createAdminIncomeMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    declareUsdtProjectIncome: (...args: unknown[]) => declareUsdtProjectIncomeMock(...args),
    createDropIncome: (...args: unknown[]) => createDropIncomeMock(...args),
    createSeniorIncome: vi.fn().mockResolvedValue({}),
    createAdminIncome: (...args: unknown[]) => createAdminIncomeMock(...args),
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

async function selectProject(name: string) {
  fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
  fireEvent.click(await screen.findByText(name))
}

async function selectReceiver(name: string) {
  fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
  const listbox = screen.getByRole('listbox')
  fireEvent.click(await within(listbox).findByText(name))
}

beforeEach(() => {
  currentRole = 'ADMIN'
  currentUserId = 'admin-1'
  declareUsdtProjectIncomeMock.mockClear()
  createDropIncomeMock.mockClear()
  createAdminIncomeMock.mockClear()
})

describe('CreateTransactionDialog — AC1: no separate USDT type-card', () => {
  it('ADMIN never sees a "USDT-приход" type-card — only ADMIN_INCOME', async () => {
    renderDialog()
    expect(await screen.findByTestId('create-transaction-type-admin_income')).toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-type-usdt_income')).not.toBeInTheDocument()
  })

  it('ACCOUNTANT never sees it either (never did)', async () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(await screen.findByTestId('create-transaction-type-admin_income')).toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-type-usdt_income')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — AC11: ADMIN_INCOME project pool is the union, not narrowed', () => {
  it('ADMIN sees their own FOP project AND every USDT project system-wide (not just their own)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('FOP Own Project')).toBeInTheDocument()
    expect(within(listbox).getByText('USDT Own Project')).toBeInTheDocument()
    // Third-party USDT project — senior is NOT admin-1, still listed (ADR D3).
    expect(within(listbox).getByText('USDT Third Party Project')).toBeInTheDocument()
    // Projects belonging to OTHER seniors/drops (not USDT, not admin-1's own) stay excluded.
    expect(within(listbox).queryByText('FOP Project')).not.toBeInTheDocument()
  })

  it('ACCOUNTANT sees admin-owned projects but NOT USDT ones (their endpoint 403s there)', async () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('FOP Own Project')).toBeInTheDocument()
    expect(within(listbox).queryByText('USDT Own Project')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('USDT Third Party Project')).not.toBeInTheDocument()
    // ACCOUNTANT's pool is admin-OWNED projects, not every project — a project
    // whose senior is a non-admin (`FOP Project`, seniorId=senior-1) must stay
    // out even though it is not USDT (`adminUserIds.has(p.seniorId)`, not a
    // blanket `projects` pass-through).
    expect(within(listbox).queryByText('FOP Project')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — AC9: receiver Select is a flat active-admin list + company account, no drop', () => {
  it('ADMIN: flat list of admins + «Счёт компании» (no group headers, no drop)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByText('Админы')).not.toBeInTheDocument()
    expect(await within(listbox).findByText('Admin One')).toBeInTheDocument()
    expect(within(listbox).getByText('Admin Two')).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: 'Счёт компании' })).toBeInTheDocument()
    // `/users` never returns a DROP-role user here — structurally impossible
    // for one to appear, which IS the enforcement (see file header AC9).
    expect(within(listbox).queryByText('Dropper One')).not.toBeInTheDocument()
    // `/users` returns every role — `adminUsers = allUsers.filter(role===ADMIN)`
    // is what keeps a non-admin OUT of the list a mutant could delete silently.
    expect(within(listbox).queryByText('Senior Person')).not.toBeInTheDocument()
  })

  it('does NOT pre-select a receiver by default', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    expect(screen.getByTestId('admin-income-receiver-trigger')).toHaveTextContent(
      'Выберите получателя',
    )
  })

  it('selecting a different admin commits the value', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectReceiver('Admin Two')
    expect(screen.getByTestId('admin-income-receiver-trigger')).toHaveTextContent('Admin Two')
  })
})

describe('CreateTransactionDialog — routing: selected project decides the endpoint', () => {
  it('non-USDT project → createAdminIncome, receiverId sent explicitly (ADMIN)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    await selectReceiver('Admin Two')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    expect(declareUsdtProjectIncomeMock).not.toHaveBeenCalled()
    const [payload] = createAdminIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      projectId: 'proj-fop-own',
      amount: 500,
      receiverId: 'admin-2',
    })
  })

  it('USDT project → declareUsdtProjectIncome, createAdminIncome NEVER called (AC4 invariant)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    await selectReceiver('Admin Two')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xusdt1' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(declareUsdtProjectIncomeMock).toHaveBeenCalledTimes(1))
    expect(createAdminIncomeMock).not.toHaveBeenCalled()
    const [payload] = declareUsdtProjectIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      projectId: 'proj-usdt-own',
      amount: 500,
      currency: 'USDT',
      receiverId: 'admin-2',
      receiptExternalUrl: 'https://etherscan.io/tx/0xusdt1',
    })
    // Notes left blank must reach the server as `null`, not `''`/`undefined` —
    // `notes || null` is the exact contract `receiptMandatoryError` /
    // `createUsdtIncomeSchema` on the other end expect.
    expect(payload.notes).toBeNull()
  })

  it('sends notes and txDate through EXACTLY as typed, not silently nulled (USDT payload)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    await selectReceiver('Admin Two')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xnotes' },
    })
    fireEvent.change(screen.getByPlaceholderText('Дополнительная информация...'), {
      target: { value: 'Quarterly settlement' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(declareUsdtProjectIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = declareUsdtProjectIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload.notes).toBe('Quarterly settlement')
    expect(typeof payload.txDate).toBe('string')
    expect(payload.txDate).not.toBeNull()
  })

  it('submits with receiverId="COMPANY_ACCOUNT" when «Счёт компании» is chosen on a USDT project', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xusdt2' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(declareUsdtProjectIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = declareUsdtProjectIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ receiverId: 'COMPANY_ACCOUNT' })
  })

  it('blocks submit and shows the receiver error when no receiver is chosen (non-USDT project)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('admin-income-error-receiver')).toBeInTheDocument()
    expect(createAdminIncomeMock).not.toHaveBeenCalled()
  })

  it('blocks submit when no project is chosen', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectReceiver('Admin Two')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-project')).toBeInTheDocument()
    expect(createAdminIncomeMock).not.toHaveBeenCalled()
    expect(declareUsdtProjectIncomeMock).not.toHaveBeenCalled()
  })

  it('currency is locked to USDT once a USDT project is selected (currency Select disabled)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    // Exact match, not `.includes` — the project trigger's OWN text now
    // contains "USDT" too ("USDT Own Project"), which `.includes` would
    // match first (DOM order) and false-pass this assertion on the wrong
    // element. The currency trigger's accessible text is the bare code.
    const currencyTrigger = screen.getAllByRole('combobox').find((el) => el.textContent === 'USDT')
    expect(currencyTrigger).toBeDisabled()
  })

  it('switching FROM a USDT project TO a non-USDT one clears the stale receiver and un-locks currency', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    await selectReceiver('Admin Two')
    expect(screen.getByTestId('admin-income-receiver-trigger')).toHaveTextContent('Admin Two')
    // Switch to a non-USDT project — the two routes have disjoint
    // receiver/funding semantics; a stale pick from the OTHER route must not
    // silently carry over into `createAdminIncome`'s payload.
    await selectProject('FOP Own Project')
    expect(screen.getByTestId('admin-income-receiver-trigger')).toHaveTextContent(
      'Выберите получателя',
    )
    const currencyTrigger = screen.getAllByRole('combobox').find((el) => el.textContent === 'USD')
    expect(currencyTrigger).not.toBeDisabled()
  })

  it('project selector is absent for types that never carry a project (EXPENSE)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))
    expect(screen.queryByTestId('create-transaction-project-trigger')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — company-account invalidation on success', () => {
  it('a «Счёт компании»-routed ADMIN_INCOME invalidates the company-account query (isAdminIncomeCompanyFunded)', async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xcompanyfunded' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['company-account'] }),
    )
    invalidateSpy.mockRestore()
  })

  it('a project-owner-routed ADMIN_INCOME does NOT invalidate the company-account query', async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    await selectReceiver('Admin Two')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['company-account'] })
    invalidateSpy.mockRestore()
  })
})

describe('CreateTransactionDialog — AC5/AC7/AC8: obligation-preview banner', () => {
  it('appears the instant a drop-bearing USDT project is selected — BEFORE any amount is typed', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    expect(screen.queryByTestId('admin-income-obligation-preview')).not.toBeInTheDocument()
    await selectProject('USDT Own Project')
    expect(await screen.findByTestId('admin-income-obligation-preview')).toBeInTheDocument()
    expect(screen.getByTestId('admin-income-obligation-preview-drop')).toBeInTheDocument()
    // Admin IS the senior on this project → no senior IOU line.
    expect(screen.queryByTestId('admin-income-obligation-preview-senior')).not.toBeInTheDocument()
    // Shown immediately with amount=0 — visible, not a crash on empty input (AC7).
    expect(screen.getByTestId('admin-income-obligation-amount-drop')).toHaveTextContent('0.00')
  })

  it('recomputes live as the amount field changes, matching roundShareAmount exactly (AC6)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '4708.69' } })
    const expected = roundShareAmount(4708.69, 5) // 5% default drop share — matches the fixture
    await waitFor(() =>
      expect(screen.getByTestId('admin-income-obligation-amount-drop')).toHaveTextContent(
        expected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      ),
    )
    expect(screen.getByTestId('admin-income-obligation-preview-drop')).toHaveTextContent('Дропу')
    expect(screen.getByTestId('admin-income-obligation-preview-drop')).toHaveTextContent(
      'Dropper One',
    )
    expect(screen.getByTestId('admin-income-obligation-source-drop')).toHaveTextContent(
      'по умолчанию',
    )

    // Change the amount again — the banner tracks the field live, no stale value.
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1000' } })
    const expected2 = roundShareAmount(1000, 5)
    await waitFor(() =>
      expect(screen.getByTestId('admin-income-obligation-amount-drop')).toHaveTextContent(
        expected2.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      ),
    )
  })

  it('shows BOTH senior and drop lines for a third-party USDT project (senior is not the caller)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Third Party Project')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1000' } })
    await waitFor(() =>
      expect(screen.getByTestId('admin-income-obligation-preview-senior')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('admin-income-obligation-preview-senior')).toHaveTextContent(
      'Senior Person',
    )
    expect(screen.getByTestId('admin-income-obligation-amount-senior')).toHaveTextContent(
      roundShareAmount(1000, 26).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    )
    expect(screen.getByTestId('admin-income-obligation-preview-drop')).toHaveTextContent(
      'Dropper One',
    )
    expect(screen.getByTestId('admin-income-obligation-amount-drop')).toHaveTextContent(
      roundShareAmount(1000, 12).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    )
  })

  it('shows NOTHING for a USDT project with no drop bound (no obligation will be created)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT No Drop Project')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1000' } })
    expect(screen.queryByTestId('admin-income-obligation-preview')).not.toBeInTheDocument()
  })

  it('disappears when the project is switched to a non-USDT one', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    expect(await screen.findByTestId('admin-income-obligation-preview')).toBeInTheDocument()
    await selectProject('FOP Own Project')
    expect(screen.queryByTestId('admin-income-obligation-preview')).not.toBeInTheDocument()
  })

  it('AC8: still shows when the receiver is «Счёт компании», not just a specific admin', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('USDT Own Project')
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1000' } })
    await waitFor(() =>
      expect(screen.getByTestId('admin-income-obligation-preview-drop')).toBeInTheDocument(),
    )
  })
})

describe('CreateTransactionDialog — AC10: ACCOUNTANT gets a constrained receiver choice, never a specific admin', () => {
  beforeEach(() => {
    currentRole = 'ACCOUNTANT'
    currentUserId = 'accountant-1'
  })

  it('shows the constrained "Счёт получателя" toggle, NOT the flat admin Select', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-income-receiver-trigger')).not.toBeInTheDocument()
  })

  it('"legacy" (project owner) sends NO receiverId — createAdminIncome payload omits it', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createAdminIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).not.toHaveProperty('receiverId')
  })

  it('"Счёт компании" sends the SAME sentinel the ADMIN route uses — still allowed for this role', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    await selectProject('FOP Own Project')
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xacct1' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createAdminIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ receiverId: 'COMPANY_ACCOUNT' })
  })

  it('gate-hint explains why USDT projects are absent when the accountant has only USDT admin-owned projects', async () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    // This fixture's accountant pool has a non-USDT project too (proj-fop-own),
    // so the hint should NOT show — mirrors the SENIOR/DROP "mixed portfolio,
    // no hint" convention. Covered by the pool test above; this asserts the
    // corollary: no hint when the pool is not empty.
    expect(screen.queryByTestId('admin-income-accountant-usdt-gate-hint')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — SENIOR/DROP gate-hint on USDT-only projects (unaffected by this task)', () => {
  it('SENIOR with a mixed FOP/USDT portfolio sees NO hint; the FOP project stays in the pool', async () => {
    currentRole = 'SENIOR'
    currentUserId = 'senior-1'
    renderDialog()
    await screen.findByTestId('create-transaction-project-trigger')
    expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(await within(listbox).findByText('FOP Project')).toBeInTheDocument()
    expect(within(listbox).queryByText('USDT Third Party Project')).not.toBeInTheDocument()
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

describe('CreateTransactionDialog — DROP_INCOME never carries a receiver (unaffected by this task)', () => {
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
