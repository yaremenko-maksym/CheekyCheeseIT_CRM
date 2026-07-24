import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Marketing textarea (landing-redesign.md §2.2) — cover-letter field only.
 * See `input.tsx`'s module doc for why the hover+focus transition uses
 * Tailwind's `[transition:...]` arbitrary-PROPERTY syntax rather than
 * `transition-[<value>]` (which only ever targets `transition-property`,
 * not a duration/easing pair).
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[140px] w-full resize-y rounded-[10px] border border-border bg-input px-3.5 py-[11px] text-[0.95rem] leading-[1.6] text-foreground placeholder:text-foreground/34 [transition:border-color_150ms_ease,box-shadow_200ms_ease] hover:border-[color-mix(in_oklch,var(--foreground)_20%,transparent)] focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/22 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Textarea }
