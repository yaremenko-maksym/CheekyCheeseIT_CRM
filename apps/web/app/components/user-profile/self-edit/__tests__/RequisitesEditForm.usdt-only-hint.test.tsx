/**
 * RequisitesEditForm.usdt-only-hint.test.tsx — task-i18n-stage3b (Task 1),
 * mutation-gate coverage.
 *
 * No unit test existed for this component at all before this PR (E2E-only,
 * `requisites-warning.spec.ts`). `USDT_ONLY_HINT` feeds the disabled
 * BANK_UAH_FOP tab's `title` attribute (`AnimatedTabs` renders
 * `disabledTooltip` as a native `title`, no hover interaction needed) for a
 * SENIOR/ADMIN — this reaches it without needing Radix's async Tooltip
 * portal for the standalone `TooltipContent` copy of the same string.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import type { UserProfileDto } from '@crm/shared'

vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMeRequisites: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { RequisitesEditForm } from '../RequisitesEditForm'

function makeUser(role: UserProfileDto['role']): UserProfileDto {
  return {
    id: 'u1',
    displayName: 'Test User',
    role,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, only the fields RequisitesEditForm reads are populated
  } as any
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('RequisitesEditForm — USDT_ONLY_HINT on the disabled Bank tab', () => {
  it('SENIOR: the disabled Bank UAH tab carries the exact hint as its title', () => {
    render(<RequisitesEditForm user={makeUser('SENIOR')} />, { wrapper: I18nTestProvider })
    const bankTab = screen.getByLabelText('ФОП (UAH)')
    expect(bankTab).toHaveAttribute(
      'title',
      'Ви отримуєте виплати лише в USDT (мережа Ethereum) — змінити спосіб не можна',
    )
  })

  it('JUNIOR: the Bank UAH tab is enabled and carries no title', () => {
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    const bankTab = screen.getByLabelText('ФОП (UAH)')
    expect(bankTab).not.toHaveAttribute('title')
  })
})
