import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Marketing card primitive (landing-redesign.md §2.2 `.cc-card`). `apps/web`
 * has its own `card.tsx` — this is a SEPARATE workspace/component-lib, not
 * shared with the CRM, so it is re-created here rather than imported.
 *
 * `hover` enables the `cc-card-hover` treatment (border tint + lift) — only
 * for cards that are themselves clickable (VacancyCard, Services).
 *
 * `glow` (§M.2) adds the same `box-shadow` glow used on the primary button,
 * on top of `hover` — ServiceCard ONLY (CaseStudyCard/ProcessStep stay
 * without hover entirely — see §M.2 "элементы без hover").
 */
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  hover?: boolean
  glow?: boolean
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, hover = false, glow = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border bg-card p-6 transition-[border-color,transform,background,box-shadow] duration-300 md:p-[30px]',
        hover &&
          'hover:-translate-y-[3px] hover:border-[color-mix(in_oklch,var(--primary)_40%,transparent)]',
        glow && 'hover:shadow-[0_20px_60px_-30px_var(--marketing-glow)]',
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = 'Card'

export { Card }
