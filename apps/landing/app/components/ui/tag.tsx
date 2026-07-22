import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Domain badge (landing-redesign.md §2.2 `.cc-tag`). Semantically distinct
 * from `Badge` (CRM roles/statuses) — this is the AI/EdTech/E-Commerce
 * differentiator used across Selected work / Services / VacancyCard / vacancy
 * detail meta-tags. `neutral` is also used for non-domain meta chips
 * (seniority/employment-type/location on the vacancy detail page).
 */
export type TagVariant = 'ai' | 'edtech' | 'ecommerce' | 'neutral'

const VARIANT_CLASSES: Record<TagVariant, string> = {
  ai: 'text-tag-ai bg-[color-mix(in_oklch,var(--tag-ai)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-ai)_28%,transparent)]',
  edtech:
    'text-tag-edtech bg-[color-mix(in_oklch,var(--tag-edtech)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-edtech)_28%,transparent)]',
  ecommerce:
    'text-tag-ecommerce bg-[color-mix(in_oklch,var(--tag-ecommerce)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-ecommerce)_28%,transparent)]',
  neutral:
    'font-medium normal-case tracking-normal text-muted-foreground bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] border-border',
}

interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: TagVariant
}

const Tag = React.forwardRef<HTMLSpanElement, TagProps>(
  ({ className, variant = 'neutral', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-[11px] py-1 text-[0.74rem] font-semibold tracking-[0.04em] uppercase',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  ),
)
Tag.displayName = 'Tag'

export { Tag }
