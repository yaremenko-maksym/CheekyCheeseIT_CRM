import { cn } from '@/lib/utils'

const WEDGE =
  'M 112 112 L 422 215 A 18 18 0 0 1 432 233 L 432 402 A 18 18 0 0 1 414 416 L 110 416 A 18 18 0 0 1 96 398 L 96 124 A 18 18 0 0 1 112 112 Z'

type BrandMarkProps = {
  className?: string
  /** outline = line-art (large sizes); flat = filled (small sizes, ≤32px) */
  variant?: 'outline' | 'flat'
}

/**
 * CheekyCheeseIT brand mark — a cheese wedge whose holes form a `>_` terminal prompt.
 * Color follows `currentColor`; set it via a text-* class (e.g. `text-primary`).
 */
export function BrandMark({ className, variant = 'outline' }: BrandMarkProps) {
  if (variant === 'flat') {
    return (
      <svg viewBox="0 0 512 512" role="img" aria-label="CheekyCheeseIT" className={cn(className)}>
        <path d={WEDGE} fill="currentColor" />
        <g className="text-background" fill="currentColor">
          <circle cx="190" cy="216" r="25" />
          <circle cx="244" cy="274" r="34" />
          <circle cx="190" cy="332" r="25" />
          <rect x="302" y="258" width="84" height="32" rx="13" />
        </g>
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="CheekyCheeseIT"
      fill="none"
      stroke="currentColor"
      className={cn(className)}
    >
      <path d={WEDGE} strokeWidth="18" strokeLinejoin="round" />
      <g strokeLinecap="round">
        <circle cx="192" cy="216" r="14" strokeWidth="10" />
        <circle cx="240" cy="272" r="20" strokeWidth="12" />
        <circle cx="192" cy="328" r="14" strokeWidth="10" />
        <rect x="300" y="258" width="80" height="28" rx="13" strokeWidth="11" />
        <circle cx="396" cy="340" r="9" strokeWidth="7" />
      </g>
    </svg>
  )
}
