/**
 * ArchiveUserDialog (profile page "Дії" → «Архівувати») — interaction
 * tests.
 *
 * task-archive-pending-modal (round 2). This directory previously had ZERO
 * test files at all — the mutation gate independently confirmed
 * `user-profile/admin-actions: 0.00% covered, 21 no-coverage` even though
 * this component was rewritten in this task (signature change from
 * `{userId, userName}` to `{user: UserProfileDto}`, new archive-impact
 * fetch + `UserArchiveImpact`/`ArchivePendingTransactionsList` reuse,
 * migration from the overflowing bare `DialogContent` to `CrmDialogContent`
 * — see the design-fidelity BLOCK this round fixed). Brought up to
 * test-coverage parity with the other two archive dialogs.
 *
 * task-i18n-stage3b (Task 2 / PR2): the per-role impact TEXT this file used
 * to own via `ImpactWarning` moved verbatim into
 * `components/archive/UserArchiveImpact.tsx` — that file's own suite now
 * owns per-role/locale text coverage. What THIS dialog still owns: its own
 * fetch/mutation wiring, the confirm-by-typing-name mechanic, and
 * delegating to `UserArchiveImpact` with the right props.
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

// task-i18n-stage3a (Task 1) blast-radius: this dialog renders the shared
// `ArchivePendingTransactionsList` (`components/archive/`), which now calls
// `useLingui()` — outside this file's own perimeter (`user-profile/**`
// migrates in a later wave), so only the render wrapper changes here.
beforeEach(async () => {
  await loadCatalog('uk')
})

function renderDialog(user: UserProfileDto, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <ArchiveUserDialog user={user} onClose={onClose} />
      </QueryClientProvider>
    </I18nTestProvider>,
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
    expect(within(dialog).getByText('Архівувати користувача')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument()
    expect(screen.getByTestId('archive-confirm-submit')).toBeInTheDocument()
  })

  it('fetches the archive-impact for THIS user (not an empty/mistyped entity type)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ role: 'ADMIN' }))

    await screen.findByRole('dialog')
    expect(api.get).toHaveBeenCalledWith('/users/u-1/archive-impact')
  })

  it('confirm button stays disabled until the typed name matches exactly', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const submit = await screen.findByTestId('archive-confirm-submit')
    expect(submit).toBeDisabled()
    expect(submit).toHaveTextContent('Архівувати')

    const input = screen.getByTestId('archive-confirm-name-input')
    await user.type(input, 'wrong name')
    expect(submit).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Oleksiy Kovalenko')
    expect(submit).toBeEnabled()
  })

  it('trims WHITESPACE ON THE TYPED VALUE before comparing — padded input still matches', async () => {
    // Pins `typed.trim()` — without it, the padded input would never equal
    // the clean displayName and the button would stay disabled forever.
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

  it('trims WHITESPACE ON user.displayName before comparing — padded stored name still matches a clean type', async () => {
    // Pins `user.displayName.trim()` specifically (the OTHER side of the
    // comparison) — a displayName with stray whitespace from bad data
    // must not become permanently unconfirmable.
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
})

describe('ArchiveUserDialog (profile page) — delegates impact text to UserArchiveImpact + AC2 pending list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['SENIOR', 'DROP'] as const)(
    '%s: renders UserArchiveImpact with the fetched team/projects, AND the pending-transactions warning alongside it (AC2/AC8)',
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
      // note in users/ArchiveUserConfirmDialog.test.tsx for why this matters.
      const dialog = await screen.findByRole('dialog')
      const block = await within(dialog).findByTestId('archive-warning-senior')
      expect(within(block).getByTestId('archive-confirm-user-name')).toHaveTextContent(
        'Oleksiy Kovalenko',
      )
      expect(block.textContent).toContain('Alpha Team')
      expect(block.textContent).toContain('Project A, Project B')

      // AC2/AC8: the pending-transactions warning renders alongside the
      // cascade copy — this dialog previously showed NEITHER.
      expect(within(dialog).getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
    },
  )

  it.each([
    ['JUNIOR', 'archive-warning-junior'],
    ['ADMIN', 'archive-warning-admin'],
  ] as const)(
    '%s: renders UserArchiveImpact with its own testid, no pending list when the payload has none',
    async (role, testId) => {
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'user',
          role,
          projectsCount: 1,
          noDependencies: true,
          pendingTransactions: [],
        },
      })
      renderDialog(makeUser({ role }))

      await screen.findByTestId(testId)
      expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
    },
  )

  it('SENIOR: the archive-impact query FAILING does not crash — no warning block, no pending list', async () => {
    // security-review PR #584 round 2 (mutation-gate survivor, OptionalChaining
    // on `impact?.type`). `isLoading: false` does not guarantee `impact` is
    // defined — a query ERROR also settles isLoading to false with data
    // staying undefined, and this component has no explicit isError branch.
    // A real reachable state (a 500 from GET .../archive-impact), proven
    // here rather than suppressed.
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
    // security-review SR-M-1 (fix-round A) — see the identical fix/rationale
    // in components/users/ArchiveUserConfirmDialog.test.tsx.
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()
    renderDialog(makeUser({ role: 'SENIOR', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('archive-impact-error')).toHaveTextContent(
      'Не вдалося порахувати наслідки архівації',
    )

    await user.type(screen.getByTestId('archive-confirm-name-input'), 'Oleksiy Kovalenko')
    expect(screen.getByTestId('archive-confirm-submit')).toBeDisabled()
  })

  it('the pending-list guard checks impact.type, not just truthiness — a non-"user" shape never renders it here', async () => {
    // security-review PR #584 round 2 (mutation-gate survivor): a mock that
    // ONLY ever resolves `type: 'user'` cannot distinguish `impact?.type ===
    // 'user'` from an unconditional `true` — both render identically. Give
    // it a `team`-shaped payload that STILL carries a non-empty
    // `pendingTransactions` array (contrived, but type-valid: the schema's
    // team variant carries the same optional field) so the two are
    // observably different: correct code hides the warning, `{true}` would
    // still try to render it.
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'team',
        // A `role` field here (even though the 'team' variant of the schema
        // doesn't use one) makes the absence assertion below actually test
        // the `impact?.type === 'user'` guard on line 78 — without it,
        // `TESTID_BY_ROLE[impact.role]` resolves to `TESTID_BY_ROLE[undefined]`
        // (undefined) regardless of the guard, so `archive-warning-junior`
        // would never be found either way and the mutant (ConditionalExpression
        // forced to `true`) survives unnoticed (PR2 mutation-gate round).
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
    // See the SENIOR/query-failure test above for why this waits on the
    // skeleton, not the always-present name input.
    await vi.waitFor(() =>
      expect(within(dialog).queryByTestId('archive-impact-loading')).not.toBeInTheDocument(),
    )
    expect(screen.queryByTestId('archive-warning-junior')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('preserves the SPACE before the confirm-name value (no run-together text)', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'user', role: 'ADMIN', noDependencies: true },
    })
    renderDialog(makeUser({ role: 'ADMIN', displayName: 'Oleksiy Kovalenko' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent ?? '').toContain('ім’я: Oleksiy Kovalenko')
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
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Користувача заархівовано'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
