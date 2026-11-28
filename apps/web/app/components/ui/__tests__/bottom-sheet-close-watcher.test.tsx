/**
 * bottom-sheet.tsx — Android back through the real Base UI path (PR #1401, fix round 4, F4-1/F4-5).
 *
 * Base UI opens a `CloseWatcher` only on Android (user agent read when its platform module loads)
 * and only when `window.CloseWatcher` exists. happy-dom has neither, so this file fakes both before
 * any import: the user agent says Android, and `CloseWatcher` is an EventTarget the test fires
 * `cancel` on, cancelable (the first back press) or not (a later one).
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
      list.splice(list.indexOf(this), 1)
    }
  }
  Object.defineProperty(window, 'CloseWatcher', { configurable: true, value: FakeCloseWatcher })
  return list
})

beforeAll(() => loadCatalog('uk'), 60_000)

function back(cancelable: boolean): Event {
  const event = new Event('cancel', { cancelable })
  act(() => {
    watchers.at(-1)?.dispatchEvent(event)
  })
  return event
}

function Harness({
  dismissible = true,
  tooltip = false,
  onOpenChange,
}: {
  dismissible?: boolean
  tooltip?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  const [date, setDate] = useState('')
  return (
    <I18nTestProvider>
      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          setOpen(next)
        }}
        title="T"
        dismissible={dismissible}
      >
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
            <Tooltip defaultOpen>
              <TooltipTrigger>Info</TooltipTrigger>
              <TooltipContent>Hint</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </BottomSheet>
    </I18nTestProvider>
  )
}

async function renderSheet(dismissible = true, tooltip = false) {
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

  // The browser lets one close request per user activation be prevented, and Base UI closes on a
  // later one regardless. A not-dismissible sheet refuses it anyway: the caller is not told, the
  // sheet stays open and a fresh watcher refuses the next back too.
  it('a non-cancelable back keeps a not-dismissible sheet open, and the next back is refused too', async () => {
    const onOpenChange = await renderSheet(false)
    const first = watchers.at(-1)

    back(false)

    await waitFor(() => expect(watchers.at(-1)).not.toBe(first))
    expect(onOpenChange).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-state', 'open')
    expect(dialog).not.toHaveAttribute('data-ending-style')

    expect(back(true).defaultPrevented).toBe(true)
    back(false)

    await waitFor(() => expect(watchers).toHaveLength(1))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
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
