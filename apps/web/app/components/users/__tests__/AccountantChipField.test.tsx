/**
 * task-i18n-stage3b (Task 2 / PR2). `AccountantChipField` previously had NO
 * dedicated test file — mutation-gate round confirmed this by surviving the
 * empty-state `<Field label={t\`Бухгалтер\`}>` StringLiteral mutant. Minimal
 * coverage for the empty-accountants branch (mirrors HrChipsField's own
 * empty-HR branch).
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { AccountantChipField } from '../AccountantChipField'

describe('AccountantChipField', () => {
  it('renders the "Бухгалтер" field label AND the empty-state hint when there are no accountants', async () => {
    await loadCatalog('uk')
    render(
      <AccountantChipField
        accountantUsers={[]}
        selectedId=""
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByText('Бухгалтер')).toBeInTheDocument()
    expect(screen.getByText('Бухгалтерів ще немає — спершу додайте бухгалтера')).toBeInTheDocument()
  })

  it('renders the selected accountant chip when one is chosen, under the "Бухгалтер" field label', async () => {
    await loadCatalog('uk')
    const accountant = {
      id: 'a-1',
      displayName: 'Ірина Бухгалтер',
      email: 'ira@example.com',
      avatarUrl: null,
    } as unknown as UserProfileDto
    render(
      <AccountantChipField
        accountantUsers={[accountant]}
        selectedId="a-1"
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('user-dialog-accountant-chip')).toHaveTextContent('Ірина Бухгалтер')
    // mutation-gate survivor: the populated-state `<Field label={t\`Бухгалтер\`}>`
    // StringLiteral (distinct from the empty-state label asserted above).
    expect(screen.getByText('Бухгалтер')).toBeInTheDocument()
  })

  it('the clear button on a removable chip carries the "Очистити бухгалтера" aria-label', async () => {
    await loadCatalog('uk')
    const accountant = {
      id: 'a-1',
      displayName: 'Ірина Бухгалтер',
      email: 'ira@example.com',
      avatarUrl: null,
    } as unknown as UserProfileDto
    render(
      <AccountantChipField
        accountantUsers={[accountant]}
        selectedId="a-1"
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('user-dialog-accountant-clear')).toHaveAttribute(
      'aria-label',
      'Очистити бухгалтера',
    )
  })
})
