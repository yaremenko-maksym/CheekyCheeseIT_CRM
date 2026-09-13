import { useEffect, useId, useRef } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AnimatedTab {
  value: string
  label: string
  /** Custom aria-label for the tab button. Defaults to `label`. Use this when
   * tests target the button by an aria-label different from the visible text. */
  ariaLabel?: string
  /** When true the tab is rendered non-interactive with a small lock icon. */
  disabled?: boolean
  /** Optional tooltip text shown on hover. The wrapping component renders the
   * actual Tooltip primitives — here we just put the string on the `title`
   * attribute so it works without a TooltipProvider context. Consumers that
   * want a custom Radix Tooltip can wrap the AnimatedTabs button externally. */
  disabledTooltip?: string
}

export interface AnimatedTabsProps {
  tabs: AnimatedTab[]
  value: string
  onChange: (value: string) => void
  className?: string
}

/**
 * SR-L-4 (security-review, fix-round 3, PR #675): finds the nearest REAL
 * scrollable ancestor of `el` by walking the plain DOM `parentElement`
 * chain and checking actual geometry (`scrollWidth > clientWidth`) —
 * deliberately NOT the CSSOM `offsetParent` chain. `AnimatedTabs`'s own
 * root `<div>` below sets `position: relative` (required for the active
 * pill's `layoutId` animation), which makes IT the active button's
 * `offsetParent` — but it is not what actually scrolls; the genuinely
 * overflowing element is the CONSUMER's own `overflow-x-auto` wrapper
 * OUTSIDE this component's root (`UserProfileShell.tsx`, `admin/route.tsx`,
 * `vacancies/$vacancyId.tsx`). A comment that used to live on this function
 * asserted the previous `scrollIntoView`-based approach could not touch
 * anything but that one ancestor "by definition" — that is not something
 * `scrollIntoView` actually guarantees (it walks and can adjust EVERY
 * scrollable ancestor in the chain needed to satisfy `block`/`inline`, not
 * only the nearest one), which is the reason this rewrite stopped calling
 * it altogether and mutates one specific, explicitly-found element instead.
 */
function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    if (node.scrollWidth > node.clientWidth) return node
    node = node.parentElement
  }
  return null
}

export function AnimatedTabs({ tabs, value, onChange, className }: AnimatedTabsProps) {
  // Unique layout group ID per AnimatedTabs instance so multiple tab bars on the
  // page don't share the same pill animation
  const groupId = useId()
  // UX-H-1 (design review, PR #675 fix-round 2): a tab bar with more tabs
  // than fit the viewport (e.g. UserProfileShell's four self-profile tabs
  // at 320/375) lives inside an `overflow-x-auto` ancestor, but nothing
  // ever scrolled the CURRENTLY ACTIVE tab into view on mount or on
  // change — a deep link to a trailing tab (`?tab=notifications`) landed
  // at scroll position 0, clipped mostly out of view at the right edge.
  //
  // SR-L-4 (fix-round 3): the original fix used `scrollIntoView`, which
  // this component has no real control over — depending on the browser and
  // the DOM it happens to be mounted in, it can walk PAST the intended
  // horizontal wrapper and adjust an ancestor's scroll in ways this
  // component never verified (see `findScrollableAncestor` above). This
  // version instead finds ONE specific ancestor by real geometry and
  // mutates ONLY its `scrollLeft`, by exactly the amount needed to bring
  // the active button back inside that ancestor's visible area — the same
  // "nearest" semantics as before, computed by hand instead of delegated.
  const activeRef = useRef<HTMLButtonElement>(null)
  const prefersReducedMotion = useReducedMotion()
  useEffect(() => {
    const button = activeRef.current
    if (!button) return
    const container = findScrollableAncestor(button)
    if (!container) return
    const buttonRect = button.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const overflowLeft = containerRect.left - buttonRect.left
    const overflowRight = buttonRect.right - containerRect.right
    if (overflowLeft <= 0 && overflowRight <= 0) return
    container.style.scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth'
    container.scrollLeft += overflowLeft > 0 ? -overflowLeft : overflowRight
  }, [value, prefersReducedMotion])
  return (
    <LayoutGroup id={groupId}>
      <div
        className={cn(
          'relative inline-flex items-center gap-1 overflow-hidden rounded-lg border bg-muted/30 p-1',
          className,
        )}
      >
        {tabs.map((tab) => {
          const active = value === tab.value
          const disabled = tab.disabled === true
          return (
            <button
              key={tab.value}
              ref={active ? activeRef : undefined}
              type="button"
              onClick={() => {
                if (disabled) return
                onChange(tab.value)
              }}
              disabled={disabled}
              aria-disabled={disabled || undefined}
              aria-label={tab.ariaLabel ?? tab.label}
              title={disabled ? tab.disabledTooltip : undefined}
              className={cn(
                'relative inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId={`animated-tab-pill-${groupId}`}
                  className="absolute inset-0 rounded-md bg-primary shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  aria-hidden
                />
              )}
              <span className="relative z-10 whitespace-nowrap">{tab.label}</span>
              {disabled && <Lock className="relative z-10 h-3 w-3 opacity-70" aria-hidden />}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
