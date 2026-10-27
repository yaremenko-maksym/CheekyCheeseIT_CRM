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

// ── SENIOR technology floor (shared `seniorTechStackSchema`) ─────────────────
const FLOOR_UK = 'Сеньйору потрібно щонайменше 3 різні технології'

type FloorForm = { submit: () => Promise<void>; setRole: (role: string) => void }

function FloorHarness({
  role = 'SENIOR',
  techStack = [],
  editingUser,
  api,
}: {
  role?: string
  techStack?: string[]
  editingUser?: { role: string; techStack: string[] | null }
  api: Partial<FloorForm>
}) {
  const form = useForm({ defaultValues: { role, techStack } })
  api.submit = () => form.handleSubmit()
  api.setRole = (r: string) => form.setFieldValue('role', r)
  return <TechStackSection form={form} editingUser={editingUser} />
}

function addTag(tag: string) {
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: tag } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('TechStackSection — SENIOR technology floor', () => {
  it('stays quiet while typing before the first submit', () => {
    render(<FloorHarness api={{}} techStack={['Zzalpha']} />)
    addTag('Zzbeta')
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
  })

  it('a SENIOR submit with 2 technologies shows the error, tied to the input', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} techStack={['Zzalpha', 'Zzbeta']} />)
    await act(() => api.submit!())
    const error = screen.getByText(FLOOR_UK)
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe(error.id)
    // UX-L-1: announced when it appears (it appears after an explicit submit).
    expect(screen.getByRole('alert')).toBe(error)
  })

  it('after a failed submit the error follows each change: stays below 3, clears at 3', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} techStack={['Zzalpha']} />)
    await act(() => api.submit!())
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    act(() => addTag('Zzbeta'))
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    act(() => addTag('Zzgamma'))
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
  })

  it('after a failed submit, switching the role away from SENIOR clears the error', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} techStack={['Zzalpha']} />)
    await act(() => api.submit!())
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    act(() => api.setRole!('JUNIOR'))
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
  })

  it('en: a SENIOR submit with 2 technologies shows the English message (SPEC-M-2)', async () => {
    await loadCatalog('en')
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} techStack={['Zzalpha', 'Zzbeta']} />)
    await act(() => api.submit!())
    const error = screen.getByText('A senior needs at least 3 different technologies')
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe(error.id)
  })

  it('a JUNIOR submit with no technology shows no error', async () => {
    const api: Partial<FloorForm> = {}
    render(<FloorHarness api={api} role="JUNIOR" />)
    await act(() => api.submit!())
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
  })

  it('editing a legacy SENIOR: an unchanged 2-technology stack submits with no error (A1)', async () => {
    const api: Partial<FloorForm> = {}
    render(
      <FloorHarness
        api={api}
        techStack={['Zzalpha', 'Zzbeta']}
        editingUser={{ role: 'SENIOR', techStack: ['Zzalpha', 'Zzbeta'] }}
      />,
    )
    await act(() => api.submit!())
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
  })
})
