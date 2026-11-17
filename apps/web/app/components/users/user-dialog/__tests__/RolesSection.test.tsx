import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SENIOR_SELECTABLE_ROLES, type SeniorSelectableRole } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { RolesSection } from '../RolesSection'

/** A controlled host: the section is stateless, the caller owns the value. */
function Host({
  initial = [],
  onChange,
  ...rest
}: {
  initial?: SeniorSelectableRole[]
  onChange?: (next: SeniorSelectableRole[]) => void
  error?: string
  announce?: 'alert' | 'status'
  disabled?: boolean
}) {
  const [value, setValue] = useState<SeniorSelectableRole[]>(initial)
  return (
    <RolesSection
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      {...rest}
    />
  )
}

async function setup(props: Parameters<typeof Host>[0] = {}) {
  await loadCatalog('uk')
  const user = userEvent.setup()
  render(<Host {...props} />, { wrapper: I18nTestProvider })
  return user
}

const options = () => screen.queryAllByTestId(/^roles-section-option-/)

describe('RolesSection', () => {
  it('renders 33 options in their groups, never SOFTWARE_ENGINEER', async () => {
    const user = await setup()
    await user.click(screen.getByTestId('roles-section-add-trigger'))
    expect(options()).toHaveLength(33)
    expect(screen.queryByTestId('roles-section-option-SOFTWARE_ENGINEER')).toBeNull()
    // The group headings are the translated group labels, in TECHNICAL_ROLE_GROUPS order.
    expect(screen.getByText('Розробка ПЗ')).toBeInTheDocument()
    expect(screen.getByText('Мобільна розробка')).toBeInTheDocument()
    expect(screen.getByText('Дані та ШІ')).toBeInTheDocument()
    expect(screen.getByTestId('roles-section-option-BACKEND_ENGINEER')).toHaveTextContent(
      'Бекенд-розробник',
    )
  })

  it('shows the empty hint and the plain label when nothing is selected', async () => {
    await setup()
    expect(screen.getByText('Технічні ролі не обрано')).toBeInTheDocument()
    expect(screen.getByText('Технічні ролі')).toBeInTheDocument()
  })

  it('labels the group and counts the selection', async () => {
    await setup({ initial: ['BACKEND_ENGINEER', 'QA_ENGINEER'] })
    const group = screen.getByRole('group', { name: /Технічні ролі \(обрано: 2\)/ })
    expect(group).toHaveAttribute('data-testid', 'roles-section')
    expect(screen.queryByText('Технічні ролі не обрано')).toBeNull()
  })

  it('a pick adds the role in canonical order, leaves the popover open and lists it no more', async () => {
    const onChange = vi.fn()
    const user = await setup({ initial: ['QA_ENGINEER'], onChange })
    await user.click(screen.getByTestId('roles-section-add-trigger'))
    expect(screen.queryByTestId('roles-section-option-QA_ENGINEER')).toBeNull()
    await user.click(screen.getByTestId('roles-section-option-BACKEND_ENGINEER'))
    expect(onChange).toHaveBeenLastCalledWith(['BACKEND_ENGINEER', 'QA_ENGINEER'])
    expect(options()).toHaveLength(31)
    expect(screen.queryByTestId('roles-section-option-BACKEND_ENGINEER')).toBeNull()
    expect(screen.getByTestId('roles-section-chip-BACKEND_ENGINEER')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Додано: Бекенд-розробник')
  })

  it('after a keyboard pick the highlight moves to the row that took its place', async () => {
    const user = await setup()
    await user.click(screen.getByTestId('roles-section-add-trigger'))
    // The first row is highlighted on open; Enter picks it.
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('roles-section-chip-BACKEND_ENGINEER')).toBeInTheDocument()
    expect(screen.getByTestId('roles-section-option-FRONTEND_ENGINEER')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('roles-section-chip-FRONTEND_ENGINEER')).toBeInTheDocument()
  })

  it('search matches the group name', async () => {
    const user = await setup()
    await user.click(screen.getByTestId('roles-section-add-trigger'))
    await user.type(screen.getByPlaceholderText('Пошук ролі…'), 'Мобільна')
    expect(options().map((o) => o.dataset['testid'])).toEqual([
      'roles-section-option-IOS_ENGINEER',
      'roles-section-option-ANDROID_ENGINEER',
      'roles-section-option-CROSS_PLATFORM_MOBILE_ENGINEER',
    ])
  })

  it('a remove drops the role, announces it and moves focus to the next remove button', async () => {
    const onChange = vi.fn()
    const user = await setup({
      initial: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'QA_ENGINEER'],
      onChange,
    })
    await user.click(screen.getByRole('button', { name: 'Прибрати роль Фронтенд-розробник' }))
    expect(onChange).toHaveBeenLastCalledWith(['BACKEND_ENGINEER', 'QA_ENGINEER'])
    expect(screen.getByTestId('roles-section-remove-QA_ENGINEER')).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Прибрано: Фронтенд-розробник')
  })

  it('removing the last chip moves focus to the previous one, then to the trigger', async () => {
    const user = await setup({ initial: ['BACKEND_ENGINEER', 'QA_ENGINEER'] })
    await user.click(screen.getByTestId('roles-section-remove-QA_ENGINEER'))
    expect(screen.getByTestId('roles-section-remove-BACKEND_ENGINEER')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('roles-section-add-trigger')).toHaveFocus()
    expect(screen.getByText('Технічні ролі не обрано')).toBeInTheDocument()
  })

  it('an error is an alert by default and wires the trigger to it', async () => {
    await setup({ error: 'Сеньйору потрібна щонайменше одна технічна роль' })
    const err = screen.getByTestId('roles-section-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err).toHaveTextContent('Сеньйору потрібна щонайменше одна технічна роль')
    const trigger = screen.getByTestId('roles-section-add-trigger')
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(trigger).toHaveAttribute('aria-describedby', err.id)
  })

  it('announce="status" makes the error polite', async () => {
    await setup({ error: 'x', announce: 'status' })
    expect(screen.getByTestId('roles-section-error')).toHaveAttribute('role', 'status')
  })

  it('no error: no message and the trigger is not invalid', async () => {
    await setup()
    expect(screen.queryByTestId('roles-section-error')).toBeNull()
    const trigger = screen.getByTestId('roles-section-add-trigger')
    expect(trigger).not.toHaveAttribute('aria-invalid')
    expect(trigger).not.toHaveAttribute('aria-describedby')
  })

  it('hides the trigger when every role is selected', async () => {
    await setup({ initial: [...SENIOR_SELECTABLE_ROLES] })
    expect(screen.queryByTestId('roles-section-add-trigger')).toBeNull()
    expect(screen.getAllByTestId(/^roles-section-remove-/)).toHaveLength(33)
  })

  it('disabled: the trigger and the remove buttons are disabled', async () => {
    await setup({ initial: ['BACKEND_ENGINEER'], disabled: true })
    expect(screen.getByTestId('roles-section-add-trigger')).toBeDisabled()
    const chip = screen.getByTestId('roles-section-chip-BACKEND_ENGINEER')
    expect(within(chip).getByRole('button')).toBeDisabled()
  })
})
