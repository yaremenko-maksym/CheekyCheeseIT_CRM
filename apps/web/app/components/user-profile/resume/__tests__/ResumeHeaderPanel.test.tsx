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
    expect(screen.getByText('Ім’я та прізвище — щонайменше два слова')).toBeInTheDocument()
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
})
