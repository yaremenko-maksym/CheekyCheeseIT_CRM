/**
 * Characterization tests for `ContactsSection` (telegram + phone) after it moved
 * out of `UserDialog.tsx` verbatim. Pins labels, the onBlur validators and the
 * error-visibility gating (touched && dirty) through a real TanStack form.
 */
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ContactsSection } from '../ContactsSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const TELEGRAM_ERROR = 'Нік у Telegram: 5–32 символи — латиниця, цифри або _'
const PHONE_ERROR = 'Введіть номер у міжнародному форматі, напр. +380671234567'

function Harness({ telegram = '', phone = '' }: { telegram?: string; phone?: string }) {
  const form = useForm({ defaultValues: { telegram, phone } })
  return (
    <>
      <ContactsSection form={form} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
      <form.Subscribe selector={(s) => s.isFieldsValid}>
        {(valid) => <output data-testid="valid">{String(valid)}</output>}
      </form.Subscribe>
    </>
  )
}

// Telegram is the first textbox, the phone number input the second.
function inputs() {
  const [telegram, phone] = screen.getAllByRole('textbox') as HTMLInputElement[]
  return { telegram: telegram!, phone: phone! }
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ContactsSection', () => {
  it('renders the section title and both field labels', () => {
    render(<Harness />)
    expect(screen.getByText('Контакти')).toBeInTheDocument()
    expect(screen.getByText('Telegram')).toBeInTheDocument()
    expect(screen.getByText('Телефон')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('@username')).toBeInTheDocument()
  })

  it('writes telegram input changes into the form value', () => {
    render(<Harness />)
    fireEvent.change(inputs().telegram, { target: { value: '@valid_name' } })
    const values = JSON.parse(screen.getByTestId('values').textContent ?? '{}')
    expect(values.telegram).toBe('@valid_name')
  })

  it('shows no error for a valid telegram handle after blur', async () => {
    render(<Harness />)
    const { telegram } = inputs()
    fireEvent.change(telegram, { target: { value: '@valid_name' } })
    fireEvent.blur(telegram)
    await Promise.resolve()
    expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument()
    expect(telegram.className).not.toContain('border-destructive')
  })

  it('flags an invalid telegram handle only after it is dirty and blurred', async () => {
    render(<Harness />)
    const { telegram } = inputs()
    expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument()
    fireEvent.change(telegram, { target: { value: 'ab' } })
    fireEvent.blur(telegram)
    expect(await screen.findByText(TELEGRAM_ERROR)).toBeInTheDocument()
    expect(telegram.className).toContain('border-destructive')
  })

  it('does not validate a pristine empty telegram on blur', async () => {
    render(<Harness />)
    fireEvent.blur(inputs().telegram)
    await Promise.resolve()
    expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument()
  })

  it('skips phone validation for fewer than 5 digits', async () => {
    render(<Harness />)
    const { phone } = inputs()
    fireEvent.change(phone, { target: { value: '+3801' } })
    fireEvent.blur(phone)
    await Promise.resolve()
    expect(screen.queryByText(PHONE_ERROR)).not.toBeInTheDocument()
  })

  it('flags an invalid phone number after blur', async () => {
    render(<Harness />)
    const { phone } = inputs()
    fireEvent.change(phone, { target: { value: '+380123' } })
    fireEvent.blur(phone)
    await waitFor(() => expect(screen.getByText(PHONE_ERROR)).toBeInTheDocument())
  })

  it('accepts a valid phone number after blur', async () => {
    render(<Harness />)
    const { phone } = inputs()
    fireEvent.change(phone, { target: { value: '+380671234567' } })
    fireEvent.blur(phone)
    await Promise.resolve()
    expect(screen.queryByText(PHONE_ERROR)).not.toBeInTheDocument()
  })

  it('trims telegram before validating (surrounding spaces are accepted)', async () => {
    render(<Harness />)
    const { telegram } = inputs()
    fireEvent.change(telegram, { target: { value: '  @valid_name  ' } })
    fireEvent.blur(telegram)
    await Promise.resolve()
    expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument()
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })

  it('treats a whitespace-only telegram as empty (no error)', async () => {
    render(<Harness />)
    const { telegram } = inputs()
    fireEvent.change(telegram, { target: { value: '   ' } })
    fireEvent.blur(telegram)
    await Promise.resolve()
    expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument()
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })

  it('clearing a dirty telegram removes the error (empty is valid)', async () => {
    render(<Harness />)
    const { telegram } = inputs()
    fireEvent.change(telegram, { target: { value: 'ab' } })
    fireEvent.blur(telegram)
    expect(await screen.findByText(TELEGRAM_ERROR)).toBeInTheDocument()
    fireEvent.change(telegram, { target: { value: '' } })
    fireEvent.blur(telegram)
    await waitFor(() => expect(screen.queryByText(TELEGRAM_ERROR)).not.toBeInTheDocument())
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })

  it('does not run the telegram validator on a pristine prefilled value', async () => {
    render(<Harness telegram="ab" />)
    fireEvent.blur(inputs().telegram)
    await Promise.resolve()
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })

  it('validates a phone number of exactly 5 digits (lower bound is exclusive of <5)', async () => {
    render(<Harness />)
    const { phone } = inputs()
    fireEvent.change(phone, { target: { value: '+38012' } })
    fireEvent.blur(phone)
    await waitFor(() => expect(screen.getByText(PHONE_ERROR)).toBeInTheDocument())
  })

  it('does not run the phone validator on a pristine prefilled value', async () => {
    render(<Harness phone="+38012" />)
    fireEvent.blur(inputs().phone)
    await Promise.resolve()
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })
})
