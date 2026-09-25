/**
 * ArchiveUserConfirmDialog (users list page variant) — interaction tests.
 *
 * task-archive-pending-modal (round 2, code-review H2). This file previously
 * had ZERO test coverage — the mutation gate independently confirmed
 * `users/ArchiveConfirmDialog.tsx: 0.00% covered, 106 no-coverage` even
 * though the component is one of the three surfaces this task rewrote
 * (the pending-transactions list, the confirm-by-typing-name mechanic).
 * Brought up to the same level the generic dialog already has via
 * `AdminActionsMenu.test.tsx`.
 *
 * task-i18n-stage3b (Task 2 / PR2): the per-role impact TEXT this file used
 * to own (`ImpactWarning`'s SENIOR/DROP cascade branch, isPaired gating,
 * "(0 шт.)" fallbacks) moved verbatim into
 * `components/archive/UserArchiveImpact.tsx` — that file's own suite
 * (`archive/__tests__/UserArchiveImpact.test.tsx`) now owns per-role/locale
 * text coverage. What THIS dialog still owns: its own query/mutation
 * wiring, the confirm-by-typing-name mechanic, the pending-mutation dismiss
 * guard (security-review PR #584 round 3), and delegating to
 * `UserArchiveImpact` with the right props.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

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
import { ArchiveUserConfirmDialog } from '../ArchiveUserConfirmDialog'

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

// task-i18n-stage3a (Task 1) blast-radius: this dialog renders the shared
// `ArchivePendingTransactionsList` (`components/archive/`), which now calls
// `useLingui()` — outside this file's own perimeter back then; both are
// migrated as of this wave.
beforeEach(async () => {
  await loadCatalog('uk')
})

function renderDialog(user: UserProfileDto | null, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <ArchiveUserConfirmDialog user={user} onClose={onClose} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
  return { ...utils, queryClient: qc, onClose }
}

describe('ArchiveUserConfirmDialog (users list) — loading + gating', () => {
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
    // but the impact area shows skeletons, not the warning block, while loading.
    expect(within(dialog).queryByTestId('archive-warning-junior')).not.toBeInTheDocument()
  })

  it('the loading condition is `isLoading || !user`, not `&&` — a pending query with a real user still shows skeletons', async () => {
    // mutation-gate survivor (LogicalOperator `||`→`&&`, ConditionalExpression
    // →`false`): a `user` truthy AND `isLoading` true is the exact case that
    // distinguishes the two — the `&&` mutant would skip the skeletons here.
    ;(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    renderDialog(makeUser({ role: 'JUNIOR', displayName: 'Oleksiy Kovalenko' }))
    const dialog = await screen.findByRole('dialog')
    // Code-review CR-H-1 (fix-round A): the PREVIOUS version of this test
    // only asserted the warning's ABSENCE, which is also true under the
    // `isLoading || !user` -> `isLoading && !user` mutant here (since
    // `impact` stays undefined regardless, `impact?.type === 'user'` is
    // false either way — the assert never actually depended on which
    // branch rendered). A POSITIVE assertion on the loading testid is the
    // one thing that actually differs between the two: under the correct
    // `||`, isLoading=true alone is enough to render it; under the `&&`
    // mutant, it would only render when BOTH isLoading AND !user are true,
    // which is false here (`user` is truthy) — so the mutant renders
    // NEITHER the loading state NOR the warning, an empty gap this
    // assertion catches directly.
    expect(within(dialog).getByTestId('archive-impact-loading')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('archive-warning-junior')).not.toBeInTheDocument()
    // The confirm input (rendered whenever `user` truthy, independent of
    // isLoading) stays present — proves `user` really is non-null here and
    // the skeleton branch is only about `isLoading`.
    expect(within(dialog).getByTestId('archive-confirm-name-input')).toBeInTheDocument()
  })

  it('fetches the archive-impact for THIS specific user id (not an empty/mistyped url)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ id: 'u-42', role: 'ADMIN' }))
    await screen.findByRole('dialog')
    expect(api.get).toHaveBeenCalledWith('/users/u-42/archive-impact')
  })

  it('the query key includes the user id — switching users (same QueryClient) fetches BOTH, not a shared/stale cache entry', async () => {
    // mutation-gate survivor: `queryKey: ['users-archive-impact', user?.id]`,
    // ArrayDeclaration/StringLiteral mutants. A constant key (`[]`) would
    // make react-query treat every user as the SAME cached query — switching
    // the `user` prop would silently keep showing the FIRST user's impact
    // instead of fetching the second one's.
    ;(api.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: { type: 'user', role: 'ADMIN', noDependencies: true } })
      .mockResolvedValueOnce({ data: { type: 'user', role: 'ADMIN', noDependencies: true } })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const userA = makeUser({ id: 'u-a', displayName: 'User A' })
    const userB = makeUser({ id: 'u-b', displayName: 'User B' })
    const { rerender } = render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <ArchiveUserConfirmDialog user={userA} onClose={vi.fn()} />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/u-a/archive-impact'))
    // Code-review CR-H-1 (fix-round A): calling `api.get` with both URLs
    // does not depend on the query-key's first element at all (the URL
    // comes from `queryFn`'s own template string, a SEPARATE mutant already
    // killed elsewhere) — it would look identical under a `['', user?.id]`
    // mutant too. What actually depends on the literal 'users-archive-impact'
    // label is react-query's OWN cache, keyed by the full array: querying
    // that exact key must find the resolved data.
    await vi.waitFor(() =>
      expect(qc.getQueryData(['users-archive-impact', 'u-a'])).not.toBeUndefined(),
    )

    rerender(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <ArchiveUserConfirmDialog user={userB} onClose={vi.fn()} />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/u-b/archive-impact'))
    await vi.waitFor(() =>
      expect(qc.getQueryData(['users-archive-impact', 'u-b'])).not.toBeUndefined(),
    )
    expect(api.get).toHaveBeenCalledTimes(2)
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

  it('trims whitespace on the typed value before comparing — padded input still matches', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const submit = await screen.findByTestId('archive-confirm-submit')
    const input = screen.getByTestId('archive-confirm-name-input')
    await user.type(input, '  Oleksiy Kovalenko  ')
    expect(submit).toBeEnabled()
  })

  it('trims whitespace on user.displayName before comparing — a padded stored name still matches a clean type', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: '  Oleksiy Kovalenko  ' }))

    const submit = await screen.findByTestId('archive-confirm-submit')
    const input = screen.getByTestId('archive-confirm-name-input')
    await user.type(input, 'Oleksiy Kovalenko')
    expect(submit).toBeEnabled()
  })

  it('preserves the space before the confirm-name value (no run-together text)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent ?? '').toContain('ім’я: Oleksiy Kovalenko')
  })

  it('submit button shows "Архівуємо…" while pending, "Архівувати" otherwise', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    let resolveDelete!: () => void
    ;(api.delete as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = () => resolve({ data: {} })
      }),
    )
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const submit = await screen.findByTestId('archive-confirm-submit')
    expect(submit).toHaveTextContent('Архівувати')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(submit)

    await vi.waitFor(() => expect(submit).toHaveTextContent('Архівуємо…'))
    resolveDelete()
  })

  it('Enter in the name input submits when the typed name matches, and does nothing when it does not', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const input = await screen.findByTestId('archive-confirm-name-input')
    await user.type(input, 'wrong name')
    await user.keyboard('{Enter}')
    expect(api.delete).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, 'Oleksiy Kovalenko')
    await user.keyboard('{Enter}')
    expect(api.delete).toHaveBeenCalledWith('/users/u-1')
  })

  it('onError falls back to a translated message when the API gives no structured error', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    // `null` is the shape `getApiErrorMessage` short-circuits to the fallback
    // on immediately (`err === null`) — a plain `Error('...')` would instead
    // surface its own `.message` via `extractBackendMessage`'s priority 3,
    // which does NOT exercise this component's own fallback string at all.
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(null)
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    await user.type(await screen.findByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Не вдалося архівувати користувача — спробуйте ще раз',
      ),
    )
  })

  it('Скасувати closes without calling DELETE', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'ADMIN' }))

    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('Скасувати clears the typed name (handleClose resets to an empty string, not a stray value)', async () => {
    // mutation-gate survivor: `setTyped('')` inside handleClose, StringLiteral
    // mutant. `onClose` here is a plain spy that does NOT unmount the dialog
    // (the `user` prop stays the same object), so the component instance
    // survives the click — the typed-name input must show empty, not
    // whatever the mutant substituted.
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const input = await screen.findByTestId('archive-confirm-name-input')
    await user.type(input, 'partial')
    expect(input).toHaveValue('partial')

    await user.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(input).toHaveValue('')
  })
})

describe('ArchiveUserConfirmDialog (users list) — delegates impact text to UserArchiveImpact + AC2 pending list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['SENIOR', 'DROP'] as const)(
    '%s: renders UserArchiveImpact with the fetched name/team, AND the pending-transactions warning alongside it (AC2)',
    async (role) => {
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'user',
          role,
          teamName: 'Alpha Team',
          projectsCount: 2,
          projectNames: ['Project A', 'Project B'],
          hrAccountantsOnTeam: 3,
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

      const dialog = await screen.findByRole('dialog')
      const block = await within(dialog).findByTestId('archive-warning-senior')
      expect(within(block).getByTestId('archive-confirm-user-name')).toHaveTextContent(
        'Oleksiy Kovalenko',
      )
      expect(block.textContent).toContain('Alpha Team')
      expect(within(dialog).getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
    },
  )

  it.each([
    ['HR', 'archive-warning-hr'],
    ['ACCOUNTANT', 'archive-warning-accountant'],
    ['JUNIOR', 'archive-warning-junior'],
    ['ADMIN', 'archive-warning-admin'],
  ] as const)(
    '%s: renders UserArchiveImpact with its own testid, no pending list when the payload has none',
    async (role, testId) => {
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { type: 'user', role, teamsCount: 1, projectsCount: 1, pendingTransactions: [] },
      })
      renderDialog(makeUser({ role }))

      const dialog = await screen.findByRole('dialog')
      expect(await within(dialog).findByTestId(testId)).toBeInTheDocument()
      expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
    },
  )

  it('SENIOR: the archive-impact query FAILING does not crash — impact stays undefined, no warning block, no pending list', async () => {
    // security-review PR #584 round 2 (mutation-gate survivor, OptionalChaining
    // on `impact?.type`). `isLoading: false` does NOT guarantee `impact` is
    // defined — a query ERROR also settles `isLoading` to false while `data`
    // stays `undefined`. That is a REAL reachable state (a 500 from GET
    // .../archive-impact), not just defensive typing — proven here rather
    // than suppressed.
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    // Waits for the SKELETON to go away, not just for the always-present
    // name input to appear (that renders on the FIRST paint, before the
    // query has any chance to settle — a false-negative race that let a
    // real mutant survive: `queryByTestId(...).not.toBeInTheDocument()`
    // trivially passes while still loading, mutated guard or not).
    await vi.waitFor(() =>
      expect(within(dialog).queryByTestId('archive-impact-loading')).not.toBeInTheDocument(),
    )
    expect(within(dialog).queryByTestId('archive-warning-senior')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('SR-M-1: a failed archive-impact fetch shows an explicit error and keeps the cascade unconfirmable', async () => {
    // security-review SR-M-1 (fix-round A): previously, an errored impact
    // query left the SENIOR/DROP cascade warning silently ABSENT while
    // "Архівувати" stayed enabled as soon as the name matched — an
    // administrator could archive a SENIOR (and their whole team+projects)
    // without ever seeing that warning, purely because the impact request
    // failed. Now: explicit error text, submit stays disabled even with a
    // matching typed name.
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('archive-impact-error')).toHaveTextContent(
      'Не вдалося порахувати наслідки архівації',
    )

    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    expect(screen.getByTestId('archive-confirm-submit')).toBeDisabled()

    // Enter-to-submit must ALSO stay inert — the keydown guard has its own
    // `isLoading`/`isError` checks, separate from the button's `disabled`.
    await user.keyboard('{Enter}')
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('the pending-list guard checks impact.type, not just truthiness — a non-"user" shape never renders it here', async () => {
    // security-review PR #584 round 2 (mutation-gate survivor): mirrors the
    // identical fix in ArchiveUserDialog.test.tsx — a fake that only ever
    // resolves `type: 'user'` cannot distinguish `impact?.type === 'user'`
    // from an unconditional `true`. A team-shaped-but-truthy-
    // pendingTransactions fixture makes the two observably different.
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'team',
        // A `role` field here makes the absence assertion below actually
        // test the `impact?.type === 'user'` guard — without it,
        // `TESTID_BY_ROLE[impact.role]` resolves to `TESTID_BY_ROLE[undefined]`
        // regardless of the guard, so `archive-warning-junior` would never be
        // found either way (PR2 mutation-gate round, mirrors the identical
        // fix in ArchiveUserDialog.test.tsx).
        role: 'JUNIOR',
        teamName: 'Not This User',
        pendingTransactions: [
          {
            id: 'tx-x',
            type: 'SALARY',
            salaryMonth: '2026-01',
            txDate: null,
            amount: '100.00',
            currency: 'USD',
          },
        ],
      },
    })
    renderDialog(makeUser({ role: 'JUNIOR' }))

    const dialog = await screen.findByRole('dialog')
    // No 'user'-typed impact was returned, so neither the warning block nor
    // the pending-list renders — this dialog only recognizes its own shape.
    // See the SENIOR/query-failure test above for why this waits on the
    // skeleton, not the always-present name input.
    await vi.waitFor(() =>
      expect(within(dialog).queryByTestId('archive-impact-loading')).not.toBeInTheDocument(),
    )
    expect(screen.queryByTestId('archive-warning-junior')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })
})

describe('ArchiveUserConfirmDialog (users list) — confirm mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['SENIOR', 'Сеньйора й команду архівовано'],
    ['DROP', 'Дропа й команду архівовано'],
    ['JUNIOR', 'Користувача архівовано'],
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

  it.each(['SENIOR', 'DROP'] as const)(
    '%s: also invalidates teams + projects queries on success (cascade side-effects)',
    async (role) => {
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { type: 'user', role, pendingTransactions: [] },
      })
      ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
      const user = userEvent.setup()
      const { queryClient, onClose } = renderDialog(
        makeUser({ role, displayName: 'Oleksiy Kovalenko' }),
      )
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

      await screen.findByRole('dialog')
      await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
      await user.click(screen.getByTestId('archive-confirm-submit'))

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
      const invalidatedKeys = invalidateSpy.mock.calls.map(
        (call) => (call[0] as { queryKey: unknown[] } | undefined)?.queryKey,
      )
      expect(invalidatedKeys).toContainEqual(['teams'])
      expect(invalidatedKeys).toContainEqual(['projects'])
    },
  )

  it('JUNIOR: does NOT invalidate teams/projects queries on success (no cascade)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'JUNIOR', pendingTransactions: [] },
    })
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    const { queryClient, onClose } = renderDialog(
      makeUser({ role: 'JUNIOR', displayName: 'Oleksiy Kovalenko' }),
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await screen.findByRole('dialog')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] } | undefined)?.queryKey,
    )
    expect(invalidatedKeys).not.toContainEqual(['teams'])
    expect(invalidatedKeys).not.toContainEqual(['projects'])
    expect(invalidatedKeys).toContainEqual(['users-admin'])
  })

  it('Скасувати is disabled while the DELETE is pending, and does not close the dialog if clicked', async () => {
    // security-review PR #584 round 3: this is what makes `user` provably
    // non-null inside mutation.onSuccess's `user?.role` checks — without it,
    // a dismiss gesture mid-mutation could null out `user` before onSuccess
    // reads it (TanStack Query v5 always uses the LATEST render's callback,
    // not the one active at `.mutate()` time).
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'SENIOR', pendingTransactions: [] },
    })
    let resolveDelete!: () => void
    ;(api.delete as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = () => resolve({ data: {} })
      }),
    )
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    await screen.findByRole('dialog')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))

    const cancel = await screen.findByRole('button', { name: 'Скасувати' })
    await vi.waitFor(() => expect(cancel).toBeDisabled())

    // A disabled button ignores clicks — this proves onClose is not
    // reachable via Cancel during the pending window, not just that the
    // attribute is set.
    await user.click(cancel)
    expect(onClose).not.toHaveBeenCalled()

    resolveDelete()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('Escape closes the dialog normally when NOT pending (baseline for the guard below)', async () => {
    // Proves onOpenChange -> handleClose actually wires up to a REAL Radix
    // dismiss gesture (Escape), not just the Cancel button's own onClick —
    // the two are separate code paths (onOpenChange also covers overlay-click).
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'SENIOR', pendingTransactions: [] },
    })
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'SENIOR' }))

    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape does NOT close the dialog while the DELETE is pending', async () => {
    // security-review PR #584 round 3: the SAME guard as the disabled
    // Cancel button, reached through the OTHER dismiss path (Radix's
    // built-in Escape handling goes through onOpenChange, not the Cancel
    // button's onClick) — both must be closed for `user` to be provably
    // non-null in mutation.onSuccess.
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'SENIOR', pendingTransactions: [] },
    })
    let resolveDelete!: () => void
    ;(api.delete as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = () => resolve({ data: {} })
      }),
    )
    const user = userEvent.setup()
    const { onClose } = renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    await screen.findByRole('dialog')
    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    await user.click(screen.getByTestId('archive-confirm-submit'))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled())

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    resolveDelete()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
