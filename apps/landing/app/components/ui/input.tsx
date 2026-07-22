import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Marketing text input (landing-redesign.md §2.2 `.cc-input`) — used only by
 * `VacancyApplyForm`. `apps/web` has its own `input.tsx`; this is a
 * SEPARATE workspace/component-lib, re-created here rather than shared.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-[46px] w-full rounded-[10px] border border-border bg-input px-3.5 text-[0.95rem] text-foreground placeholder:text-foreground/34 transition-[border-color,box-shadow] duration-200 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/22 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
