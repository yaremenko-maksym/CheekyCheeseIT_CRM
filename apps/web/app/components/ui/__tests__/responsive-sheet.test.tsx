/**
 * responsive-sheet.tsx — one sheet API, three presentations (Task 0.4 of the redesign v2 plan).
 *
 * `useDeviceClass` is mocked through a module-level variable, so a `rerender` after changing it
 * is exactly what a rotation / resize across a breakpoint does to the component.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { useEffect, useRef, useState } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceClass } from '@/hooks/use-device-class'
import { useAnyDialogOpen } from '@/hooks/use-any-dialog-open'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { DatePickerField } from '../date-picker'
import { ResponsiveSheet, type ResponsiveSheetProps } from '../responsive-sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'

let deviceClass: DeviceClass = 'mobile'
vi.mock('@/hooks/use-device-class', () => ({ useDeviceClass: () => deviceClass }))

const CLASSES: DeviceClass[] = ['mobile', 'tablet', 'desktop']

function Sheet(
  props: Partial<
    Pick<ResponsiveSheetProps, 'onOpenChange' | 'dismissible' | 'side' | 'description' | 'detents'>
  >,
) {
  return (
    <ResponsiveSheet
      open
      onOpenChange={() => {}}
      title="T"
      footer={<button type="button">Save</button>}
      {...props}
    >
      {/* Uncontrolled on purpose: its value lives only in the DOM node, so a remount loses it. */}
      <input aria-label="Amount" defaultValue="" />
    </ResponsiveSheet>
  )
}

function WithTrigger() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ResponsiveSheet open={open} onOpenChange={setOpen} title="T">
        <input aria-label="Amount" />
      </ResponsiveSheet>
    </>
  )
}

function renderSheet(props: Parameters<typeof Sheet>[0] = {}) {
  return render(<Sheet {...props} />, { wrapper: I18nTestProvider })
}

// The first catalog load compiles the .po file; on a loaded box that outlives a 10 s hook.
beforeAll(() => loadCatalog('uk'), 60_000)

beforeEach(() => {
  deviceClass = 'mobile'
})

describe('ResponsiveSheet', () => {
  it('renders a bottom sheet on mobile and a side panel on desktop', async () => {
    const view = renderSheet()
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-presentation', 'bottom')

    deviceClass = 'desktop'
    view.rerender(<Sheet />)
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'side'),
    )
  })

  it('renders a centred dialog when side is center on tablet and desktop', async () => {
    deviceClass = 'tablet'
    renderSheet({ side: 'center' })
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-presentation', 'center')
  })

  it('keeps form state when the sheet switches presentation', async () => {
    const user = userEvent.setup()
    const view = renderSheet()
    const input = await screen.findByLabelText('Amount')
    await user.type(input, '42')

    for (const next of ['desktop', 'tablet', 'mobile'] as const) {
      deviceClass = next
      view.rerender(<Sheet />)
      await waitFor(() =>
        expect(screen.getByRole('dialog')).toHaveAttribute(
          'data-presentation',
          next === 'mobile' ? 'bottom' : 'side',
        ),
      )
      const after = screen.getByLabelText('Amount')
      // Same DOM node, not a re-created one with the same value.
      expect(after).toBe(input)
      expect(after).toHaveValue('42')
    }
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'tablet', side: 'right' },
    { cls: 'desktop', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('does not close while dismissible is false ($cls, $side)', async (c) => {
    deviceClass = c.cls
    // A modal sets `pointer-events: none` on <body>; the press outside must still be dispatched.
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange, dismissible: false, side: c.side })
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')
    await user.click(document.body)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it.each(CLASSES)('closes on Escape when dismissible (%s)', async (cls) => {
    deviceClass = cls
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange })
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Positive control for the dismissible=false case: the same outside press does reach a sheet.
  it.each(CLASSES)('closes on an outside press when dismissible (%s)', async (cls) => {
    deviceClass = cls
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange })
    await screen.findByRole('dialog')

    await user.click(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each(CLASSES)('does not close when the user clicks inside the content (%s)', async (cls) => {
    deviceClass = cls
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange })

    await user.click(await screen.findByLabelText('Amount'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it.each(CLASSES)('labels the dialog with title on every class (%s)', async (cls) => {
    deviceClass = cls
    renderSheet({ description: 'D' })
    const dialog = await screen.findByRole('dialog', { name: 'T' })
    expect(dialog).toHaveAccessibleDescription('D')
  })

  // `ui/sheet.tsx` names its close control with a literal "Close" (pre-existing, not localized here
  // because an E2E spec selects it by that name); the other two go through the catalog.
  it.each([
    { cls: 'mobile', side: 'right', name: 'Закрити' },
    { cls: 'tablet', side: 'right', name: 'Close' },
    { cls: 'desktop', side: 'center', name: 'Закрити' },
  ] as const)('offers a named close control when dismissible ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange, side: c.side })
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: c.name }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('hides the bottom sheet close control while dismissible is false', async () => {
    renderSheet({ dismissible: false })
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Закрити' })).not.toBeInTheDocument()
  })

  it.each(CLASSES)('moves focus into the sheet on open (%s)', async (cls) => {
    deviceClass = cls
    const user = userEvent.setup()
    render(<WithTrigger />, { wrapper: I18nTestProvider })

    await user.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = await screen.findByRole('dialog')

    // Base UI focuses the popup itself; Radix focuses the first tabbable, the Sheet's close button.
    const focusTarget = cls === 'mobile' ? dialog : screen.getByRole('button', { name: 'Close' })
    await waitFor(() => expect(focusTarget).toHaveFocus())
  })

  // Mobile only: Radix's FocusScope restore needs real-browser focus semantics that happy-dom
  // lacks (see AttachReceiptSheet.test.tsx); the tablet/desktop path is the unchanged Radix one.
  it('returns focus to the trigger when the bottom sheet closes', async () => {
    const user = userEvent.setup()
    render(<WithTrigger />, { wrapper: I18nTestProvider })
    const trigger = screen.getByRole('button', { name: 'Open' })

    await user.click(trigger)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  // Two distinct detents is the only path that hands Base UI snap points; a re-render with a fresh
  // detents array must neither close the sheet nor loop.
  it('stays open across re-renders with half and full detents', async () => {
    const onOpenChange = vi.fn()
    const view = renderSheet({ onOpenChange, detents: ['half', 'full'] })
    await screen.findByRole('dialog')

    view.rerender(<Sheet onOpenChange={onOpenChange} detents={['half', 'full']} />)
    view.rerender(<Sheet onOpenChange={onOpenChange} detents={['half', 'full']} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'bottom')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('useAnyDialogOpen is true while the bottom sheet is open', async () => {
    renderSheet()
    await screen.findByRole('dialog')
    const { result } = renderHook(() => useAnyDialogOpen())
    await act(async () => {})
    expect(result.current).toBe(true)
  })
})

// Nested non-modal layers (a date popover, a select listbox) portal to <body> and must be seen as
// inside the sheet; React events from `children` must reach ancestors once; `children` must mount
// in the document so their first effect and `autoFocus` work.
describe('ResponsiveSheet content lives in the presentation tree', () => {
  beforeAll(() => {
    // Radix Select calls pointer-capture and scroll APIs happy-dom does not implement.
    const proto = Element.prototype as unknown as Record<string, unknown>
    proto.hasPointerCapture ??= () => false
    proto.releasePointerCapture ??= () => {}
    proto.scrollIntoView ??= () => {}
  })

  const PRESENTATIONS = [
    { cls: 'mobile', side: 'right', presentation: 'bottom' },
    { cls: 'desktop', side: 'right', presentation: 'side' },
    { cls: 'desktop', side: 'center', presentation: 'center' },
  ] as const

  function Nested({
    onOpenChange,
    side,
  }: Pick<ResponsiveSheetProps, 'onOpenChange'> & { side: 'right' | 'center' }) {
    const [date, setDate] = useState('')
    return (
      <ResponsiveSheet open onOpenChange={onOpenChange} title="T" side={side}>
        <DatePickerField value={date} onChange={setDate} data-testid="date" />
        <Select>
          <SelectTrigger aria-label="Kind">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      </ResponsiveSheet>
    )
  }

  it.each(PRESENTATIONS)(
    'a press inside an open date popover does not close the sheet ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
      const onOpenChange = vi.fn()
      render(<Nested onOpenChange={onOpenChange} side={c.side} />, { wrapper: I18nTestProvider })
      await screen.findByRole('dialog')

      await user.click(screen.getByTestId('date'))
      await user.click(await screen.findByRole('grid'))

      expect(onOpenChange).not.toHaveBeenCalledWith(false)
    },
  )

  it.each(PRESENTATIONS)(
    'a press inside an open select listbox does not close the sheet ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
      const onOpenChange = vi.fn()
      render(<Nested onOpenChange={onOpenChange} side={c.side} />, { wrapper: I18nTestProvider })
      await screen.findByRole('dialog')

      screen.getByRole('combobox', { name: 'Kind' }).focus()
      await user.keyboard('{Enter}')
      await user.click(await screen.findByRole('option', { name: 'Beta' }))

      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent('Beta')
    },
  )

  it.each(PRESENTATIONS)(
    'Escape with the date popover open closes only the popover ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
      const onOpenChange = vi.fn()
      render(<Nested onOpenChange={onOpenChange} side={c.side} />, { wrapper: I18nTestProvider })
      await screen.findByRole('dialog')

      await user.click(screen.getByTestId('date'))
      await screen.findByRole('grid')
      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', c.presentation)
    },
  )

  it.each(PRESENTATIONS)(
    'a click inside children reaches an ancestor onClick once ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const user = userEvent.setup()
      const onClick = vi.fn()
      render(
        <div onClick={onClick}>
          <ResponsiveSheet open onOpenChange={() => {}} title="T" side={c.side}>
            <button type="button">Inner</button>
          </ResponsiveSheet>
        </div>,
        { wrapper: I18nTestProvider },
      )

      await user.click(await screen.findByRole('button', { name: 'Inner' }))

      expect(onClick).toHaveBeenCalledTimes(1)
    },
  )

  it.each(PRESENTATIONS)(
    'children are in the document on their first effect ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const seen: boolean[] = []
      function Probe() {
        const ref = useRef<HTMLSpanElement>(null)
        useEffect(() => {
          seen.push(ref.current !== null && document.contains(ref.current))
        }, [])
        return <span ref={ref}>probe</span>
      }
      render(
        <ResponsiveSheet open onOpenChange={() => {}} title="T" side={c.side}>
          <Probe />
        </ResponsiveSheet>,
        { wrapper: I18nTestProvider },
      )

      await screen.findByText('probe')
      expect(seen[0]).toBe(true)
    },
  )

  it.each([
    { cls: 'tablet', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('autoFocus inside children receives focus on open ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const user = userEvent.setup()
    function WithAutoFocus() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <ResponsiveSheet open={open} onOpenChange={setOpen} title="T" side={c.side}>
            <input aria-label="Amount" autoFocus />
          </ResponsiveSheet>
        </>
      )
    }
    render(<WithAutoFocus />, { wrapper: I18nTestProvider })

    await user.click(screen.getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveFocus())
  })
})
