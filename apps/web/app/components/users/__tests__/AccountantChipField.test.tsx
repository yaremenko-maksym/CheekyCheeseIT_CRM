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

  it('the clear button on a removable chip carries the "Прибрати бухгалтера" aria-label', async () => {
    // COPY-M-6 (fix-round B): "Очистити"/"Clear" implied the field itself
    // gets wiped; nothing is deleted here, only the selection — reworded to
    // "Прибрати"/"Remove", matching the HR chip's own "Прибрати {0}".
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
      'Прибрати бухгалтера',
    )
  })

  it('CR-M-1: the trigger button says "Обрати бухгалтера" with no selection, "Змінити" once one is chosen', async () => {
    // mutation-gate NoCoverage survivors: `selected ? t\`Змінити\` : t\`Обрати
    // бухгалтера\`` — neither branch was exercised by a test before this.
    await loadCatalog('uk')
    const a = {
      id: 'a-1',
      displayName: 'Ірина Бухгалтер',
      email: 'ira@example.com',
      avatarUrl: null,
    } as unknown as UserProfileDto
    const b = {
      id: 'a-2',
      displayName: 'Олег Бухгалтер',
      email: 'oleg@example.com',
      avatarUrl: null,
    } as unknown as UserProfileDto
    const { rerender } = render(
      <AccountantChipField
        accountantUsers={[a, b]}
        selectedId=""
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('user-dialog-accountant-trigger')).toHaveTextContent(
      'Обрати бухгалтера',
    )
    rerender(
      <AccountantChipField
        accountantUsers={[a, b]}
        selectedId="a-1"
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
    )
    expect(screen.getByTestId('user-dialog-accountant-trigger')).toHaveTextContent('Змінити')
  })

  it('CR-M-1: the add-dropdown search placeholder is localized', async () => {
    // mutation-gate NoCoverage survivor: `t\`Пошук за ім'ям або email…\`` on
    // the popover's CommandInput.
    await loadCatalog('uk')
    const user = (await import('@testing-library/user-event')).default.setup()
    const a = {
      id: 'a-1',
      displayName: 'Ірина Бухгалтер',
      email: 'ira@example.com',
      avatarUrl: null,
    } as unknown as UserProfileDto
    render(
      <AccountantChipField
        accountantUsers={[a]}
        selectedId=""
        onChange={vi.fn()}
        onlyAccountant={false}
      />,
      { wrapper: I18nTestProvider },
    )
    await user.click(screen.getByTestId('user-dialog-accountant-trigger'))
    expect(screen.getByPlaceholderText('Пошук за ім’ям або email…')).toBeInTheDocument()
  })
})
