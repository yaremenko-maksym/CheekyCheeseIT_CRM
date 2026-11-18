import * as React from 'react'
import { createPortal } from 'react-dom'
import { useDeviceClass } from '@/hooks/use-device-class'
import { BottomSheet, type SheetDetent } from './bottom-sheet'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

export interface ResponsiveSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode // rendered as the accessible name on every class
  description?: React.ReactNode
  detents?: SheetDetent[] // mobile only; default ['content', 'full']
  side?: 'right' | 'center' // tablet/desktop presentation; default 'right'
  dismissible?: boolean // default true; false while a write is in flight
  footer?: React.ReactNode // sticky action bar, above the keyboard on mobile
  children: React.ReactNode
}

// `display: contents` so the host's layout (padding, flex gap) applies to the caller's nodes.
function createSlot(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.display = 'contents'
  return el
}

/**
 * One sheet API, three presentations picked by `useDeviceClass()`: a Base UI bottom sheet on
 * mobile, the Radix side `Sheet` (`side="right"`) or the centred `Dialog` (`side="center"`) on
 * tablet and desktop. The dialog element carries `data-presentation="bottom" | "side" | "center"`.
 *
 * `children` and `footer` are rendered from ONE fixed position in this component through portals
 * into two detached DOM nodes; each presentation only provides an empty host that adopts those
 * nodes. Crossing a breakpoint while open therefore moves the caller's DOM instead of remounting
 * it, and uncontrolled inputs and component state survive. Focus and scroll position inside the
 * content are not restored after such a move.
 *
 * Because the content is not rendered inside the presentation's React tree, it does not see that
 * tree's context: `SheetClose` / `DialogClose` / `Drawer.Close` placed in `children` do nothing.
 * Close through `onOpenChange` instead.
 *
 * `dismissible={false}`: Escape, an outside press, swipe-down and the built-in close controls do
 * not reach `onOpenChange` on any class.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  detents,
  side = 'right',
  dismissible = true,
  footer,
  children,
}: ResponsiveSheetProps): React.JSX.Element {
  const device = useDeviceClass()
  const [slots] = React.useState(() => ({ body: createSlot(), footer: createSlot() }))
  const [hosted, setHosted] = React.useState(false)

  // Callback refs: a detach of the old host and an attach of the new one land in the same commit.
  const bodyHost = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.appendChild(slots.body)
      setHosted(el !== null)
    },
    [slots],
  )
  const footerHost = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.appendChild(slots.footer)
    },
    [slots],
  )

  const handleOpenChange = (next: boolean) => {
    if (next || dismissible) onOpenChange(next)
  }
  // Radix wires aria-describedby to its Description itself; without one it wants an explicit opt-out.
  const noDescription = description ? {} : { 'aria-describedby': undefined }
  const body = <div ref={bodyHost} style={{ display: 'contents' }} />
  const footerBar = footer ? <div ref={footerHost} style={{ display: 'contents' }} /> : undefined
  // Kept mounted through the presentation's exit animation, until its host leaves the DOM.
  const content = open || hosted

  let shell: React.JSX.Element
  if (device === 'mobile') {
    shell = (
      <BottomSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={title}
        description={description}
        detents={detents}
        dismissible={dismissible}
        footer={footerBar}
      >
        {body}
      </BottomSheet>
    )
  } else if (side === 'center') {
    shell = (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          data-presentation="center"
          {...noDescription}
          className="flex max-h-[calc(100dvh-2rem)] flex-col"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
          {footerBar ? <div className="flex shrink-0 justify-end gap-2">{footerBar}</div> : null}
        </DialogContent>
      </Dialog>
    )
  } else {
    shell = (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          data-presentation="side"
          {...noDescription}
          className="flex w-full flex-col sm:max-w-[400px] lg:max-w-[420px] min-[90rem]:max-w-[480px]"
        >
          <SheetHeader className="pr-8">
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
          {footerBar ? (
            <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-4">
              {footerBar}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <>
      {shell}
      {content ? createPortal(children, slots.body) : null}
      {content && footer ? createPortal(footer, slots.footer) : null}
    </>
  )
}
