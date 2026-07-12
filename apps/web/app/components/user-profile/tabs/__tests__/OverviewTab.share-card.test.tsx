/**
 * OverviewTab — «Доля» card role-aware rendering tests.
 *
 * Bug: карточка «Доля» всегда показывала `seniorSharePercent` (leftover default = 26)
 * для DROP-пользователей, вместо `dropSharePercent` (5/6/7 %).
 *
 * AC-1. DROP-профиль (dropSharePercent: 5, seniorSharePercent: 26, share permission) →
 *       карточка «Доля» показывает «5%».
 * AC-2. SENIOR-профиль (seniorSharePercent: 30, share permission) →
 *       карточка «Доля» показывает «30%».
 * AC-3. Когда share permission отсутствует (fields.share !== true) →
 *       карточка «Доля» не рендерится независимо от роли.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { OverviewTab } from '../OverviewTab'

// OverviewTab renders AdminNoteDialog conditionally — mock to prevent fetch calls.
vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    seniorSharePercent: 0,
    dropSharePercent: null,
    legalFullName: null,
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

const SHARE_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: [],
  fields: { share: true },
}

const NO_SHARE_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: [],
  fields: {},
}

const EMPTY_DATA = { overview: {} }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverviewTab — «Доля» card role-aware display', () => {
  it('AC-1: DROP profile shows dropSharePercent (5%), not seniorSharePercent (26%)', () => {
    render(
      <OverviewTab
        user={makeUser({ role: 'DROP', dropSharePercent: 5, seniorSharePercent: 26 })}
        mode="view"
        permissions={SHARE_PERMS}
        data={EMPTY_DATA}
      />,
    )

    const shareCard =
      screen.getByText('Доля').closest('[class*="card"], .rounded-xl, [data-slot="card"]') ??
      screen.getByText('Доля').parentElement?.parentElement?.parentElement

    // The card must exist and show 5%, not 26%
    const cardText = shareCard?.textContent ?? document.body.textContent ?? ''
    expect(cardText).toContain('5%')
    expect(cardText).not.toContain('26%')
  })

  it('AC-2: SENIOR profile shows seniorSharePercent (30%)', () => {
    render(
      <OverviewTab
        user={makeUser({ role: 'SENIOR', seniorSharePercent: 30, dropSharePercent: null })}
        mode="view"
        permissions={SHARE_PERMS}
        data={EMPTY_DATA}
      />,
    )

    const cardText =
      screen.getByText('Доля').closest('*')?.parentElement?.parentElement?.textContent ?? ''
    expect(cardText).toContain('30%')
  })

  it('AC-3: «Доля» card is hidden when share permission is absent', () => {
    render(
      <OverviewTab
        user={makeUser({ role: 'DROP', dropSharePercent: 5, seniorSharePercent: 26 })}
        mode="view"
        permissions={NO_SHARE_PERMS}
        data={EMPTY_DATA}
      />,
    )

    expect(screen.queryByText('Доля')).not.toBeInTheDocument()
  })
})
