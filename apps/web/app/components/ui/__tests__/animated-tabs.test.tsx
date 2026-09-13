/**
 * animated-tabs.test.tsx — the FIRST unit test for this component (added
 * task-notification-settings-ui, fix-round 2, PR #675: the mutation gate
 * found 11 survived mutants on a file that had never been unit-tested
 * before, 0% coverage — the shared tab-bar primitive behind the profile's
 * tab strip, the finance tab bar, and several other consumers). Covers the
 * pre-existing render/click/disabled contract AND the new UX-H-1
 * `scrollIntoView` behaviour together, since both now live in the same
 * file and mutation-gate scope does not distinguish "old" from "new" lines.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AnimatedTabs } from '../animated-tabs'

const TABS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true, disabledTooltip: 'Locked for now' },
]

// happy-dom (this project's test DOM) does not implement scrollIntoView.
// `Element.prototype.scrollIntoView` is ONE function shared by every element
// on the prototype chain — a plain `vi.fn()` assigned there would make
// `buttonA.scrollIntoView` and `buttonB.scrollIntoView` the exact SAME
// function reference, so asserting on one button's `.scrollIntoView` mock
// says nothing about which element it was actually invoked ON. Recording
// `this` (the calling element) per call, into a plain array, is what makes
// "the OTHER tab was never scrolled" an assertion about behaviour rather
// than about a shared reference.
let scrollCalls: Array<{ el: Element; options: unknown }>

beforeEach(() => {
  scrollCalls = []
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrollCalls.push({ el: this, options })
  }
})

describe('AnimatedTabs — rendering', () => {
  it('renders every tab label as a button', () => {
    render(<AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bravo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Charlie' })).toBeInTheDocument()
  })

  // Pins the ternary at the className computation — a mutant that always
  // (or never) applies the active-pill text color would make this pass for
  // the WRONG tab, or both tabs identically.
  it('the active tab gets the active-pill text color; the inactive tab gets the muted one', () => {
    render(<AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />)
    const active = screen.getByRole('button', { name: 'Alpha' })
    const inactive = screen.getByRole('button', { name: 'Bravo' })
    expect(active.className).toContain('text-primary-foreground')
    expect(active.className).not.toContain('text-muted-foreground')
    expect(inactive.className).toContain('text-muted-foreground')
    expect(inactive.className).not.toContain('text-primary-foreground')
  })

  // Pins `disabled && <Lock .../>` — both directions, so a mutant forcing
  // the icon to always/never render is caught regardless of which way it
  // flips.
  it('renders the lock icon only for a disabled tab', () => {
    render(<AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />)
    const disabledButton = screen.getByRole('button', { name: 'Charlie' })
    const enabledButton = screen.getByRole('button', { name: 'Alpha' })
    expect(disabledButton.querySelector('svg')).not.toBeNull()
    expect(enabledButton.querySelector('svg')).toBeNull()
  })
})

describe('AnimatedTabs — interaction', () => {
  it('clicking an enabled tab calls onChange with its value', () => {
    const onChange = vi.fn()
    render(<AnimatedTabs tabs={TABS} value="a" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bravo' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('clicking a disabled tab never calls onChange', () => {
    const onChange = vi.fn()
    render(<AnimatedTabs tabs={TABS} value="a" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Charlie' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AnimatedTabs — UX-H-1: scrollIntoView on the active tab', () => {
  it('scrolls the initially active tab into view on mount, and no other tab', () => {
    render(<AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />)
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    const alpha = screen.getByRole('button', { name: 'Alpha' })
    expect(scrollCalls).toContainEqual({
      el: bravo,
      options: { block: 'nearest', inline: 'nearest' },
    })
    // The tab that is NOT active never gets scrolled into view.
    expect(scrollCalls.some((c) => c.el === alpha)).toBe(false)
  })

  // Pins the effect's dependency array (`[value]`, mutated to `[]` by the
  // ArrayDeclaration mutant reported by the gate) — with `[]` the effect
  // would only ever run once, on mount, and never again when `value`
  // changes on a re-render (exactly the deep-link-then-navigate scenario
  // UX-H-1 was filed against).
  it('scrolls the newly active tab into view again when `value` changes on a re-render', () => {
    const { rerender } = render(<AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />)
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    expect(scrollCalls.some((c) => c.el === bravo)).toBe(false)

    rerender(<AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />)
    expect(scrollCalls).toContainEqual({
      el: bravo,
      options: { block: 'nearest', inline: 'nearest' },
    })
  })

  // Pins the optional-chaining guard on `activeRef.current` — without it, a
  // render where NO tab matches `value` (e.g. the parent passed a stale/
  // unknown value for one tick) would throw instead of silently no-op-ing.
  it('never throws when no tab matches the current value (activeRef stays null)', () => {
    expect(() =>
      render(<AnimatedTabs tabs={TABS} value="does-not-exist" onChange={vi.fn()} />),
    ).not.toThrow()
  })
})
