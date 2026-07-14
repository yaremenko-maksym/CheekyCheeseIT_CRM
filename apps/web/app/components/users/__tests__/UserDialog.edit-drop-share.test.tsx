/**
 * Prod bug repro — ADMIN edits a DROP user's «Доля дропа (%)» (dropSharePercent)
 * via the profile edit dialog, submits, sees «Пользователь обновлён», but the
 * value is unchanged after reload.
 *
 * Root cause: `UserDialog.tsx`'s edit-mode `onSubmit` payload builder computes
 * `isDrop` but only ever spreads a Finance slice into the PATCH payload for
 * `isSenior` (`seniorSharePercent`) — there is no matching `isDrop` branch that
 * adds `dropSharePercent`. The field renders and is editable (Finance section
 * switches on `role === 'DROP'`), but the edited value is silently dropped
 * from the request body. The backend's `adminUpdateUser` only writes fields
 * present in `data` (`if (data.dropSharePercent !== undefined) ...`), so a
 * PATCH without the key is a no-op for that column — 200 OK, unchanged row.
 *
 * This test drives the real edit form (mode="edit", DROP user), changes the
 * share input, submits, and asserts the PATCH body actually carries the new
 * `dropSharePercent`. Before the fix this assertion fails (key absent).
 *
 * A companion assertion covers `seniorSharePercent` (SENIOR edit) to prove the
 * sibling field was never broken — only the DROP branch was missing.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UserProfileDto } from '@crm/shared'

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

const mockPatch = vi.fn()
const mockGet = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: {
    post: vi.fn(),
    patch: (...args: unknown[]) => mockPatch(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn().mockReturnValue({ data: null, isLoading: false, error: null }),
  useSaveContractBody: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  contractKeys: { detail: (id: string) => ['employee-contract', id] },
}))
vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: () => <div data-testid="contract-editor-mock" />,
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/hooks/use-user-profile', () => ({
  // useUser(id, enabled) — the dialog merges this over the slim list-item.
  // Return "no data yet" so the form falls back to the passed-in `user` prop
  // (which already carries every field for this test — no slim/full split).
  useUser: () => ({ data: undefined, isLoading: false, error: null }),
}))

// Real useMutation pass-through (mirrors UserDialog.create-wizard.test.tsx) so
// mutationFn → api.patch → onSuccess lifecycle fires exactly as in prod.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null }),
    useQueryClient: vi.fn().mockReturnValue({
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    }),
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

const dropUser: UserProfileDto = {
  id: 'drop-1',
  email: 'drop@example.com',
  displayName: 'Сергій Сергеєв',
  role: 'DROP',
  avatarUrl: null,
  avatarDocumentId: null,
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
  dropSharePercent: 5,
  legalFullName: null,
  registrationAddress: null,
  monthlySalary: null,
  salaryCurrency: 'USD',
  archivedAt: null,
  adminNote: null,
  createdAt: new Date(),
} as unknown as UserProfileDto

const seniorUser: UserProfileDto = {
  ...dropUser,
  id: 'senior-1',
  email: 'senior@example.com',
  displayName: 'Синьйор Тест',
  role: 'SENIOR',
  seniorSharePercent: 26,
  dropSharePercent: null,
} as unknown as UserProfileDto

describe('UserDialog — edit-mode DROP share % persists on submit (prod bug repro)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPatch.mockResolvedValue({ data: { ...dropUser, dropSharePercent: 10 } })
  })

  it('includes the edited dropSharePercent in the PATCH body', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={dropUser} onClose={vi.fn()} />)

    const shareInput = await screen.findByRole('spinbutton', { name: 'Доля дропа в процентах' })
    expect(shareInput).toHaveValue(5)

    // Controlled numeric input — a single `fireEvent.change` mirrors what the
    // browser delivers on a real edit (avoids RTL's `.clear()`/`.type()`
    // keystroke replay racing the React-controlled `value` prop).
    fireEvent.change(shareInput, { target: { value: '10' } })
    fireEvent.blur(shareInput)
    expect(shareInput).toHaveValue(10)

    await user.click(screen.getByTestId('user-dialog-submit'))

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
    })

    const [, body] = mockPatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('dropSharePercent', 10)
  })
})

describe('UserDialog — edit-mode SENIOR share % persists on submit (regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPatch.mockResolvedValue({ data: { ...seniorUser, seniorSharePercent: 30 } })
  })

  it('includes the edited seniorSharePercent in the PATCH body (was never broken)', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)

    const shareInput = await screen.findByRole('spinbutton', { name: 'Доля синьора в процентах' })
    expect(shareInput).toHaveValue(26)

    fireEvent.change(shareInput, { target: { value: '30' } })
    fireEvent.blur(shareInput)
    expect(shareInput).toHaveValue(30)

    await user.click(screen.getByTestId('user-dialog-submit'))

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
    })

    const [, body] = mockPatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('seniorSharePercent', 30)
  })
})
