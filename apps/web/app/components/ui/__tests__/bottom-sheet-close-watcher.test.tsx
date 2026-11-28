/**
 * bottom-sheet.tsx — Android back through the real Base UI path (PR #1401, fix round 4, F4-1/F4-5).
 *
 * Base UI opens a `CloseWatcher` only on Android (user agent read when its platform module loads)
 * and only when `window.CloseWatcher` exists. happy-dom has neither, so this file fakes both before
 * any import: the user agent says Android, and `CloseWatcher` is an EventTarget the test fires
 * `cancel` on, cancelable (the first back press after a user activation) or not (a later one).
 * Like the browser, a back goes to every live watcher, newest first, until one prevents it; a
 * watcher whose `cancel` is not prevented closes and is destroyed.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { useLayoutEffect, useState } from 'react'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { useAnyDialogOpen } from '@/hooks/use-any-dialog-open'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { BottomSheet } from '../bottom-sheet'
import { DatePickerField } from '../date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

const watchers = vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
  })
  const list: EventTarget[] = []
  class FakeCloseWatcher extends EventTarget {
    constructor() {
      super()
      list.push(this)
    }
    destroy() {
      const i = list.indexOf(this)
      if (i >= 0) list.splice(i, 1)
    }
  }
  Object.defineProperty(window, 'CloseWatcher', { configurable: true, value: FakeCloseWatcher })
  return list
})

beforeAll(() => loadCatalog('uk'), 60_000)

function back(cancelable: boolean): Event {
  let event = new Event('cancel', { cancelable })
  act(() => {
    for (const watcher of [...watchers].reverse() as (EventTarget & { destroy(): void })[]) {
      if (!watchers.includes(watcher)) continue // destroyed by an earlier handler
      event = new Event('cancel', { cancelable })
      watcher.dispatchEvent(event)
      if (event.defaultPrevented) break
      // Not prevented: the browser closes the watcher, which destroys it.
      watcher.destroy()
    }
  })
  return event
}

// Every value `useAnyDialogOpen()` took while the sheet was mounted, to catch a closed flicker.
const dialogOpenSeen: boolean[] = []
function DialogOpenProbe() {
  const open = useAnyDialogOpen()
  useLayoutEffect(() => {
    dialogOpenSeen.push(open)
  }, [open])
  return null
}

function Harness({
  dismissible = true,
  tooltip = false,
  tooltipLabel,
  tooltipOpen,
  refuseClose = false,
  onOpenChange,
}: {
  dismissible?: boolean
  tooltip?: boolean
  /** Radix moves `role="tooltip"` off the content when it has an `aria-label`. */
  tooltipLabel?: string
  /** The caller hears the close request but keeps the sheet open. */
  refuseClose?: boolean
  /** Unset: the tooltip opens on mount; set: it follows this prop. */
  tooltipOpen?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  // The prop opens the tooltip later; an Escape still closes it through this state.
  const [tipOpen, setTipOpen] = useState(tooltipOpen)
  const [tipProp, setTipProp] = useState(tooltipOpen)
  if (tooltipOpen !== tipProp) {
    setTipProp(tooltipOpen)
    setTipOpen(tooltipOpen)
  }
  const [date, setDate] = useState('')
  return (
    <I18nTestProvider>
      <DialogOpenProbe />
      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          if (!refuseClose) setOpen(next)
        }}
        title="T"
        dismissible={dismissible}
      >
        <input aria-label="Amount" />
        <DatePickerField value={date} onChange={setDate} data-testid="date" />
        <Select>
          <SelectTrigger aria-label="Kind">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
          </SelectContent>
        </Select>
        {/* A modal layer without a popper wrapper: only the <body> style signals it. */}
        <Select>
          <SelectTrigger aria-label="Mode">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
          <SelectContent position="item-aligned">
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
        {tooltip && (
          <TooltipProvider>
            <Tooltip
              {...(tipOpen === undefined
                ? { defaultOpen: true }
                : { open: tipOpen, onOpenChange: setTipOpen })}
            >
              <TooltipTrigger>Info</TooltipTrigger>
              <TooltipContent {...(tooltipLabel ? { 'aria-label': tooltipLabel } : {})}>
                Hint
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </BottomSheet>
    </I18nTestProvider>
  )
}

function Controlled({ open, nestedOpen = false }: { open: boolean; nestedOpen?: boolean }) {
  return (
    <I18nTestProvider>
      <BottomSheet open={open} onOpenChange={() => {}} title="Outer" dismissible={false}>
        <input aria-label="Amount" />
        <BottomSheet open={nestedOpen} onOpenChange={() => {}} title="Inner">
          <p>Inner</p>
        </BottomSheet>
      </BottomSheet>
    </I18nTestProvider>
  )
}

async function renderSheet(dismissible = true, tooltip = false) {
  dialogOpenSeen.length = 0
  const onOpenChange = vi.fn()
  render(<Harness dismissible={dismissible} tooltip={tooltip} onOpenChange={onOpenChange} />)
  await screen.findByRole('dialog')
  return onOpenChange
}

describe('BottomSheet Android back (fake CloseWatcher; happy-dom has none)', () => {
  beforeAll(() => {
    // Radix Select calls pointer-capture and scroll APIs happy-dom does not implement.
    const proto = Element.prototype as unknown as Record<string, unknown>
    proto.hasPointerCapture ??= () => false
    proto.releasePointerCapture ??= () => {}
    proto.scrollIntoView ??= () => {}
  })

  it('closes a dismissible sheet when no nested layer is open', async () => {
    const onOpenChange = await renderSheet()

    const event = back(true)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('with a select open, closes the select and keeps the sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet()
    screen.getByRole('combobox', { name: 'Kind' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    const event = back(true)

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('with an item-aligned select open (no popper wrapper), closes the select and keeps the sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet()
    screen.getByRole('combobox', { name: 'Mode' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    const event = back(true)

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // The layer recorded at pointerdown applies to that outside press only, not to a later Escape.
  it('an Escape after a tap that closed the date popover closes the sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet()
    await user.click(screen.getByTestId('date'))
    await screen.findByRole('grid')
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('with the date popover open, closes the popover and keeps the sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet()
    await user.click(screen.getByTestId('date'))
    await screen.findByRole('grid')

    const event = back(true)

    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('refuses a cancelable back while not dismissible', async () => {
    const onOpenChange = await renderSheet(false)

    const event = back(true)

    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // The browser lets one close request per user activation be prevented; without a new activation
  // every later back is not cancelable, and Base UI closes on it regardless and loses its watcher.
  // A not-dismissible sheet refuses them all with its own watcher, and its content stays mounted.
  it('back, back, back with no tap keeps a not-dismissible sheet open with its content intact', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet(false)
    const dialog = screen.getByRole('dialog')
    const amount = screen.getByRole('textbox', { name: 'Amount' })
    await user.type(amount, '42')
    expect(back(true).defaultPrevented).toBe(true)

    for (let i = 0; i < 3; i++) {
      const before = watchers.at(-1)
      back(false)
      expect(watchers).toHaveLength(1)
      expect(watchers.at(-1)).not.toBe(before)
    }

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog).toHaveAttribute('data-state', 'open')
    expect(dialog).not.toHaveAttribute('data-ending-style')
    expect(screen.getByRole('textbox', { name: 'Amount' })).toBe(amount)
    expect(amount).toHaveValue('42')
    expect(amount).toHaveFocus()
    expect(dialogOpenSeen.at(-1)).toBe(true)
    expect(dialogOpenSeen.slice(dialogOpenSeen.indexOf(true))).not.toContain(false)
  })

  it('after a refused non-cancelable back, a cancelable one is refused and keeps the watcher', async () => {
    const onOpenChange = await renderSheet(false)
    back(false)
    const own = watchers.at(-1)

    expect(back(true).defaultPrevented).toBe(true)

    expect(watchers.at(-1)).toBe(own)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // The write finished while the sheet's own watcher was armed: the next back closes it.
  it('once dismissible again, the next back closes the sheet through its own watcher', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<Harness dismissible={false} onOpenChange={onOpenChange} />)
    await screen.findByRole('dialog')
    back(false)
    rerender(<Harness dismissible onOpenChange={onOpenChange} />)

    back(false)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  // The cleanup that destroys the sheet's own watcher: a leaked one would swallow the next back.
  it('closing or unmounting the sheet removes its own watcher', async () => {
    const view = render(<Controlled open />)
    await screen.findByRole('dialog')
    back(false)
    expect(watchers).toHaveLength(1)

    view.rerender(<Controlled open={false} />)
    expect(watchers).toHaveLength(0)

    view.rerender(<Controlled open />)
    await screen.findByRole('dialog')
    back(false)
    expect(watchers).toHaveLength(1)
    view.unmount()
    expect(watchers).toHaveLength(0)
  })

  // After a nested sheet closes, Base UI arms the outer watcher again next to the sheet's own one.
  // One back must be handled once and leave exactly one live watcher.
  it('after a nested sheet closes, a back is handled by one watcher and leaves one', async () => {
    const view = render(<Controlled open />)
    await screen.findByRole('dialog')
    back(false)
    view.rerender(<Controlled open nestedOpen />)
    await waitFor(() => expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2))
    view.rerender(<Controlled open />)
    await waitFor(() => expect(watchers).toHaveLength(2))

    expect(back(true).defaultPrevented).toBe(true)
    expect(watchers).toHaveLength(1)

    back(false)
    expect(watchers).toHaveLength(1)
    back(false)
    expect(watchers).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Outer' })).toHaveAttribute('data-state', 'open')
  })

  // The caller heard the close and kept the sheet open: the next back must still be caught.
  it('when the caller keeps the sheet open after a back, the next back is caught too', async () => {
    const onOpenChange = vi.fn()
    render(<Harness refuseClose onOpenChange={onOpenChange} />)
    await screen.findByRole('dialog')

    back(true)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(watchers).toHaveLength(1))

    back(false)
    expect(onOpenChange).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(watchers).toHaveLength(1))
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
  })

  it('with an aria-labelled tooltip open, back closes a dismissible sheet', async () => {
    const onOpenChange = vi.fn()
    render(<Harness tooltip tooltipLabel="Hint label" onOpenChange={onOpenChange} />)
    await screen.findByRole('dialog')
    // Radix puts the role on a visually hidden child here, not on the content.
    await waitFor(() => expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument())

    const event = back(true)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('with a select open in a not-dismissible sheet, a non-cancelable back closes only the select', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet(false)
    screen.getByRole('combobox', { name: 'Kind' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    back(false)

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
    expect(watchers).toHaveLength(1)
  })

  // A tooltip portaled above an open popover is the top Radix layer, so the forwarded Escape closes
  // only the tooltip; the next back closes the popover.
  it('with a tooltip above the open date popover, back closes the tooltip, then the popover', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    const { rerender } = render(<Harness tooltip tooltipOpen={false} onOpenChange={onOpenChange} />)
    await user.click(await screen.findByTestId('date'))
    await screen.findByRole('grid')
    rerender(<Harness tooltip tooltipOpen onOpenChange={onOpenChange} />)
    await waitFor(() => expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument())

    expect(back(true).defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('grid')).toBeInTheDocument()

    expect(back(true).defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a non-cancelable back closes a dismissible sheet and tells the caller', async () => {
    const onOpenChange = await renderSheet()

    back(false)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  // A tooltip is a popper too, but it is not a layer the back press or a tap should close first.
  it('with a tooltip open, back closes a dismissible sheet', async () => {
    const onOpenChange = await renderSheet(true, true)
    // The tooltip portals outside the modal sheet, which hides the rest of the page from roles.
    await waitFor(() => expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument())

    const event = back(true)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(event.defaultPrevented).toBe(false)
  })

  // Only a tooltip's own popper is skipped: a layer whose content merely holds a tooltip counts.
  it('a popper whose content holds a tooltip deeper down still counts as a layer', async () => {
    const onOpenChange = await renderSheet()
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    wrapper.innerHTML = '<div><p><span role="tooltip">Hint</span></p></div>'
    document.body.append(wrapper)
    // Stands in for the Radix layer, which marks the forwarded Escape handled.
    const layerEscape = vi.fn((e: KeyboardEvent) => e.preventDefault())
    document.addEventListener('keydown', layerEscape, true)
    onTestFinished(() => {
      wrapper.remove()
      document.removeEventListener('keydown', layerEscape, true)
    })

    const event = back(true)

    expect(event.defaultPrevented).toBe(true)
    expect(layerEscape).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('with a tooltip open, an outside press closes a dismissible sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet(true, true)
    // The tooltip portals outside the modal sheet, which hides the rest of the page from roles.
    await waitFor(() => expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument())

    await user.click(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Device note: Android back with a select open inside a not-dismissible sheet.
  it('with a select open in a not-dismissible sheet, back closes the select and keeps the sheet', async () => {
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = await renderSheet(false)
    screen.getByRole('combobox', { name: 'Kind' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    const event = back(true)

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
