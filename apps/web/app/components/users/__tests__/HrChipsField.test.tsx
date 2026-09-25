/**
 * task-i18n-stage3b (Task 2 / PR2). `HrChipsField` previously had NO
 * dedicated test file — mutation-gate round confirmed this by surviving the
 * `selected`/`available` useMemo derivations (ArrowFunction/MethodExpression
 * mutants): UserDialog's own suite never exercises 2+ HR users at once, so
 * the actual `.map/.find/.filter` logic that turns `selectedIds` into chip
 * objects and the remainder into the "Add HR" dropdown was never directly
 * observed by a test.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { HrChipsField } from '../HrChipsField'

function hr(id: string, displayName: string): UserProfileDto {
  return {
    id,
    displayName,
    email: `${id}@example.com`,
    avatarUrl: null,
  } as unknown as UserProfileDto
}

const HR_A = hr('hr-a', 'Алла HR')
const HR_B = hr('hr-b', 'Богдан HR')
const HR_C = hr('hr-c', 'Віра HR')

describe('HrChipsField', () => {
  it('renders the empty-state hint when there are no HR users', async () => {
    await loadCatalog('uk')
    render(
      <HrChipsField
        hrUsers={[]}
        selectedIds={[]}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByText('HR ще немає — спершу додайте HR')).toBeInTheDocument()
  })

  it('`selected` resolves selectedIds to the matching HR objects (real .map/.find), skipping stale ids', async () => {
    await loadCatalog('uk')
    render(
      <HrChipsField
        hrUsers={[HR_A, HR_B, HR_C]}
        // 'hr-ghost' has no matching entry in hrUsers — the `.filter((u):
        // u is UserProfileDto => !!u)` step must drop it, not crash.
        selectedIds={['hr-a', 'hr-ghost', 'hr-c']}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('user-dialog-hr-chip-hr-a')).toHaveTextContent('Алла HR')
    expect(screen.getByTestId('user-dialog-hr-chip-hr-c')).toHaveTextContent('Віра HR')
    expect(screen.queryByTestId('user-dialog-hr-chip-hr-b')).not.toBeInTheDocument()
  })

  it('`available` excludes already-selected HR from the add-dropdown options (real .filter)', async () => {
    await loadCatalog('uk')
    const user = (await import('@testing-library/user-event')).default.setup()
    render(
      <HrChipsField
        hrUsers={[HR_A, HR_B, HR_C]}
        selectedIds={['hr-a']}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
      { wrapper: I18nTestProvider },
    )
    await user.click(screen.getByTestId('user-dialog-hr-add-trigger'))
    expect(screen.getByTestId('user-dialog-hr-option-hr-b')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-hr-option-hr-c')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-hr-option-hr-a')).not.toBeInTheDocument()
  })

  it('the field label shows "HR" with no selection, and "HR (обрано: N)" once N are selected', async () => {
    await loadCatalog('uk')
    const { rerender } = render(
      <HrChipsField
        hrUsers={[HR_A, HR_B]}
        selectedIds={[]}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByText('HR', { selector: 'label, span, div' })).toBeInTheDocument()
    rerender(
      <HrChipsField
        hrUsers={[HR_A, HR_B]}
        selectedIds={['hr-a']}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
    )
    expect(screen.getByText('HR (обрано: 1)')).toBeInTheDocument()
  })

  it('the add-dropdown search placeholder and the "nothing found" empty state are localized', async () => {
    await loadCatalog('uk')
    const user = (await import('@testing-library/user-event')).default.setup()
    render(
      <HrChipsField
        hrUsers={[HR_A, HR_B]}
        selectedIds={[]}
        onChange={vi.fn()}
        required={false}
        onlyHr={false}
      />,
      { wrapper: I18nTestProvider },
    )
    await user.click(screen.getByTestId('user-dialog-hr-add-trigger'))
    const input = screen.getByPlaceholderText('Пошук за ім’ям або email…')
    expect(input).toBeInTheDocument()
    await user.type(input, 'zzz-no-such-name')
    expect(await screen.findByText('Нічого не знайдено')).toBeInTheDocument()
  })
})
