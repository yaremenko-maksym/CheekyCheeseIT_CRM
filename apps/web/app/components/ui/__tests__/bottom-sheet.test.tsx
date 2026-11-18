/**
 * bottom-sheet.tsx — a refused close is cancelled, not ignored (PR #1401, fix round 2, SPEC-M-4).
 *
 * `Drawer.Root` is wrapped so every `onOpenChange` call records its reason and a spy on
 * `details.cancel`. Base UI skips the close (and, on a swipe, settles back on the snap point) only
 * when `cancel()` ran, so that call is the observable contract. A real swipe needs a real drag and
 * is a device check.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { BottomSheet } from '../bottom-sheet'

const calls = vi.hoisted(() => [] as Array<{ reason: string; cancel: MockInstance }>)
// The props BottomSheet last passed to Drawer.Root, to drive what happy-dom cannot (CloseWatcher, a swipe).
const root = vi.hoisted(() => ({ props: {} as Record<string, unknown> }))

vi.mock('@base-ui/react/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@base-ui/react/drawer')>()
  function Root({ onOpenChange, ...props }: ComponentProps<typeof actual.Drawer.Root>) {
    root.props = { onOpenChange, ...props }
    return (
      <actual.Drawer.Root
        {...props}
        onOpenChange={(open, details) => {
          calls.push({ reason: details.reason, cancel: vi.spyOn(details, 'cancel') })
          onOpenChange?.(open, details)
        }}
      />
    )
  }
  return { ...actual, Drawer: { ...actual.Drawer, Root } }
})

beforeAll(() => loadCatalog('uk'), 60_000)

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  document.body.style.pointerEvents = ''
  vi.restoreAllMocks()
})

type OpenChange = NonNullable<ComponentProps<typeof BottomSheet>['onOpenChange']>
type RootOpenChange = (open: boolean, details: unknown) => void

// A close request as Base UI hands it over; `cancel` is the observable refusal.
function closeRequest(reason: string, target: EventTarget | null = null) {
  return { reason, event: { target, defaultPrevented: false }, cancel: vi.fn() }
}

async function renderBottomSheet(dismissible: boolean) {
  const onOpenChange = vi.fn<OpenChange>()
  render(
    <BottomSheet open onOpenChange={onOpenChange} title="T" dismissible={dismissible}>
      <input aria-label="Amount" />
    </BottomSheet>,
    { wrapper: I18nTestProvider },
  )
  await screen.findByRole('dialog')
  return onOpenChange
}

describe('BottomSheet refused close', () => {
  it.each([
    { reason: 'escape-key', act: () => userEvent.setup().keyboard('{Escape}') },
    {
      reason: 'outside-press',
      act: () =>
        userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never }).click(document.body),
    },
  ])('cancels the close on $reason while not dismissible', async (c) => {
    const onOpenChange = await renderBottomSheet(false)

    await c.act()

    const call = calls.find((x) => x.reason === c.reason)
    expect(call?.cancel).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not cancel a close while dismissible', async () => {
    const onOpenChange = await renderBottomSheet(true)

    await userEvent.setup().keyboard('{Escape}')

    const call = calls.find((x) => x.reason === 'escape-key')
    expect(call?.cancel).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

// Android back arrives as a CloseWatcher request, only on Android Chromium; the handler is driven
// directly. A Radix modal layer (Select, DropdownMenu) marks itself by `pointer-events: none` on <body>.
describe('BottomSheet close requests while a nested layer is open', () => {
  it.each(['close-watcher', 'outside-press'])(
    'refuses a %s request while a nested Radix modal layer is open',
    async (reason) => {
      const onOpenChange = await renderBottomSheet(true)
      document.body.style.pointerEvents = 'none'
      const request = closeRequest(reason)

      act(() => (root.props.onOpenChange as RootOpenChange)(false, request))

      expect(request.cancel).toHaveBeenCalledTimes(1)
      expect(onOpenChange).not.toHaveBeenCalled()
    },
  )

  // The click after a Radix layer closed itself on pointerdown lands on <html>.
  it('refuses an outside press that landed on <html>', async () => {
    const onOpenChange = await renderBottomSheet(true)
    const request = closeRequest('outside-press', document.documentElement)

    act(() => (root.props.onOpenChange as RootOpenChange)(false, request))

    expect(request.cancel).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // An Escape is nested only when a layer handled it (defaultPrevented), whatever the body style.
  it('passes an Escape no nested layer handled, even with <body> pointer-events none', async () => {
    const onOpenChange = await renderBottomSheet(true)
    document.body.style.pointerEvents = 'none'
    const request = closeRequest('escape-key', document.documentElement)

    act(() => (root.props.onOpenChange as RootOpenChange)(false, request))

    expect(request.cancel).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each(['close-watcher', 'outside-press'])(
    'passes a %s request on when no nested layer is open',
    async (reason) => {
      const onOpenChange = await renderBottomSheet(true)
      const request = closeRequest(reason, document.body)

      act(() => (root.props.onOpenChange as RootOpenChange)(false, request))

      expect(request.cancel).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    },
  )
})

// happy-dom reports every element 800 px tall, so `half` is a 400 px offset and `full` 0 px.
describe('BottomSheet snap point on reopen', () => {
  it('reopens at the first detent after a caller-driven close from another detent', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
    const sheet = (open: boolean) => (
      <BottomSheet open={open} onOpenChange={() => {}} title="T" detents={['half', 'full']}>
        <input aria-label="Amount" />
      </BottomSheet>
    )
    const view = render(sheet(true), { wrapper: I18nTestProvider })
    const offset = async (value: string) =>
      waitFor(() =>
        expect(
          screen.getByRole('dialog').style.getPropertyValue('--drawer-snap-point-offset'),
        ).toBe(value),
      )
    await offset('400px')

    // What a swipe up to `full` reports when it ends.
    const onSnapPointChange = root.props.onSnapPointChange as (point: number) => void
    act(() => onSnapPointChange(1))
    await offset('0px')

    view.rerender(sheet(false))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    view.rerender(sheet(true))
    await offset('400px')
  })
})
