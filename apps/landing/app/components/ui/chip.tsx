import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Pill with a dot indicator (landing-redesign.md §2.2 `.cc-chip`) — hero
 * eyebrow strip + tech-stack grid. Distinct from `Tag` (domain semantics) and
 * `Badge` (CRM roles/statuses).
 *
 * §M v3.4 mobile audit #1 — `items-start` (was `items-center`) + dot
 * `mt-[calc(0.75em-3px)]`: at `items-center`, a WRAPPING (2-line) `Chip`
 * (the hero eyebrow badge wraps on every mobile viewport) centers the dot
 * against the whole 2-line text block instead of the first line, so it
 * visually floats between the lines. The offset is half the gap between the
 * inherited line-height (Tailwind Preflight default `1.5`) and the dot's
 * fixed `size-1.5` (6px): `(1.5em - 6px) / 2`. `em` resolves off the dot's
 * own (inherited) font-size, so this stays correct for any `Chip` caller
 * that overrides text size. Verified mathematically pixel-identical to the
 * old `items-center` result for every SINGLE-line `Chip` (tech-stack grid) —
 * safe as the component's global default, no wrap/no-wrap fork needed.
 */
const Chip = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex min-h-10 items-start gap-[7px] rounded-full border border-border bg-[color-mix(in_oklch,var(--card)_60%,transparent)] px-3.5 py-2 font-mono text-[0.86rem] text-foreground/82 transition-[border-color,color,transform] duration-200 ease-out hover:-translate-y-px hover:border-[color-mix(in_oklch,var(--primary)_55%,transparent)] hover:text-foreground',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="mt-[calc(0.75em-3px)] size-1.5 rounded-full bg-primary/80"
      />
      {children}
    </span>
  ),
)
Chip.displayName = 'Chip'

export { Chip }
