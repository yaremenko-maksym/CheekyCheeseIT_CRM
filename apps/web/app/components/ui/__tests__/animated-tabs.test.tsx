/**
 * animated-tabs.test.tsx — the FIRST unit test for this component (added
 * task-notification-settings-ui, fix-round 2, PR #675: the mutation gate
 * found 11 survived mutants on a file that had never been unit-tested
 * before, 0% coverage — the shared tab-bar primitive behind the profile's
 * tab strip, the finance tab bar, and several other consumers). Covers the
 * pre-existing render/click/disabled contract AND the SR-L-4 (fix-round 3)
 * horizontal-only scroll behaviour together, since both now live in the
 * same file and mutation-gate scope does not distinguish "old" from "new"
 * lines.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AnimatedTabs } from '../animated-tabs'

const TABS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true, disabledTooltip: 'Locked for now' },
]

// SR-L-4 (security-review, fix-round 3, PR #675): `AnimatedTabs` no longer
// calls `scrollIntoView` at all (see the component for why) — it walks up
// from the active button's real DOM parent chain to find a genuinely
// overflowing ancestor and mutates ONLY that ancestor's `scrollLeft`, by
// how much it reads off `getBoundingClientRect()`. None of happy-dom's
// default layout numbers reflect real geometry, and the effect runs
// synchronously on mount — before a test gets a chance to grab the
// rendered elements and stub them per-instance. So geometry is faked at
// the PROTOTYPE level, keyed by `data-testid`/button label, and set
// BEFORE each render call (mutable module-level state a test fills in,
// then `render()`/`rerender()` reads through the prototype override).
let wrapperGeometry = { scrollWidth: 0, clientWidth: 0, left: 0, right: 0 }
let buttonRects: Record<string, { left: number; right: number }> = {}
let scrollIntoViewCalls: number
let windowScrollToCalls: number

function rect(partial: { left: number; right: number }): DOMRect {
  return { top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...partial } as DOMRect
}

beforeEach(() => {
  wrapperGeometry = { scrollWidth: 0, clientWidth: 0, left: 0, right: 0 }
  buttonRects = {}
  scrollIntoViewCalls = 0
  windowScrollToCalls = 0

  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'wrapper' ? wrapperGeometry.scrollWidth : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'wrapper' ? wrapperGeometry.clientWidth : 0
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.testid === 'wrapper') {
      return rect({ left: wrapperGeometry.left, right: wrapperGeometry.right })
    }
    if (this.tagName === 'BUTTON') {
      const label = this.textContent?.trim() ?? ''
      const buttonRect = buttonRects[label]
      if (buttonRect) return rect(buttonRect)
    }
    return rect({ left: 0, right: 0 })
  }
  // Still stubbed (not deleted) so a regression that brings `scrollIntoView`
  // back is caught as "it got called" rather than "the test crashed" —
  // happy-dom does not implement it at all.
  Element.prototype.scrollIntoView = () => {
    scrollIntoViewCalls += 1
  }
  window.scrollTo = (() => {
    windowScrollToCalls += 1
  }) as typeof window.scrollTo
})

afterEach(() => {
  vi.restoreAllMocks()
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

describe('AnimatedTabs — SR-L-4: horizontal-only container scroll on the active tab', () => {
  // Renders inside an explicit wrapper standing in for the CONSUMER's own
  // `overflow-x-auto` div (`UserProfileShell.tsx`, `admin/route.tsx`,
  // `vacancies/$vacancyId.tsx`) — `AnimatedTabs` never renders that wrapper
  // itself, it only ever finds it by walking up from the active button.
  function renderInWrapper(value: string, onChange = vi.fn()) {
    const utils = render(
      <div data-testid="wrapper">
        <AnimatedTabs tabs={TABS} value={value} onChange={onChange} />
      </div>,
    )
    const wrapper = screen.getByTestId('wrapper')
    return { ...utils, wrapper }
  }

  it('mount: moves the container scrollLeft RIGHT just enough to reveal a tab clipped past the right edge', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    const { wrapper } = renderInWrapper('b')
    // overflowRight = buttonRect.right(500) - containerRect.right(300) = 200
    expect(wrapper.scrollLeft).toBe(200)
  })

  it('mount: does not move the container when the active tab already fits within its visible area', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Alpha: { left: 50, right: 150 } }
    const { wrapper } = renderInWrapper('a')
    expect(wrapper.scrollLeft).toBe(0)
  })

  it('mount: does not move the container when no scrollable ancestor is found at all', () => {
    // wrapperGeometry left at its beforeEach default (scrollWidth ===
    // clientWidth === 0) — `findScrollableAncestor` walks all the way up
    // without finding a genuinely overflowing node and the effect no-ops,
    // exactly like a consumer that renders `AnimatedTabs` with NO
    // `overflow-x-auto` ancestor at all (`RequisitesEditForm.tsx`).
    buttonRects = { Bravo: { left: 400, right: 500 } }
    const { wrapper } = renderInWrapper('b')
    expect(wrapper.scrollLeft).toBe(0)
  })

  it('never calls scrollIntoView and never touches window.scrollTo/scrollY', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    renderInWrapper('b')
    expect(scrollIntoViewCalls).toBe(0)
    expect(windowScrollToCalls).toBe(0)
    expect(window.scrollY).toBe(0)
  })

  // Pins the effect's dependency array (`[value]`) — with the array emptied
  // by an ArrayDeclaration mutant, the effect would only ever run once, on
  // mount, and never again when `value` changes on a re-render (exactly the
  // deep-link-then-navigate scenario UX-H-1 was filed against, and which
  // SR-L-4's rewrite must not regress).
  it('adjusts scrollLeft again (RIGHT) when `value` changes to a tab clipped past the right edge', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Alpha: { left: 50, right: 150 }, Bravo: { left: 400, right: 500 } }
    const { rerender, wrapper } = renderInWrapper('a')
    expect(wrapper.scrollLeft).toBe(0)

    rerender(
      <div data-testid="wrapper">
        <AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />
      </div>,
    )
    expect(wrapper.scrollLeft).toBe(200)
  })

  // The LEFT-overflow branch (`container.scrollLeft -= overflowLeft`) only
  // fires once `scrollLeft` is already > 0 — mirrors switching back to an
  // earlier tab after the bar auto-scrolled right for a later one, above.
  it('adjusts scrollLeft again (LEFT) when `value` changes back to a tab clipped before the left edge', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Bravo: { left: 400, right: 500 }, Alpha: { left: -50, right: 50 } }
    const { rerender, wrapper } = renderInWrapper('b')
    expect(wrapper.scrollLeft).toBe(200)

    rerender(
      <div data-testid="wrapper">
        <AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />
      </div>,
    )
    // overflowLeft = containerRect.left(0) - buttonRect.left(-50) = 50
    expect(wrapper.scrollLeft).toBe(150)
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
