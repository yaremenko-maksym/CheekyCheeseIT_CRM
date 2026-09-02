/**
 * AdminActionsMenu — "Изменить/Добавить личный email" (COPY-M-12,
 * copy-review PR #623 round 5). Mirrors
 * `AdminActionsMenu.resend-invite.test.tsx`'s shape (zero prior coverage for
 * this menu item's own state-dependent label).
 *
 * `canChangePersonalEmail` is deliberately NOT gated on `user.personalEmail`
 * (see that field's own comment, `AdminActionsMenu.tsx`) — this is the ONLY
 * entry point that can ADD a first personal address, not just change one.
 * The label is what tells the two states apart.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, UserProfileDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { AdminActionsMenu } from '../AdminActionsMenu'

const BASE_USER = {
  id: 'u-1',
  email: 'u1@example.com',
  displayName: 'Oleksiy Kovalenko',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'SENIOR',
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
  personalEmail: null,
  personalContactVisible: false,
  personalEmailCanLogin: null,
} as unknown as UserProfileDto

function makeUser(overrides: Partial<UserProfileDto>): UserProfileDto {
  return { ...BASE_USER, ...overrides } as UserProfileDto
}

const ALL_ACTIONS: ActionKey[] = [
  'edit-profile',
  'change-role',
  'change-salary',
  'change-requisites',
  'set-note',
  'archive',
  'change-personal-email',
]

function renderMenu(user: UserProfileDto, actions: ActionKey[] = ALL_ACTIONS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AdminActionsMenu userId={user.id} user={user} actions={actions} />
    </QueryClientProvider>,
  )
}

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('admin-actions-trigger'))
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AdminActionsMenu — change-personal-email label (COPY-M-12)', () => {
  it('shows "Добавить личный email" when the user has no personal address at all', async () => {
    renderMenu(makeUser({ personalEmail: null, personalContactVisible: true }))
    await openMenu()
    expect(screen.getByTestId('admin-actions-change-personal-email')).toHaveTextContent(
      'Добавить личный email',
    )
  })

  it('shows "Изменить личный email" once a personal address exists', async () => {
    renderMenu(makeUser({ personalEmail: 'ivan.personal@gmail.com', personalContactVisible: true }))
    await openMenu()
    expect(screen.getByTestId('admin-actions-change-personal-email')).toHaveTextContent(
      'Изменить личный email',
    )
  })

  // COPY-M-12's own point: visibility stays UNGATED on personalEmail — only
  // the label changes. If this regressed to gating visibility instead, the
  // admin would lose the only way to add a first personal address.
  it('is still visible (not hidden) when there is no personal address — only the label differs', async () => {
    renderMenu(makeUser({ personalEmail: null, personalContactVisible: true }))
    await openMenu()
    expect(screen.getByTestId('admin-actions-change-personal-email')).toBeInTheDocument()
  })

  it('hides the item when personalContactVisible is false (masked from this viewer)', async () => {
    renderMenu(makeUser({ personalEmail: null, personalContactVisible: false }))
    await openMenu()
    expect(screen.queryByTestId('admin-actions-change-personal-email')).not.toBeInTheDocument()
  })

  it('hides the item when the viewer lacks the change-personal-email action key', async () => {
    renderMenu(
      makeUser({ personalEmail: 'ivan.personal@gmail.com', personalContactVisible: true }),
      ALL_ACTIONS.filter((a) => a !== 'change-personal-email'),
    )
    await openMenu()
    expect(screen.queryByTestId('admin-actions-change-personal-email')).not.toBeInTheDocument()
  })

  it('opens ChangePersonalEmailDialog with the matching "Добавить" title when adding (label and dialog stay in sync)', async () => {
    renderMenu(makeUser({ personalEmail: null, personalContactVisible: true }))
    const user = await openMenu()
    await user.click(screen.getByTestId('admin-actions-change-personal-email'))
    // Two "Добавить личный email" strings now exist on screen: the (closed)
    // menu item is unmounted once the dialog opens, so this resolves to the
    // dialog's own DialogTitle — proves the menu's add-state label and the
    // dialog's own add-state title are the SAME condition, not two that
    // could drift apart.
    expect(screen.getByRole('heading', { name: 'Добавить личный email' })).toBeInTheDocument()
  })
})
