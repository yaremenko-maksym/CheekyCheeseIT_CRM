/**
 * OverviewTab — pending SENIOR share (task-pending-share, position 5,
 * AC9 mutation-gate gap-fill 2026-09-03).
 *
 * The banner (self + SENIOR + a live proposal) and the informational badge
 * (any viewer who can see the share at all) are two INDEPENDENT gates on
 * the same `user.pendingSeniorShare` field — see OverviewTab.tsx's own
 * comment right above each. Each test below flips exactly ONE of the
 * banner's three AND-clauses (mode / role / pendingSeniorShare) while
 * holding the other two at the "would otherwise show" value — the standard
 * shape for killing every mutant a compound `&&` can produce (whole-true,
 * whole-false, operator swaps, equality flips, string-literal swaps).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingSeniorShare, UserProfileDto, ViewPermissions } from '@crm/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OverviewTab } from '../OverviewTab'

vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))

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

const PENDING: PendingSeniorShare = {
  percent: 55,
  // task-648-fix-round-1 (COPY-H-2/COPY-H-3): a base-share proposal always
  // equals `percent` itself — see PendingSeniorShare's own doc comment.
  effectivePercentAfterApproval: 55,
  approverId: 'a0000000-0000-4000-8000-000000000001',
  approverName: 'Senior One',
}

function makeUser(overrides: Partial<UserProfileDto>): UserProfileDto {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    email: 'test@cheekycheese.dev',
    displayName: 'Test User',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'SENIOR',
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 26,
    dropSharePercent: null,
    legalFullName: null,
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    pendingSeniorShare: null,
    ...overrides,
  }
}

const SHARE_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: [],
  fields: { share: true },
}

const EMPTY_DATA = { overview: {} }

function renderTab(user: UserProfileDto, mode: 'self' | 'view') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <OverviewTab user={user} mode={mode} permissions={SHARE_PERMS} data={EMPTY_DATA} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return { qc }
}

describe('OverviewTab — pending base share banner (self + SENIOR + live proposal)', () => {
  it('shows the banner when mode=self, role=SENIOR, and a proposal is pending (all three true)', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    expect(screen.getByTestId('pending-base-share-approval-banner')).toBeInTheDocument()
  })

  it('hides the banner when mode is NOT self, even for the SENIOR with a pending proposal', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view')
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides the banner when the self-viewer is not a SENIOR, even with a pending proposal', () => {
    renderTab(makeUser({ role: 'DROP', dropSharePercent: 5, pendingSeniorShare: PENDING }), 'self')
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides the banner for a self-viewing SENIOR when nothing is pending', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: null }), 'self')
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })
})

describe('OverviewTab — pending share informational badge (any viewer who can see the share)', () => {
  it('shows the badge on the "Доля" card when viewing someone else\'s pending proposal (mode=view)', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view')
    expect(screen.getByTestId('user-senior-share-pending-badge')).toBeInTheDocument()
    // The actionable banner must NOT also appear for a non-self viewer.
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides the badge when nothing is pending', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: null }), 'view')
    expect(screen.queryByTestId('user-senior-share-pending-badge')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Approve / reject interactions — mutation-gate gap-fill (2026-09-03). The
// display-gating tests above never CLICK anything, so none of
// useApproveSeniorShareChange/useRejectSeniorShareChange's own mutationFn/
// onSuccess/onError bodies (use-user-profile.ts) or the reject dialog's
// disabled/handler wiring (OverviewTab.tsx) were ever exercised — same
// convention as ChangePersonalEmailDialog.test.tsx (click, waitFor, assert
// on the mocked api.* call args + toast.*).
// ---------------------------------------------------------------------------

describe('OverviewTab — pending base share banner, approve/reject interactions', () => {
  const USER_ID = 'a0000000-0000-4000-8000-000000000001'

  // task-648-fix-round-1 (COPY-M-3): the approve success toast now names the
  // CONFIRMED value from the response body (`data.user.seniorSharePercent`),
  // so the mock response needs that shape, not an arbitrary `{ ok: true }`.
  const CONFIRMED_PERCENT = 55

  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { seniorSharePercent: CONFIRMED_PERCENT }, permissions: {}, data: {} },
    })
  })

  it("the exact copy names the pending percent, with the space JSX needs an explicit {' '} for", () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const banner = screen.getByTestId('pending-base-share-approval-banner')
    // A single assertion spanning the JSX text node AND the `{' '}` spacer
    // AND the <span> — `.toContain('...доли')` +
    // `.toContain('55%')` SEPARATELY would not notice `{' '}` collapsing to
    // `{''}` (both substrings would still individually be present, just
    // run together as "...доли:55%").
    expect(banner.textContent).toContain('Новый базовый процент вашей доли: 55%')
  })

  it('approve: POSTs to the approve endpoint with no body and shows the exact success toast', async () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/users/${USER_ID}/senior-share/approve`),
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Ваша доля теперь ${CONFIRMED_PERCENT}%`),
    )
  })

  it('approve: a rejected request (no axios .response — not a 404/409) shows the raw message with no "Ошибка: " prefix', async () => {
    // task-648-fix-round-1 (COPY-M-1): the prefix added nothing (the toast
    // is already red) and this exact test used to pin it as a "contract" —
    // now pins its removal instead. `seniorShareErrorMessage` only special-
    // cases 404/409 (getAxiosStatus reads `.response.status`, absent on a
    // plain Error); everything else falls through getApiErrorMessage's
    // Priority 3 (axios's own generic `.message`, unprefixed).
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'))
  })

  it('approve: a 404 (stale/foreign proposal) shows the friendly "устарело" message, not the raw backend text', async () => {
    // task-648-fix-round-1 (COPY-H-4/QA-MED-5): the backend's real 404 body
    // for this endpoint is `ApprovalsService.assertRespondable`'s generic
    // "Подтверждение не найдено или уже закрыто" — seniorShareErrorMessage
    // maps the STATUS to a message that names the actual next step instead.
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: 'Подтверждение не найдено или уже закрыто' } },
    })
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
      ),
    )
  })

  it('approve: invalidates BOTH the userId-keyed and the "me"-keyed profile query on success', async () => {
    const { qc } = renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] }),
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
  })

  it('reject dialog starts closed, with an empty reason field', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    expect(screen.queryByTestId('pending-base-share-reject-reason')).not.toBeInTheDocument()
  })

  it('reject: the confirm button is disabled until a non-blank reason is entered', async () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    const reasonField = (await screen.findByTestId(
      'pending-base-share-reject-reason',
    )) as HTMLTextAreaElement
    expect(reasonField.value).toBe('')
    const confirmButton = screen.getByTestId('pending-base-share-reject-confirm')
    expect(confirmButton).toBeDisabled()

    // Whitespace-only stays disabled — `reason.trim()`, not `reason` itself.
    await user.type(reasonField, '   ')
    expect(confirmButton).toBeDisabled()

    await user.type(reasonField, 'причина отказа')
    expect(confirmButton).toBeEnabled()
  })

  it('reject: Отмена closes the dialog WITHOUT calling the reject endpoint', async () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(await screen.findByTestId('pending-base-share-reject-reason'), 'черновик')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.queryByTestId('pending-base-share-reject-reason')).not.toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('reject: confirming POSTs the reason to the reject endpoint, shows the exact success toast, and closes + resets the dialog', async () => {
    const { qc } = renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(
      await screen.findByTestId('pending-base-share-reject-reason'),
      'Слишком высокий процент',
    )
    await user.click(screen.getByTestId('pending-base-share-reject-confirm'))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/users/${USER_ID}/senior-share/reject`, {
        reason: 'Слишком высокий процент',
      }),
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Доля отклонена — действует прежний процент. Админ увидит причину',
      ),
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
    // Dialog closed (state.rejectOpen reset) — reopening shows an EMPTY
    // field, not the stale submitted text (state.reason reset).
    await waitFor(() =>
      expect(screen.queryByTestId('pending-base-share-reject-reason')).not.toBeInTheDocument(),
    )
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    const reopened = (await screen.findByTestId(
      'pending-base-share-reject-reason',
    )) as HTMLTextAreaElement
    expect(reopened.value).toBe('')
  })

  it('reject: a rejected request (no axios .response) shows the raw message with no "Ошибка: " prefix', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('validation failed'))
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(await screen.findByTestId('pending-base-share-reject-reason'), 'причина')
    await user.click(screen.getByTestId('pending-base-share-reject-confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('validation failed'))
  })

  it('reject: a 409 (already resolved elsewhere) shows the friendly "уже принято" message', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Подтверждение уже получило ответ' } },
    })
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(await screen.findByTestId('pending-base-share-reject-reason'), 'причина')
    await user.click(screen.getByTestId('pending-base-share-reject-confirm'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Решение по этому проценту уже принято. Обновите страницу.',
      ),
    )
  })
})
