/**
 * ArchiveUserDialog (profile page "Действия" → «Архивировать») — interaction
 * tests.
 *
 * task-archive-pending-modal (round 2). This directory previously had ZERO
 * test files at all — the mutation gate independently confirmed
 * `user-profile/admin-actions: 0.00% covered, 21 no-coverage` even though
 * this component was rewritten in this task (signature change from
 * `{userId, userName}` to `{user: UserProfileDto}`, new archive-impact
 * fetch + `ImpactWarning`/`ArchivePendingTransactionsList` reuse, migration
 * from the overflowing bare `DialogContent` to `CrmDialogContent` — see the
 * design-fidelity BLOCK this round fixed). Brought up to test-coverage
 * parity with the other two archive dialogs.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UserProfileDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { ArchiveUserDialog } from '../ArchiveUserDialog'

const BASE_USER = {
  id: 'u-1',
  email: 'u1@example.com',
  displayName: 'Oleksiy Kovalenko',
  avatarUrl: null,
  avatarDocumentId: null,
  telegram: null,
  phone: null,
  techStack: [],
  paymentMethod: 'USDT_ERC20',
  walletUsdtErc20: null,
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

function makeUser(overrides: Partial<UserProfileDto>): UserProfileDto {
  return { ...BASE_USER, ...overrides } as UserProfileDto
}

function renderDialog(user: UserProfileDto, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <ArchiveUserDialog user={user} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { ...utils, queryClient: qc, onClose }
}

describe('ArchiveUserDialog (profile page) — mounts on the CrmDialogContent pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the dialog with title + both action buttons even before impact resolves', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    renderDialog(makeUser({ role: 'JUNIOR' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Архивировать пользователя')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeInTheDocument()
    expect(screen.getByTestId('archive-confirm-submit')).toBeInTheDocument()
  })

  it('confirm button stays disabled until the typed name matches exactly', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const submit = await screen.findByTestId('archive-confirm-submit')
    expect(submit).toBeDisabled()

    const input = screen.getByTestId('archive-confirm-name-input')
    await user.type(input, 'wrong name')
    expect(submit).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Oleksiy Kovalenko')
    expect(submit).toBeEnabled()
  })

  it('Отмена closes without calling DELETE', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'ADMIN' }))

    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.delete).not.toHaveBeenCalled()
  })
})

describe('ArchiveUserDialog (profile page) — reuses ImpactWarning + AC2 pending list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['SENIOR', 'DROP'] as const)(
    'renders the FULL cascade-pair copy for %s (AC7/AC9) — names team, projects, third-party counts',
    async (role) => {
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'user',
          role,
          isPaired: true,
          teamName: 'Alpha Team',
          projectsCount: 2,
          projectNames: ['Project A', 'Project B'],
          hrAccountantsToBeRemoved: 3,
          juniorsAffected: 4,
          pendingTransactions: [
            {
              id: 'tx-1',
              type: 'SENIOR_INCOME',
              salaryMonth: null,
              txDate: '2026-08-01T00:00:00.000Z',
              amount: '4500.00',
              currency: 'USD',
            },
          ],
        },
      })
      renderDialog(makeUser({ role, displayName: 'Oleksiy Kovalenko' }))

      // Wait for the ACTUAL content, not just the dialog shell — see the same
      // note in users/ArchiveConfirmDialog.test.tsx for why this matters.
      await screen.findByTestId('archive-warning-senior')
      const dialog = screen.getByRole('dialog')
      const text = dialog.textContent ?? ''
      expect(text).toContain('связанная пара')
      expect(text).toContain('Alpha Team')
      expect(text).toContain('Project A, Project B')
      expect(text).toContain('остаются активными членами')

      // AC2/AC8: the pending-transactions warning renders alongside the
      // cascade copy — this dialog previously showed NEITHER.
      expect(within(dialog).getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
      expect(text).toContain('4')
    },
  )

  it('JUNIOR: shows projects-removed copy (no cascade wording)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'JUNIOR', projectsCount: 1, pendingTransactions: [] },
    })
    renderDialog(makeUser({ role: 'JUNIOR' }))

    await screen.findByTestId('archive-warning-junior')
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent ?? '').toContain('активных проектов')
    expect(dialog.textContent ?? '').not.toContain('связанная пара')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('ADMIN: no cascade, no pending list', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ role: 'ADMIN' }))

    await screen.findByTestId('archive-warning-admin')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })
})

describe('ArchiveUserDialog (profile page) — confirm mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DELETEs /users/:id, toasts, and closes on success', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'JUNIOR', projectsCount: 0, pendingTransactions: [] },
    })
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'JUNIOR', displayName: 'Oleksiy Kovalenko' }))

    await screen.findByRole('dialog')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))

    expect(api.delete).toHaveBeenCalledWith('/users/u-1')
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Пользователь архивирован'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
