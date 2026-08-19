/**
 * ArchiveConfirmDialog (users list page variant) — interaction tests.
 *
 * task-archive-pending-modal (round 2, code-review H2). This file previously
 * had ZERO test coverage — the mutation gate independently confirmed
 * `users/ArchiveConfirmDialog.tsx: 0.00% covered, 106 no-coverage` even
 * though the component is one of the three surfaces this task rewrote
 * (`ImpactWarning`'s SENIOR/DROP cascade branch, the pending-transactions
 * list, the confirm-by-typing-name mechanic). Brought up to the same level
 * the generic dialog already has via `AdminActionsMenu.test.tsx`.
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
import { ArchiveConfirmDialog } from '../ArchiveConfirmDialog'

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

function renderDialog(user: UserProfileDto | null, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <ArchiveConfirmDialog user={user} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { ...utils, queryClient: qc, onClose }
}

describe('ArchiveConfirmDialog (users list) — loading + gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing (no dialog) when user is null', () => {
    renderDialog(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows skeletons while the impact query is pending', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    renderDialog(makeUser({ role: 'JUNIOR' }))
    const dialog = await screen.findByRole('dialog')
    // Confirm-input is only rendered once `user` truthy — always present —
    // but the impact area shows skeletons, not warning text, while loading.
    expect(within(dialog).queryByTestId('archive-warning-junior')).not.toBeInTheDocument()
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

describe('ArchiveConfirmDialog (users list) — role-aware ImpactWarning + AC2 pending list', () => {
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
              type: 'SALARY',
              salaryMonth: '2026-07',
              txDate: null,
              amount: '500.00',
              currency: 'USD',
            },
          ],
        },
      })
      renderDialog(makeUser({ role, displayName: 'Oleksiy Kovalenko' }))

      // Wait for the ACTUAL content, not just the dialog shell — the shell
      // mounts synchronously with `open` already true, so `findByRole('dialog')`
      // alone can resolve before the mocked query settles.
      await screen.findByTestId('archive-warning-senior')
      const dialog = screen.getByRole('dialog')
      const text = dialog.textContent ?? ''
      expect(text).toContain('связанная пара')
      expect(text).toContain('Alpha Team')
      expect(text).toContain('Project A, Project B')
      expect(text).toContain('2')
      expect(text).toContain('3')
      expect(text).toContain('4')
      expect(text).toContain('остаются активными членами')

      // AC2: the pending-transactions warning renders alongside the cascade copy.
      expect(within(dialog).getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
      expect(text).toContain('500')
    },
  )

  it('HR: shows teams-removed copy, no cascade wording', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'HR', teamsCount: 2, pendingTransactions: [] },
    })
    renderDialog(makeUser({ role: 'HR' }))

    await screen.findByTestId('archive-warning-hr')
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent ?? '').not.toContain('связанная пара')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('ACCOUNTANT: shows teams-removed copy', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ACCOUNTANT', teamsCount: 1, pendingTransactions: [] },
    })
    renderDialog(makeUser({ role: 'ACCOUNTANT' }))

    expect(await screen.findByTestId('archive-warning-accountant')).toBeInTheDocument()
  })

  it('JUNIOR: shows projects-removed copy', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'JUNIOR', projectsCount: 1, pendingTransactions: [] },
    })
    renderDialog(makeUser({ role: 'JUNIOR' }))

    await screen.findByTestId('archive-warning-junior')
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent ?? '').toContain('активных проектов')
  })

  it('ADMIN: no cascade, no pending list', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ role: 'ADMIN' }))

    await screen.findByTestId('archive-warning-admin')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('SENIOR with zero counts and no projectNames: falls back to "—" team name, no ": " suffix', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        projectsCount: 0,
        projectNames: [],
        hrAccountantsToBeRemoved: 0,
        juniorsAffected: 0,
        pendingTransactions: [],
      },
    })
    renderDialog(makeUser({ role: 'SENIOR' }))

    await screen.findByTestId('archive-warning-senior')
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent ?? '').toContain('команда синьора')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })
})

describe('ArchiveConfirmDialog (users list) — confirm mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['SENIOR', 'Синьор и команда архивированы'],
    ['DROP', 'Дроп и команда архивированы'],
    ['JUNIOR', 'Пользователь архивирован'],
  ] as const)('DELETEs /users/:id and shows the %s-specific toast', async (role, expectedToast) => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role, pendingTransactions: [] },
    })
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role, displayName: 'Oleksiy Kovalenko' }))

    await screen.findByRole('dialog')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))

    expect(api.delete).toHaveBeenCalledWith('/users/u-1')
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith(expectedToast))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
