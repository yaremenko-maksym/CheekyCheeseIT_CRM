/**
 * OverviewTab — a SENIOR's technical roles replace the free-text stack card
 * (senior roles PR 5, `docs/design/senior-roles-ui.md`). The profile shows every
 * role (no "+N"); a legacy SENIOR with none keeps the "не вказано" card and never
 * shows the stale stack. Every other role keeps the stack card unchanged.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { OverviewTab } from '../OverviewTab'

vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/components/senior-availability/SeniorAvailabilitySection', () => ({
  SeniorAvailabilitySection: () => null,
}))

const BASE_USER: UserProfileDto = {
  id: 'user-1',
  email: 'user-1@example.test',
  displayName: 'User One',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'SENIOR',
  telegram: null,
  phone: null,
  techStack: null,
  technicalRoles: [],
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

function renderTab(overrides: Partial<UserProfileDto>, permissions: ViewPermissions = PERMS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OverviewTab
        user={{ ...BASE_USER, ...overrides }}
        mode="view"
        permissions={permissions}
        data={{}}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('OverviewTab — technical roles of a senior (senior roles PR 5)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('a SENIOR sees a "Технічні ролі" card with every role, no "+N", never the stack', () => {
    renderTab({
      techStack: ['Zzstale'],
      technicalRoles: [
        'BACKEND_ENGINEER',
        'FRONTEND_ENGINEER',
        'FULLSTACK_ENGINEER',
        'QA_ENGINEER',
      ],
    })
    const roles = screen.getByTestId('profile-technical-roles')
    expect(within(roles).getByRole('heading', { name: 'Технічні ролі' })).toBeInTheDocument()
    expect(within(roles).getAllByTestId(/^role-chip-/)).toHaveLength(4)
    expect(within(roles).getByText('QA-інженер (мануальне тестування)')).toBeInTheDocument()
    expect(screen.queryByTestId('role-chips-more')).toBeNull()
    expect(screen.queryByText('Технології')).toBeNull()
    expect(screen.queryByText('Zzstale')).toBeNull()
  })

  it('a legacy SENIOR with no roles keeps the card with "не вказано", not the stale stack', () => {
    renderTab({ techStack: ['Zzstale'], technicalRoles: [] })
    const roles = screen.getByTestId('profile-technical-roles')
    expect(within(roles).getByRole('heading', { name: 'Технічні ролі' })).toBeInTheDocument()
    expect(within(roles).getByText('не вказано')).toBeInTheDocument()
    expect(screen.queryByTestId('role-chips')).toBeNull()
    expect(screen.queryByText('Zzstale')).toBeNull()
  })

  it('a JUNIOR keeps the "Технології" stack card and shows no role chips', () => {
    renderTab({ role: 'JUNIOR', techStack: ['Zzgo'], technicalRoles: [] })
    const stack = screen.getByTestId('profile-tech-stack')
    expect(within(stack).getByRole('heading', { name: 'Технології' })).toBeInTheDocument()
    expect(within(stack).getByText('Zzgo')).toBeInTheDocument()
    expect(screen.queryByTestId('profile-technical-roles')).toBeNull()
    expect(screen.queryByText('Технічні ролі')).toBeNull()
    expect(screen.queryByTestId('role-chips')).toBeNull()
  })

  it('the techStack field gate hides the roles card too', () => {
    renderTab(
      { technicalRoles: ['BACKEND_ENGINEER'] },
      { tabs: ['overview'], actions: [], fields: { techStack: false } },
    )
    expect(screen.queryByTestId('profile-technical-roles')).toBeNull()
    expect(screen.queryByTestId('role-chips')).toBeNull()
  })
})
