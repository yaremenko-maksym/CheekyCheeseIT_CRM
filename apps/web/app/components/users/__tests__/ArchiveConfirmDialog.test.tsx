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

      // Wait for the ACTUAL content, not just the dialog shell — the shell
      // mounts synchronously with `open` already true, so `findByRole('dialog')`
      // alone can resolve before the mocked query settles.
      await screen.findByTestId('archive-warning-senior')
      const dialog = screen.getByRole('dialog')
      const text = dialog.textContent ?? ''
      expect(text).toContain('связанная пара')
      // Precise, position-pinned substrings — not loose single-digit
      // `.toContain('2')` checks, which a mutant swapping the SOURCE of the
      // digit (e.g. reading a different field, or defaulting to 0) can
      // still satisfy by coincidence elsewhere in the paragraph.
      expect(text).toContain(role === 'SENIOR' ? 'профиль синьора' : 'профиль дропа')
      expect(text).toContain('команда Alpha Team и все её проекты (2 шт.: Project A, Project B)')
      expect(text).toContain('HR/бухгалтеры на команде (3)')
      expect(text).toContain('JUNIOR на этих проектах (4)')
      expect(text).toContain('остаются активными членами')
      // The closing sentence's space-preserved pair word.
      expect(text).toContain(`пара ${role === 'SENIOR' ? 'senior' : 'drop'}+team`)

      // AC2: the pending-transactions warning renders alongside the cascade copy.
      expect(within(dialog).getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
      expect(text).toContain('500')
    },
  )

  it.each(['SENIOR', 'DROP'] as const)(
    '%s: impact.isPaired === false is a HARD gate — populated-but-unpaired fields are ALL ignored',
    async (role) => {
      // security-review PR #584 round 2 (mutation-gate survivors): every
      // derived value in the SENIOR/DROP branch is guarded by
      // `impact.isPaired &&` before it is used. A fixture that only ever
      // sets isPaired:true cannot prove that guard is load-bearing — a
      // mutant deleting it would render byte-for-byte the same output.
      // Here isPaired is false while every OTHER field is populated with
      // values that would be obviously wrong if used — proving they are not.
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'user',
          role,
          isPaired: false,
          teamName: 'WRONG-TEAM-SHOULD-NOT-RENDER',
          projectsCount: 99,
          projectNames: ['WRONG-PROJECT-SHOULD-NOT-RENDER'],
          hrAccountantsOnTeam: 88,
          juniorsAffected: 77,
        },
      })
      renderDialog(makeUser({ role, displayName: 'Oleksiy Kovalenko' }))

      await screen.findByTestId('archive-warning-senior')
      const dialog = screen.getByRole('dialog')
      const text = dialog.textContent ?? ''

      expect(text).not.toContain('WRONG-TEAM-SHOULD-NOT-RENDER')
      expect(text).not.toContain('WRONG-PROJECT-SHOULD-NOT-RENDER')
      expect(text).not.toContain('99')
      expect(text).not.toContain('88')
      expect(text).not.toContain('77')
      // Every value falls back to its default instead.
      expect(text).toContain(role === 'SENIOR' ? 'команда синьора' : 'команда дропа')
      expect(text).toContain('(0 шт.)')
      expect(text).not.toContain('(0 шт.:')
      expect(text).toContain('HR/бухгалтеры на команде (0)')
      expect(text).toContain('JUNIOR на этих проектах (0)')
    },
  )

  it.each(['SENIOR', 'DROP'] as const)(
    '%s: impact.type !== "user" is ALSO a hard gate, independent of isPaired — a mismatched payload is ignored even fully paired',
    async (role) => {
      // security-review PR #584 round 2 (mutation-gate survivors, round 2).
      // Stryker's LogicalOperator mutant on `impact && impact.type ===
      // 'user' && impact.isPaired && impact.X` flips the FIRST `&&` (between
      // `impact` and the type check) to `||` — because the AST node it
      // targets is the SUB-expression `impact && impact.type === 'user'`,
      // NOT the whole chain. Since `impact` is always a truthy object in
      // every test, `(impact || impact.type === 'user')` always reduces to
      // `impact` (truthy) regardless of the real type — which makes the
      // type check disappear ENTIRELY once isPaired is true. The
      // isPaired:false test above cannot catch this: it makes BOTH the
      // real code and the mutant evaluate to `false` (short-circuiting on
      // isPaired either way), so the type-check operand is never the
      // deciding factor there. This fixture isolates it: isPaired:TRUE (so
      // nothing else short-circuits first) with a type that is NOT 'user'.
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'team',
          teamName: 'WRONG-TEAM-SHOULD-NOT-RENDER',
          isPaired: true,
          projectsCount: 99,
          projectNames: ['WRONG-PROJECT-SHOULD-NOT-RENDER'],
          hrAccountantsOnTeam: 88,
          juniorsAffected: 77,
        },
      })
      renderDialog(makeUser({ role, displayName: 'Oleksiy Kovalenko' }))

      await screen.findByTestId('archive-warning-senior')
      const dialog = screen.getByRole('dialog')
      const text = dialog.textContent ?? ''

      expect(text).not.toContain('WRONG-TEAM-SHOULD-NOT-RENDER')
      expect(text).not.toContain('WRONG-PROJECT-SHOULD-NOT-RENDER')
      expect(text).not.toContain('99')
      expect(text).not.toContain('88')
      expect(text).not.toContain('77')
      expect(text).toContain(role === 'SENIOR' ? 'команда синьора' : 'команда дропа')
      expect(text).toContain('(0 шт.)')
      expect(text).not.toContain('(0 шт.:')
      expect(text).toContain('HR/бухгалтеры на команде (0)')
      expect(text).toContain('JUNIOR на этих проектах (0)')
    },
  )

  it('SENIOR: the archive-impact query FAILING does not crash — impact stays undefined, no pending list, cascade copy falls back to defaults', async () => {
    // security-review PR #584 round 2 (mutation-gate survivor, OptionalChaining
    // on `impact?.type`). `isLoading: false` does NOT guarantee `impact` is
    // defined — a query ERROR also settles `isLoading` to false while `data`
    // stays `undefined`, and this component has no explicit isError branch.
    // That is a REAL reachable state (a 500 from GET .../archive-impact), not
    // just defensive typing — proven here rather than suppressed.
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    // Waits for the query to settle (isLoading -> false on error) and the
    // fallback cascade copy to appear — the definitive post-load marker.
    await vi.waitFor(() => expect(dialog.textContent ?? '').toContain('команда синьора'))
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('SENIOR: isPaired true but every optional count OMITTED — each falls back independently (not just via isPaired)', async () => {
    // Companion to the isPaired:false test above: THIS fixture proves the
    // per-field `!== undefined` checks are independently load-bearing, not
    // just shadowed by the outer isPaired gate. If any one of them were
    // mutated to `true` (always use impact.X), the omitted field would
    // render as nothing (React silently drops `undefined` children) instead
    // of the "0" the default is supposed to produce.
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        // teamName, projectsCount, projectNames, juniorsAffected,
        // hrAccountantsOnTeam all deliberately OMITTED.
      },
    })
    renderDialog(makeUser({ role: 'SENIOR' }))

    await screen.findByTestId('archive-warning-senior')
    const dialog = screen.getByRole('dialog')
    const text = dialog.textContent ?? ''
    expect(text).toContain('команда синьора')
    expect(text).toContain('(0 шт.)')
    expect(text).not.toContain('(0 шт.:')
    expect(text).toContain('HR/бухгалтеры на команде (0)')
    expect(text).toContain('JUNIOR на этих проектах (0)')
  })

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

  it('SENIOR with zero counts and no projectNames: falls back to fallback team name, no ": " suffix', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        projectsCount: 0,
        projectNames: [],
        hrAccountantsOnTeam: 0,
        juniorsAffected: 0,
        pendingTransactions: [],
      },
    })
    renderDialog(makeUser({ role: 'SENIOR' }))

    await screen.findByTestId('archive-warning-senior')
    const dialog = screen.getByRole('dialog')
    const text = dialog.textContent ?? ''
    expect(text).toContain('команда синьора')
    expect(text).toContain('(0 шт.)')
    expect(text).not.toContain('(0 шт.:')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
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

    await screen.findByTestId('archive-warning-junior')
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

  it('Отмена is disabled while the DELETE is pending, and does not close the dialog if clicked', async () => {
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

    const cancel = await screen.findByRole('button', { name: 'Отмена' })
    await vi.waitFor(() => expect(cancel).toBeDisabled())

    // A disabled button ignores clicks — this proves onClose is not
    // reachable via Cancel during the pending window, not just that the
    // attribute is set.
    await user.click(cancel)
    expect(onClose).not.toHaveBeenCalled()

    resolveDelete()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
