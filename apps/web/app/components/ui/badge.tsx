import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive: 'border-transparent bg-destructive text-white shadow hover:bg-destructive/80',
        outline: 'text-foreground border-border',
        admin: 'border-yellow-500/30 bg-yellow-500/15 text-yellow-400',
        senior: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
        junior: 'border-green-500/30 bg-green-500/15 text-green-400',
        hr: 'border-purple-500/30 bg-purple-500/15 text-purple-400',
        accountant: 'border-orange-500/30 bg-orange-500/15 text-orange-400',
        // Drop role - phase 1: cyan/teal pill, distinct from senior (blue)
        // and HR (purple) so the financial-proxy persona reads at a glance.
        drop: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-400',
        // Status variants for project/contract/salary badges (junior hub)
        // Using CSS var tokens — no hardcoded hex values.
        'status-active': 'border-green-500/30 bg-green-500/10 text-green-400',
        'status-closed': 'border-transparent bg-secondary text-secondary-foreground',
        paid: 'border-green-500/30 bg-green-500/10 text-green-400',
        pending: 'border-transparent bg-secondary text-secondary-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
