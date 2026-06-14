import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TechAutocompleteInput } from '../tech-autocomplete-input'

// ---------------------------------------------------------------------------
// Controlled wrapper
// ---------------------------------------------------------------------------
function Controlled({
  initial = [] as string[],
  onChange,
}: {
  initial?: string[]
  onChange?: (v: string[]) => void
}) {
  const [value, setValue] = React.useState<string[]>(initial)
  return (
    <TechAutocompleteInput
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TechAutocompleteInput — Escape key behaviour', () => {
  it('calls preventDefault + stopPropagation on Escape when dropdown is open, and closes the dropdown', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Controlled />)

    const input = screen.getByRole('combobox')

    // Type "Re" — triggers suggestions (React, Redux, etc. from TECHNOLOGIES).
    await user.click(input)
    await user.type(input, 'Re')

    // Dropdown must be open (aria-expanded="true").
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    // Create a spy on the keyboard event to capture preventDefault/stopPropagation calls.
    const preventDefaultSpy = vi.fn()
    const stopPropagationSpy = vi.fn()

    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          // Wrap the native methods — we cannot replace them on the SyntheticEvent,
          // but we can intercept on the native DOM event that React wraps.
          const origPD = e.preventDefault.bind(e)
          const origSP = e.stopPropagation.bind(e)
          Object.defineProperty(e, 'preventDefault', {
            value: () => {
              preventDefaultSpy()
              origPD()
            },
            writable: true,
          })
          Object.defineProperty(e, 'stopPropagation', {
            value: () => {
              stopPropagationSpy()
              origSP()
            },
            writable: true,
          })
        }
      },
      // capture=true so this fires before React's synthetic handler
      true,
    )

    await user.keyboard('{Escape}')

    // After Escape the dropdown should be closed (input cleared → no suggestions → aria-expanded false).
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // The event must have been stopped so it doesn't bubble to the Dialog.
    expect(preventDefaultSpy).toHaveBeenCalled()
    expect(stopPropagationSpy).toHaveBeenCalled()
  })

  it('does NOT call stopPropagation on Escape when dropdown is already closed', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Controlled />)

    const input = screen.getByRole('combobox')
    await user.click(input)

    // Input is empty → no suggestions → dropdown closed.
    expect(input).toHaveAttribute('aria-expanded', 'false')

    const stopPropagationSpy = vi.fn()

    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          const orig = e.stopPropagation.bind(e)
          Object.defineProperty(e, 'stopPropagation', {
            value: () => {
              stopPropagationSpy()
              orig()
            },
            writable: true,
          })
        }
      },
      true,
    )

    await user.keyboard('{Escape}')

    // Dropdown was already closed — stopPropagation must NOT have been called
    // so the event bubbles normally (e.g. to close a parent Dialog).
    expect(stopPropagationSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Basic smoke tests (chip add/remove, ArrowDown, Tab)
// ---------------------------------------------------------------------------

describe('TechAutocompleteInput — chip interactions', () => {
  it('adds a chip when Enter is pressed on a highlighted suggestion', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.type(input, 'Re')

    expect(input).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    // onChange must have been called with a non-empty array.
    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string[]
    expect(lastCall.length).toBeGreaterThan(0)
    // Input cleared after commit.
    expect(input).toHaveValue('')
  })

  it('adds a chip via Tab on highlighted suggestion', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.type(input, 'Ja')

    expect(input).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Tab}')

    expect(onChange).toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('removes the last chip on Backspace when input is empty', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled initial={['React', 'TypeScript']} onChange={onChange} />)

    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.keyboard('{Backspace}')

    expect(onChange).toHaveBeenCalledWith(['React'])
  })
})
