/**
 * OverviewTab — ToS acceptance marker tests.
 *
 * Covers Task 3 AC:
 *   AC-1. When `data.overview.tosAcceptedAt` is defined (non-undefined),
 *         the card renders with the accepted date + version.
 *   AC-2. When `data.overview.tosAcceptedAt` is null (defined but null),
 *         the card renders "Не принято".
 *   AC-3. When `data.overview.tosAcceptedAt` is undefined (field absent),
 *         the ToS card is hidden (no permission to see).
 *
 * ADMIN-viewer scenario: backend includes tosAcceptedAt when the viewer is
 * ADMIN or viewing own profile.  Non-ADMIN viewing another user → field is
 * omitted → canSeeTos = false → card hidden.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { OverviewTab } from '../OverviewTab'

// OverviewTab renders AdminNoteDialog conditionally — it imports a mutation
// hook internally. Mock the hook to prevent fetch calls in unit tests.
vi.mock('@/hooks/use-admin-note', () => ({
  useSetAdminNote: () => ({ mutate: vi.fn(), isPending: false }),
}))

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_USER: UserProfileDto = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'junior@cheekycheese.dev',
  displayName: 'Junior Dev',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'JUNIOR',
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
}

const NO_ACTIONS_PERMS: ViewPermissions = {
  tabs: ['overview'],
  actions: [],
  fields: {},
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverviewTab — ToS acceptance marker', () => {
  it('AC-1: renders accepted date and version when tosAcceptedAt is set', () => {
    render(
      <OverviewTab
        user={BASE_USER}
        mode="view"
        permissions={NO_ACTIONS_PERMS}
        data={{
          overview: {
            techStack: null,
            adminNote: null,
            tosAcceptedAt: '2026-01-15T10:00:00.000Z',
            tosVersion: 1,
          },
        }}
      />,
    )

    // Card heading
    expect(screen.getByTestId('tos-acceptance-card')).toBeInTheDocument()
    // Accepted text contains the date (formatted ru-RU) and version
    const text = screen.getByTestId('tos-accepted-text').textContent ?? ''
    expect(text).toContain('15.01.2026')
    expect(text).toContain('v1')
  })

  it('AC-2: renders "Не принято" when tosAcceptedAt is null', () => {
    render(
      <OverviewTab
        user={BASE_USER}
        mode="view"
        permissions={NO_ACTIONS_PERMS}
        data={{
          overview: {
            techStack: null,
            adminNote: null,
            tosAcceptedAt: null,
            tosVersion: null,
          },
        }}
      />,
    )

    expect(screen.getByTestId('tos-acceptance-card')).toBeInTheDocument()
    expect(screen.getByTestId('tos-not-accepted-text')).toBeInTheDocument()
    expect(screen.queryByTestId('tos-accepted-text')).not.toBeInTheDocument()
  })

  it('AC-3: hides ToS card when tosAcceptedAt is absent (undefined)', () => {
    render(
      <OverviewTab
        user={BASE_USER}
        mode="view"
        permissions={NO_ACTIONS_PERMS}
        data={{
          overview: {
            techStack: null,
            adminNote: null,
            // tosAcceptedAt intentionally omitted → undefined → canSeeTos = false
          },
        }}
      />,
    )

    expect(screen.queryByTestId('tos-acceptance-card')).not.toBeInTheDocument()
  })
})
