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
 *
 * §M.2a HOTFIX (2026-07-24) — `will-change-transform` on the `hover` variant
 * only (static, non-hoverable cards get no transition at all, so nothing to
 * pre-promote). Root cause of the reported "jump": `ServiceCard`/`VacancyCard`
 * live inside a `ScrollReveal` wrapper whose ALWAYS-active inline
 * `transform`/`opacity` creates a new compositing context for the whole
 * subtree; the browser doesn't pre-promote this NESTED hover-only element to
 * its own compositor layer until the very first `:hover` fires, and that
 * first "layer promotion" frame can show a visible micro-jump/subpixel-snap
 * (documented Chrome/compositor behavior for a transform nested inside an
 * already-transformed/opacity'd ancestor). `will-change-transform`
 * pre-promotes the element BEFORE the first hover, per
 * `make-interfaces-feel-better`'s sanctioned use of `will-change` ("only for
 * first-frame stutter on compositor-friendly properties").
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
        'rounded-2xl border border-border bg-card p-6 transition-[border-color,transform,background,box-shadow] duration-300 ease-out md:p-[30px]',
        hover &&
          'will-change-transform hover:-translate-y-[3px] hover:border-[color-mix(in_oklch,var(--primary)_40%,transparent)]',
        glow && 'hover:shadow-[0_20px_60px_-30px_var(--marketing-glow)]',
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = 'Card'

export { Card }
