import { useEffect, useId, useRef } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
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

export function AnimatedTabs({ tabs, value, onChange, className }: AnimatedTabsProps) {
  // Unique layout group ID per AnimatedTabs instance so multiple tab bars on the
  // page don't share the same pill animation
  const groupId = useId()
  // UX-H-1 (design review, PR #675 fix-round 2): a tab bar with more tabs than
  // fit the viewport (e.g. UserProfileShell's four self-profile tabs at
  // 320/375) lives inside a `overflow-x-auto` ancestor — scrolling DOES work
  // (verified: the ancestor's scrollWidth/clientWidth genuinely differ, and a
  // manual `scrollLeft` change moves the tab into view), but nothing ever
  // scrolled the CURRENTLY ACTIVE tab into view on mount or on change. A deep
  // link to a trailing tab (`?tab=notifications`) landed at scroll position 0,
  // so the just-navigated-to tab sat mostly clipped at the right edge —
  // technically reachable by a manual swipe, but nothing told the viewer that
  // swiping was the way to see what they just opened. `scrollIntoView` on the
  // active button (mount AND every `value` change) makes the active tab
  // visible without the viewer discovering the gesture on their own; the
  // `{ block: 'nearest', inline: 'nearest' }` options move ONLY the
  // horizontal scroll ancestor (this bar's own `overflow-x-auto` wrapper),
  // never the page's vertical scroll — this component has no idea whether
  // it's inside a sticky header or not, so it must not touch the page scroll.
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value])
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
