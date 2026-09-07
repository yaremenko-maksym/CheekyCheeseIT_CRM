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

/**
 * task-648-fix-round-3 (COPY-H-8): the banner's gate is now the READER, so
 * every test has to say who is reading. `viewerId` is set by `renderTab`
 * below before each render.
 */
const { authState } = vi.hoisted(() => ({ authState: { id: null as string | null } }))
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: authState.id === null ? null : { id: authState.id } }),
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

/**
 * task-648-fix-round-2 (UX-H-3(r2)): the withdraw control is ADMIN-only, and
 * the component reads that off the SAME `set-note` action key `canSeeAdminNote`
 * already uses (see `UsersAccessService` — it means "ADMIN viewing someone
 * else"). An ACCOUNTANT/HR viewer has `fields.share` but not that action.
 */
const ADMIN_SHARE_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: ['set-note'],
  fields: { share: true },
}

/**
 * task-648-fix-round-3 (COPY-H-8). `viewerId` defaults so the existing tests
 * keep meaning what they meant: on `mode='self'` the reader IS the profile's
 * subject, on `mode='view'` it is somebody else. Tests that care about the
 * route/reader mismatch — the whole point of the finding — pass it
 * explicitly.
 */
const OTHER_VIEWER = 'b0000000-0000-4000-8000-0000000000ff'

function renderTab(
  user: UserProfileDto,
  mode: 'self' | 'view',
  permissions: ViewPermissions = SHARE_PERMS,
  viewerId: string | null = mode === 'self' ? user.id : OTHER_VIEWER,
) {
  authState.id = viewerId
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <OverviewTab user={user} mode={mode} permissions={permissions} data={EMPTY_DATA} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return { qc }
}

// ---------------------------------------------------------------------------
// task-648-fix-round-3 (COPY-H-8). The banner used to be gated on
// `mode === 'self' && role === 'SENIOR' && pendingSeniorShare` — i.e. on the
// ROUTE plus a role. Both clauses were wrong for the same reason: neither
// answers "is the person reading this the person who must decide".
//
//  - the ROUTE: a senior who opens their OWN profile through
//    `/profile/$userId` (an admin sends the link, or they arrive from a team
//    list) got `mode='view'` — third person, no buttons, about themselves.
//  - the ROLE: the backend opens a USER_SENIOR_SHARE proposal for whoever the
//    PATCH targets, with no `role === 'SENIOR'` check anywhere
//    (`adminUpdateUser` → `proposeSeniorShareChangeInTx`). An ADMIN holds a
//    `seniorSharePercent` too, so this clause hid the banner from a reader
//    who genuinely had to answer.
//
// The one question that IS right is `approverId === viewer.id`, which the
// project half already asked — now both ask it through one helper.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// task-648-fix-round-3 (COPY-L-13). `percent` is nullable on the shared
// schema: `null` means "clear the override, fall back to the resolved value",
// NOT "zero". Round 1 shipped `?? 0` here, COPY-H-2 removed it, and round 2
// let it back in through `UserDialog`. Every fixture in this file has
// `percent === effectivePercentAfterApproval`, so BOTH branches produced the
// same number and no test could tell the resolved read from a wrong one — the
// mutation gate is what surfaced that, by deleting the branch and staying
// green. This fixture makes the two numbers differ.
// ---------------------------------------------------------------------------
const PENDING_CLEARING: PendingSeniorShare = {
  percent: null,
  effectivePercentAfterApproval: 26,
  approverId: 'a0000000-0000-4000-8000-000000000001',
  approverName: 'Senior One',
}

/**
 * The mirror fixture: a CONCRETE percent that differs from the resolved one.
 * Every other fixture in this file has the two equal, so "read `percent`" and
 * "read `effectivePercentAfterApproval`" produced the same string and the
 * branch was untestable in the other direction — the mutation gate said so by
 * collapsing the ternary to its null arm and staying green. Same shape the
 * project half's `ProjectEditFields` test already used.
 */
const PENDING_DIVERGENT: PendingSeniorShare = {
  percent: 55,
  effectivePercentAfterApproval: 26,
  approverId: 'a0000000-0000-4000-8000-000000000001',
  approverName: 'Senior One',
}

describe('OverviewTab — a proposal whose percent is null reads the RESOLVED value', () => {
  it('a CONCRETE percent is shown as-is, not swapped for the resolved value', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING_DIVERGENT }), 'view')
    expect(screen.getByTestId('user-senior-share-pending-badge').textContent).toBe('Предложено 55%')
  })

  it('and the withdraw confirmation names that same concrete percent', async () => {
    const user = userEvent.setup()
    renderTab(
      makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING_DIVERGENT }),
      'view',
      ADMIN_SHARE_PERMS,
    )
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    const dialog = await screen.findByTestId('cancel-pending-share-confirm-user')
    expect(dialog).toHaveTextContent('Отменить предложение 55%?')
  })

  it('the badge names the resolved percent, never «0%» and never «null%»', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING_CLEARING }), 'view')
    const badge = screen.getByTestId('user-senior-share-pending-badge')
    expect(badge.textContent).toBe('Предложено 26%')
  })

  it('the withdraw confirmation names the same resolved percent', async () => {
    const user = userEvent.setup()
    renderTab(
      makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING_CLEARING }),
      'view',
      ADMIN_SHARE_PERMS,
    )
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    const dialog = await screen.findByTestId('cancel-pending-share-confirm-user')
    expect(dialog).toHaveTextContent('Отменить предложение 26%?')
  })
})

describe('OverviewTab — pending base share banner (gated on the READER, not the route)', () => {
  it('shows the banner to the person the proposal waits on, on the self route', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    expect(screen.getByTestId('pending-base-share-approval-banner')).toBeInTheDocument()
  })

  it('shows it to that SAME person on the /profile/$userId route — the finding', () => {
    // Identical user, identical proposal; only the ROUTE differs. Before this
    // round the senior was shown their own share in the third person here.
    const senior = makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING })
    renderTab(senior, 'view', SHARE_PERMS, senior.id)
    expect(screen.getByTestId('pending-base-share-approval-banner')).toBeInTheDocument()
    // ...and the third-person badge stands down, so one reader is not told
    // both «Вашу долю…» and «Подтверждает <имя>» on one screen.
    expect(screen.queryByTestId('user-senior-share-pending-badge')).not.toBeInTheDocument()
  })

  it('hides it from a reader who is not the approver, even on the self route', () => {
    // The mirror case: the route says "self", the reader is someone else.
    // Route and reader disagreeing in EITHER direction must follow the reader.
    renderTab(
      makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }),
      'self',
      SHARE_PERMS,
      OTHER_VIEWER,
    )
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides it from an ADMIN viewing the affected senior', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view')
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides it when nothing is pending, however the reader arrived', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: null }), 'self')
    expect(screen.queryByTestId('pending-base-share-approval-banner')).not.toBeInTheDocument()
  })

  it('hides it when nobody is logged in (no reader, no first person)', () => {
    // `useAuth` returns `null` before the session resolves — a null viewer id
    // must never accidentally equal an approver id.
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self', SHARE_PERMS, null)
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

  // task-648-fix-round-1 (COPY-M-7): first person, no name, when the
  // affected SENIOR is looking at their OWN profile — kills the
  // ConditionalExpression/EqualityOperator/StringLiteral mutants on
  // `mode === 'self' ? <>...</> : <>...</>` (both the badge text and its
  // tooltip carry an independent copy of the same ternary).
  // task-648-fix-round-2 (COPY-L-7): in self-view the badge is gone. After
  // COPY-M-7 and COPY-M-10 stripped it down it carried nothing the
  // actionable banner two centimetres above did not already say, and on 320
  // both were on screen at once.
  it('self-view shows the actionable banner and NOT a second, redundant badge', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    expect(screen.getByTestId('pending-base-share-approval-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('user-senior-share-pending-badge')).toBeNull()
  })

  it('view-mode badge renders its label and number as ONE text node, with the space intact', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view')
    const badge = screen.getByTestId('user-senior-share-pending-badge')
    // task-648-fix-round-2 (COPY-H-5). `toHaveTextContent` alone CANNOT see
    // this defect and was green all through round 1: `textContent`
    // concatenates a whitespace text node that `inline-flex` never renders,
    // so the assertion read «Ждёт подтверждения: 55%» while the screen said
    // «Ждёт подтверждения:55%». The structural assertion below is the one
    // that fails if a `{' '}` between elements ever comes back.
    expect(badge.childNodes).toHaveLength(1)
    expect(badge.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    // task-648-fix-round-3 (COPY-H-7 / COPY-M-15): «Предложено N%».
    expect(badge.textContent).toBe('Предложено 55%')
    expect(badge).not.toHaveTextContent('Senior One')
  })

  // task-648-fix-round-2 (COPY-M-12 / UX-M-3(r2)): the approver's name and
  // the "prior percent still applies" fact used to be reachable ONLY by
  // hovering the badge — impossible on touch (Radix returns early for
  // `pointerType === 'touch'`) and impossible from a keyboard (`Badge`
  // renders a non-focusable `div`). Asserted WITHOUT any hover.
  it('view-mode shows the approver name and the live percent without hovering anything', () => {
    renderTab(
      makeUser({ role: 'SENIOR', seniorSharePercent: 26, pendingSeniorShare: PENDING }),
      'view',
    )
    // The WHOLE sentence, both facts and the live number — a partial match
    // would survive the name or the percent being dropped.
    const line = screen.getByText(/Подтверждает Senior One/)
    expect(line.textContent).toBe('Подтверждает Senior One — пока действует 26%')
  })

  it('the live percent in that line is the ACTIVE one, not the proposed one', () => {
    // PENDING proposes 55; the sentence must say 26 — naming the proposed
    // value here would tell the reader the change already happened.
    renderTab(
      makeUser({ role: 'SENIOR', seniorSharePercent: 26, pendingSeniorShare: PENDING }),
      'view',
    )
    expect(screen.getByText(/Подтверждает Senior One/).textContent).toContain('26%')
    expect(screen.getByText(/Подтверждает Senior One/).textContent).not.toContain('55%')
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-2 (UX-H-3(r2) / SR-H-2 / CR-H-3 / SPEC-H-2 / QA-HIGH-2):
// the withdraw control. Round 1 shipped the endpoint with no way to reach it.
// ---------------------------------------------------------------------------

describe('OverviewTab — withdraw ("Отменить предложение") control', () => {
  it('an ADMIN viewer gets it next to the indicator', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view', ADMIN_SHARE_PERMS)
    expect(screen.getByTestId('cancel-pending-share-user')).toBeInTheDocument()
  })

  it('a viewer who can see the share but is NOT an admin does not get it', () => {
    // ACCOUNTANT/HR shape: `fields.share` yes, `set-note` action no. The
    // backend would 403 them on the cancel endpoint, so offering the button
    // would be a promise the server refuses to keep.
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view')
    expect(screen.queryByTestId('cancel-pending-share-user')).toBeNull()
  })

  it('is absent when nothing is pending, even for an ADMIN viewer', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: null }), 'view', ADMIN_SHARE_PERMS)
    expect(screen.queryByTestId('cancel-pending-share-user')).toBeNull()
  })

  it('carries an accessible name — it is icon-only', () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'view', ADMIN_SHARE_PERMS)
    expect(screen.getByRole('button', { name: 'Отменить предложение' })).toBeInTheDocument()
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

  it("the exact copy names BOTH the active and the pending percent, with the spaces JSX needs an explicit {' '} for", () => {
    // task-648-fix-round-1 (COPY-M-5/COPY-M-6): "доля по умолчанию" (no
    // "базов*"), and BOTH numbers on screen — the default fixture's
    // `seniorSharePercent: 26` is the ACTIVE value shown alongside the
    // PENDING 55.
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const banner = screen.getByTestId('pending-base-share-approval-banner')
    // A single assertion spanning the JSX text nodes AND the `{' '}` spacers
    // AND the <span>s — `.toContain(...)` on the individual pieces
    // separately would not notice a `{' '}` collapsing to `{''}` (the
    // substrings would still individually be present, just run together).
    expect(banner.textContent).toContain(
      'Вашу долю по умолчанию предлагают изменить: сейчас 26%, предлагают 55%',
    )
    expect(banner.textContent).toContain('действует 26%')
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

  it("reject: an error with neither .response nor a string .message falls through to REJECT's own fallback text", async () => {
    // task-648-fix-round-2 (COPY-L-6): approve and reject now carry DIFFERENT
    // last-resort strings again (round 1 merged them into one anonymous "Не
    // удалось выполнить действие"). Asserting only approve's would let
    // reject's be blanked without a single test noticing.
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(screen.getByTestId('pending-base-share-reject-reason'), 'нет')
    await user.click(screen.getByTestId('pending-base-share-reject-confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не удалось отклонить'))
  })

  it("approve: an error with neither .response nor a string .message falls through to seniorShareErrorMessage's own fallback text", async () => {
    // Kills the StringLiteral mutant on `getApiErrorMessage(err, 'Не удалось
    // выполнить действие')`'s fallback argument — every OTHER error test in
    // this file has either a `.response` (404/409 branches) or a plain
    // Error's `.message` (getApiErrorMessage's Priority 3), so none of them
    // ever reach this specific fallback parameter.
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    // task-648-fix-round-2 (COPY-L-6): the fallback names the action again.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не удалось подтвердить'))
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
    const { qc } = renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-approve-button'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Предложение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
      ),
    )
    // QA-MED-5: a stale banner (proposal already resolved elsewhere) must
    // refetch on failure too, not just on success — otherwise it stays
    // clickable showing a number that no longer means anything.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
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

  it('approve: button label switches to "Подтверждение…" while the mutation is in flight, back to "Подтвердить" after', async () => {
    // task-648-fix-round-1 (COPY-M-9): kills the StringLiteral mutants on
    // both branches of `approveMutation.isPending ? 'Подтверждение…' :
    // 'Подтвердить'` — every OTHER approve test resolves/rejects
    // synchronously enough that the button never observably sits in the
    // pending state, so this is the only test that holds it open on
    // purpose (an unresolved promise) to look at it mid-flight.
    let resolvePost!: (value: unknown) => void
    ;(api.post as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve
      }),
    )
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    const approveButton = screen.getByTestId('pending-base-share-approve-button')
    expect(approveButton).toHaveTextContent('Подтвердить')
    await user.click(approveButton)
    await waitFor(() => expect(approveButton).toHaveTextContent('Подтверждение…'))
    resolvePost({
      data: { user: { seniorSharePercent: CONFIRMED_PERCENT }, permissions: {}, data: {} },
    })
    await waitFor(() => expect(approveButton).toHaveTextContent('Подтвердить'))
  })

  it('reject: confirm button label switches to "Отклонение…" while the mutation is in flight', async () => {
    // task-648-fix-round-1 (COPY-M-9): same reasoning as the approve test
    // above, for the reject-confirm button's own ternary.
    let resolvePost!: (value: unknown) => void
    ;(api.post as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve
      }),
    )
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(await screen.findByTestId('pending-base-share-reject-reason'), 'причина')
    const confirmButton = screen.getByTestId('pending-base-share-reject-confirm')
    expect(confirmButton).toHaveTextContent('Отклонить')
    await user.click(confirmButton)
    await waitFor(() => expect(confirmButton).toHaveTextContent('Отклонение…'))
    resolvePost({ data: { ok: true } })
  })

  // task-648-fix-round-4 (COPY-M-18). The dialog asked the senior to reject
  // «новый процент» while every other surface of the same feature called it a
  // предложение — and the percent is not what is being rejected: it stays
  // exactly where it was, which is what the reject toast says one line later.
  it('the reject dialog names the proposal, not the percent', async () => {
    renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Отклонить предложение')
    expect(dialog).not.toHaveTextContent('Отклонить новый процент')
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
        'Новый процент отклонён — действует прежний. Админ увидит причину',
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

  it('reject: a 409 (already resolved elsewhere) shows the friendly "уже принято" message and refetches (QA-MED-5)', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Подтверждение уже получило ответ' } },
    })
    const { qc } = renderTab(makeUser({ role: 'SENIOR', pendingSeniorShare: PENDING }), 'self')
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-base-share-reject-button'))
    await user.type(await screen.findByTestId('pending-base-share-reject-reason'), 'причина')
    await user.click(screen.getByTestId('pending-base-share-reject-confirm'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Решение по этому предложению уже принято. Обновите страницу.',
      ),
    )
    // QA-MED-5: same refetch-on-failure fix as the approve test above — a
    // stale banner must not stay clickable after a 409 from elsewhere.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
  })
})
