/**
 * TeamTab.empty-state.test.tsx — task-web-border-hack-and-honest-empty-state
 * (defect 69) AC9.
 *
 * An empty `/users/:id/team` response has two possible real-world causes —
 * the profile genuinely has no team, or the roster is non-empty but masked
 * out for this viewer (getTeamMembersForUser). The frontend cannot and must
 * not distinguish the two (owner decision 2026-08-17), so the empty-state
 * copy is a single honest string that stays true in both cases. This test
 * pins that literal string so a future edit can't silently reintroduce the
 * old "Не состоит в команде" claim (which asserted "no team" as fact).
 *
 * Asserts on the literal (not an imported constant) per AC9 — the constant
 * itself could drift from what's actually rendered without either test or
 * reviewer noticing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const getMock = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: { get: (url: string) => getMock(url) },
}))

// Stub TanStack Router Link — no router context available in unit tests
// (same pattern as UserProfileHeader.test.tsx).
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, ...props }: { children?: ReactNode; to?: string }) => (
      <a href={props.to ?? '#'}>{children}</a>
    ),
  }
})

// Import AFTER the mock is registered.
import { TeamTab } from '../TeamTab'

function renderTab(userId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TeamTab userId={userId} />
    </QueryClientProvider>,
  )
}

describe('TeamTab — honest empty state', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows the honest empty-state copy when the roster is empty', async () => {
    getMock.mockResolvedValueOnce({ data: [] })
    renderTab('u-1')

    await waitFor(() => {
      expect(screen.getByText('Нет данных о составе команды')).toBeInTheDocument()
    })

    // The old wording claimed a fact ("not on a team") that a masked-but-real
    // roster would make false — must not reappear.
    expect(screen.queryByText('Не состоит в команде')).not.toBeInTheDocument()
  })

  it('shows the honest empty-state copy when the request fails (masked as empty)', async () => {
    getMock.mockRejectedValueOnce(new Error('403'))
    renderTab('u-2')

    await waitFor(() => {
      expect(screen.getByText('Нет данных о составе команды')).toBeInTheDocument()
    })
  })

  it('renders the roster (not the empty state) when members are present', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        {
          id: 'm-1',
          displayName: 'Ivan Petrenko',
          role: 'JUNIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
    })
    renderTab('u-3')

    await waitFor(() => {
      expect(screen.getByText('Ivan Petrenko')).toBeInTheDocument()
    })
    expect(screen.queryByText('Нет данных о составе команды')).not.toBeInTheDocument()
  })
})
