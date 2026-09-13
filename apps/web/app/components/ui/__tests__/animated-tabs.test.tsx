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

// SR-L-4 mutation-gate follow-up (fix-round 3, PR #675): `container.style.
// scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth'` needs BOTH
// branches driven directly — `useReducedMotion` reads `window.matchMedia`,
// which happy-dom does not implement, so mocking the hook itself (instead
// of matchMedia) is what makes both branches reachable at all.
let mockReducedMotion = false
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: () => mockReducedMotion }
})

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

// SR-L-7 (security-review, fix-round 4, PR #675): a SECOND, independent
// testid-keyed geometry map, on top of `wrapperGeometry` above — needed to
// give a test more than one candidate ancestor at once (an outer REAL
// scroll container plus an inner `overflow: visible` box that merely
// reports the same `scrollWidth > clientWidth` inequality because a child
// spills past it). Every entry also carries the computed `overflow-x` the
// new predicate reads; `wrapperGeometry`'s own element (`data-testid=
// "wrapper"`) keeps defaulting to `auto` below, unchanged, so none of the
// pre-existing tests need to name an `overflowX` themselves.
let extraGeometry: Record<
  string,
  { scrollWidth: number; clientWidth: number; left: number; right: number; overflowX: string }
> = {}

// SR-L-7 follow-up: `document.documentElement` (`<html>`) has no
// `data-testid` to key off of — it needs its OWN slot so a test can make it
// satisfy the container predicate (overflowing + `auto`/`scroll`) ON
// PURPOSE, to prove the walk never reaches it. Inert by default (`0/0`,
// `visible`) so no pre-existing test that never sets this is affected.
let htmlGeometry = { scrollWidth: 0, clientWidth: 0, left: 0, right: 0, overflowX: 'visible' }

function rect(partial: { left: number; right: number }): DOMRect {
  return { top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...partial } as DOMRect
}

beforeEach(() => {
  wrapperGeometry = { scrollWidth: 0, clientWidth: 0, left: 0, right: 0 }
  extraGeometry = {}
  htmlGeometry = { scrollWidth: 0, clientWidth: 0, left: 0, right: 0, overflowX: 'visible' }
  buttonRects = {}
  scrollIntoViewCalls = 0
  windowScrollToCalls = 0
  mockReducedMotion = false

  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this === document.documentElement) return htmlGeometry.scrollWidth
      if (this.dataset.testid === 'wrapper') return wrapperGeometry.scrollWidth
      const extra = this.dataset.testid ? extraGeometry[this.dataset.testid] : undefined
      return extra ? extra.scrollWidth : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this === document.documentElement) return htmlGeometry.clientWidth
      if (this.dataset.testid === 'wrapper') return wrapperGeometry.clientWidth
      const extra = this.dataset.testid ? extraGeometry[this.dataset.testid] : undefined
      return extra ? extra.clientWidth : 0
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === document.documentElement) {
      return rect({ left: htmlGeometry.left, right: htmlGeometry.right })
    }
    if (this.dataset.testid === 'wrapper') {
      return rect({ left: wrapperGeometry.left, right: wrapperGeometry.right })
    }
    const extra = this.dataset.testid ? extraGeometry[this.dataset.testid] : undefined
    if (extra) return rect({ left: extra.left, right: extra.right })
    if (this.tagName === 'BUTTON') {
      const label = this.textContent?.trim() ?? ''
      const buttonRect = buttonRects[label]
      if (buttonRect) return rect(buttonRect)
    }
    return rect({ left: 0, right: 0 })
  }
  // SR-L-7: `findScrollableAncestor` now reads `getComputedStyle(node).
  // overflowX` — happy-dom applies no real stylesheet in these tests, so
  // its own computed style would report the CSS default (`visible`) for
  // every node regardless of Tailwind class names. `wrapper` stands in for
  // the consumer's real `overflow-x-auto` div and is hard-coded to `auto`
  // here (matching every pre-existing test, none of which mention
  // `overflowX` at all); anything in `extraGeometry` reports whatever
  // `overflowX` that test gave it; `<html>` reports `htmlGeometry`'s;
  // everything else falls through to happy-dom's real default.
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((el: Element) => {
    if (el === document.documentElement) {
      return { overflowX: htmlGeometry.overflowX } as CSSStyleDeclaration
    }
    const testid = (el as HTMLElement).dataset?.testid
    if (testid === 'wrapper') return { overflowX: 'auto' } as CSSStyleDeclaration
    if (testid && extraGeometry[testid]) {
      return { overflowX: extraGeometry[testid].overflowX } as CSSStyleDeclaration
    }
    return originalGetComputedStyle(el)
  }) as typeof window.getComputedStyle
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

  // Mutation-gate follow-up (fix-round 3, PR #675): the two `<= 0` checks
  // guarding the early return need their own EXACT-ZERO boundary cases —
  // a strictly-negative overflow (used by every test above) cannot tell
  // `<= 0` apart from `< 0`, since both agree everywhere except at 0.
  it('boundary: overflowLeft exactly 0 (button flush at the left edge) counts as NOT overflowing — no scroll, no style touch', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    // overflowLeft = 0 - 0 = 0; overflowRight = 100 - 300 = -200 (both <= 0).
    buttonRects = { Alpha: { left: 0, right: 100 } }
    const { wrapper } = renderInWrapper('a')
    expect(wrapper.scrollLeft).toBe(0)
    expect(wrapper.style.scrollBehavior).toBe('')
  })

  it('boundary: overflowRight exactly 0 (button flush at the right edge) counts as NOT overflowing — no scroll, no style touch', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    // overflowLeft = 0 - 200 = -200; overflowRight = 300 - 300 = 0 (both <= 0).
    buttonRects = { Alpha: { left: 200, right: 300 } }
    const { wrapper } = renderInWrapper('a')
    expect(wrapper.scrollLeft).toBe(0)
    expect(wrapper.style.scrollBehavior).toBe('')
  })

  // Mutation-gate follow-up: the ternary picking which side to move by
  // (`overflowLeft > 0 ? -overflowLeft : overflowRight`) needs its own
  // EXACT-ZERO case on `overflowLeft` too — every "moves RIGHT" test above
  // has `overflowLeft` strictly negative, which cannot tell `> 0` apart
  // from `>= 0` (both agree there); only `overflowLeft === 0` disagrees.
  it('boundary: overflowLeft exactly 0 while overflowRight is positive still moves by overflowRight, not by -overflowLeft', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    // overflowLeft = 0 - 0 = 0 (not > 0); overflowRight = 350 - 300 = 50.
    buttonRects = { Alpha: { left: 0, right: 350 } }
    const { wrapper } = renderInWrapper('a')
    // If the ternary picked -overflowLeft (i.e. treated 0 as "> 0"), the
    // delta would be -0 = 0 and scrollLeft would stay 0 instead of 50.
    expect(wrapper.scrollLeft).toBe(50)
  })

  // Mutation-gate follow-up: pins BOTH string literals of the ternary that
  // picks `scrollBehavior` — a StringLiteral mutant emptying either one
  // passed every test above because none of them asserted on the value.
  it('sets scrollBehavior to "smooth" when motion is not reduced', () => {
    mockReducedMotion = false
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    const { wrapper } = renderInWrapper('b')
    expect(wrapper.scrollLeft).toBe(200)
    expect(wrapper.style.scrollBehavior).toBe('smooth')
  })

  it('sets scrollBehavior to "auto" when the viewer prefers reduced motion', () => {
    mockReducedMotion = true
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    const { wrapper } = renderInWrapper('b')
    expect(wrapper.scrollLeft).toBe(200)
    expect(wrapper.style.scrollBehavior).toBe('auto')
  })

  // Pins the optional-chaining guard on `activeRef.current` — without it, a
  // render where NO tab matches `value` (e.g. the parent passed a stale/
  // unknown value for one tick) would throw instead of silently no-op-ing.
  it('never throws when no tab matches the current value (activeRef stays null)', () => {
    expect(() =>
      render(<AnimatedTabs tabs={TABS} value="does-not-exist" onChange={vi.fn()} />),
    ).not.toThrow()
  })

  // SR-L-7 (security-review, fix-round 4, PR #675): an `overflow: visible`
  // ancestor with an overflowing child reports the exact same `scrollWidth
  // > clientWidth` inequality a real scroll container does, without
  // scrolling anything — the pre-round-4 predicate could not tell the two
  // apart and would stop (and mutate `.scrollLeft`) on the wrong one,
  // never reaching the real `overflow-x-auto` wrapper one level further
  // out. `wrapper` (outer, `overflow-x: auto`) and `inner-visible` (its
  // child, `overflow: visible`) both report overflowing geometry here; only
  // `wrapper` may end up with a non-zero `scrollLeft`.
  it('an "overflow: visible" ancestor with an overflowing child is walked past, not selected as the scroll container', () => {
    wrapperGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300 }
    extraGeometry['inner-visible'] = {
      scrollWidth: 800,
      clientWidth: 300,
      left: 0,
      right: 300,
      overflowX: 'visible',
    }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    render(
      <div data-testid="wrapper">
        <div data-testid="inner-visible">
          <AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />
        </div>
      </div>,
    )
    const wrapper = screen.getByTestId('wrapper')
    const innerVisible = screen.getByTestId('inner-visible')
    // overflowRight = buttonRect.right(500) - containerRect.right(300) = 200
    expect(wrapper.scrollLeft).toBe(200)
    expect(innerVisible.scrollLeft).toBe(0)
  })

  // SR-L-7: the walk stops AT `document.body` and never continues to
  // `document.documentElement` (`<html>`) — rendering with no
  // `overflow-x-auto` ancestor anywhere (e.g. `RequisitesEditForm.tsx`) is
  // a legitimate "nothing to do" outcome, not a reason to fall back to a
  // page-wide element. Neither `<body>` nor `<html>` should ever have its
  // `scroll-behavior` (or anything else) written.
  it('boundary: no scrollable ancestor anywhere in the tree — <body>/<html> style is never touched', () => {
    render(<AnimatedTabs tabs={TABS} value="a" onChange={vi.fn()} />)
    expect(document.body.style.scrollBehavior).toBe('')
    expect(document.documentElement.style.scrollBehavior).toBe('')
    expect(document.body.getAttribute('style')).toBeNull()
  })

  // Mutation-gate follow-up (SR-L-7, fix-round 4, PR #675): every test above
  // exercises the `'auto'` half of `overflowX === 'auto' || overflowX ===
  // 'scroll'` — none of them can tell "the `'scroll'` branch was deleted"
  // apart from "the `'scroll'` branch works", since none of them make
  // `overflowX` equal `'scroll'` in the first place. `overflow-x: scroll`
  // (as opposed to `auto`) is a real, valid CSS value for a scroll
  // container and must be recognized identically.
  it('an ancestor with `overflow-x: scroll` (not `auto`) is recognized as a valid scroll container too', () => {
    extraGeometry['scroll-wrapper'] = {
      scrollWidth: 1000,
      clientWidth: 300,
      left: 0,
      right: 300,
      overflowX: 'scroll',
    }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    render(
      <div data-testid="scroll-wrapper">
        <AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />
      </div>,
    )
    const container = screen.getByTestId('scroll-wrapper')
    // overflowRight = buttonRect.right(500) - containerRect.right(300) = 200
    expect(container.scrollLeft).toBe(200)
  })

  // Mutation-gate follow-up (SR-L-7): pins that the walk stops EXACTLY at
  // `document.body` rather than merely "eventually stopping somewhere
  // harmless". `<html>` here is deliberately made to satisfy BOTH halves
  // of the predicate (`overflow-x: auto` AND `scrollWidth > clientWidth`)
  // — if the body check were ever skipped (or inverted), this is the one
  // scenario where the walk would keep going, find `<html>` a valid match,
  // and mutate it. No `wrapper`/`extraGeometry` ancestor exists in this
  // tree, so the ONLY way `scrollLeft`/`style` could end up written on
  // anything is if the walk incorrectly reached `<html>`.
  it('boundary: <html> satisfying the container predicate is still never reached — the walk stops at <body>', () => {
    htmlGeometry = { scrollWidth: 1000, clientWidth: 300, left: 0, right: 300, overflowX: 'auto' }
    buttonRects = { Bravo: { left: 400, right: 500 } }
    render(<AnimatedTabs tabs={TABS} value="b" onChange={vi.fn()} />)
    expect(document.documentElement.scrollLeft).toBe(0)
    expect(document.documentElement.style.scrollBehavior).toBe('')
    expect(document.body.style.scrollBehavior).toBe('')
  })
})
