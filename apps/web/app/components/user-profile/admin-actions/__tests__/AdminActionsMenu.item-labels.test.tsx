/**
 * AdminActionsMenu.item-labels.test.tsx — task-i18n-stage3b (Task 1),
 * mutation-gate coverage. "Нотатка адміністратора" (`set-note`) and
 * "Архівувати" (`archive`) had zero unit assertion pinning their resolved
 * text — E2E (`admin-actions.spec.ts`) covers them, but the mutation gate
 * cannot see Playwright specs (only Vitest).
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

import { AdminActionsMenu } from '../AdminActionsMenu'

const BASE_USER = {
  id: 'u-1',
  email: 'u1@example.com',
  displayName: 'Oleksiy Kovalenko',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'SENIOR',
  telegram: null,
  phone: null,
  techStack: [],
  paymentMethod: 'USDT_ERC20',
  walletUsdtErc20: null,
  walletUsdtLabel: null,
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  seniorSharePercent: 26,
  dropSharePercent: null,
  legalFullName: null,
  registrationAddress: null,
  monthlySalary: null,
  salaryCurrency: 'USD',
  archivedAt: null,
  adminNote: null,
  createdAt: new Date(),
  personalEmail: null,
  personalContactVisible: false,
  personalEmailCanLogin: null,
} as unknown as UserProfileDto

function renderMenu(actions: ActionKey[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <AdminActionsMenu userId={BASE_USER.id} user={BASE_USER} actions={actions} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('AdminActionsMenu — set-note / archive item text', () => {
  it('shows "Нотатка адміністратора" for the set-note action', async () => {
    renderMenu(['set-note'])
    const user = userEvent.setup()
    await user.click(screen.getByTestId('admin-actions-trigger'))
    expect(screen.getByRole('menuitem', { name: 'Нотатка адміністратора' })).toBeInTheDocument()
  })

  it('shows "Архівувати" for the archive action (not-yet-archived user)', async () => {
    renderMenu(['archive'])
    const user = userEvent.setup()
    await user.click(screen.getByTestId('admin-actions-trigger'))
    expect(screen.getByRole('menuitem', { name: 'Архівувати' })).toBeInTheDocument()
  })
})
