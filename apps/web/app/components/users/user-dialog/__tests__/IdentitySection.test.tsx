/**
 * Characterization tests for `IdentitySection` (email, personal email, name, role,
 * locale) after it moved out of `UserDialog.tsx` verbatim. SECURITY-SENSITIVE: the
 * role field encodes RBAC — create omits ADMIN (ut-12), self-ADMIN edit locks the
 * role Select (ut-11). Expected values are literals, not derived from the code.
 */
import { render as rtlRender, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { IdentitySection } from '../IdentitySection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

interface HarnessProps {
  isCreate?: boolean
  isEdit?: boolean
  hasEditingUser?: boolean
  hrOnly?: boolean
  isSelfAdminEdit?: boolean
  originalEmail?: string
  email?: string
  role?: string
  onEmailChangeIntent?: (email: string) => void
}

function Harness({
  isCreate = false,
  isEdit = !isCreate,
  hasEditingUser = isEdit,
  hrOnly = false,
  isSelfAdminEdit = false,
  originalEmail = 'old@example.com',
  email = 'old@example.com',
  role = 'SENIOR',
  onEmailChangeIntent = () => {},
}: HarnessProps) {
  const form = useForm({
    defaultValues: { email, personalEmail: '', displayName: '', role, locale: 'uk' },
  })
  return (
    <>
      <IdentitySection
        form={form}
        isCreate={isCreate}
        isEdit={isEdit}
        editingUser={hasEditingUser ? { id: 'u1' } : null}
        hrOnly={hrOnly}
        isSelfAdminEdit={isSelfAdminEdit}
        originalEmail={originalEmail}
        onEmailChangeIntent={onEmailChangeIntent}
      />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

async function openRoleOptions() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('user-dialog-role-trigger'))
  const listbox = await screen.findByRole('listbox')
  return { user, listbox }
}

function optionNames(listbox: HTMLElement) {
  return within(listbox)
    .getAllByRole('option')
    .map((o) => o.textContent)
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('IdentitySection — role options (RBAC)', () => {
  it('create mode omits ADMIN and lists exactly the five create-allowed roles', async () => {
    render(<Harness isCreate role="SENIOR" />)
    const { listbox } = await openRoleOptions()
    expect(optionNames(listbox)).toEqual(['Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп'])
    expect(within(listbox).queryByRole('option', { name: 'Адміністратор' })).toBeNull()
  })

  it('edit mode lists all six roles including ADMIN', async () => {
    render(<Harness role="SENIOR" />)
    const { listbox } = await openRoleOptions()
    expect(optionNames(listbox)).toEqual([
      'Адміністратор',
      'Сеньйор',
      'Джуніор',
      'HR',
      'Бухгалтер',
      'Дроп',
    ])
  })

  it('selecting an option writes the role into the form', async () => {
    render(<Harness isCreate role="SENIOR" />)
    const { user, listbox } = await openRoleOptions()
    await user.click(within(listbox).getByRole('option', { name: 'Дроп' }))
    await waitFor(() => expect(screen.getByTestId('values').textContent).toContain('"role":"DROP"'))
  })

  it('isSelfAdminEdit disables the role Select and shows the lock hint', () => {
    render(<Harness role="ADMIN" isSelfAdminEdit />)
    expect(screen.getByTestId('user-dialog-role-trigger')).toBeDisabled()
    expect(screen.getByText('Свою роль змінити не можна')).toBeInTheDocument()
  })

  it('without isSelfAdminEdit the role Select is enabled and shows no lock hint', () => {
    render(<Harness role="SENIOR" />)
    expect(screen.getByTestId('user-dialog-role-trigger')).toBeEnabled()
    expect(screen.queryByText('Свою роль змінити не можна')).toBeNull()
  })

  it('hrOnly renders a fixed SENIOR badge instead of the Select', () => {
    render(<Harness isCreate hrOnly role="SENIOR" />)
    expect(screen.queryByTestId('user-dialog-role-trigger')).toBeNull()
    expect(screen.getByText('(HR може створювати лише сеньйорів)')).toBeInTheDocument()
    expect(screen.getByText('Сеньйор')).toBeInTheDocument()
  })
})

describe('IdentitySection — email change intent (parent owns the warning)', () => {
  async function blurEmailWith(value: string, props: HarnessProps) {
    const onEmailChangeIntent = vi.fn()
    render(<Harness {...props} onEmailChangeIntent={onEmailChangeIntent} />)
    const input = screen.getByTestId('user-dialog-email')
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    // let the field validators settle
    await screen.findByTestId('values')
    return onEmailChangeIntent
  }

  it('edit mode + changed email -> onEmailChangeIntent with the trimmed new value', async () => {
    const spy = await blurEmailWith('new@example.com', {})
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('new@example.com')
  })

  it('edit mode + unchanged email -> no intent', async () => {
    const spy = await blurEmailWith('old@example.com', {})
    expect(spy).not.toHaveBeenCalled()
  })

  it('edit mode + empty email -> no intent', async () => {
    const spy = await blurEmailWith('', {})
    expect(spy).not.toHaveBeenCalled()
  })

  it('create mode + any email -> no intent', async () => {
    const spy = await blurEmailWith('new@example.com', { isCreate: true, email: '' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('edit mode without an editing user -> no intent', async () => {
    const spy = await blurEmailWith('new@example.com', { hasEditingUser: false })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('IdentitySection — fields and validation', () => {
  it('renders the section title and field labels (edit: no personal email / locale)', () => {
    render(<Harness />)
    expect(screen.getByText('Основне')).toBeInTheDocument()
    expect(screen.getByText('Email')).toBeInTheDocument()
    expect(screen.getByText('Ім’я та прізвище')).toBeInTheDocument()
    expect(screen.getByText('Роль')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-personal-email')).toBeNull()
    expect(screen.queryByTestId('user-locale-select')).toBeNull()
  })

  it('create mode adds the personal-email field and the locale select', () => {
    render(<Harness isCreate email="" />)
    expect(screen.getByTestId('user-dialog-personal-email')).toBeInTheDocument()
    expect(screen.getByTestId('user-locale-select')).toBeInTheDocument()
    expect(screen.getByText('Мова інтерфейсу')).toBeInTheDocument()
  })

  it('locale select offers Українська and English and writes the value', async () => {
    render(<Harness isCreate email="" />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('user-locale-select'))
    const listbox = await screen.findByRole('listbox')
    expect(optionNames(listbox)).toEqual(['Українська', 'English'])
    await user.click(within(listbox).getByRole('option', { name: 'English' }))
    await waitFor(() => expect(screen.getByTestId('values').textContent).toContain('"locale":"en"'))
  })

  it('an edited-then-blurred empty email shows the required error', async () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-email')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Введіть email')).toBeInTheDocument()
    expect(input).toHaveClass('border-destructive')
  })

  it('an edited-then-blurred malformed email shows the format error', async () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-email')
    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Введіть email у форматі name@domain')).toBeInTheDocument()
    expect(input).toHaveClass('border-destructive')
  })

  it('an untouched email blur shows no error', async () => {
    render(<Harness />)
    fireEvent.blur(screen.getByTestId('user-dialog-email'))
    await screen.findByTestId('values')
    expect(screen.getByTestId('user-dialog-email')).not.toHaveClass('border-destructive')
  })

  it('an untouched blur of an empty email leaves no stale error once the user types', async () => {
    // The validator bails while the field is pristine; otherwise this blur would
    // store "required" and it would surface as soon as the field turned dirty.
    render(<Harness email="" />)
    const input = screen.getByTestId('user-dialog-email')
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'ok@example.com' } })
    await screen.findByTestId('values')
    expect(screen.queryByText('Введіть email')).toBeNull()
    expect(input).not.toHaveClass('border-destructive')
  })

  it('the email input is configured for no autofill, correction or spellcheck', () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-email')
    expect(input).toHaveAttribute('type', 'email')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input).toHaveAttribute('autocapitalize', 'off')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('autocomplete', 'off')
  })

  it('a too-short display name shows the min error after edit + blur', async () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-name')
    fireEvent.change(input, { target: { value: 'А' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Ім’я — мінімум 2 символи')).toBeInTheDocument()
    expect(input).toHaveClass('border-destructive')
  })

  it('a display name is trimmed before the length check', async () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-name')
    fireEvent.change(input, { target: { value: ' А ' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Ім’я — мінімум 2 символи')).toBeInTheDocument()
  })

  it('an untouched blur of the display name leaves no stale error once the user types', async () => {
    render(<Harness />)
    const input = screen.getByTestId('user-dialog-name')
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'Іван Петренко' } })
    await screen.findByTestId('values')
    expect(screen.queryByText('Ім’я — мінімум 2 символи')).toBeNull()
    expect(input).not.toHaveClass('border-destructive')
  })

  it('personal email equal to the work email shows the must-differ error', async () => {
    render(<Harness isCreate email="same@example.com" />)
    const input = screen.getByTestId('user-dialog-personal-email')
    fireEvent.change(input, { target: { value: 'SAME@example.com' } })
    fireEvent.blur(input)
    await waitFor(() => expect(input).toHaveClass('border-destructive'))
  })

  it('an invalid personal email shows an error; a valid distinct one does not', async () => {
    render(<Harness isCreate email="a@example.com" />)
    const input = screen.getByTestId('user-dialog-personal-email')
    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.blur(input)
    // type="email" sanitization leaves the raw string; the zod validator flags it
    await waitFor(() => expect(input).toHaveClass('border-destructive'))
    fireEvent.change(input, { target: { value: 'b@example.com' } })
    fireEvent.blur(input)
    await waitFor(() => expect(input).not.toHaveClass('border-destructive'))
  })
})
