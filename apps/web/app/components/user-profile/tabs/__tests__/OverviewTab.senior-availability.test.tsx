/**
 * OverviewTab — who sees the senior-availability setter (vacancy-queue design §5.2).
 * Viewer → target: SENIOR → self and ADMIN → an active SENIOR see it; ADMIN → a non-senior or an
 * archived senior, and every other viewer → a senior, do not. The API enforces the same pairs;
 * this pins that the UI never offers a form the API would refuse.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Role, UserProfileDto, ViewPermissions } from '@crm/shared'
import { OverviewTab } from '../OverviewTab'

vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))
const viewer: { role: Role } = { role: 'SENIOR' }
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer', role: viewer.role }, invalidate: vi.fn() }),
}))
vi.mock('@/components/senior-availability/SeniorAvailabilitySection', () => ({
  SeniorAvailabilitySection: ({ userId }: { userId: string }) => (
    <div data-testid="senior-availability-section" data-user={userId} />
  ),
}))

i18n.load('uk', {})
i18n.activate('uk')

const SENIOR: UserProfileDto = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'senior@cheekycheese.dev',
  displayName: 'Senior Dev',
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
}
const PERMS: ViewPermissions = { tabs: ['overview'], actions: [], fields: {} }

function renderTab(user: UserProfileDto, mode: 'self' | 'view') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <OverviewTab user={user} mode={mode} permissions={PERMS} data={{}} />
      </QueryClientProvider>
    </I18nProvider>,
  )
}
const section = () => screen.queryByTestId('senior-availability-section')

beforeEach(() => {
  viewer.role = 'SENIOR'
})

describe('OverviewTab — senior availability setter', () => {
  it('SENIOR → self: shown, for their own id', () => {
    renderTab(SENIOR, 'self')
    expect(section()).toHaveAttribute('data-user', SENIOR.id)
  })

  it('ADMIN → an active SENIOR: shown', () => {
    viewer.role = 'ADMIN'
    renderTab(SENIOR, 'view')
    expect(section()).toBeInTheDocument()
  })

  it.each<Role>(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT'])('%s → another senior: absent', (role) => {
    viewer.role = role
    renderTab(SENIOR, 'view')
    expect(section()).toBeNull()
  })

  it('ADMIN → an HR profile or an archived senior: absent', () => {
    viewer.role = 'ADMIN'
    const { unmount } = renderTab({ ...SENIOR, role: 'HR' }, 'view')
    expect(section()).toBeNull()
    unmount()
    renderTab({ ...SENIOR, archivedAt: new Date('2026-10-01T00:00:00Z') }, 'view')
    expect(section()).toBeNull()
  })
})
