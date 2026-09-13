/**
 * switch.test.tsx — task-notification-settings-ui (position 7b).
 *
 * The first ARIA-`switch` primitive in this codebase. Pins the project's
 * track/thumb token classes directly (not just aria-checked/role) — those
 * class strings are static, present in the DOM regardless of `checked`
 * (the actual on/off visual is driven by Tailwind's `data-[state=...]`
 * attribute selector, evaluated by the browser, not by this test), so
 * asserting their presence catches a StringLiteral mutant emptying either
 * class string, which no interaction-only test would ever observe.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from '../switch'

describe('Switch', () => {
  it('renders role="switch" wired to the project track/thumb tokens', () => {
    render(<Switch checked={true} onCheckedChange={vi.fn()} aria-label="test switch" />)
    const el = screen.getByRole('switch')
    expect(el.className).toContain('data-[state=checked]:bg-primary')
    expect(el.className).toContain('data-[state=unchecked]:bg-input')
    const thumb = el.querySelector('span')
    expect(thumb?.className).toContain('data-[state=checked]:translate-x-4')
    expect(thumb?.className).toContain('data-[state=unchecked]:translate-x-0')
  })

  it('reflects checked/unchecked via aria-checked and data-state', () => {
    const { rerender } = render(
      <Switch checked={true} onCheckedChange={vi.fn()} aria-label="test switch" />,
    )
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked')

    rerender(<Switch checked={false} onCheckedChange={vi.fn()} aria-label="test switch" />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked')
  })
})
