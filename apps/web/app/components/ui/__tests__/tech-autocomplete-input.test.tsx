import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TechAutocompleteInput } from '../tech-autocomplete-input'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Controlled wrapper so state updates propagate correctly. */
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

/** Find the autocomplete text input (role=textbox, not combobox — no explicit role attr). */
function getInput() {
  return screen.getByRole('textbox')
}

// ---------------------------------------------------------------------------
// Escape key behaviour — the core bug fix
// ---------------------------------------------------------------------------

describe('TechAutocompleteInput — Escape key behaviour', () => {
  it('closes dropdown on Escape when open, and does NOT propagate the event to parent', async () => {
    const user = userEvent.setup({ delay: null })
    const parentKeyDown = vi.fn()

    render(
      // Wrap in a div that listens for keydown at the bubble phase.
      // If stopPropagation is NOT called the spy will fire.
      <div onKeyDown={parentKeyDown}>
        <Controlled />
      </div>,
    )

    const input = getInput()
    await user.click(input)
    await user.type(input, 'Re')

    // Deterministic gate: aria-expanded="true" is set in the same React commit
    // that mounts the listbox, so this is race-free.
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    // Clear spy calls accumulated during user.type() — R and e keydowns bubble
    // to the parent too, so we only care about the Escape event.
    parentKeyDown.mockClear()

    await user.keyboard('{Escape}')

    // Dropdown must be gone — input cleared → no suggestions → aria-expanded false.
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // The Escape event must NOT have bubbled to the parent (stopPropagation was called).
    // React batches synthetic events but the onKeyDown spy fires on bubble; if it is
    // called here the bug is still present.
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  it('does NOT stop propagation on Escape when dropdown is already closed', async () => {
    const user = userEvent.setup({ delay: null })
    const parentKeyDown = vi.fn()

    render(
      <div onKeyDown={parentKeyDown}>
        <Controlled />
      </div>,
    )

    const input = getInput()
    await user.click(input)

    // Input is empty → no suggestions → dropdown closed.
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')

    // When dropdown is closed, Escape must bubble normally so a parent Dialog
    // (Radix) can close itself.
    expect(parentKeyDown).toHaveBeenCalledOnce()
    const event = parentKeyDown.mock.calls[0][0] as React.KeyboardEvent
    expect(event.key).toBe('Escape')
  })

  it('input is cleared after Escape regardless of whether dropdown was open', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Controlled />)

    const input = getInput()
    await user.click(input)
    await user.type(input, 'Re')
    expect(input).toHaveValue('Re')

    await user.keyboard('{Escape}')

    expect(input).toHaveValue('')
  })
})

// ---------------------------------------------------------------------------
// Chip interactions (ArrowDown/Enter, Tab, Backspace)
// ---------------------------------------------------------------------------

describe('TechAutocompleteInput — chip interactions', () => {
  it('adds a chip when ArrowDown + Enter is pressed on a highlighted suggestion', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const input = getInput()
    await user.click(input)
    await user.type(input, 'Re')

    expect(input).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

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

    const input = getInput()
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

    const input = getInput()
    await user.click(input)
    await user.keyboard('{Backspace}')

    expect(onChange).toHaveBeenCalledWith(['React'])
  })
})
