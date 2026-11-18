import * as React from 'react'
import { Drawer } from '@base-ui/react/drawer'
import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

type HeightDetent = 'half' | 'full'
/**
 * `['content']`: no snap points, the sheet is as tall as its content (capped at the viewport).
 * Otherwise the sheet is viewport-tall and opens at the first detent: `half` shows the top 50 %,
 * `full` all of it. Base UI snap points are heights, so "as tall as the content" cannot be one of
 * several; the type keeps `content` alone.
 */
export type SheetDetents = readonly ['content'] | readonly [HeightDetent, ...HeightDetent[]]

const SNAP_POINT: Record<HeightDetent, number> = { half: 0.5, full: 1 }

export interface BottomSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode | undefined
  /** Default `['content']`. */
  detents?: SheetDetents | undefined
  /** `false` hides the close control; Escape, swipe-down and an outside press are refused. */
  dismissible?: boolean | undefined
  footer?: React.ReactNode | undefined
  children: React.ReactNode
}

/**
 * Mobile bottom sheet on the Base UI `Drawer`: drag handle, detents, safe-area padding and a footer
 * that rides above the on-screen keyboard. The popup carries `role="dialog"` and
 * `data-state="open"` like a Radix dialog, so `useAnyDialogOpen()` counts it.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  detents = ['content'],
  dismissible = true,
  footer,
  children,
}: BottomSheetProps): React.JSX.Element {
  const { t } = useLingui()
  const snapPoints =
    detents[0] === 'content'
      ? undefined
      : [...new Set((detents as readonly HeightDetent[]).map((d) => SNAP_POINT[d]))]
  // Controlled, so every open starts at the first detent: Base UI keeps the last one across a
  // caller-driven close.
  const [snapPoint, setSnapPoint] = React.useState<Drawer.Root.SnapPoint | null | undefined>(
    snapPoints?.[0],
  )
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSnapPoint(snapPoints?.[0])
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next, details) => {
        // An open Radix modal layer (Select, DropdownMenu) sets `pointer-events: none` on <body>.
        // It closes itself on pointerdown, so by the click Base UI reads as an outside press the
        // style is gone; the click then lands on <html>, which the backdrop otherwise always covers.
        const nestedModalOpen = document.body.style.pointerEvents === 'none'
        const nestedLayerDismiss =
          // A Radix layer inside the sheet (date popover, select) dismissed itself on this Escape.
          (details.reason === 'escape-key' && details.event.defaultPrevented) ||
          (details.reason === 'outside-press' &&
            (nestedModalOpen || details.event.target === document.documentElement)) ||
          // Android back while a nested modal layer is open is meant for that layer.
          (details.reason === 'close-watcher' && nestedModalOpen)
        if (!nestedLayerDismiss && (next || dismissible)) {
          onOpenChange(next)
          return
        }
        // Refused, not ignored: Base UI then settles a swipe back on its snap point.
        details.cancel()
      }}
      snapPoints={snapPoints}
      snapPoint={snapPoints ? snapPoint : undefined}
      onSnapPointChange={setSnapPoint}
    >
      <Drawer.VirtualKeyboardProvider>
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
          <Drawer.Viewport className="fixed inset-0 z-50 flex items-end">
            <Drawer.Popup
              data-presentation="bottom"
              data-state={
                open
                  ? 'open'
                  : // Stryker disable next-line StringLiteral: the popup stays mounted while closed only during its exit animation, which happy-dom never runs; the closed case of useAnyDialogOpen is asserted after unmount.
                    'closed'
              }
              className={cn(
                // Stryker disable next-line StringLiteral: pure layout and surface (flex/width/radius/colour); happy-dom computes no layout, so no test can tell these classes apart from none.
                'flex max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full flex-col rounded-t-xl border-t border-border bg-card text-card-foreground shadow-xl outline-none',
                snapPoints && 'h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)]',
                // Stryker disable next-line StringLiteral: visual position only; Base UI resolves the snap offset itself (asserted through --drawer-snap-point-offset), happy-dom applies no transform.
                '[transform:translateY(calc(var(--drawer-snap-point-offset,0px)_+_var(--drawer-swipe-movement-y,0px)))]',
                // A fixed-height sheet slides down by the snap offset; the same padding keeps the footer
                // in view. A content sheet would only grow by it, so it gets none.
                snapPoints &&
                  '[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset,0px)_+_var(--drawer-swipe-movement-y,0px)))] data-[ending-style]:[padding-bottom:0] data-[starting-style]:[padding-bottom:0]',
                'transition-transform duration-300 ease-out data-[swiping]:transition-none motion-reduce:transition-none',
                // Stryker disable next-line StringLiteral: enter and exit slide only; happy-dom runs no transitions and Base UI never sets starting/ending style there.
                'data-[ending-style]:[transform:translateY(100%)] data-[starting-style]:[transform:translateY(100%)]',
              )}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Decorative: the close control and Escape are the accessible ways out. */}
                <div aria-hidden className="flex h-6 shrink-0 items-center justify-center">
                  <div className="h-[5px] w-9 rounded-full bg-muted-foreground/40" />
                </div>
                <div className="flex shrink-0 items-start gap-2 px-4 pb-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Drawer.Title className="text-lg font-semibold text-foreground">
                      {title}
                    </Drawer.Title>
                    {description ? (
                      <Drawer.Description className="text-sm text-muted-foreground">
                        {description}
                      </Drawer.Description>
                    ) : null}
                  </div>
                  {dismissible ? (
                    <Drawer.Close
                      aria-label={t`Закрити`}
                      className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-5 w-5" aria-hidden />
                    </Drawer.Close>
                  ) : null}
                </div>
                <Drawer.Content
                  className={cn(
                    // Stryker disable next-line StringLiteral: pure layout (scroll container sizing and padding); happy-dom computes no layout or overflow.
                    'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4',
                    // Stryker disable next-line StringLiteral: bottom padding only (safe-area inset without a footer); happy-dom has no safe-area or layout.
                    footer ? 'pb-4' : 'pb-[max(1rem,env(safe-area-inset-bottom))]',
                  )}
                >
                  {children}
                </Drawer.Content>
                {footer ? (
                  <div
                    data-slot="sheet-footer"
                    className="shrink-0 border-t border-border bg-card px-4 pt-3 pb-[calc(0.75rem+max(env(safe-area-inset-bottom),var(--drawer-keyboard-inset,0px)))]"
                  >
                    {footer}
                  </div>
                ) : null}
              </div>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.VirtualKeyboardProvider>
    </Drawer.Root>
  )
}
