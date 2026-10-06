/**
 * Characterization tests for `ContractDataSection` (legalFullName +
 * registrationAddress) after it moved out of `UserDialog.tsx` verbatim. Pins the
 * ADMIN gate, labels, the onBlur validator, the create-only onSubmit "required
 * for contract" rule and the error-visibility gating through a real TanStack form.
 */
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ContractDataSection } from '../ContractDataSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

let submit: (() => Promise<void>) | undefined

function Harness({
  role = 'SENIOR',
  isCreate = true,
  legalFullName = '',
  registrationAddress = '',
}: {
  role?: string
  isCreate?: boolean
  legalFullName?: string
  registrationAddress?: string
}) {
  const form = useForm({ defaultValues: { role, legalFullName, registrationAddress } })
  submit = () => form.handleSubmit()
  return (
    <>
      <ContractDataSection form={form} isCreate={isCreate} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
      <form.Subscribe selector={(s) => s.isFieldsValid}>
        {(valid) => <output data-testid="valid">{String(valid)}</output>}
      </form.Subscribe>
    </>
  )
}

const legal = () => screen.getByTestId('user-dialog-legal-full-name') as HTMLInputElement
const address = () => screen.getByTestId('user-dialog-registration-address') as HTMLInputElement
const values = () => JSON.parse(screen.getByTestId('values').textContent ?? '{}')

async function submitForm() {
  await act(async () => {
    await submit?.()
  })
}

beforeEach(async () => {
  submit = undefined
  await loadCatalog('uk')
})

describe('ContractDataSection', () => {
  it('renders title, labels, hints and placeholders for a non-ADMIN role', () => {
    render(<Harness />)
    expect(screen.getByText('Дані для контракту')).toBeInTheDocument()
    expect(screen.getByText('Юридичне ПІБ')).toBeInTheDocument()
    expect(screen.getByText('Адреса реєстрації (ФОП)')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Ця адреса підставляється в текст контракту')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Іваненко Іван Іванович')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('м. Київ, вул. Хрещатик, 1')).toBeInTheDocument()
    expect(legal().getAttribute('autocapitalize')).toBe('words')
    expect(legal().getAttribute('autocomplete')).toBe('off')
  })

  it('renders nothing for the ADMIN role', () => {
    render(<Harness role="ADMIN" />)
    expect(screen.queryByText('Дані для контракту')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-legal-full-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-registration-address')).not.toBeInTheDocument()
  })

  it('writes both inputs into the form values', () => {
    render(<Harness />)
    fireEvent.change(legal(), { target: { value: 'Іваненко Іван Іванович' } })
    fireEvent.change(address(), { target: { value: 'м. Київ' } })
    expect(values().legalFullName).toBe('Іваненко Іван Іванович')
    expect(values().registrationAddress).toBe('м. Київ')
  })

  it('flags a too-short legal name only after it is dirty and blurred', async () => {
    render(<Harness />)
    expect(legal().getAttribute('aria-invalid')).toBeNull()
    fireEvent.change(legal(), { target: { value: 'abc' } })
    fireEvent.blur(legal())
    await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBe('true'))
    expect(legal().className).toContain('border-destructive')
  })

  it('accepts a legal name of exactly 5 characters', async () => {
    render(<Harness />)
    fireEvent.change(legal(), { target: { value: 'abcde' } })
    fireEvent.blur(legal())
    await Promise.resolve()
    expect(legal().getAttribute('aria-invalid')).toBeNull()
  })

  it('trims before validating (padding does not make a short name valid)', async () => {
    render(<Harness />)
    fireEvent.change(legal(), { target: { value: '  abc  ' } })
    fireEvent.blur(legal())
    await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBe('true'))
  })

  it('treats whitespace-only as empty on blur (no error)', async () => {
    render(<Harness />)
    fireEvent.change(legal(), { target: { value: '     ' } })
    fireEvent.blur(legal())
    await Promise.resolve()
    expect(legal().getAttribute('aria-invalid')).toBeNull()
  })

  it('does not validate a pristine prefilled short value on blur', async () => {
    render(<Harness legalFullName="abc" />)
    fireEvent.blur(legal())
    await Promise.resolve()
    expect(legal().getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByTestId('valid').textContent).toBe('true')
  })

  it('clearing a dirty invalid legal name removes the error', async () => {
    render(<Harness />)
    fireEvent.change(legal(), { target: { value: 'abc' } })
    fireEvent.blur(legal())
    await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBe('true'))
    fireEvent.change(legal(), { target: { value: '' } })
    fireEvent.blur(legal())
    await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBeNull())
  })

  it.each(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT', 'DROP'])(
    'on submit with an empty legal name, role %s is required in create mode',
    async (role) => {
      render(<Harness role={role} isCreate />)
      await submitForm()
      await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBe('true'))
    },
  )

  it('on submit with an empty legal name, edit mode shows no required error', async () => {
    render(<Harness role="SENIOR" isCreate={false} />)
    await submitForm()
    expect(legal().getAttribute('aria-invalid')).toBeNull()
  })

  it('on submit with a whitespace-only legal name, create mode still requires it', async () => {
    render(<Harness role="SENIOR" isCreate legalFullName="   " />)
    await submitForm()
    await waitFor(() => expect(legal().getAttribute('aria-invalid')).toBe('true'))
  })

  it('on submit with a filled legal name, no required error appears', async () => {
    render(<Harness role="SENIOR" isCreate legalFullName="Іваненко Іван Іванович" />)
    await submitForm()
    expect(legal().getAttribute('aria-invalid')).toBeNull()
  })

  it('registrationAddress has no validation and no error styling', async () => {
    render(<Harness />)
    fireEvent.change(address(), { target: { value: 'x' } })
    fireEvent.blur(address())
    await Promise.resolve()
    expect(address().getAttribute('aria-invalid')).toBeNull()
    expect(values().registrationAddress).toBe('x')
  })
})
