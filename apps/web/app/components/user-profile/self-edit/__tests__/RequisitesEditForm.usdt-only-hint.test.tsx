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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    // `getByLabelText` above resolves via the tab's `aria-label` attribute —
    // it does NOT exercise the separate `label` field (the tab's own VISIBLE
    // text) that this same object literal carries (mutation-gate Fix-round
    // B: `label: t\`ФОП (UAH)\`` -> `t\`\`` survived against exactly this
    // test file before this assertion existed).
    expect(bankTab).toHaveTextContent('ФОП (UAH)')
  })

  it('JUNIOR: the Bank UAH tab is enabled and carries no title', () => {
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    const bankTab = screen.getByLabelText('ФОП (UAH)')
    expect(bankTab).not.toHaveAttribute('title')
  })
})

// mutation-gate (@crm/web, Fix-round B, CI-MUT) — the USDT tab's own
// value/label/ariaLabel object, the form's own aria-label, and the wallet
// label input's placeholder had zero unit assertion (the test above only
// exercises the SECOND ("ФОП (UAH)") tab option).
describe('RequisitesEditForm — USDT tab + form-level text', () => {
  it('renders the USDT (ERC-20) tab with its own label/ariaLabel (hardcoded, not catalog — see requisites-warning.spec.ts comment)', () => {
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    const usdtTab = screen.getByLabelText('USDT (ERC-20)')
    expect(usdtTab).toBeInTheDocument()
    // mutation-gate (@crm/web, Fix-round B round 2, CI-MUT): `label: 'USDT
    // (ERC-20)'` -> `label: ""` survived against `getByLabelText` above —
    // for THIS tab, `label` and `ariaLabel` happen to be the identical
    // string, so `getByLabelText` (which resolves via `aria-label`) cannot
    // tell whether the separate VISIBLE `label` field was actually emptied.
    expect(usdtTab).toHaveTextContent('USDT (ERC-20)')
  })

  it('the USDT tab carries its own `value` (not just a label) — switching away and back still lands on the USDT fields, not a value that matches no tab', async () => {
    // mutation-gate (@crm/web, Fix-round B round 2, CI-MUT): `value:
    // 'USDT_ERC20'` -> `value: ""` survived — `value` is purely internal
    // (drives which fields `method === 'USDT_ERC20'` renders), invisible to
    // every label/ariaLabel-based query above.
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    expect(screen.getByLabelText('Гаманець USDT (ERC-20)')).toBeInTheDocument()

    // `AnimatePresence mode="wait"` keeps the outgoing card in the DOM for
    // its own exit transition — the removal is not synchronous with the click.
    fireEvent.click(screen.getByLabelText('ФОП (UAH)'))
    await waitFor(() =>
      expect(screen.queryByLabelText('Гаманець USDT (ERC-20)')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByLabelText('USDT (ERC-20)'))
    await waitFor(() => expect(screen.getByLabelText('Гаманець USDT (ERC-20)')).toBeInTheDocument())
  })

  it('the form itself carries the "Спосіб виплати" aria-label', () => {
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    expect(screen.getByRole('form', { name: 'Спосіб виплати' })).toBeInTheDocument()
  })

  it('the wallet label input carries the "наприклад: основний" placeholder', () => {
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    expect(screen.getByPlaceholderText('наприклад: основний')).toBeInTheDocument()
  })

  it('the Bank UAH fields carry their own example placeholders (recipient name + bank name)', async () => {
    // mutation-gate (@crm/web, Fix-round B round 2, CI-MUT): both
    // `t\`Іваненко Іван Іванович\`` and `t\`ПриватБанк\`` -> `t\`\`` survived —
    // no test switched to the Bank UAH tab at all before this one.
    render(<RequisitesEditForm user={makeUser('JUNIOR')} />, { wrapper: I18nTestProvider })
    fireEvent.click(screen.getByLabelText('ФОП (UAH)'))
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Іваненко Іван Іванович')).toBeInTheDocument(),
    )
    expect(screen.getByPlaceholderText('ПриватБанк')).toBeInTheDocument()
  })
})
