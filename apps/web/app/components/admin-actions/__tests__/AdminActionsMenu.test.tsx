/**
 * AdminActionsMenu — interaction tests.
 *
 * Covers task-fix-pr34-polish AutoTest #3.B (AdminActionsMenu keyboard +
 * Escape close) and the archive-vs-unarchive branching.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// `api` is consumed transitively by use-archive — we mock it so the menu
// renders without a real network round-trip.
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

import { AdminActionsMenu } from '../AdminActionsMenu'

function renderMenu(
  props: {
    entityType?: 'team' | 'project' | 'user'
    isArchived?: boolean
  } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <AdminActionsMenu
        entityType={props.entityType ?? 'team'}
        entityId="entity-1"
        entityName="Alpha Team"
        isArchived={props.isArchived ?? false}
      />
    </QueryClientProvider>,
  )
  return { ...utils, queryClient: qc }
}

describe('AdminActionsMenu — trigger + dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the trigger with Russian "Действия" label', () => {
    renderMenu()
    const trigger = screen.getByTestId('admin-actions-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('Действия')
  })

  it('opens dropdown when trigger is clicked (active entity → Архивировать item)', async () => {
    const user = userEvent.setup()
    renderMenu({ isArchived: false })

    await user.click(screen.getByTestId('admin-actions-trigger'))

    const archiveItem = await screen.findByTestId('admin-action-archive')
    expect(archiveItem).toBeInTheDocument()
    expect(archiveItem).toHaveTextContent('Архивировать')
    // Unarchive item must NOT be present for an active entity
    expect(screen.queryByTestId('admin-action-unarchive')).not.toBeInTheDocument()
  })

  it('shows only Восстановить из архива for archived entities', async () => {
    const user = userEvent.setup()
    renderMenu({ isArchived: true })

    await user.click(screen.getByTestId('admin-actions-trigger'))

    const unarchive = await screen.findByTestId('admin-action-unarchive')
    expect(unarchive).toHaveTextContent('Восстановить из архива')
    expect(screen.queryByTestId('admin-action-archive')).not.toBeInTheDocument()
  })

  it('opens via keyboard (Enter on trigger) and exposes the archive item', async () => {
    const user = userEvent.setup()
    renderMenu({ isArchived: false })

    const trigger = screen.getByTestId('admin-actions-trigger')
    trigger.focus()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('admin-action-archive')).toBeInTheDocument()
  })

  it('Escape closes the open dropdown without firing any action', async () => {
    const user = userEvent.setup()
    renderMenu({ isArchived: false })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    expect(await screen.findByTestId('admin-action-archive')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    // Radix marks the item as hidden via aria/pointer events; assert it is gone.
    expect(screen.queryByTestId('admin-action-archive')).not.toBeInTheDocument()
  })

  it('Clicking Архивировать opens the ArchiveConfirmDialog (renders title in role=dialog)', async () => {
    const user = userEvent.setup()
    renderMenu({ isArchived: false })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    // The role=dialog has the title "Архивировать команду"
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Архивировать команду/)).toBeInTheDocument()
  })

  // task-archive-pending-modal (AC2). `api.get` above is a bare `vi.fn()`
  // with no resolved value, so `impact` stays `undefined` for the whole test
  // — the `(impact?.type === 'user' || impact?.type === 'team')` guard is
  // never actually exercised as true OR false by that test. These two pin
  // both sides for real.
  it('shows the pending-transactions warning when archive-impact resolves with a PENDING row (team)', async () => {
    const { api } = await import('@/lib/axios')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'team',
        isPaired: true,
        teamName: 'Alpha Team',
        seniorName: 'Senior One',
        projectsCount: 2,
        // TWO entries — proves the join separator is really ', ' and not
        // just "whatever a single-element array renders regardless of it".
        projectNames: ['Project A', 'Project B'],
        membersAffected: 2,
        pendingTransactions: [
          {
            id: 'a0000000-0000-4000-8000-000000000001',
            type: 'SALARY',
            salaryMonth: '2026-07',
            txDate: null,
            amount: '1500.00',
            currency: 'USD',
          },
        ],
      },
    })
    const user = userEvent.setup()
    renderMenu({ isArchived: false, entityType: 'team' })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    expect(await screen.findByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
    expect(screen.getByText(/Незакрытые PENDING-транзакции/)).toBeInTheDocument()
    // The named-projects list actually renders BOTH names joined with ", ".
    expect(screen.getByText(/Project A, Project B/)).toBeInTheDocument()
    // seniorName renders as given (also used as the confirm-input's expected
    // value) — the `|| '—'` fallback did NOT fire anywhere.
    expect(screen.getAllByText(/Senior One/).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('team-type impact with an EMPTY projectNames / missing seniorName: no ": " suffix, falls back to "—"', async () => {
    const { api } = await import('@/lib/axios')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'team',
        isPaired: true,
        teamName: 'Alpha Team',
        seniorName: '',
        projectsCount: 0,
        projectNames: [],
        membersAffected: 0,
      },
    })
    const user = userEvent.setup()
    renderMenu({ isArchived: false, entityType: 'team' })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    const dialog = await screen.findByRole('dialog')
    // Empty seniorName falls back to the em dash placeholder — rendered
    // twice in this copy (both `impact.seniorName || '—'` occurrences).
    expect(within(dialog).getAllByText('—')).toHaveLength(2)
    // Zero projects: the "(0 шт.)" text renders WITHOUT a ": " names suffix.
    expect(within(dialog).getByText(/\(0 шт\.\)/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/\(0 шт\.:/)).not.toBeInTheDocument()
    // Nothing pending → the warning box itself is absent.
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  it('does NOT show the pending-transactions warning for a project-type impact (no pendingTransactions field)', async () => {
    const { api } = await import('@/lib/axios')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { type: 'project', activeMembersCount: 2 },
    })
    const user = userEvent.setup()
    renderMenu({ isArchived: false, entityType: 'project' })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    await screen.findByRole('dialog')
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })

  // task-archive-pending-modal (AC2). `entityType === 'user'` reaches the
  // SAME shared conditional (`impact?.type === 'user' || impact?.type ===
  // 'team'`) from its OTHER side — every test above only ever resolves
  // `type: 'team'`, so the `'user'` alternative was never independently
  // load-bearing until this one.
  it('shows the pending-transactions warning for a user-type impact too (entityType="user")', async () => {
    const { api } = await import('@/lib/axios')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'user',
        role: 'JUNIOR',
        projectsCount: 1,
        pendingTransactions: [
          {
            id: 'a0000000-0000-4000-8000-000000000002',
            type: 'SALARY',
            salaryMonth: '2026-07',
            txDate: null,
            amount: '500.00',
            currency: 'USD',
          },
        ],
      },
    })
    const user = userEvent.setup()
    renderMenu({ isArchived: false, entityType: 'user' })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    expect(await screen.findByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
  })

  // task-archive-pending-modal (AC7/AC9). `role === 'SENIOR' || role ===
  // 'DROP'` picks the cascade-copy branch. The JUNIOR test above never makes
  // that condition true, so every mutation of it (flipping either operand,
  // the whole condition, or the string literals) survived unnoticed. SENIOR
  // and DROP are exercised separately — they render DIFFERENT genitive
  // words ("синьора" vs "дропа"), so a truthiness-only assertion would still
  // miss a mutant that swaps `role === 'SENIOR' ? 'синьора' : 'дропа'`
  // (pinned instead by the users/ArchiveConfirmDialog + ArchiveUserDialog
  // paths, which share the identical pattern).
  it.each(['SENIOR', 'DROP'] as const)(
    'renders the FULL cascade-pair copy for a %s user-type impact (entityType="user")',
    async (role) => {
      const { api } = await import('@/lib/axios')
      ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          type: 'user',
          role,
          isPaired: true,
          teamName: 'Alpha Team',
          projectsCount: 2,
          // TWO entries — pins the ', ' join separator, same reason as the
          // team-type test above.
          projectNames: ['Project A', 'Project B'],
          hrAccountantsToBeRemoved: 3,
          juniorsAffected: 4,
        },
      })
      const user = userEvent.setup()
      renderMenu({ isArchived: false, entityType: 'user' })

      await user.click(screen.getByTestId('admin-actions-trigger'))
      await user.click(await screen.findByTestId('admin-action-archive'))

      const dialog = await screen.findByRole('dialog')
      const dialogText = dialog.textContent ?? ''
      expect(dialogText).toContain('связанная пара, убрать по одному нельзя')
      expect(dialogText).toContain(role === 'SENIOR' ? 'профиль синьора' : 'профиль дропа')
      // Named projects, joined with ", " — not a coincidence of a single item.
      expect(dialogText).toContain('Project A, Project B')
      expect(dialogText).toContain('2')
      // The two "third parties stay active" counts.
      expect(dialogText).toContain('3')
      expect(dialogText).toContain('4')
      expect(dialogText).toContain('остаются активными членами')
      // The closing sentence's role-specific English pair word.
      expect(dialogText).toContain(role === 'SENIOR' ? 'senior+команда' : 'drop+команда')
    },
  )

  // task-archive-pending-modal (AC8): the empty-projectNames / zero-counts
  // side of the SAME branch — a single richly-populated fixture cannot prove
  // `?? 0` / `.length > 0 ? … : ''` are load-bearing (see the team-type
  // "EMPTY projectNames" test above for the identical reasoning).
  it('user-type SENIOR impact with zero counts and no projectNames: no ": " suffix, "0" everywhere', async () => {
    const { api } = await import('@/lib/axios')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName: 'Alpha Team',
        projectsCount: 0,
        projectNames: [],
        hrAccountantsToBeRemoved: 0,
        juniorsAffected: 0,
      },
    })
    const user = userEvent.setup()
    renderMenu({ isArchived: false, entityType: 'user' })

    await user.click(screen.getByTestId('admin-actions-trigger'))
    await user.click(await screen.findByTestId('admin-action-archive'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/\(0 шт\.\)/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/\(0 шт\.:/)).not.toBeInTheDocument()
  })
})
