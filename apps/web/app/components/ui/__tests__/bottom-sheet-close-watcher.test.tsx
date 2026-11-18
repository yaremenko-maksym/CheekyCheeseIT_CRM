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
  onOpenChange,
}: {
  dismissible?: boolean
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
      </BottomSheet>
    </I18nTestProvider>
  )
}

async function renderSheet(dismissible = true) {
  const onOpenChange = vi.fn()
  render(<Harness dismissible={dismissible} onOpenChange={onOpenChange} />)
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

  // The browser lets one close request per user activation be prevented; Base UI closes on the
  // next one regardless, so the caller's state must follow.
  it('a non-cancelable back closes even a not-dismissible sheet and tells the caller', async () => {
    const onOpenChange = await renderSheet(false)

    back(false)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
