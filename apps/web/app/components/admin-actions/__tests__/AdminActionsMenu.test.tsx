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

function renderMenu(props: {
  entityType?: 'team' | 'project'
  isArchived?: boolean
} = {}) {
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
    expect(document.activeElement).toBe(trigger)

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
})
