/**
 * The resume header editor: profile values are the defaults, an override is saved only while it
 * differs from the profile, and the shared checks gate the save.
 */
import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ComponentProps, ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_HEADER } from '@crm/shared'
import { translateZodCode } from '@/lib/axios-utils'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeHeaderPanel } from '../ResumeHeaderPanel'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

const DEFAULTS = {
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+380671234567',
  telegram: 'jane_doe',
}

function setup(props: Partial<ComponentProps<typeof ResumeHeaderPanel>> = {}) {
  const onSave = vi.fn()
  render(
    <ResumeHeaderPanel
      header={EMPTY_RESUME_HEADER}
      defaults={DEFAULTS}
      disabled={false}
      isSaving={false}
      staged={false}
      onSave={onSave}
      {...props}
    />,
  )
  const field = (key: string) => screen.getByTestId(`resume-header-${key}`) as HTMLInputElement
  const save = screen.getByTestId('resume-header-save')
  return { onSave, field, save }
}

describe('ResumeHeaderPanel', () => {
  it('prefills the profile values, the handle with its @, and has nothing to save', () => {
    const { field, save } = setup()
    expect(field('displayName').value).toBe('Jane Doe')
    expect(field('telegram').value).toBe('@jane_doe')
    expect(save).toBeDisabled()
  })

  it('saves only the changed field; the rest stay null and follow the profile', () => {
    const { field, save, onSave } = setup()
    fireEvent.change(field('phone'), { target: { value: '+48 600 000 000' } })
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({ ...EMPTY_RESUME_HEADER, phone: '+48 600 000 000' })
  })

  it.each([
    ['displayName', 'Jane', 'RESUME_HEADER_NAME_FORMAT'],
    ['displayName', 'Іван Петренко', 'RESUME_HEADER_NAME_LATIN'],
    ['email', 'jane@', 'EMAIL_INVALID'],
    ['phone', '0671234567', 'PHONE_INVALID'],
    ['telegram', 'jane_doe2', 'RESUME_HEADER_TELEGRAM_FORMAT'],
  ] as const)('a malformed %s blocks the save and says why', (key, value, code) => {
    const { field, save, onSave } = setup()
    fireEvent.change(field(key), { target: { value } })
    expect(field(key)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(translateZodCode(code))).toBeInTheDocument()
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('the name check says it in the catalog text', () => {
    const { field } = setup()
    fireEvent.change(field('displayName'), { target: { value: 'Jane' } })
    expect(screen.getByText('Введіть ім’я та прізвище, напр. Ivan Petrenko')).toBeInTheDocument()
  })

  it('an override shows the profile value, and the reset puts it back as null', () => {
    const { field, save, onSave } = setup({
      header: { ...EMPTY_RESUME_HEADER, displayName: 'Jana Doe' },
    })
    expect(field('displayName').value).toBe('Jana Doe')
    expect(screen.getByText('У профілі: Jane Doe')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('resume-header-displayName-reset'))
    expect(field('displayName').value).toBe('Jane Doe')
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith(EMPTY_RESUME_HEADER)
  })

  it('an emptied field follows the profile again', () => {
    const { field, save, onSave } = setup({
      header: { ...EMPTY_RESUME_HEADER, email: 'cv@example.com' },
    })
    fireEvent.change(field('email'), { target: { value: '  ' } })
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith(EMPTY_RESUME_HEADER)
  })

  it('locks every input while a check runs, and warns before discarding a staged result', () => {
    const { field } = setup({ disabled: true })
    expect(field('email')).toBeDisabled()
    expect(screen.queryByTestId('resume-header-discards-staged')).toBeNull()
  })

  it('warns that a header change discards the staged result', () => {
    setup({ staged: true })
    expect(screen.getByTestId('resume-header-discards-staged')).toBeInTheDocument()
  })

  it('labels, types and placeholders: each input is named by its label and described by its hint', () => {
    setup()
    const rows = [
      ['Ім’я та прізвище', 'text', 'Ivan Petrenko'],
      ['Email', 'email', 'name@example.com'],
      ['Телефон', 'tel', '+380 67 123 45 67'],
      ['Telegram', 'text', '@username'],
    ] as const
    for (const [label, type, placeholder] of rows) {
      const input = screen.getByLabelText(label)
      expect(input).toHaveAttribute('type', type)
      expect(input).toHaveAttribute('placeholder', placeholder)
      expect(input).toHaveAttribute('aria-invalid', 'false')
      expect(input).toHaveAccessibleDescription('З профілю CRM')
    }
    expect(screen.getAllByText('З профілю CRM')[0]).toHaveClass('text-muted-foreground')
    // A field that follows the profile has nothing to reset.
    expect(screen.queryByRole('button', { name: 'Повернути значення з профілю' })).toBeNull()
  })

  it('prefills each profile value trimmed; a missing one is empty, a handle with @ keeps one @', () => {
    const { field } = setup({
      defaults: {
        displayName: '  Jane Doe  ',
        email: 'jane@example.com',
        phone: null,
        telegram: '@jane',
      },
    })
    expect(field('displayName').value).toBe('Jane Doe')
    expect(field('email').value).toBe('jane@example.com')
    expect(field('phone').value).toBe('')
    expect(field('telegram').value).toBe('@jane')
  })

  it('a missing profile handle prefills an empty Telegram field, not a bare @', () => {
    const { field } = setup({ defaults: { ...DEFAULTS, telegram: null } })
    expect(field('telegram').value).toBe('')
    expect(field('phone').value).toBe('+380671234567')
  })

  it('saves a typed value trimmed', () => {
    const { field, save, onSave } = setup()
    fireEvent.change(field('phone'), { target: { value: '  +48 600 000 000  ' } })
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({ ...EMPTY_RESUME_HEADER, phone: '+48 600 000 000' })
  })

  it('an override over a missing profile value says the profile has none', () => {
    setup({
      defaults: { ...DEFAULTS, phone: null },
      header: { ...EMPTY_RESUME_HEADER, phone: '+48 600 000 000' },
    })
    expect(screen.getByText('У профілі не вказано')).toBeInTheDocument()
    const reset = screen.getByRole('button', { name: 'Повернути значення з профілю' })
    expect(reset).toHaveAttribute('title', 'Повернути значення з профілю')
  })

  it('an error hint is styled as an error', () => {
    const { field } = setup()
    fireEvent.change(field('email'), { target: { value: 'jane@' } })
    expect(screen.getByText(translateZodCode('EMAIL_INVALID'))).toHaveClass('text-destructive')
  })

  describe('submitting the form (Enter) saves only a valid change while nothing runs', () => {
    // A submit event from a field bubbles to its form, as Enter in that field does.
    const submit = () => fireEvent.submit(screen.getByTestId('resume-header-displayName'))

    it('nothing changed: no save', () => {
      const { onSave } = setup()
      submit()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('a malformed change: no save', () => {
      const { field, onSave } = setup()
      fireEvent.change(field('email'), { target: { value: 'jane@' } })
      submit()
      expect(onSave).not.toHaveBeenCalled()
    })

    it.each([
      ['a check runs', { disabled: true }],
      ['a save runs', { isSaving: true }],
    ])('%s: no save', (_label, props) => {
      const { field, onSave } = setup(props)
      fireEvent.change(field('phone'), { target: { value: '+48 600 000 000' } })
      submit()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('a valid change saves', () => {
      const { field, onSave } = setup()
      fireEvent.change(field('phone'), { target: { value: '+48 600 000 000' } })
      submit()
      expect(onSave).toHaveBeenCalledTimes(1)
    })
  })

  it('no staged result, no warning', () => {
    setup()
    expect(screen.queryByTestId('resume-header-discards-staged')).toBeNull()
  })
})
