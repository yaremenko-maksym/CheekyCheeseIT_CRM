/**
 * TeamTab.sort-order.test.tsx — task-i18n-stage3b (Task 1), mutation-gate
 * coverage.
 *
 * The roster sort — `ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
 * cmp(a.displayName, b.displayName)` — had zero unit assertion on the
 * resulting DOM order before this file: `TeamTab.empty-state.test.tsx` only
 * ever fixtures an empty or single-member list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const getMock = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: { get: (url: string) => getMock(url) },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, ...props }: { children?: ReactNode; to?: string }) => (
      <a href={props.to ?? '#'}>{children}</a>
    ),
  }
})

import { TeamTab } from '../TeamTab'

function renderTab(userId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TeamTab userId={userId} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(() => loadCatalog('uk'))
afterEach(() => vi.clearAllMocks())

describe('TeamTab — roster sort order (role first, name as tiebreak)', () => {
  it('sorts JUNIOR/ADMIN/ACCOUNTANT/HR/SENIOR into SENIOR, HR, ACCOUNTANT, JUNIOR, ADMIN', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 'j1',
          displayName: 'Junior Person',
          role: 'JUNIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: 'a1',
          displayName: 'Admin Person',
          role: 'ADMIN',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: 'ac1',
          displayName: 'Accountant Person',
          role: 'ACCOUNTANT',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        { id: 'h1', displayName: 'Hr Person', role: 'HR', avatarUrl: null, avatarDocumentId: null },
        {
          id: 's1',
          displayName: 'Senior Person',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
    })
    renderTab('target-1')
    await waitFor(() => expect(screen.getByText('Senior Person')).toBeInTheDocument())
    const names = screen.getAllByRole('link').map((el) => el.textContent)
    // Role order pinned: SENIOR(0) < HR(1) < ACCOUNTANT(2) < JUNIOR(3) < ADMIN(4).
    // A `-` → `+` mutant, an `||` → `&&` mutant, or either `true`/`false`
    // constant-fold on the comparator all reorder this list differently.
    expect(names).toEqual([
      expect.stringContaining('Senior Person'),
      expect.stringContaining('Hr Person'),
      expect.stringContaining('Accountant Person'),
      expect.stringContaining('Junior Person'),
      expect.stringContaining('Admin Person'),
    ])
  })

  it('same-role members are ordered by name (the tiebreak half of the `||`)', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 's2',
          displayName: 'Zoya Senior',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: 's1',
          displayName: 'Anna Senior',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
    })
    renderTab('target-1')
    await waitFor(() => expect(screen.getByText('Zoya Senior')).toBeInTheDocument())
    const names = screen.getAllByRole('link').map((el) => el.textContent)
    expect(names).toEqual([
      expect.stringContaining('Anna Senior'),
      expect.stringContaining('Zoya Senior'),
    ])
  })
})
