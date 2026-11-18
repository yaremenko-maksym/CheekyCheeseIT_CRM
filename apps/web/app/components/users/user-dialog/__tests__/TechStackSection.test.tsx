/**
 * Characterization tests for `TechStackSection` after it moved out of
 * `UserDialog.tsx` verbatim. Pins title, label, placeholder, and that the chip
 * field reads from / writes into the form's `techStack` value.
 */
import { act, render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { TechStackSection } from '../TechStackSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

function Harness({ techStack = [] }: { techStack?: string[] }) {
  const form = useForm({ defaultValues: { techStack } })
  return (
    <>
      <TechStackSection form={form} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('TechStackSection', () => {
  it('renders the section title, field label and placeholder', () => {
    render(<Harness />)
    expect(screen.getByText('Професія')).toBeInTheDocument()
    expect(screen.getByText('Технології')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Почніть вводити: React, Node.js…')).toBeInTheDocument()
  })

  it('renders prefilled form values as chips', () => {
    render(<Harness techStack={['React', 'Node.js']} />)
    expect(screen.getByText('React')).toBeInTheDocument()
    expect(screen.getByText('Node.js')).toBeInTheDocument()
  })

  it('writes an added tag into the form value', () => {
    render(<Harness />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Zzcustomtech' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const values = JSON.parse(screen.getByTestId('values').textContent ?? '{}')
    expect(values.techStack).toEqual(['Zzcustomtech'])
  })
})

// ── SENIOR technical-roles floor (`SENIOR_MIN_ROLES`) ───────────────────────
const MIN_ROLES_UK = 'Сеньйору потрібна щонайменше одна технічна роль'

type FloorForm = { submit: () => Promise<void>; setRole: (role: string) => void }

function FloorHarness({
  role = 'SENIOR',
  techStack = [],
  technicalRoles = [],
  editingUser,
  api,
  onSubmit,
}: {
  role?: string
  techStack?: string[]
  technicalRoles?: string[]
  editingUser?: { role: string; techStack: string[] | null; technicalRoles: string[] }
  api: Partial<FloorForm>
  onSubmit?: () => void
}) {
  const form = useForm({
    defaultValues: { role, techStack, technicalRoles },
    ...(onSubmit ? { onSubmit } : {}),
  })
  api.submit = () => form.handleSubmit()
  api.setRole = (r: string) => form.setFieldValue('role', r)
  return (
    <>
      <TechStackSection form={form} editingUser={editingUser} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

const values = () => JSON.parse(screen.getByTestId('values').textContent ?? '{}')

describe('TechStackSection — SENIOR gets technical roles instead of the stack', () => {
  it('a SENIOR sees RolesSection and no stack input; a JUNIOR sees the stack', () => {
    render(<FloorHarness api={{}} />)
    expect(screen.getByTestId('roles-section')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Професія')).toBeInTheDocument()
  })

  it('switching the role swaps the sections instantly', () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} role="JUNIOR" />)
    expect(screen.queryByTestId('roles-section')).toBeNull()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    act(() => api.setRole!('SENIOR'))
    expect(screen.getByTestId('roles-section')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('stays quiet before the first submit', () => {
    render(<FloorHarness api={{}} />)
    expect(screen.queryByText(MIN_ROLES_UK)).toBeNull()
  })

  it('a SENIOR submit with no roles shows the SENIOR_MIN_ROLES alert, tied to the trigger', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} />)
    await act(() => api.submit!())
    const error = screen.getByText(MIN_ROLES_UK)
    expect(error).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('roles-section-add-trigger')).toHaveAttribute(
      'aria-describedby',
      error.id,
    )
  })

  it('after a failed submit the error clears once a role is picked, and the pick lands in the form', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} />)
    await act(() => api.submit!())
    fireEvent.click(screen.getByTestId('roles-section-add-trigger'))
    fireEvent.click(screen.getByTestId('roles-section-option-QA_ENGINEER'))
    expect(screen.queryByText(MIN_ROLES_UK)).toBeNull()
    expect(values().technicalRoles).toEqual(['QA_ENGINEER'])
  })

  it('after a failed submit, switching the role away from SENIOR clears the error', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} />)
    await act(() => api.submit!())
    expect(screen.getByText(MIN_ROLES_UK)).toBeInTheDocument()
    act(() => api.setRole!('JUNIOR'))
    expect(screen.queryByText(MIN_ROLES_UK)).toBeNull()
  })

  it('en: the SENIOR_MIN_ROLES message is English', async () => {
    await loadCatalog('en')
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} />)
    await act(() => api.submit!())
    expect(screen.getByText('A senior needs at least one technical role')).toBeInTheDocument()
  })

  it('a JUNIOR submit with no technology shows no error (no stack floor)', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} role="JUNIOR" />)
    await act(() => api.submit!())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('editing a legacy SENIOR with no roles: an unchanged submit shows no error', async () => {
    const api: Partial<FloorForm> = {}
    render(
      <FloorHarness
        api={api}
        editingUser={{ role: 'SENIOR', techStack: ['Zzalpha'], technicalRoles: [] }}
      />,
    )
    await act(() => api.submit!())
    expect(screen.queryByText(MIN_ROLES_UK)).toBeNull()
  })

  it('editing a SENIOR who removes the last role is refused', async () => {
    const api: Partial<FloorForm> = {}
    render(
      <FloorHarness
        api={api}
        technicalRoles={['QA_ENGINEER']}
        editingUser={{ role: 'SENIOR', techStack: null, technicalRoles: ['QA_ENGINEER'] }}
      />,
    )
    fireEvent.click(screen.getByTestId('roles-section-remove-QA_ENGINEER'))
    await act(() => api.submit!())
    expect(screen.getByText(MIN_ROLES_UK)).toBeInTheDocument()
  })

  // CR-L: clearing the message is not enough — the refused submit leaves a field-level error in
  // the form state, and if it survived the role switch the next submit would never run.
  it('after a failed SENIOR submit, switching to JUNIOR lets the next submit through', async () => {
    const api: Partial<FloorForm> = {}
    let submits = 0
    render(<FloorHarness api={api} onSubmit={() => void submits++} />)
    await act(() => api.submit!())
    expect(screen.getByText(MIN_ROLES_UK)).toBeInTheDocument()
    expect(submits).toBe(0)
    act(() => api.setRole!('JUNIOR'))
    await act(() => api.submit!())
    expect(submits).toBe(1)
    expect(screen.queryByText(MIN_ROLES_UK)).toBeNull()
  })

  it('editing a JUNIOR being promoted to SENIOR without roles is refused', async () => {
    const api: Partial<FloorForm> = {}
    render(
      <FloorHarness
        api={api}
        editingUser={{ role: 'JUNIOR', techStack: null, technicalRoles: [] }}
      />,
    )
    await act(() => api.submit!())
    expect(screen.getByText(MIN_ROLES_UK)).toBeInTheDocument()
  })
})
