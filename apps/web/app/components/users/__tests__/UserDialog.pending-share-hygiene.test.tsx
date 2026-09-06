/**
 * task-648-fix-round-2 (SR-M-5 / QA-HIGH-3) — manual QA's live repro, as a
 * test.
 *
 * QA edited ONE field on a senior's profile — the phone number — and watched
 * the senior's live share proposal go `PENDING → CANCELLED` in the database,
 * with no signal anywhere in the UI. Two independent causes, both fixed in
 * round 2:
 *
 *  1. the backend treated "requested percent == active percent" as an
 *     implicit cancel (removed in round 2 — `users.pending-share.spec.ts`
 *     covers that half);
 *  2. THIS half: `UserDialog` puts `seniorSharePercent` into the PATCH body
 *     on EVERY save of a SENIOR, touched or not. Even with (1) fixed that is
 *     a field-scoped-RBAC write the operator never asked for; combined with
 *     (1) it was destructive.
 *
 * The project-side form has always done this correctly (`overrideChanged` in
 * `$projectId.tsx` compares against the server snapshot before including the
 * key) — this brings the user-side form to the same rule.
 *
 * Harness mirrors `UserDialog.edit-drop-share.test.tsx` (same mocks, same
 * real-`useMutation` pass-through) so both files exercise the identical
 * submit lifecycle.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UserProfileDto } from '@crm/shared'

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
const mockPost = vi.fn()
const mockGet = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: {
    post: (...args: unknown[]) => mockPost(...args),
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

// `vi.mock` factories are hoisted above module-scope consts — the spies have
// to be created inside `vi.hoisted` to exist by the time the factory runs.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

vi.mock('@/hooks/use-user-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-user-profile')>()
  return {
    ...actual,
    useUser: () => ({ data: undefined, isLoading: false, error: null }),
  }
})

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

const seniorUser: UserProfileDto = {
  id: 'senior-1',
  email: 'senior@example.com',
  displayName: 'Синьйор Тест',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  telegram: null,
  phone: '+380501112233',
  techStack: [],
  paymentMethod: 'USDT_ERC20',
  walletUsdtErc20: '0x1234567890123456789012345678901234567890',
  walletUsdtLabel: null,
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  seniorSharePercent: 26,
  dropSharePercent: null,
  legalFullName: null,
  registrationAddress: null,
  monthlySalary: null,
  salaryCurrency: 'USD',
  archivedAt: null,
  adminNote: null,
  createdAt: new Date(),
} as unknown as UserProfileDto

describe('UserDialog — SR-M-5/QA-HIGH-3: an untouched share % never reaches the wire', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPatch.mockResolvedValue({ data: { ...seniorUser } })
  })

  it('editing an unrelated field sends NO seniorSharePercent key at all', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)

    // QA's repro used the phone; the assertion is about ANY unrelated field.
    // Addressed by test-id, not by label: this dialog's `Field` wrapper
    // renders the caption as a sibling `<label>` with no `htmlFor`, so
    // `findByLabelText` cannot reach any of its inputs.
    const displayName = await screen.findByTestId('user-dialog-name')
    fireEvent.change(displayName, { target: { value: 'Синьйор Перейменований' } })
    fireEvent.blur(displayName)

    await user.click(screen.getByTestId('user-dialog-submit'))
    await waitFor(() => expect(mockPatch).toHaveBeenCalled())

    const [, body] = mockPatch.mock.calls[0] as [string, Record<string, unknown>]
    // Not "equals 26" — ABSENT. The backend writes only keys that are
    // present, so absence is the only shape that cannot open, refresh or
    // kill a proposal.
    expect(body).not.toHaveProperty('seniorSharePercent')
  })

  it('editing the share % itself still sends it (the fix must not disable the field)', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)

    const shareInput = await screen.findByRole('spinbutton', { name: 'Доля синьора в процентах' })
    fireEvent.change(shareInput, { target: { value: '40' } })
    fireEvent.blur(shareInput)

    await user.click(screen.getByTestId('user-dialog-submit'))
    await waitFor(() => expect(mockPatch).toHaveBeenCalled())

    const [, body] = mockPatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('seniorSharePercent', 40)
  })
})

describe('UserDialog — COPY-H-6: saving a share change says the change is not live yet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
  })

  it('names the proposed value, the live value, and who must confirm', async () => {
    // The PATCH response already carries the opened proposal — no extra
    // round-trip needed to know a proposal was created.
    mockPatch.mockResolvedValue({
      data: {
        ...seniorUser,
        seniorSharePercent: 26,
        pendingSeniorShare: {
          percent: 40,
          effectivePercentAfterApproval: 40,
          approverId: 'senior-1',
          approverName: 'Синьйор Тест',
        },
      },
    })
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)

    const shareInput = await screen.findByRole('spinbutton', { name: 'Доля синьора в процентах' })
    fireEvent.change(shareInput, { target: { value: '40' } })
    fireEvent.blur(shareInput)

    await user.click(screen.getByTestId('user-dialog-submit'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())

    const message = String(toastSuccess.mock.calls.at(-1)?.[0])
    expect(message).toContain('40%')
    expect(message).toContain('26%')
    expect(message).toMatch(/ждёт подтверждения/i)
    // «Пользователь обновлён» is the lie this replaces for THIS case: the
    // live column was not updated at all.
    expect(message).not.toBe('Пользователь обновлён')
  })

  it('keeps the plain «Пользователь обновлён» when no proposal was opened', async () => {
    mockPatch.mockResolvedValue({ data: { ...seniorUser, pendingSeniorShare: null } })
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)

    // QA's repro used the phone; the assertion is about ANY unrelated field.
    // Addressed by test-id, not by label: this dialog's `Field` wrapper
    // renders the caption as a sibling `<label>` with no `htmlFor`, so
    // `findByLabelText` cannot reach any of its inputs.
    const displayName = await screen.findByTestId('user-dialog-name')
    fireEvent.change(displayName, { target: { value: 'Синьйор Перейменований' } })
    fireEvent.blur(displayName)

    await user.click(screen.getByTestId('user-dialog-submit'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())

    expect(toastSuccess).toHaveBeenCalledWith('Пользователь обновлён')
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-2 (UX-H-3(r2)) — the edit dialog stops hiding a live
// proposal. The designer's finding: an ADMIN who opens this form to "fix" the
// percent saw a slider holding the ACTIVE value and nothing at all about the
// proposal already awaiting an answer, so the natural gesture (type a new
// number, save) silently superseded it.
// ---------------------------------------------------------------------------

const seniorWithPending: UserProfileDto = {
  ...seniorUser,
  pendingSeniorShare: {
    percent: 40,
    effectivePercentAfterApproval: 40,
    approverId: 'senior-1',
    approverName: 'Синьйор Тест',
  },
} as unknown as UserProfileDto

describe('UserDialog — edit dialog announces a live proposal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue({ data: { ...seniorUser, pendingSeniorShare: null } })
  })

  it('names the proposed percent and the person who must answer it', async () => {
    render(<UserDialog mode="edit" user={seniorWithPending} onClose={vi.fn()} />)
    const notice = await screen.findByTestId('pending-share-edit-notice-user')
    expect(notice).toHaveTextContent('40%')
    expect(notice).toHaveTextContent('Синьйор Тест')
  })

  it('offers to withdraw it, and the button POSTs to the cancel endpoint', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorWithPending} onClose={vi.fn()} />)
    await user.click(await screen.findByTestId('cancel-pending-share-user-in-dialog'))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/users/senior-1/senior-share/cancel'),
    )
  })

  it('is absent when nothing is pending', async () => {
    render(<UserDialog mode="edit" user={seniorUser} onClose={vi.fn()} />)
    // Wait for the share field itself so "absent" is a real absence, not a
    // race against the dialog rendering at all.
    await screen.findByRole('spinbutton', { name: 'Доля синьора в процентах' })
    expect(screen.queryByTestId('pending-share-edit-notice-user')).toBeNull()
  })

  it('is absent in create mode, where the share field renders against a null editingUser', async () => {
    // Also the only test that renders the share field with `editingUser ===
    // null` — the `?.` in `editingUser?.pendingSeniorShare` is load-bearing
    // exactly here, and without this case a plain `.` would throw only in
    // production.
    // `hrOnly` starts the wizard on role SENIOR (see `initialRole`), which
    // is what puts the share field on screen with no `editingUser` behind it.
    render(<UserDialog mode="create" open={true} hrOnly onClose={vi.fn()} />)
    await screen.findByTestId('user-dialog-name')
    expect(screen.getByRole('spinbutton', { name: 'Доля синьора в процентах' })).toBeInTheDocument()
    expect(screen.queryByTestId('pending-share-edit-notice-user')).toBeNull()
  })
})
