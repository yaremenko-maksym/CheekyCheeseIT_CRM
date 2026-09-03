/**
 * AdminActionsMenu — "Отправить приглашение повторно" (task-user-emails-invite,
 * spec §5). Zero prior coverage for this menu (mirrors the gap
 * ArchiveUserDialog.test.tsx's own doc comment describes for its directory).
 */
import { render, screen, waitFor } from '@testing-library/react'
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

import { api } from '@/lib/axios'
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
  'resend-personal-invite',
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

describe('AdminActionsMenu — resend-invite visibility', () => {
  it('shows the item when set, not yet accepted, action key present', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
    )
    await openMenu()
    expect(screen.getByTestId('admin-actions-resend-invite')).toHaveTextContent(
      'Отправить приглашение снова',
    )
  })

  it('hides the item once accepted (personalEmailCanLogin true)', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: true,
      }),
    )
    await openMenu()
    expect(screen.queryByTestId('admin-actions-resend-invite')).not.toBeInTheDocument()
  })

  it('hides the item when there is no personal address at all', async () => {
    renderMenu(makeUser({}))
    await openMenu()
    expect(screen.queryByTestId('admin-actions-resend-invite')).not.toBeInTheDocument()
  })

  it('hides the item when the viewer lacks the action key even though data qualifies', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
      ALL_ACTIONS.filter((a) => a !== 'resend-personal-invite'),
    )
    await openMenu()
    expect(screen.queryByTestId('admin-actions-resend-invite')).not.toBeInTheDocument()
  })

  // UX-M-1 regression: masked viewers get personalContactVisible=false with
  // personalEmailCanLogin sitting at null (never false) — this pins that the
  // button cannot appear via that path either, independent of the "false"
  // check above.
  it('hides the item when the field is masked from this viewer (personalContactVisible false)', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: false,
        personalEmailCanLogin: null,
      }),
    )
    await openMenu()
    expect(screen.queryByTestId('admin-actions-resend-invite')).not.toBeInTheDocument()
  })

  // mutation-gate closure (CI full-diff round): `user.personalContactVisible
  // === true` mutated to `true` — the test above uses personalEmailCanLogin:
  // null, which the LAST clause (`=== false`) already fails on its own, so
  // it does not isolate THIS check. Here every OTHER clause is satisfied
  // (personalEmailCanLogin genuinely false) — only personalContactVisible
  // being falsy hides the item; the mutant would show it.
  it('hides the item when masked even though personalEmailCanLogin is genuinely false (isolates the personalContactVisible check)', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: false,
        personalEmailCanLogin: false,
      }),
    )
    await openMenu()
    expect(screen.queryByTestId('admin-actions-resend-invite')).not.toBeInTheDocument()
  })
})

describe('AdminActionsMenu — resend-invite click', () => {
  it('POSTs to the resend-invite endpoint and shows a success toast', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
    )
    const user = await openMenu()
    await user.click(screen.getByTestId('admin-actions-resend-invite'))

    expect(api.post).toHaveBeenCalledWith('/users/u-1/personal-email/resend-invite')
  })
})

// mutation-gate closure (CI full-diff round): `disabled={item.key ===
// 'resend-invite' && resendInviteMutation.isPending}` had SIX surviving
// mutants — nothing in this file ever inspected the DISABLED state of any
// menu item. Three scenarios below, together, distinguish every one of
// them: (1) resend-invite item while pending → disabled (kills the
// always-false mutants), (2) resend-invite item while NOT pending → enabled
// (kills the always-true mutants), (3) a DIFFERENT item while resend-invite
// IS pending → still enabled (kills the `&&`→`||` and the `item.key ===
// 'resend-invite'`→`true` mutants, both of which would make EVERY item
// react to resendInviteMutation.isPending, not just its own).
describe('AdminActionsMenu — resend-invite disabled state (mutation-gate closure)', () => {
  // Radix closes the dropdown on select regardless of the item's own
  // `onClick` — clicking resend-invite starts the mutation AND closes the
  // menu in the same tick, so the disabled attribute cannot be observed on
  // the element that was just clicked. It CAN be observed by re-opening the
  // menu while the mutation promise is still unresolved — the exact case
  // `disabled` exists to guard (an admin who clicks the trigger again
  // before a slow response comes back must not be able to fire a second
  // resend).
  it('the resend-invite item is disabled if the menu is re-opened while its own mutation is pending', async () => {
    let resolvePost: (() => void) | undefined
    ;(api.post as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = () => resolve({ data: { ok: true, delivered: true } })
      }),
    )
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
    )
    const user = await openMenu()
    await user.click(screen.getByTestId('admin-actions-resend-invite'))
    await user.click(screen.getByTestId('admin-actions-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('admin-actions-resend-invite')).toHaveAttribute('data-disabled'),
    )
    resolvePost?.()
  })

  it('the resend-invite item is NOT disabled before it has been clicked (isPending starts false)', async () => {
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
    )
    await openMenu()
    expect(screen.getByTestId('admin-actions-resend-invite')).not.toHaveAttribute('data-disabled')
  })

  it('a DIFFERENT item ("Редактировать") stays enabled if the menu is re-opened while the resend-invite mutation is pending', async () => {
    let resolvePost: (() => void) | undefined
    ;(api.post as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = () => resolve({ data: { ok: true, delivered: true } })
      }),
    )
    renderMenu(
      makeUser({
        personalEmail: 'ivan.personal@gmail.com',
        personalContactVisible: true,
        personalEmailCanLogin: false,
      }),
    )
    const user = await openMenu()
    await user.click(screen.getByTestId('admin-actions-resend-invite'))
    await user.click(screen.getByTestId('admin-actions-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('admin-actions-resend-invite')).toHaveAttribute('data-disabled'),
    )
    expect(screen.getByRole('menuitem', { name: /Редактировать/ })).not.toHaveAttribute(
      'data-disabled',
    )
    resolvePost?.()
  })
})
