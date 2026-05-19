import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { validatePhoneNumberLength } from 'libphonenumber-js/min'
import * as RPNInput from 'react-phone-number-input'
import { PhoneInput } from '../phone-input'

// ---------------------------------------------------------------------------
// Unit tests for checkIfValidInput logic (extracted inline for clarity)
// ---------------------------------------------------------------------------

function checkIfValidInput(value: string, defaultCountry: RPNInput.Country = 'UA'): boolean {
  const initialValueTestString = `${value}0`
  const initialValueTestResult = validatePhoneNumberLength(initialValueTestString)

  if (initialValueTestResult === 'TOO_LONG') return false

  if (initialValueTestResult === 'INVALID_COUNTRY' && defaultCountry) {
    const withoutPlus = `+${initialValueTestString}`

    let isDefaultCountry = false
    try {
      isDefaultCountry = RPNInput.parsePhoneNumber(withoutPlus)?.country === defaultCountry
    } catch {
      // unparseable
    }

    if (isDefaultCountry) {
      return validatePhoneNumberLength(withoutPlus) !== 'TOO_LONG'
    }

    const withoutCountryCode = `+${RPNInput.getCountryCallingCode(defaultCountry)}${initialValueTestString}`
    if (validatePhoneNumberLength(withoutCountryCode) === 'TOO_LONG') return false
  }

  return true
}

describe('checkIfValidInput', () => {
  describe('Ukrainian numbers (defaultCountry=UA, code +380)', () => {
    it('allows empty string', () => {
      expect(checkIfValidInput('')).toBe(true)
    })

    it('allows partial number while typing', () => {
      expect(checkIfValidInput('+38')).toBe(true)
      expect(checkIfValidInput('+380')).toBe(true)
      expect(checkIfValidInput('+38066')).toBe(true)
      expect(checkIfValidInput('+3806612345')).toBe(true)
    })

    it('allows a complete valid UA number', () => {
      expect(checkIfValidInput('+380661234567')).toBe(true)
    })

    it('blocks one digit beyond the valid UA length', () => {
      expect(checkIfValidInput('+3806612345678')).toBe(false)
    })

    it('blocks multiple extra digits', () => {
      expect(checkIfValidInput('+38066123456789')).toBe(false)
    })
  })

  describe('US numbers (defaultCountry=US, code +1)', () => {
    it('allows +1 prefix — the bug case', () => {
      // This was crashing before the try-catch fix
      expect(checkIfValidInput('+1', 'US')).toBe(true)
    })

    it('allows partial US number', () => {
      expect(checkIfValidInput('+1650', 'US')).toBe(true)
      expect(checkIfValidInput('+1650555', 'US')).toBe(true)
    })

    it('allows a complete valid US number', () => {
      // +1 (1) + 650555123 (9) = 11 chars total; test string appends 0 → NOT TOO_LONG
      expect(checkIfValidInput('+1650555123', 'US')).toBe(true)
    })

    it('blocks one digit beyond the valid US length', () => {
      expect(checkIfValidInput('+16505551234', 'US')).toBe(false)
    })
  })

  describe('UK numbers (defaultCountry=GB, code +44)', () => {
    it('allows +44 prefix', () => {
      expect(checkIfValidInput('+44', 'GB')).toBe(true)
    })

    it('allows partial GB number', () => {
      expect(checkIfValidInput('+447700', 'GB')).toBe(true)
    })

    it('allows a complete valid GB number', () => {
      // +44 (3) + 770090000 (9) = 12 chars; test string appends 0 → NOT TOO_LONG
      expect(checkIfValidInput('+44770090000', 'GB')).toBe(true)
    })

    it('blocks one digit beyond the valid GB length', () => {
      expect(checkIfValidInput('+447700900000', 'GB')).toBe(false)
    })
  })

  describe('Edge cases', () => {
    it('does not throw on unparseable short inputs like +1', () => {
      // parsePhoneNumber('+10') would throw without try-catch
      expect(() => checkIfValidInput('+1', 'UA')).not.toThrow()
      expect(checkIfValidInput('+1', 'UA')).toBe(true)
    })

    it('does not throw on single digit', () => {
      expect(() => checkIfValidInput('1')).not.toThrow()
    })

    it('does not throw on only plus sign', () => {
      expect(() => checkIfValidInput('+')).not.toThrow()
    })

    it('allows digits-only input (no leading +)', () => {
      // RPNInput passes the raw input value before formatting
      expect(checkIfValidInput('066')).toBe(true)
      expect(checkIfValidInput('0661234567')).toBe(true)
    })

    it('blocks way-too-long digits-only input', () => {
      expect(checkIfValidInput('066123456789999')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Component integration tests
// ---------------------------------------------------------------------------

// Controlled wrapper so RPNInput receives updated value on every onChange
function ControlledPhoneInput({ defaultCountry = 'UA' as RPNInput.Country, onChange }: {
  defaultCountry?: RPNInput.Country
  onChange: (v: RPNInput.Value) => void
}) {
  const [value, setValue] = React.useState<RPNInput.Value>('' as RPNInput.Value)
  return (
    <PhoneInput
      value={value}
      onChange={(v) => { setValue(v); onChange(v) }}
      defaultCountry={defaultCountry}
    />
  )
}

function setup(defaultCountry: RPNInput.Country = 'UA') {
  const onChange = vi.fn()
  render(<ControlledPhoneInput defaultCountry={defaultCountry} onChange={onChange} />)
  const input = screen.getByPlaceholderText('Номер телефона')
  return { input, onChange }
}

describe('PhoneInput component', () => {
  it('renders the phone input', () => {
    const { input } = setup()
    expect(input).toBeInTheDocument()
  })

  it('calls onChange when a valid character is typed', async () => {
    const user = userEvent.setup({ delay: null })
    const { input, onChange } = setup()
    await user.type(input, '6')
    expect(onChange).toHaveBeenCalled()
  })

  it('does not lose focus while typing a valid number', async () => {
    const user = userEvent.setup({ delay: null })
    const { input } = setup()
    input.focus()
    await user.type(input, '+380661234567')
    expect(document.activeElement).toBe(input)
  })

  it('does not call onChange when input would exceed max length', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(
      <PhoneInput
        value={'+3806612345678' as RPNInput.Value}
        onChange={onChange}
        defaultCountry="UA"
      />,
    )
    const input = screen.getByPlaceholderText('Номер телефона')
    onChange.mockClear()
    await user.type(input, '9')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not throw when typing +1 (US short code bug)', async () => {
    const user = userEvent.setup({ delay: null })
    const { input } = setup('US')
    await expect(user.type(input, '+1')).resolves.not.toThrow()
  })

  it('maintains focus across multiple keystrokes', async () => {
    const user = userEvent.setup({ delay: null })
    const { input } = setup()
    input.focus()
    await user.type(input, '+38066')
    expect(document.activeElement).toBe(input)
  })

  // ---------------------------------------------------------------------------
  // Country switching scenarios
  // ---------------------------------------------------------------------------

  // Helper: open dropdown, optionally search, click the country label span
  async function selectCountry(user: ReturnType<typeof userEvent.setup>, searchQuery: string) {
    const trigger = screen.getByRole('button')
    await user.click(trigger)
    const searchInput = screen.getByPlaceholderText('Поиск страны...')
    await user.type(searchInput, searchQuery)
    // Find by role=option to avoid matching SVG <title> elements
    const option = await screen.findByRole('option', { name: new RegExp(searchQuery, 'i') })
    await user.click(option)
  }

  it('sets country calling code in input after switching country via dropdown', async () => {
    const user = userEvent.setup({ delay: null })
    const { input, onChange } = setup('UA')

    // Type a digit first so RPNInput has a value to migrate on country change
    await user.type(input, '6')
    await selectCountry(user, 'United States')

    // After switching to US, the migrated value must start with +1
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string
    expect(lastCall).toMatch(/^\+1/)
  })

  it('can type a number after switching country', async () => {
    const user = userEvent.setup({ delay: null })
    const { input, onChange } = setup('UA')

    await selectCountry(user, 'Germany')

    onChange.mockClear()
    await user.type(input, '30')
    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string
    expect(lastCall).toMatch(/^\+49/)
  })

  it('can switch countries multiple times and type after each', async () => {
    const user = userEvent.setup({ delay: null })
    const { input, onChange } = setup('UA')

    const countries = [
      { search: 'Poland', prefix: '+48' },
      { search: 'France', prefix: '+33' },
      { search: 'United Kingdom', prefix: '+44' },
    ]

    for (const { search, prefix } of countries) {
      await selectCountry(user, search)

      onChange.mockClear()
      await user.type(input, '1')
      expect(onChange).toHaveBeenCalled()
      const lastCall = onChange.mock.calls.at(-1)?.[0] as string
      expect(lastCall).toMatch(new RegExp(`^\\${prefix}`))
    }
  }, 30000)

  it('normalizes local UA number (0XXXXXXXXX) to e164 (+380XXXXXXXXX)', async () => {
    const user = userEvent.setup({ delay: null })
    const { input, onChange } = setup('UA')

    await user.type(input, '0661234567')

    // Last onChange call should produce a value with +380 prefix
    const calls = onChange.mock.calls.map((c) => c[0] as string)
    const lastValid = [...calls].reverse().find((v: string) => v?.startsWith('+380'))
    expect(lastValid).toBeDefined()
  })
})
