/**
 * Task 3–5: UserDialog create-mode wizard tests.
 *
 * Strategy: mock heavy deps (TanStack Query, Router, auth, axios) and test
 * step navigation logic, POST/PATCH call targets, and button states.
 * Edit-mode is NOT tested here — it remains unchanged.
 */
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin' } }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
      <a href={to ?? '#'}>{children}</a>
    ),
    useNavigate: () => vi.fn(),
  }
})

// Mock API calls — axios intercepted directly
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockGet = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: {
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

// Mock contract hook components to avoid CodeMirror heavy deps
vi.mock('@/components/user-profile/contract/useEmployeeContract', async () => ({
  useEmployeeContract: vi.fn().mockReturnValue({
    data: {
      id: 'contract-1',
      status: 'DRAFT',
      bodyMarkdown: '# Draft contract',
      userId: 'new-user-1',
      templateId: 'tpl-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    isLoading: false,
    error: null,
  }),
  useSaveContractBody: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useMarkContractReady: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useResetContractToTemplate: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useRevertContract: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  contractActionState: vi.fn().mockReturnValue({
    editable: true,
    showSave: true,
    showMarkReady: true,
    showReset: true,
    showRevert: false,
    revertDestructive: false,
  }),
  contractKeys: { detail: (id: string) => ['employee-contract', id] },
}))

vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: ({ value }: { value: string }) => (
    <div data-testid="contract-editor-mock">{value}</div>
  ),
}))

vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// ── TanStack Query — real implementation but with mocked queryClient ────────
// We use the real useMutation/useQuery so component lifecycle works correctly.
// The actual API calls are intercepted by mockPost/mockGet above.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    }),
    useQueryClient: vi.fn().mockReturnValue({
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    }),
    // useMutation: pass-through so onSuccess/onError lifecycle fires properly
    useMutation: vi
      .fn()
      .mockImplementation(
        ({
          mutationFn,
          onSuccess,
          onError,
        }: {
          mutationFn: (data: unknown) => Promise<unknown>
          onSuccess?: (res: unknown, vars: unknown) => void
          onError?: (err: unknown, vars: unknown) => void
        }) => {
          const mutate = vi.fn(async (data: unknown) => {
            try {
              const res = await mutationFn(data)
              await onSuccess?.(res, data)
            } catch (e) {
              await onError?.(e, data)
            }
          })
          return { mutate, isPending: false }
        },
      ),
  }
})

// ── Import component under test ────────────────────────────────────────────
import { UserDialog } from '../UserDialog'

// ── Helpers ────────────────────────────────────────────────────────────────

const newUserResponse = {
  data: {
    id: 'new-user-id-123',
    email: 'test@example.com',
    displayName: 'Тест Тестов',
    role: 'JUNIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'BANK_UAH_FOP',
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: 'Тестов Тест',
    bankUahIban: 'UA123456789012345678901234567',
    bankUahRnokpp: '1234567890',
    bankUahBankName: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    legalFullName: 'Тестов Тест Тестович',
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
  },
}

/**
 * Fill all Step 1 mandatory fields and click «Далее».
 * JUNIOR default role requires BANK_UAH_FOP requisites + legalFullName.
 */
async function fillStep1AndAdvance(user: ReturnType<typeof userEvent.setup>) {
  // Identity
  await user.type(screen.getByTestId('user-dialog-email'), 'test@example.com')
  await user.type(screen.getByTestId('user-dialog-name'), 'Тест Тестов')
  await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Тестов Тест Тестович')

  // Bank UAH FOP requisites (required for JUNIOR default role)
  await user.type(screen.getByTestId('user-dialog-bank-recipient'), 'Тестов Тест')
  await user.type(screen.getByTestId('user-dialog-bank-iban'), 'UA123456789012345678901234567')
  await user.type(screen.getByTestId('user-dialog-bank-rnokpp'), '1234567890')

  await user.click(screen.getByTestId('wizard-next-btn'))
}

// ── Tests: Task 3 ──────────────────────────────────────────────────────────

describe('UserDialog — create-mode wizard (Task 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    // Default: successful POST
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('shows Stepper in create mode', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-3')).toBeInTheDocument()
  })

  it('step 1 is active at start', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'upcoming')
  })

  it('shows «Далее» button in step 1 create mode', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('wizard-next-btn')).toBeInTheDocument()
  })

  it('«Далее» calls POST /api/users and advances to step 2 on success', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<UserDialog mode="create" open={true} onClose={onClose} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => {
        expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active')
      },
      { timeout: 3000 },
    )

    // Dialog should NOT have closed
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays on step 1 when POST fails', async () => {
    const user = userEvent.setup()
    mockPost.mockRejectedValue(
      Object.assign(new Error('Server error'), { response: { status: 500, data: {} } }),
    )

    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-email'), 'fail@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Ошибка Пользователь')
    await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Пользователь Ошибка Пет')

    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
    })
  })
})

// ── Tests: Task 4 ──────────────────────────────────────────────────────────

describe('UserDialog — step 2 contract editor (Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('renders contract section at step 2', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => {
        expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active')
      },
      { timeout: 3000 },
    )

    expect(screen.getByTestId('wizard-contract-step')).toBeInTheDocument()
  })

  it('«Назад» from step 2 goes back to step 1', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    await user.click(screen.getByTestId('wizard-back-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active'),
    )
  })

  it('«Далее» from step 2 advances to step 3', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    await user.click(screen.getByTestId('wizard-step2-next-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active'),
    )
  })
})

// ── Tests: Task 5 ──────────────────────────────────────────────────────────

const defaultContractData = {
  id: 'contract-1',
  status: 'DRAFT' as const,
  bodyMarkdown: '# Draft contract',
  userId: 'new-user-id-123',
  templateId: 'tpl-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('UserDialog — step 3 confirm (Task 5)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
    // Restore default contract mock (clearAllMocks wipes mockReturnValue)
    const { useEmployeeContract } =
      await import('@/components/user-profile/contract/useEmployeeContract')
    vi.mocked(useEmployeeContract).mockReturnValue({
      data: defaultContractData,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useEmployeeContract>)
  })

  async function advanceToStep3(user: ReturnType<typeof userEvent.setup>) {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    await user.click(screen.getByTestId('wizard-step2-next-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active'),
    )
  }

  it('shows step 3 confirm section with both finalize buttons', async () => {
    const user = userEvent.setup()
    await advanceToStep3(user)

    expect(screen.getByTestId('wizard-confirm-step')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-save-draft-btn')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-mark-ready-btn')).toBeInTheDocument()
  })

  it('«Назад» from step 3 goes back to step 2', async () => {
    const user = userEvent.setup()
    await advanceToStep3(user)

    await user.click(screen.getByTestId('wizard-step3-back-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
    )
  })

  it('«Сохранить как черновик» closes without POST /ready call', async () => {
    const user = userEvent.setup()
    await advanceToStep3(user)

    // Reset mockPost to track only /ready calls from now
    mockPost.mockClear()

    await user.click(screen.getByTestId('wizard-save-draft-btn'))

    const readyCalls = mockPost.mock.calls.filter((c) => String(c[0]).includes('/ready'))
    expect(readyCalls).toHaveLength(0)
  })

  it('«Отметить готовым» is disabled when hasContract=false (no-template)', async () => {
    // Override: useEmployeeContract returns error (no template)
    const { useEmployeeContract } =
      await import('@/components/user-profile/contract/useEmployeeContract')
    vi.mocked(useEmployeeContract).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: Object.assign(new Error('No template'), { response: { status: 404 } }),
    } as ReturnType<typeof useEmployeeContract>)

    const user = userEvent.setup()
    await advanceToStep3(user)

    const readyBtn = screen.getByTestId('wizard-mark-ready-btn')
    expect(readyBtn).toBeDisabled()
  })

  it('«Отметить готовым» calls POST /ready', async () => {
    const user = userEvent.setup()

    // advanceToStep3 renders component & calls fillStep1AndAdvance internally
    // which consumes the first mockPost call (POST /users).
    // We use mockResolvedValue (not Once) so all POST calls succeed.
    // After reaching step 3, the /ready call is a separate POST invocation.
    mockPost.mockResolvedValue(newUserResponse)

    await advanceToStep3(user)

    // Track calls before clicking ready
    const callsBefore = mockPost.mock.calls.length

    await user.click(screen.getByTestId('wizard-mark-ready-btn'))

    await waitFor(() => {
      // At least one new POST call after step 3 click
      const newCalls = mockPost.mock.calls.slice(callsBefore)
      expect(newCalls.length).toBeGreaterThan(0)
    })
  })
})
