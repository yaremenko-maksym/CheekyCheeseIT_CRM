import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Domain badge (landing-redesign.md §2.2 `.cc-tag`). Semantically distinct
 * from `Badge` (CRM roles/statuses) — this is the AI/EdTech/E-Commerce
 * differentiator used across Selected work / Services / VacancyCard / vacancy
 * detail meta-tags. `neutral` is also used for non-domain meta chips
 * (seniority/employment-type/location on the vacancy detail page) AND as the
 * fallback for the 13 domains `task-domains-expansion` widened the vacancy
 * enum with (`lib/vacancy-domain.ts` — no brand hue assigned to those on
 * purpose). `open` is a DIFFERENT thing: the 4th Services card ("Any
 * domain") isn't a domain missing a colour, it's a deliberate non-domain
 * invitation chip — reusing `neutral` there made it read as a styling
 * oversight next to three uppercase/tracked/coloured siblings (task
 * fix-service-card-fourth-chip). `open` keeps the same base
 * uppercase/tracking/weight as the domain variants (no override, unlike
 * `neutral`) so the row still reads as one family, but a dashed border +
 * brand-gold tint (same hue as the primary CTA/focus ring) marks it as
 * "open slot", not "one of the three". Do NOT repoint `neutral`'s consumers
 * to `open` — they mean "no brand colour", not "no domain".
 */
export type TagVariant = 'ai' | 'edtech' | 'ecommerce' | 'open' | 'neutral'

const VARIANT_CLASSES: Record<TagVariant, string> = {
  ai: 'text-tag-ai bg-[color-mix(in_oklch,var(--tag-ai)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-ai)_28%,transparent)]',
  edtech:
    'text-tag-edtech bg-[color-mix(in_oklch,var(--tag-edtech)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-edtech)_28%,transparent)]',
  ecommerce:
    'text-tag-ecommerce bg-[color-mix(in_oklch,var(--tag-ecommerce)_12%,transparent)] border-[color-mix(in_oklch,var(--tag-ecommerce)_28%,transparent)]',
  // NOTE (found while building this variant, NOT fixed here — out of scope
  // for a single-card fix): `globals.css`'s `* { border-color: var(--border) }`
  // reset is unlayered, and unlayered rules always beat `@layer utilities`
  // in the cascade regardless of source order — so EVERY `border-color`
  // this file's variants set (`ai`/`edtech`/`ecommerce` too, verified via
  // computed style, not just `open`) silently loses to the grey default.
  // `border-dashed` (a border-STYLE, untouched by that reset) still renders
  // correctly, so it — plus the text/background tint below, both of which
  // DO apply — carries the "deliberately different" signal on its own.
  open: 'text-primary bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] border-dashed border-[color-mix(in_oklch,var(--primary)_45%,transparent)]',
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
