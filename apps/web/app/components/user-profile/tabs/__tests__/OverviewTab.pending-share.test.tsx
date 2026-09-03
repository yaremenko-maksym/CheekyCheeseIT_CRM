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

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
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

const PENDING: PendingSeniorShare = {
  percent: 55,
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
