/**
 * ArchiveConfirmDialog (`components/archive/`) — the generic
 * user/team/project archive-confirmation dialog used by
 * `AdminActionsMenu.tsx` (projects/users/team pages).
 *
 * task-i18n-stage3a (Task 1), Step 6, fix-round 1 (FR-4). This directory
 * had ZERO tests for this file at all before this round — the previous
 * round's mutation-gate follow-up found 20 surviving mutants + 13
 * no-coverage lines on a scoped `mutation:changed` run, entirely because
 * nothing exercised `renderImpactText`'s seven role/entity branches or the
 * dialog's own title/confirm-label/expected-name logic. Mirrors the
 * coverage depth already established for the two sibling archive dialogs
 * (`components/users/ArchiveConfirmDialog.tsx`,
 * `components/user-profile/admin-actions/ArchiveUserDialog.tsx`).
 *
 * Text assertions below match the copy-review round-1 fixes on this same
 * PR (#700, review 5262646217): «сеньйор» not «синьйор» (COPY-H-2),
 * «джуніор» not «джун»/raw `JUNIOR` enum (COPY-M-7/M-8), the team-branch
 * tautology fix "В архів підуть:" not "При архівації будуть архівовані:"
 * (COPY-M-13), and the reworded loading/no-dependencies copy (COPY-M-11).
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import { ArchiveConfirmDialog } from '../ArchiveConfirmDialog'

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

function renderDialog(
  props: Partial<Parameters<typeof ArchiveConfirmDialog>[0]> & {
    entityType: 'user' | 'team' | 'project'
    entityId: string
    entityName: string
  },
  onClose = vi.fn(),
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const utils = render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <ArchiveConfirmDialog onClose={onClose} {...props} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
  return { ...utils, queryClient: qc, onClose }
}

function mockGet(data: unknown) {
  ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data })
}

describe('ArchiveConfirmDialog — fetch + loading', () => {
  it('fetches archive-impact from the endpoint matching entityType', async () => {
    mockGet({ type: 'project', activeMembersCount: 0 })
    renderDialog({ entityType: 'project', entityId: 'p-1', entityName: 'Alpha' })

    await screen.findByRole('dialog')
    expect(api.get).toHaveBeenCalledWith('/projects/p-1/archive-impact')
  })

  it('shows a loading skeleton (not the impact text) while the query is pending', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Oleksiy' })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/буде архівований/)).not.toBeInTheDocument()
    // Input + footer buttons render regardless of the impact query state.
    expect(screen.getByTestId('archive-confirm-input')).toBeInTheDocument()
    expect(screen.getByTestId('archive-confirm-submit')).toBeInTheDocument()
  })

  it('the query error does not crash — impact stays in the "computing" state', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Oleksiy' })

    const dialog = await screen.findByRole('dialog')
    // isLoading settles to false on error too — the skeleton must disappear
    // and the dialog must not throw despite `impact` staying undefined.
    await screen.findByText('Рахуємо, що зміниться…')
    expect(dialog).toBeInTheDocument()
  })
})

// task-i18n-stage3b (Task 2 / PR2), Step 2: the seven user-role branches
// this dialog used to own (SENIOR+DROP pair-cascade, HR, ACCOUNTANT, JUNIOR,
// ADMIN, both no-team sub-cases) moved verbatim into
// `components/archive/UserArchiveImpact.tsx` — that file's own test suite
// (`archive/__tests__/UserArchiveImpact.test.tsx`) now owns per-role/locale
// text coverage. What THIS dialog still needs its own test for is only the
// delegation itself: entityType='user' renders `<UserArchiveImpact>` with
// the right `entityName`/`impact` props, picked out by its stable testids.
describe('ArchiveConfirmDialog — renderImpactText: user delegates to UserArchiveImpact', () => {
  it('user/SENIOR (with team) renders via UserArchiveImpact — testid + name + team text present', async () => {
    mockGet({
      type: 'user',
      role: 'SENIOR',
      teamName: 'Alpha Team',
      projectsCount: 2,
      projectNames: ['Project A', 'Project B'],
      hrAccountantsOnTeam: 3,
      juniorsAffected: 4,
    })
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Oleksiy Kovalenko' })

    const dialog = await screen.findByRole('dialog')
    const block = await within(dialog).findByTestId('archive-warning-senior')
    expect(within(block).getByTestId('archive-confirm-user-name')).toHaveTextContent(
      'Oleksiy Kovalenko',
    )
    expect(block.textContent).toContain('Alpha Team')
  })

  it('user/HR renders via UserArchiveImpact — testid archive-warning-hr', async () => {
    mockGet({ type: 'user', role: 'HR', teamsCount: 5 })
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Nina' })

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('archive-warning-hr')).toBeInTheDocument()
  })

  it('user/ADMIN renders via UserArchiveImpact — testid archive-warning-admin', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Root Admin' })

    const dialog = await screen.findByRole('dialog')
    const block = await within(dialog).findByTestId('archive-warning-admin')
    expect(block.textContent).toContain('Root Admin')
  })
})

describe('ArchiveConfirmDialog — renderImpactText: team (SENIOR default vs DROP)', () => {
  it('legacy SENIOR team (teamType absent): uses seniorName, falls back to "—" when missing', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Beta Team',
      seniorName: '',
      projectsCount: 1,
      membersAffected: 2,
    })
    renderDialog({ entityType: 'team', entityId: 't-1', entityName: 'Beta Team' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/і її сеньйор/)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Beta Team')
    expect(text).toContain('—') // seniorName fallback
    expect(text).not.toContain('дроп')
    // COPY-M-13: no more "При архівації будуть архівовані" tautology.
    expect(text).toContain('В архів підуть')
    expect(text).not.toContain('При архівації будуть архівовані')
    // `{' '}` boundaries: "сеньйор" -> seniorName/fallback, block1 -> block2.
    expect(text).toContain('сеньйор —')
    expect(text).toContain('стосується. Це еквівалентно')
    // MUT-1 (fix-round 2): the `</Trans>{' '}<Trans>` boundary itself
    // (legacy-SENIOR branch's own copy of the same block1→block2 join —
    // a SEPARATE source line from the pair-cascade one above).
    expect(text).toContain('). HR/бухгалтери')
  })

  it('DROP team: uses dropName (trimmed), NOT the senior word (no cross-read of ROLE_RU.SENIOR)', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma Team',
      seniorName: 'Ihor Senior',
      teamType: 'DROP',
      dropName: '  Dmytro Drop  ',
      projectsCount: 2,
      membersAffected: 1,
      seniorWillBeDetached: true,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma Team' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/і її дроп/)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Dmytro Drop')
    expect(text).toContain('профіль')
    expect(text).toContain('дропа')
    expect(text).toContain('В архів підуть')
    expect(text).toContain('Активний сеньйор Ihor Senior')
    expect(text).toContain('від’єднається')
    // `{' '}` boundaries: "дроп" -> dropName, block1 -> block2.
    expect(text).toContain('дроп Dmytro Drop')
    expect(text).toContain('стосується. Активний сеньйор')
    // MUT-1 (fix-round 2): the `</Trans>{' '}<Trans>` boundary itself,
    // right after block1's closing ").").
    expect(text).toContain('). HR/бухгалтери')
  })

  it('DROP team: seniorWillBeDetached=false renders the "немає" branch, not the detach sentence', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma Team',
      seniorName: '',
      teamType: 'DROP',
      dropName: 'Dmytro Drop',
      projectsCount: 0,
      membersAffected: 0,
      seniorWillBeDetached: false,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma Team' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/і її дроп/)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Активного сеньйора в команді немає')
    expect(text).not.toContain('від’єднається')
    expect(text).toContain('стосується. Активного сеньйора')
  })

  it('DROP team: seniorWillBeDetached=true with NO seniorName omits the name suffix ("Активний сеньйор" alone)', async () => {
    // Pins the `impact.seniorName ? \` ${name}\` : ''` FALSE branch — every
    // other seniorWillBeDetached=true test in this file provides a
    // non-empty seniorName, so that branch had zero coverage.
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma Team',
      seniorName: '',
      teamType: 'DROP',
      dropName: 'Dmytro Drop',
      projectsCount: 0,
      membersAffected: 0,
      seniorWillBeDetached: true,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma Team' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/і її дроп/)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Активний сеньйор від’єднається від')
    expect(text).not.toContain('Активний сеньйор  ') // no double space / stray name
  })

  it('DROP team: dropName absent falls back to "—" (dropName?.trim() || "—")', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma Team',
      seniorName: '',
      teamType: 'DROP',
      projectsCount: 0,
      membersAffected: 0,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma Team' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/і її дроп/)
    // The dialog title's confirm input ALSO shows `expected` (dropName ?? ''
    // → '') separately from the impact-text fallback below; the matched
    // element IS the impact paragraph itself (Testing Library resolves
    // `getByText` to the smallest element containing the full string).
    const impactPara = within(dialog).getByText(/і її дроп/)
    expect(impactPara.textContent ?? '').toContain('—')
  })
})

describe('ArchiveConfirmDialog — renderImpactText: project', () => {
  it('project: activeMembersCount pluralizes, clarifies senior/team are NOT archived', async () => {
    mockGet({ type: 'project', activeMembersCount: 4 })
    renderDialog({ entityType: 'project', entityId: 'p-1', entityName: 'Project X' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/буде архівований/)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Project X')
    // few-form (4): "4 активні джуніори" — mod10 4 is few per uk plural
    // rules; COPY-M-8 renamed "джун" to "джуніор" across this file.
    expect(text).toContain('4 активні джуніори')
    expect(text).toContain('не')
    expect(text).toContain('будуть архівовані')
    // `{' '}` boundaries: "архівований," -> count, count -> "будуть відв’язані".
    expect(text).toContain('архівований, 4 активні джуніори')
    expect(text).toContain('джуніори будуть відв’язані')
    // COPY-H-2: the standalone capitalized "Синьйор" sentence-opener in
    // this branch was missed by the first (lowercase-only) sweep.
    expect(text).toContain('Сеньйор і команда')
    expect(text).not.toContain('Синьйор')
  })
})

describe('ArchiveConfirmDialog — pending-transactions list gating', () => {
  it('renders ArchivePendingTransactionsList for user impact', async () => {
    mockGet({
      type: 'user',
      role: 'ADMIN',
      pendingTransactions: [
        {
          id: 'tx-1',
          type: 'SALARY',
          salaryMonth: '2026-08',
          txDate: null,
          amount: '100.00',
          currency: 'USD',
        },
      ],
    })
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Root' })

    await screen.findByRole('dialog')
    expect(await screen.findByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
  })

  it('does NOT render the list for project impact (project schema has no pendingTransactions field)', async () => {
    mockGet({ type: 'project', activeMembersCount: 0 })
    renderDialog({ entityType: 'project', entityId: 'p-1', entityName: 'Project X' })

    await screen.findByRole('dialog')
    await screen.findByText(/буде архівований/)
    expect(screen.queryByTestId('archive-pending-transactions-warning')).not.toBeInTheDocument()
  })
})

describe('ArchiveConfirmDialog — title + confirm-input label per entity/team-variant', () => {
  it('user: title is "Архівувати користувача", label is "ім\'я"', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Root' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/Для підтвердження введіть/)
    expect(within(dialog).getByText('Архівувати користувача')).toBeInTheDocument()
    expect(dialog.textContent ?? '').toContain('Для підтвердження введіть ім’я:')
  })

  it('project: title is "Архівувати проєкт", label is "назва проєкту"', async () => {
    mockGet({ type: 'project', activeMembersCount: 0 })
    renderDialog({ entityType: 'project', entityId: 'p-1', entityName: 'Project X' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/Для підтвердження введіть/)
    expect(within(dialog).getByText('Архівувати проєкт')).toBeInTheDocument()
    expect(dialog.textContent ?? '').toContain('Для підтвердження введіть назва проєкту:')
  })

  it('team (SENIOR default): title is "Архівувати команду", label is "ім\'я сеньйора"', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Beta',
      seniorName: 'Ihor Senior',
      projectsCount: 0,
      membersAffected: 0,
    })
    renderDialog({ entityType: 'team', entityId: 't-1', entityName: 'Beta' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/Для підтвердження введіть/)
    expect(within(dialog).getByText('Архівувати команду')).toBeInTheDocument()
    expect(dialog.textContent ?? '').toContain('Для підтвердження введіть ім’я сеньйора:')
  })

  it('team (DROP variant): title is "Архівувати команду дропа", label is "ім\'я дропа"', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma',
      seniorName: '',
      teamType: 'DROP',
      dropName: 'Dmytro Drop',
      projectsCount: 0,
      membersAffected: 0,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma' })

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/Для підтвердження введіть/)
    expect(within(dialog).getByText('Архівувати команду дропа')).toBeInTheDocument()
    expect(dialog.textContent ?? '').toContain('Для підтвердження введіть ім’я дропа:')
  })
})

describe('ArchiveConfirmDialog — expected/matches + confirm flow', () => {
  it('confirmName prop overrides the computed expected name', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    const user = userEvent.setup()
    renderDialog({
      entityType: 'user',
      entityId: 'u-1',
      entityName: 'Root Admin',
      confirmName: 'custom-confirm-token',
    })

    const submit = await screen.findByTestId('archive-confirm-submit')
    const input = screen.getByTestId('archive-confirm-input')
    await user.type(input, 'Root Admin')
    expect(submit).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'custom-confirm-token')
    expect(submit).toBeEnabled()
  })

  it('team DROP: typed value must match dropName (not seniorName / not entityName)', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma',
      seniorName: 'Ihor Senior',
      teamType: 'DROP',
      dropName: 'Dmytro Drop',
      projectsCount: 0,
      membersAffected: 0,
    })
    const user = userEvent.setup()
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma' })

    const submit = await screen.findByTestId('archive-confirm-submit')
    const input = screen.getByTestId('archive-confirm-input')
    await user.type(input, 'Ihor Senior')
    expect(submit).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Dmytro Drop')
    expect(submit).toBeEnabled()
  })

  it('team DROP with empty dropName: expected is empty, button stays disabled no matter what — even empty input never "matches" an empty expected', async () => {
    mockGet({
      type: 'team',
      isPaired: true,
      teamName: 'Gamma',
      seniorName: '',
      teamType: 'DROP',
      projectsCount: 0,
      membersAffected: 0,
    })
    renderDialog({ entityType: 'team', entityId: 't-2', entityName: 'Gamma' })

    const submit = await screen.findByTestId('archive-confirm-submit')
    // `expected` is falsy here ⇒ the confirmation prompt paragraph is
    // entirely absent (the `{expected && (...)}` guard). Wait for the
    // impact text first so the query has genuinely settled before
    // asserting on absence.
    await screen.findByText(/і її дроп/)
    expect(screen.queryByText(/Для підтвердження введіть/)).not.toBeInTheDocument()
    expect(submit).toBeDisabled()
  })

  it('typed value is trimmed before comparing to expected', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    const user = userEvent.setup()
    renderDialog({ entityType: 'user', entityId: 'u-1', entityName: 'Root Admin' })

    const submit = await screen.findByTestId('archive-confirm-submit')
    const input = screen.getByTestId('archive-confirm-input')
    await user.type(input, '  Root Admin  ')
    expect(submit).toBeEnabled()
  })

  it('Скасувати closes without calling DELETE', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    const user = userEvent.setup()
    const { onClose } = renderDialog({
      entityType: 'user',
      entityId: 'u-1',
      entityName: 'Root Admin',
    })

    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('Архівувати (submit) calls DELETE on the matching entity and then onClose', async () => {
    mockGet({ type: 'user', role: 'ADMIN' })
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    const { onClose } = renderDialog({
      entityType: 'user',
      entityId: 'u-42',
      entityName: 'Root Admin',
    })

    const input = await screen.findByTestId('archive-confirm-input')
    await user.type(input, 'Root Admin')
    const submit = screen.getByTestId('archive-confirm-submit')
    expect(submit).toBeEnabled()
    await user.click(submit)

    expect(api.delete).toHaveBeenCalledWith('/users/u-42')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
