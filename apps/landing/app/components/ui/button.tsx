import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// Marketing size scale (landing-redesign.md §2.3 `.cc-btn`): default=46px /
// sm=40px / lg=52px, `active:translate-y-px` "press" instead of the CRM's
// `active:scale-[0.98]` — visually different from apps/web on purpose, this
// is a SEPARATE workspace/component-lib, not shared with the CRM.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium tracking-[-0.01em] transition-all duration-200 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[3px] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-200',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary)_92%,white)] hover:shadow-[0_8px_30px_-8px_var(--marketing-glow)] hover:[&_svg]:translate-x-[3px] active:translate-y-px',
        destructive:
          'bg-destructive text-white shadow-sm hover:bg-destructive/90 active:translate-y-px',
        outline:
          'border border-border bg-transparent hover:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] active:translate-y-px',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-secondary hover:text-secondary-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[46px] px-[22px] py-0',
        sm: 'h-10 rounded-[10px] px-4 text-[0.9rem]',
        lg: 'h-[52px] rounded-[10px] px-7 text-base',
        icon: 'h-[46px] w-[46px]',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      block: false,
    },
  },
)

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, block, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
