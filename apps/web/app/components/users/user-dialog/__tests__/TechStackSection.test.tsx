/**
 * Characterization tests for `TechStackSection` after it moved out of
 * `UserDialog.tsx` verbatim. Pins title, label, placeholder, and that the chip
 * field reads from / writes into the form's `techStack` value.
 */
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
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
