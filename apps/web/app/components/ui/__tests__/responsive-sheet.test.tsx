/**
 * responsive-sheet.tsx — one sheet API, three presentations (Task 0.4 of the redesign v2 plan).
 *
 * `useDeviceClass` is mocked through a module-level variable, so a `rerender` after changing it
 * is exactly what a rotation / resize across a breakpoint does to the component.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Drawer } from '@base-ui/react/drawer'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { DeviceClass } from '@/hooks/use-device-class'
import { useAnyDialogOpen } from '@/hooks/use-any-dialog-open'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { BottomSheet } from '../bottom-sheet'
import { DatePickerField } from '../date-picker'
import {
  ResponsiveSheet,
  ResponsiveSheetClose,
  type ResponsiveSheetProps,
} from '../responsive-sheet'
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

  it.each(['tablet', 'desktop'] as const)(
    'renders a centred dialog when side is center (%s)',
    async (cls) => {
      deviceClass = cls
      renderSheet({ side: 'center' })
      expect(await screen.findByRole('dialog')).toHaveAttribute('data-presentation', 'center')
    },
  )

  // The content remounts on a class change, so form state lives with the caller: the controlled
  // input keeps its value, the uncontrolled one and the mount count show the remount.
  it('remounts the content on a presentation switch; caller-held state and the footer survive', async () => {
    let mounts = 0
    function MountCounter() {
      useEffect(() => {
        mounts += 1
      }, [])
      return null
    }
    // `cls` only forces the re-render a real useDeviceClass subscription would cause; the React
    // Compiler would otherwise reuse the memoized JSX of a prop-less component.
    function Controlled({ cls }: { cls: DeviceClass }) {
      const [amount, setAmount] = useState('')
      return (
        <ResponsiveSheet
          open
          onOpenChange={() => {}}
          title="T"
          footer={<button type="button">Save</button>}
        >
          <input
            aria-label="Amount"
            data-class={cls}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input aria-label="Note" defaultValue="" />
          <MountCounter />
        </ResponsiveSheet>
      )
    }
    const user = userEvent.setup()
    const view = render(<Controlled cls="mobile" />, { wrapper: I18nTestProvider })
    await user.type(await screen.findByLabelText('Amount'), '42')
    await user.type(screen.getByLabelText('Note'), 'draft')
    expect(mounts).toBe(1)

    // Tablet and desktop share the side presentation, so only bottom <-> side remounts.
    const steps = [
      { next: 'desktop', mounts: 2 },
      { next: 'tablet', mounts: 2 },
      { next: 'mobile', mounts: 3 },
    ] as const
    for (const { next, mounts: expected } of steps) {
      deviceClass = next
      view.rerender(<Controlled cls={next} />)
      await waitFor(() =>
        expect(screen.getByRole('dialog')).toHaveAttribute(
          'data-presentation',
          next === 'mobile' ? 'bottom' : 'side',
        ),
      )
      expect(screen.getByLabelText('Amount')).toHaveValue('42')
      expect(screen.getByLabelText('Note')).toHaveValue('')
      expect(mounts).toBe(expected)
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
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

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'tablet', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('offers a named close control when dismissible ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange, side: c.side })
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'Закрити' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'tablet', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('hides the close control while dismissible is false ($cls, $side)', async (c) => {
    deviceClass = c.cls
    renderSheet({ dismissible: false, side: c.side })
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: /^(Закрити|Close)$/ })).not.toBeInTheDocument()
  })

  // With the close control hidden, Radix's initial focus lands on the first tabbable in children;
  // Base UI (bottom) focuses the popup itself.
  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'tablet', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('moves initial focus when not dismissible ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const user = userEvent.setup()
    function Locked() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <ResponsiveSheet
            open={open}
            onOpenChange={setOpen}
            title="T"
            side={c.side}
            dismissible={false}
          >
            <input aria-label="Amount" />
          </ResponsiveSheet>
        </>
      )
    }
    render(<Locked />, { wrapper: I18nTestProvider })

    await user.click(screen.getByRole('button', { name: 'Open' }))

    const target =
      c.cls === 'mobile' ? await screen.findByRole('dialog') : screen.getByLabelText('Amount')
    await waitFor(() => expect(target).toHaveFocus())
  })

  it.each(CLASSES)('moves focus into the sheet on open (%s)', async (cls) => {
    deviceClass = cls
    const user = userEvent.setup()
    render(<WithTrigger />, { wrapper: I18nTestProvider })

    await user.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = await screen.findByRole('dialog')

    // Base UI focuses the popup itself; Radix focuses the first tabbable, the Sheet's close button.
    const focusTarget = cls === 'mobile' ? dialog : screen.getByRole('button', { name: 'Закрити' })
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

  // A fresh detents array with equal values must neither close the sheet nor loop.
  it('stays open across re-renders with half and full detents', async () => {
    const onOpenChange = vi.fn()
    const view = renderSheet({ onOpenChange, detents: ['half', 'full'] })
    await screen.findByRole('dialog')

    view.rerender(<Sheet onOpenChange={onOpenChange} detents={['half', 'full']} />)
    view.rerender(<Sheet onOpenChange={onOpenChange} detents={['half', 'full']} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'bottom')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'desktop', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('useAnyDialogOpen follows the sheet open and closed ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const props = { onOpenChange: () => {}, title: 'T', side: c.side, children: <input /> }
    const view = render(<ResponsiveSheet open {...props} />, { wrapper: I18nTestProvider })
    await screen.findByRole('dialog')
    const { result } = renderHook(() => useAnyDialogOpen())
    await act(async () => {})
    expect(result.current).toBe(true)

    view.rerender(<ResponsiveSheet open={false} {...props} />)

    await waitFor(() => expect(result.current).toBe(false))
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'desktop', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('unmounts children and footer once closed ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const props = {
      onOpenChange: () => {},
      title: 'T',
      side: c.side,
      footer: <button type="button">Save</button>,
      children: <input aria-label="Amount" />,
    }
    const view = render(<ResponsiveSheet open {...props} />, { wrapper: I18nTestProvider })
    await screen.findByLabelText('Amount')

    view.rerender(<ResponsiveSheet open={false} {...props} />)

    await waitFor(() => expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'desktop', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('renders without a description and without a warning ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderSheet({ side: c.side })
      const dialog = await screen.findByRole('dialog', { name: 'T' })
      await act(async () => {})
      expect(dialog).not.toHaveAttribute('aria-describedby')
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it.each([
    { cls: 'mobile', side: 'right' },
    { cls: 'desktop', side: 'right' },
    { cls: 'desktop', side: 'center' },
  ] as const)('renders the footer bar only when a footer is given ($cls, $side)', async (c) => {
    deviceClass = c.cls
    const footerBar = async () =>
      // eslint-disable-next-line testing-library/no-node-access -- the footer bar has no role; data-slot names it
      (await screen.findByRole('dialog')).querySelector('[data-slot="sheet-footer"]')

    const withFooter = renderSheet({ side: c.side })
    expect(await footerBar()).toContainElement(screen.getByRole('button', { name: 'Save' }))
    withFooter.unmount()

    render(
      <ResponsiveSheet open onOpenChange={() => {}} title="T" side={c.side}>
        <input aria-label="Amount" />
      </ResponsiveSheet>,
      { wrapper: I18nTestProvider },
    )
    expect(await footerBar()).toBeNull()
  })
})

// happy-dom has no layout: every element reports a height of 800 px, so Base UI resolves snap
// points against an 800 px popup in an 800 px viewport.
describe('ResponsiveSheet detents (mobile)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const FULL_HEIGHT = /(^|\s)h-\[calc\(100dvh/

  async function popupFor(detents?: ResponsiveSheetProps['detents']) {
    renderSheet(detents ? { detents } : {})
    return screen.findByRole('dialog')
  }

  it.each([
    { detents: ['half'], offset: '400px' },
    { detents: ['full'], offset: '0px' },
    { detents: ['half', 'full'], offset: '400px' },
    { detents: ['full', 'half'], offset: '0px' },
  ] as const)('opens at the first detent ($detents)', async (c) => {
    const popup = await popupFor(c.detents)
    await waitFor(() =>
      expect(popup.style.getPropertyValue('--drawer-snap-point-offset')).toBe(c.offset),
    )
  })

  it('sizes a content sheet by its content and a full sheet to the viewport', async () => {
    const content = await popupFor(['content'])
    expect(content.className).not.toMatch(FULL_HEIGHT)
    cleanup()

    const full = await popupFor(['full'])
    expect(full.className).toMatch(FULL_HEIGHT)
  })

  // Padding by the swipe offset keeps a fixed-height sheet's footer in view; on a content sheet it
  // would grow the popup by the distance it moves.
  it('pads by the snap and swipe offset only a sheet with snap points', async () => {
    const PAD = '[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset'
    const content = await popupFor(['content'])
    expect(content.className).not.toContain(PAD)
    cleanup()

    const half = await popupFor(['half'])
    expect(half.className).toContain(PAD)
  })

  it('defaults to a content sheet', async () => {
    const popup = await popupFor()
    expect(popup.className).not.toMatch(FULL_HEIGHT)
  })

  // Compile-time only: `apps/web/tsconfig.json` includes `app`, so `pnpm --filter @crm/web typecheck`
  // checks this file and fails on a broken assertion; nothing is checked at run time.
  // Base UI has no "content height" snap point to combine with others.
  it('rejects content together with another detent at compile time', () => {
    expectTypeOf<readonly ['content', 'full']>().not.toExtend<
      NonNullable<ResponsiveSheetProps['detents']>
    >()
    expectTypeOf<readonly ['half', 'full']>().toExtend<
      NonNullable<ResponsiveSheetProps['detents']>
    >()
  })
})

describe('BottomSheet (mobile shell)', () => {
  it('is dismissible by default', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <BottomSheet open onOpenChange={onOpenChange} title="T">
        <input aria-label="Amount" />
      </BottomSheet>,
      { wrapper: I18nTestProvider },
    )
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Only an Escape a nested layer already handled is refused; other closes do not read the flag.
  it('honours a close press whose click default was prevented elsewhere', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const prevent = (event: Event) => event.preventDefault()
    document.addEventListener('click', prevent, true)
    try {
      renderSheet({ onOpenChange })
      await screen.findByRole('dialog')

      await user.click(screen.getByRole('button', { name: 'Закрити' }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally {
      document.removeEventListener('click', prevent, true)
    }
  })

  // happy-dom has no layout, so the footer staying in view at `half` is a real-browser check; the
  // class carrying it (CR-M-1) and the reduced-motion opt-out (SPEC-M-2) are pinned here.
  it('pads the popup by the snap offset and honours reduced motion', async () => {
    renderSheet({ detents: ['half'] })
    const popup = await screen.findByRole('dialog')
    expect(popup).toHaveClass(
      '[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset,0px)_+_var(--drawer-swipe-movement-y,0px)))]',
      'motion-reduce:transition-none',
    )
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

  // The date popover is non-modal (no body style); Radix closes it on pointerdown, before Base UI
  // reads the click as an outside press of the sheet.
  it('a backdrop tap with the date popover open closes only the popover; the next closes the sheet (bottom)', async () => {
    deviceClass = 'mobile'
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    render(<Nested onOpenChange={onOpenChange} side="right" />, { wrapper: I18nTestProvider })
    await screen.findByRole('dialog')
    await user.click(screen.getByTestId('date'))
    await screen.findByRole('grid')

    await user.click(document.body)

    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()

    await user.click(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // An open Radix Select sets `pointer-events: none` on <body>, so a real tap outside the listbox
  // lands on <html>. Base UI reads that as an outside press of the sheet.
  it('an outside press with a select open closes only the select (bottom)', async () => {
    deviceClass = 'mobile'
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    render(<Nested onOpenChange={onOpenChange} side="right" />, { wrapper: I18nTestProvider })
    await screen.findByRole('dialog')

    screen.getByRole('combobox', { name: 'Kind' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.click(document.documentElement)

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'bottom')
  })

  it('once the select is closed, an outside press closes the sheet (bottom)', async () => {
    deviceClass = 'mobile'
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const onOpenChange = vi.fn()
    render(<Nested onOpenChange={onOpenChange} side="right" />, { wrapper: I18nTestProvider })
    await screen.findByRole('dialog')
    screen.getByRole('combobox', { name: 'Kind' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.click(document.documentElement)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

    await user.click(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // The bottom case is the next test: it is measured against a bare Base UI Drawer.
  it.each(PRESENTATIONS.filter((p) => p.presentation !== 'bottom'))(
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

  // The bottom presentation adds no click beyond what a bare Base UI Drawer delivers. The absolute
  // count is a happy-dom artefact; the real-browser count is a device check (Task 1.3).
  it('a click inside children reaches an ancestor as often as through a bare Base UI Drawer (bottom)', async () => {
    deviceClass = 'mobile'
    const user = userEvent.setup()
    async function ancestorClicks(tree: ReactNode) {
      const onClick = vi.fn()
      const view = render(<div onClick={onClick}>{tree}</div>, { wrapper: I18nTestProvider })
      await user.click(await screen.findByRole('button', { name: 'Inner' }))
      view.unmount()
      return onClick.mock.calls.length
    }

    const bare = await ancestorClicks(
      <Drawer.Root open>
        <Drawer.Portal>
          <Drawer.Viewport>
            <Drawer.Popup>
              <button type="button">Inner</button>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>,
    )
    const bottom = await ancestorClicks(
      <ResponsiveSheet open onOpenChange={() => {}} title="T">
        <button type="button">Inner</button>
      </ResponsiveSheet>,
    )

    expect(bare).toBeGreaterThan(0)
    expect(bottom).toBe(bare)
  })

  it.each(PRESENTATIONS)(
    'ResponsiveSheetClose in children and footer closes the sheet ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const user = userEvent.setup()
      for (const where of ['children', 'footer'] as const) {
        const onOpenChange = vi.fn()
        const close = <ResponsiveSheetClose>Cancel</ResponsiveSheetClose>
        const view = render(
          <ResponsiveSheet
            open
            onOpenChange={onOpenChange}
            title="T"
            side={c.side}
            footer={where === 'footer' ? close : undefined}
          >
            {where === 'children' ? close : <input aria-label="Amount" />}
          </ResponsiveSheet>,
          { wrapper: I18nTestProvider },
        )

        await user.click(await screen.findByRole('button', { name: 'Cancel' }))

        expect(onOpenChange).toHaveBeenCalledWith(false)
        view.unmount()
      }
    },
  )

  // `dismissible={false}` guards accidental exits; an explicit Cancel is intent.
  it.each(PRESENTATIONS)(
    'ResponsiveSheetClose closes a not-dismissible sheet and runs its own onClick ($presentation)',
    async (c) => {
      deviceClass = c.cls
      const onOpenChange = vi.fn()
      const onClick = vi.fn()
      render(
        <ResponsiveSheet
          open
          onOpenChange={onOpenChange}
          title="T"
          side={c.side}
          dismissible={false}
          footer={<ResponsiveSheetClose onClick={onClick}>Cancel</ResponsiveSheetClose>}
        >
          <input aria-label="Amount" />
        </ResponsiveSheet>,
        { wrapper: I18nTestProvider },
      )

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel' }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
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
    { cls: 'mobile', side: 'right' },
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
