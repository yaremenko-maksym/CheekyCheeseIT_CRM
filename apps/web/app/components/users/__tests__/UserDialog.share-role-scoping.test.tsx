/**
 * task-drop-share-low-findings — LOW findings from PR #373 review.
 *
 * Two frontend fixes, both about role-scoping the Finance section of
 * UserDialog to match the already-role-scoped backend contract:
 *
 *  1. DROP <ShareSlider> now gets `min={0}` (previously defaulted to
 *     `min=1`, making 0% unreachable through the UI even though the
 *     validator/backend both allow it).
 *  2. The edit-mode submit payload no longer includes `monthlySalary` /
 *     `salaryCurrency` for a DROP target (DROP has no salary field in the
 *     Finance section — the payload now mirrors what's actually rendered).
 */
import { render, screen, waitFor } from '@testing-library/react'
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

// Mock API calls — axios intercepted directly, matching UserDialog.create-wizard.test.tsx
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

// Contract-heavy deps — not exercised in edit mode (rendered only for
// isCreate && currentStep===2), stub them defensively anyway.
vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn().mockReturnValue({ data: null, isLoading: false, error: null }),
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
  ContractEditor: () => <div data-testid="contract-editor-mock" />,
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockUseUser = vi.fn()
vi.mock('@/hooks/use-user-profile', () => ({
  useUser: (...args: unknown[]) => mockUseUser(...args),
}))

// Real useMutation pass-through (mutationFn actually invoked, capturing the
// api.patch call) — mirrors UserDialog.create-wizard.test.tsx. useQuery is
// static (no exchange-rate/teams/projects data needed for these assertions).
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
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

import { UserDialog } from '../UserDialog'

// ── Fixtures ─────────────────────────────────────────────────────────────
// Shape mirrors the full single-resource profile (buildProfileView) merged
// over the slim list-item, same contract as UserDialog.edit-prefill.test.tsx.

function makeProfile(overrides: Record<string, unknown>) {
  return {
    id: 'user-x',
    email: 'user@example.com',
    displayName: 'Тест Юзер',
    avatarUrl: null,
    avatarDocumentId: null,
    googleId: null,
    telegram: null,
    phone: null,
    techStack: [],
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x1234567890123456789012345678901234567890',
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    legalFullName: 'Тестов Тест Тестович',
    registrationAddress: null,
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const dropProfile = makeProfile({
  id: 'drop-1',
  email: 'drop@example.com',
  displayName: 'Дроп Тестовый',
  role: 'DROP',
  dropSharePercent: 5,
})

const hrProfile = makeProfile({
  id: 'hr-1',
  email: 'hr@example.com',
  displayName: 'HR Тестовый',
  role: 'HR',
  paymentMethod: 'BANK_UAH_FOP',
  walletUsdtErc20: null,
  bankUahRecipient: 'Іваненко Іван',
  bankUahIban: 'UA903052992990004149123456789',
  bankUahRnokpp: '1234567890',
  monthlySalary: '1500.00',
})

function mockProfileResponse(profile: ReturnType<typeof makeProfile>) {
  return { user: profile, permissions: { tabs: ['overview'], actions: [], fields: {} }, data: {} }
}

describe('UserDialog — DROP role-scoped share/salary fields (LOW findings PR #373)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
  })

  // ── AC3 / test-case 6 ──────────────────────────────────────────────────
  it('DROP ShareSlider allows 0% via min=0 on both range and number inputs', async () => {
    mockUseUser.mockReturnValue({ data: mockProfileResponse(dropProfile), isLoading: false })

    render(<UserDialog mode="edit" user={dropProfile as never} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getAllByLabelText('Доля дропа в процентах').length).toBeGreaterThan(0)
    })
    const inputs = screen.getAllByLabelText('Доля дропа в процентах')
    const rangeInput = inputs.find((el) => el.getAttribute('type') === 'range')
    const numberInput = inputs.find((el) => el.getAttribute('type') === 'number')
    expect(rangeInput).toHaveAttribute('min', '0')
    expect(numberInput).toHaveAttribute('min', '0')
  })

  // ── AC4 / test-case 7 ──────────────────────────────────────────────────
  it('edit-payload for a DROP target does NOT include monthlySalary/salaryCurrency', async () => {
    mockUseUser.mockReturnValue({ data: mockProfileResponse(dropProfile), isLoading: false })
    mockPatch.mockResolvedValue({ data: dropProfile })

    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={dropProfile as never} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('user-dialog-submit')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('user-dialog-submit'))

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
    })
    const payload = mockPatch.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload).not.toHaveProperty('monthlySalary')
    expect(payload).not.toHaveProperty('salaryCurrency')
  })

  it('edit-payload for a HR (salary-role) target still includes monthlySalary/salaryCurrency (regression)', async () => {
    mockUseUser.mockReturnValue({ data: mockProfileResponse(hrProfile), isLoading: false })
    mockPatch.mockResolvedValue({ data: hrProfile })

    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={hrProfile as never} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('user-dialog-submit')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('user-dialog-submit'))

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
    })
    const payload = mockPatch.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload).toHaveProperty('monthlySalary')
    expect(payload).toHaveProperty('salaryCurrency', 'USD')
  })
})
