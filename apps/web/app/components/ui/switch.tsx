/**
 * Switch — standard shadcn/ui primitive over @radix-ui/react-switch.
 *
 * task-notification-settings-ui (position 7b): the first ARIA-`switch` in
 * this codebase (`docs/design/notification-settings.md` §0.3/§4) — the
 * existing `RadioGroup`/`SegmentedToggle` encode "pick one of N", not a
 * binary on/off toggle. Radix gives `role="switch"`, `aria-checked`,
 * `data-state` and Space/Enter keyboard handling for free — this file only
 * adds the project's token styling (§3 of the design spec).
 */
import * as React from 'react'
import * as SwitchPrimitives from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full bg-primary-foreground shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
