import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Pill with a dot indicator (landing-redesign.md §2.2 `.cc-chip`) — hero
 * eyebrow strip + tech-stack grid. Distinct from `Tag` (domain semantics) and
 * `Badge` (CRM roles/statuses).
 */
const Chip = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex min-h-10 items-center gap-[7px] rounded-full border border-border bg-[color-mix(in_oklch,var(--card)_60%,transparent)] px-3.5 py-2 font-mono text-[0.86rem] text-foreground/82 transition-[border-color,color,transform] duration-200 hover:-translate-y-px hover:border-[color-mix(in_oklch,var(--primary)_55%,transparent)] hover:text-foreground',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-primary/80" />
      {children}
    </span>
  ),
)
Chip.displayName = 'Chip'

export { Chip }
