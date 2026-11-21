import * as React from 'react'
import { useDeviceClass } from '@/hooks/use-device-class'
import { BottomSheet, type SheetDetents } from './bottom-sheet'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

// The sheet's own close, so one button serves all three presentations.
const CloseContext = React.createContext<() => void>(() => {})

/**
 * A close button for `children` or `footer` that works in whichever presentation is active.
 * A bare `SheetClose` / `DialogClose` / `Drawer.Close` has no context in the other presentations.
 * It calls `onOpenChange(false)` even while `dismissible={false}`: pressing it is an explicit
 * close, which `dismissible` does not guard; hide or disable it while a write is in flight.
 */
export function ResponsiveSheetClose(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
): React.JSX.Element {
  const close = React.useContext(CloseContext)
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        props.onClick?.(event)
        close()
      }}
    />
  )
}

export interface ResponsiveSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode // rendered as the accessible name on every class
  description?: React.ReactNode | undefined
  detents?: SheetDetents | undefined // mobile only; default ['content']
  side?: 'right' | 'center' | undefined // tablet/desktop presentation; default 'right'
  dismissible?: boolean | undefined // default true; false while a write is in flight
  footer?: React.ReactNode | undefined // sticky action bar, above the keyboard on mobile
  children: React.ReactNode
}

/**
 * One sheet API, three presentations picked by `useDeviceClass()`: a Base UI bottom sheet on
 * mobile, the Radix side `Sheet` (`side="right"`) or the centred `Dialog` (`side="center"`) on
 * tablet and desktop. The dialog element carries `data-presentation="bottom" | "side" | "center"`.
 *
 * `children` and `footer` render inside the active presentation, so nested popovers and selects
 * behave as in any dialog. Close from inside with `ResponsiveSheetClose` (or `onOpenChange(false)`),
 * never a presentation's own `*Close` part. Crossing a breakpoint while open swaps the presentation
 * and remounts both: keep form state above the sheet (a controlled form), not in uncontrolled
 * inputs. Focus and scroll position inside the content are not carried across. Keep the queries
 * the content reads above the sheet too (or give them a non-zero `staleTime`), so the remount
 * does not refetch.
 *
 * `dismissible={false}`: Escape, an outside press, swipe-down, Android back and the built-in close
 * controls do not reach `onOpenChange` on any class; `ResponsiveSheetClose` still does.
 *
 * Never open a mobile (bottom) sheet from inside a Radix modal dialog: it reads the global
 * `pointer-events: none` that dialog puts on <body> as a nested layer, so every outside press is
 * refused and Android back is sent to the dialog underneath as an Escape.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  detents,
  side,
  dismissible = true,
  footer,
  children,
}: ResponsiveSheetProps): React.JSX.Element {
  const device = useDeviceClass()
  const close = () => onOpenChange(false)

  if (device === 'mobile') {
    return (
      <CloseContext.Provider value={close}>
        <BottomSheet
          open={open}
          onOpenChange={onOpenChange}
          title={title}
          description={description}
          detents={detents}
          dismissible={dismissible}
          footer={footer}
        >
          {children}
        </BottomSheet>
      </CloseContext.Provider>
    )
  }

  const handleOpenChange = (next: boolean) => {
    if (next || dismissible) onOpenChange(next)
  }
  // Inner padding keeps focus rings of edge-to-edge fields clear of the scroll container's clip.
  const scrollArea = (
    <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-1">{children}</div>
  )

  if (side === 'center') {
    return (
      <CloseContext.Provider value={close}>
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            data-presentation="center"
            showCloseButton={dismissible}
            className="flex max-h-[calc(100dvh-2rem)] flex-col"
          >
            {/* pr-8 keeps a long title clear of the absolutely placed close control. */}
            <DialogHeader className="pr-8">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </DialogHeader>
            {scrollArea}
            {footer ? (
              <div data-slot="sheet-footer" className="flex shrink-0 justify-end gap-2">
                {footer}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </CloseContext.Provider>
    )
  }

  return (
    <CloseContext.Provider value={close}>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          data-presentation="side"
          showCloseButton={dismissible}
          className="flex w-full flex-col sm:max-w-[400px] lg:max-w-[420px] min-[90rem]:max-w-[480px]"
        >
          <SheetHeader className="pr-8">
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
          {scrollArea}
          {footer ? (
            <div
              data-slot="sheet-footer"
              className="flex shrink-0 justify-end gap-2 border-t border-border pt-4"
            >
              {footer}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </CloseContext.Provider>
  )
}
