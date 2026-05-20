import { useId } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface AnimatedTabsProps {
  tabs: Array<{ value: string; label: string }>
  value: string
  onChange: (value: string) => void
  className?: string
}

export function AnimatedTabs({ tabs, value, onChange, className }: AnimatedTabsProps) {
  // Unique layout group ID per AnimatedTabs instance so multiple tab bars on the
  // page don't share the same pill animation
  const groupId = useId()
  return (
    <LayoutGroup id={groupId}>
      <div
        className={cn(
          'relative inline-flex items-center gap-1 rounded-lg border bg-muted/30 p-1',
          className,
        )}
      >
        {tabs.map((tab) => {
          const active = value === tab.value
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => onChange(tab.value)}
              className={cn(
                'relative inline-flex items-center justify-center rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId="animated-tab-pill"
                  className="absolute inset-0 rounded-md bg-background shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  aria-hidden
                />
              )}
              <span className="relative z-10 whitespace-nowrap">{tab.label}</span>
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
