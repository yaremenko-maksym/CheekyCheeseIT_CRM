import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Marketing card primitive (landing-redesign.md §2.2 `.cc-card`). `apps/web`
 * has its own `card.tsx` — this is a SEPARATE workspace/component-lib, not
 * shared with the CRM, so it is re-created here rather than imported.
 *
 * `hover` enables the `cc-card-hover` treatment (border tint + lift) — only
 * for cards that are themselves clickable (VacancyCard, Services).
 */
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  hover?: boolean
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, hover = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border bg-card p-6 transition-[border-color,transform,background] duration-300 md:p-[30px]',
        hover &&
          'hover:-translate-y-[3px] hover:border-[color-mix(in_oklch,var(--primary)_40%,transparent)]',
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = 'Card'

export { Card }
