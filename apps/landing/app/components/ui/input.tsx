import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Marketing text input (landing-redesign.md §2.2 `.cc-input`) — used only by
 * `VacancyApplyForm`. `apps/web` has its own `input.tsx`; this is a
 * SEPARATE workspace/component-lib, re-created here rather than shared.
 *
 * Hover border transition (§M.2, HOTFIX 2026-07-24: 180ms, was 150ms — the
 * one hover duration that sat exactly on the "≥150ms" boundary, raised with
 * margin) coexists with the pre-existing focus-visible ring transition
 * (box-shadow, 200ms) — different durations per property, so this needs the
 * FULL `transition` shorthand, not Tailwind's `transition-[<value>]`
 * utility (that one only ever compiles to `transition-property`, which does
 * not accept a duration/easing — an earlier
 * `transition-[border-color_150ms_ease,box-shadow_200ms_ease]` was invalid
 * CSS for that property and silently produced no utility at all, code
 * review caught it by inspecting the compiled stylesheet). Uses Tailwind's
 * arbitrary-PROPERTY syntax `[transition:...]` (`[property:value]` sets the
 * raw CSS property directly — see
 * https://tailwindcss.com/docs/adding-custom-styles#using-arbitrary-properties)
 * with the literal `ease-out` cubic-bezier (§M.2 HOTFIX — explicit
 * `cubic-bezier(0,0,0.2,1)`, not the generic `ease` keyword, since this is
 * raw CSS rather than a `duration-*`/`ease-out` Tailwind utility pair).
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-[46px] w-full rounded-[10px] border border-border bg-input px-3.5 text-[0.95rem] text-foreground placeholder:text-foreground/34 [transition:border-color_180ms_cubic-bezier(0,0,0.2,1),box-shadow_200ms_ease] hover:border-[color-mix(in_oklch,var(--foreground)_20%,transparent)] focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/22 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:!border-destructive aria-invalid:focus-visible:ring-destructive/22',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
