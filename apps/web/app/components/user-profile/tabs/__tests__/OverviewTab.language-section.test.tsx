/**
 * OverviewTab — self-service interface language switcher (task-i18n-stage2,
 * Task 7, AC7).
 *
 * The section (`LanguageSection`, rendered via `SelfLanguageSection` — see
 * `OverviewTab.tsx`'s own doc comment right above it) is gated on the SAME
 * `mode === 'self'` condition as the neighboring "Личные данные" card, one
 * profile screen up from where the plan places it (spec §4.6 / plan Task 7
 * uточнение 2): a viewer only ever manages THEIR OWN interface language,
 * never someone else's.
 *
 * `SelfLanguageSection` reads the active locale through `useLingui()`,
 * which THROWS without an `I18nProvider` ancestor — real in production
 * (`__root.tsx`, Task 6) but not implicit in a unit test, hence the wrapper
 * below (mirrors the fix already applied to
 * `OverviewTab.pending-share.test.tsx`'s `mode='self'` cases).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { OverviewTab } from '../OverviewTab'

vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))

i18n.load('uk', {})
i18n.activate('uk')

const BASE_USER: UserProfileDto = {
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

const NO_ACTIONS_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: [],
  fields: {},
}

function renderTab(mode: 'self' | 'view') {
  // `mode='self'` also mounts `ProfileEditFields` (the "Личные данные"
  // card right above the language section), which calls `useUpdateMe()`
  // (`useMutation`) — needs a `QueryClientProvider` ancestor regardless of
  // whether this file ever exercises that mutation.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <OverviewTab user={BASE_USER} mode={mode} permissions={NO_ACTIONS_PERMS} data={{}} />
      </QueryClientProvider>
    </I18nProvider>,
  )
}

describe('OverviewTab — interface language switcher (AC7)', () => {
  it("renders both locale options on the viewer's own profile (mode=self)", () => {
    renderTab('self')
    expect(screen.getByTestId('locale-option-uk')).toBeInTheDocument()
    expect(screen.getByTestId('locale-option-en')).toBeInTheDocument()
  })

  it("is absent from another user's profile (mode=view)", () => {
    renderTab('view')
    expect(screen.queryByTestId('locale-option-uk')).not.toBeInTheDocument()
    expect(screen.queryByTestId('locale-option-en')).not.toBeInTheDocument()
  })
})
