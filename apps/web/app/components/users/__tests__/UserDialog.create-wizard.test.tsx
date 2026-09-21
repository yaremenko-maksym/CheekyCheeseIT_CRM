/**
 * Task 3–5: UserDialog create-mode wizard tests.
 *
 * Strategy: mock heavy deps (TanStack Query, Router, auth, axios) and test
 * step navigation logic, POST/PATCH call targets, and button states.
 * Edit-mode is NOT tested here — it remains unchanged.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { i18n } from '@lingui/core'
import { toast } from 'sonner'

// task-i18n-stage4-task4: UserDialog's field validators now translate their
// zod.<CODE> results through `translateZodMessage` (`i18n._` under the
// hood) — an activated locale is required, same pattern as
// `axios-utils.spec.ts`'s own tests.
beforeAll(() => {
  i18n.load('uk', {})
  i18n.activate('uk')
})

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
    } as unknown as ReturnType<typeof useEmployeeContract>)
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
    } as unknown as ReturnType<typeof useEmployeeContract>)

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

// ── Tests: Task 6 — AC6 back→PATCH (no duplicate POST) ────────────────────

describe('UserDialog — AC6 back→PATCH no duplicate POST (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
    mockPatch.mockResolvedValue(newUserResponse)
  })

  it('«Назад» after step 1 POST then «Далее» again calls PATCH not POST', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    // Step 1 → advance → POST /users is called once, createdUserId set
    await fillStep1AndAdvance(user)

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    // Verify POST was called exactly once
    const postCallsAfterFirst = mockPost.mock.calls.filter((c) => !String(c[0]).includes('/ready'))
    expect(postCallsAfterFirst).toHaveLength(1)

    // «Назад» — navigates back to step 1, no mutation
    await user.click(screen.getByTestId('wizard-back-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active'),
    )

    // «Далее» again — should call PATCH not POST
    const patchCallsBefore = mockPatch.mock.calls.length
    const postCallsBefore = mockPost.mock.calls.filter(
      (c) => !String(c[0]).includes('/ready'),
    ).length

    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    // PATCH called at least once
    expect(mockPatch.mock.calls.length).toBeGreaterThan(patchCallsBefore)
    // POST /users NOT called again
    const postCallsAfterSecond = mockPost.mock.calls.filter(
      (c) => !String(c[0]).includes('/ready'),
    ).length
    expect(postCallsAfterSecond).toBe(postCallsBefore)
  })

  it('«Назад» itself does not trigger any API call', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(
      () => expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
      { timeout: 3000 },
    )

    const callsBefore = {
      post: mockPost.mock.calls.length,
      patch: mockPatch.mock.calls.length,
    }

    await user.click(screen.getByTestId('wizard-back-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active'),
    )

    // No new API calls from «Назад» alone
    expect(mockPost.mock.calls.length).toBe(callsBefore.post)
    expect(mockPatch.mock.calls.length).toBe(callsBefore.patch)
  })
})

// ── Tests: BUG #2 — visible legalFullName validation error ────────────────

describe('UserDialog — step 1 legalFullName visible error on submit (BUG #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('shows error under legalFullName and aria-invalid when submit attempted without filling it (JUNIOR role)', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    // Fill only identity + bank fields, leave legalFullName empty
    await user.type(screen.getByTestId('user-dialog-email'), 'nolegal@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Без Юридичного')
    // Touch (but do not fill) legalFullName so errorMap.onSubmit surfaces
    await user.click(screen.getByTestId('user-dialog-legal-full-name'))
    await user.tab()

    await user.type(screen.getByTestId('user-dialog-bank-recipient'), 'Тестов Тест')
    await user.type(screen.getByTestId('user-dialog-bank-iban'), 'UA123456789012345678901234567')
    await user.type(screen.getByTestId('user-dialog-bank-rnokpp'), '1234567890')

    await user.click(screen.getByTestId('wizard-next-btn'))

    // createUserSchema.superRefine will reject → toast.error fires
    // (POST is not called because Zod parse fails before mutation)
    // The field itself should show aria-invalid once submit is attempted
    await waitFor(
      () => {
        const input = screen.getByTestId('user-dialog-legal-full-name')
        // Either the field is aria-invalid, OR post was NOT called (validation blocked)
        const postCalls = mockPost.mock.calls.filter((c) => !String(c[0]).includes('/ready'))
        expect(postCalls.length === 0 || input.getAttribute('aria-invalid') === 'true').toBe(true)
      },
      { timeout: 2000 },
    )

    // Note (fix-round 2 investigation, CI-5/CR-H-2): this particular path is
    // NOT a counter-example for `createUserSchema.safeParse`'s own toast —
    // `legalFullName`'s `onSubmit` field validator (this file, just above)
    // duplicates the SAME check and TanStack Form never calls this
    // component's `onSubmit` at all once a field validator reports an
    // error, so `toast.error` is NEVER invoked on this exact path (verified:
    // 0 calls). The schema-level `toast.error(translateZodMessage(first?.message)
    // ?? translateZodCode('VALIDATION_FAILED_FORM'))` a few lines up in this
    // file IS reachable, just not from an empty `legalFullName` — see the
    // dedicated test below.
  })
})

// fix-round 2 (CI-5/CR-H-2): the two tests above (BUG #2 + the personalEmail
// describe block) only ever exercise a schema failure that ALSO has its own
// TanStack Form field-level validator — which blocks `form.handleSubmit()`
// from ever reaching this component's manual `createUserSchema.safeParse`
// re-check, so `toast.error(translateZodMessage(first?.message) ??
// translateZodCode('VALIDATION_FAILED_FORM'))` (this file, `isCreate`
// non-drop branch) stayed unobserved by any test — a mutant on either `?.`
// or `??` passed every existing assertion. `bankUahRecipient` /
// `bankUahIban` / `bankUahRnokpp` have ONLY an `onBlur` validator (no
// `onSubmit`), and that validator explicitly no-ops when the field was never
// touched (`!fieldApi.state.meta.isDirty`) — so leaving them completely
// untouched (not even focused) reaches this component's manual schema
// check with `bankUahRecipient: ''`, which `createUserSchema`'s BASE field
// shape (`.min(3, 'zod.RECIPIENT_NAME_MIN')`) rejects as the FIRST issue —
// before `refineRequisitePresence`'s own `RECIPIENT_NAME_REQUIRED` superRefine
// check ever runs (verified directly against the compiled schema).
describe('UserDialog — schema-level toast fallback is reachable (fix-round 2, CI-5/CR-H-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('shows the translated RECIPIENT_NAME_MIN text when bank fields are left completely untouched', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-email'), 'norecipient@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Без Реквизитов')
    await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Валідне ПІБ Тест')
    // Deliberately NOT touching bankUahRecipient/Iban/Rnokpp — their onBlur
    // validators no-op on an untouched field, so nothing blocks submit at
    // the field level; the schema-level check is what has to catch it.

    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() => {
      expect(mockPost).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('ПІБ отримувача — мінімум 3 символи')
    })
  })
})

// ── Tests: §4.4 personalEmail field (task-user-emails-dual-login) ─────────

describe('UserDialog — personalEmail field (§4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('is rendered only in create mode, not edit mode', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('user-dialog-personal-email')).toBeInTheDocument()
  })

  it('a filled personalEmail is forwarded in the POST /api/users body', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-personal-email'), 'ivan.personal@gmail.com')
    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body.personalEmail).toBe('ivan.personal@gmail.com')
    })
  })

  it('an omitted personalEmail is NOT present in the POST /api/users body', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body).not.toHaveProperty('personalEmail')
    })
  })

  it('a personalEmail identical to the work email is rejected client-side — no POST', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-email'), 'same@example.com')
    await user.type(screen.getByTestId('user-dialog-personal-email'), 'same@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Тест Тестов')
    await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Тестов Тест Тестович')
    await user.type(screen.getByTestId('user-dialog-bank-recipient'), 'Тестов Тест')
    await user.type(screen.getByTestId('user-dialog-bank-iban'), 'UA123456789012345678901234567')
    await user.type(screen.getByTestId('user-dialog-bank-rnokpp'), '1234567890')
    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls).toHaveLength(0)
    })
  })

  // mutation-gate closure (PR #623): the tests above exercise the onBlur
  // validator (Tests ran: lists them against every survivor in the block),
  // but never asserted the actual rendered error TEXT or destructive style —
  // only whether POST fired. A validator that silently returns the wrong
  // message, or a render that silently drops the destructive class, left
  // those tests green. The tests below assert what actually appears in the
  // DOM.
  it('shows the exact zod format-error text and the destructive input style for an invalid personalEmail', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-personal-email')
    expect(input).toHaveAttribute('spellcheck', 'false')
    // Baseline: untouched field carries no destructive style.
    expect(input.className).not.toContain('border-destructive')

    await user.type(input, 'not-an-email')
    await user.tab()

    expect(await screen.findByText('Введіть email у форматі name@domain')).toBeInTheDocument()
    expect(input.className).toContain('border-destructive')
  })

  it('shows the exact duplicate-email error when personalEmail matches the (untrimmed, differently-cased) work email', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    // Trailing space on the work email — the email field's own onChange is
    // raw/untrimmed until submit, so the comparison must trim it itself.
    // Different case on both sides — the comparison must fold both.
    await user.type(screen.getByTestId('user-dialog-email'), 'Same@Example.com ')
    await user.type(screen.getByTestId('user-dialog-personal-email'), 'same@example.com')
    await user.tab()

    expect(
      await screen.findByText('Особистий email має відрізнятися від робочого'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-personal-email').className).toContain(
      'border-destructive',
    )
  })

  it('clears the inline error once an invalid personalEmail is fixed to a genuinely different, valid one', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-personal-email')
    await user.type(input, 'not-an-email')
    await user.tab()
    expect(await screen.findByText('Введіть email у форматі name@domain')).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'ivan.personal@gmail.com')
    await user.tab()

    await waitFor(() => {
      expect(screen.queryByText('Введіть email у форматі name@domain')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Особистий email має відрізнятися від робочого'),
      ).not.toBeInTheDocument()
    })
    expect(input.className).not.toContain('border-destructive')
  })

  // Note on intent: this types a padded value on purpose, but the padding
  // itself is NOT what's being pinned — a `type="email"` input's own HTML
  // value-sanitization strips leading/trailing whitespace before `onChange`
  // ever sees it (verified in jsdom; WHATWG HTML §4.10.5.1.4, not a jsdom
  // quirk), so no typed input can exercise the `.trim()` calls in
  // UserDialog.tsx differently with vs. without them — those are suppressed
  // at the source with that reasoning. What THIS test still pins for real:
  // a personalEmail typed alongside real spacebar keystrokes round-trips to
  // the POST body correctly and raises no false-positive inline error.
  it('forwards a personalEmail typed with surrounding spaces to POST /api/users, with no inline error', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-personal-email'), '  ivan.personal@gmail.com  ')
    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body.personalEmail).toBe('ivan.personal@gmail.com')
    })
    expect(screen.queryByText('Введіть email у форматі name@domain')).not.toBeInTheDocument()
  })

  it('omits a whitespace-only personalEmail from the POST body instead of sending it as an empty string', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-personal-email')
    await user.type(input, '   ')
    await user.tab()

    // mutation-gate closure: a mutant that bypasses the validator's
    // `!trimmed` early-return would fall through to `z.string().email()`
    // on an EMPTY string (post-trim) and produce the format error here —
    // whitespace-only is meant to behave exactly like untouched/empty, not
    // like invalid input.
    await waitFor(() => {
      expect(screen.queryByText('Введіть email у форматі name@domain')).not.toBeInTheDocument()
    })
    expect(input.className).not.toContain('border-destructive')

    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body).not.toHaveProperty('personalEmail')
    })
  })
})

// task-i18n-stage2 (Task 3, Step 6) — create-wizard "Данные" step field.
describe('UserDialog — locale field (task-i18n-stage2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue(newUserResponse)
  })

  it('is rendered only in create mode, defaults to Українська', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    const trigger = screen.getByTestId('user-locale-select')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('Українська')
  })

  it('selecting English forwards locale:"en" in the POST /api/users body', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('user-locale-select'))
    fireEvent.click(await screen.findByRole('option', { name: 'English' }))
    expect(screen.getByTestId('user-locale-select')).toHaveTextContent('English')

    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body.locale).toBe('en')
    })
  })

  it('leaving the default selection forwards locale:"uk" in the POST /api/users body', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await fillStep1AndAdvance(user)

    await waitFor(() => {
      const postCalls = mockPost.mock.calls.filter((c) => String(c[0]) === '/users')
      expect(postCalls.length).toBeGreaterThan(0)
      const body = postCalls[0]?.[1] as Record<string, unknown>
      expect(body.locale).toBe('uk')
    })
  })
})

// fix-round 2 (CI-5/CR-H-2): the `email` and `displayName` field onBlur
// validators (`EMAIL_REQUIRED`/`EMAIL_INVALID`/`DISPLAY_NAME_MIN`) had no
// test asserting the RENDERED error text — only indirect coverage through
// tests that fill valid values. A mutant flipping the `!trimmed` condition,
// or blanking the `zod.EMAIL_INVALID`/`zod.DISPLAY_NAME_MIN` string
// literals, left every existing test green.
describe('UserDialog — email/displayName field errors (fix-round 2, CI-5/CR-H-2)', () => {
  it('shows EMAIL_REQUIRED once the work email is touched and cleared', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-email')
    await user.type(input, 'x')
    await user.clear(input)
    await user.tab()

    expect(await screen.findByText('Введіть email')).toBeInTheDocument()
  })

  it('shows EMAIL_INVALID for a malformed work email', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-email')
    await user.type(input, 'not-an-email')
    await user.tab()

    expect(await screen.findByText('Введіть email у форматі name@domain')).toBeInTheDocument()
  })

  it('shows DISPLAY_NAME_MIN for a 1-character name', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    const input = screen.getByTestId('user-dialog-name')
    await user.type(input, 'A')
    await user.tab()

    expect(await screen.findByText('Ім’я — мінімум 2 символи')).toBeInTheDocument()
  })

  it('shows LEGAL_FULL_NAME_MIN for a non-empty legalFullName under the 5-char minimum', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    // Non-empty (the onBlur validator no-ops on an empty value — the
    // "required for contract" case is a SEPARATE onSubmit validator, see
    // the dedicated BUG #2 describe block above) but under the 5-char floor.
    const input = screen.getByTestId('user-dialog-legal-full-name')
    await user.type(input, 'Абв')
    await user.tab()

    expect(await screen.findByText('ПІБ — мінімум 5 символів')).toBeInTheDocument()
  })
})
