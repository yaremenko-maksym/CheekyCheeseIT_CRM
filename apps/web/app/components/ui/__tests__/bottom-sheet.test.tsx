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

// Outside press, Android back and a nested Radix layer run through the real Base UI path in
// responsive-sheet.test.tsx and bottom-sheet-close-watcher.test.tsx. An Escape is nested only
// when a layer handled it (defaultPrevented), whatever the body style.
describe('BottomSheet Escape and the body style', () => {
  it('passes an Escape no nested layer handled, even with <body> pointer-events none', async () => {
    const onOpenChange = await renderBottomSheet(true)
    document.body.style.pointerEvents = 'none'
    const request = closeRequest('escape-key', document.documentElement)

    act(() => (root.props.onOpenChange as RootOpenChange)(false, request))

    expect(request.cancel).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

// happy-dom reports every element 800 px tall, so `half` is a 400 px offset and `full` 0 px.
// A real drag needs layout happy-dom lacks, so a swipe's end is replayed through the
// `onSnapPointChange` Base UI was given; a sheet that passes none fails on the offset, not a throw.
describe('BottomSheet snap point', () => {
  type SnapChange = (point: number | null, details?: { cancel: () => void }) => void
  const snapTo: SnapChange = (point, details) =>
    act(() => (root.props.onSnapPointChange as SnapChange | undefined)?.(point, details))
  const offset = async (value: string) =>
    waitFor(() =>
      expect(screen.getByRole('dialog').style.getPropertyValue('--drawer-snap-point-offset')).toBe(
        value,
      ),
    )
  const sheet = (
    open: boolean,
    detents: ComponentProps<typeof BottomSheet>['detents'] = ['half', 'full'],
    dismissible = true,
  ) => (
    <BottomSheet
      open={open}
      onOpenChange={() => {}}
      title="T"
      detents={detents}
      dismissible={dismissible}
    >
      <input aria-label="Amount" />
    </BottomSheet>
  )
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  })

  // Base UI 1.9.0 reports a dismissing swipe as a `null` snap point before it asks to close; a
  // canceled `null` rejects the dismissal before the exit styles start.
  it('refuses the null snap point of a dismissing swipe while not dismissible', async () => {
    render(sheet(true, ['half', 'full'], false), { wrapper: I18nTestProvider })
    await offset('400px')
    const details = { cancel: vi.fn() }

    snapTo(null, details)

    expect(details.cancel).toHaveBeenCalledTimes(1)
    await offset('400px')
  })

  it('accepts a detent snap point while not dismissible', async () => {
    render(sheet(true, ['half', 'full'], false), { wrapper: I18nTestProvider })
    await offset('400px')
    const details = { cancel: vi.fn() }

    snapTo(1, details)

    expect(details.cancel).not.toHaveBeenCalled()
    await offset('0px')
  })

  it('accepts the null snap point of a dismissing swipe while dismissible', async () => {
    render(sheet(true), { wrapper: I18nTestProvider })
    await offset('400px')
    const details = { cancel: vi.fn() }

    snapTo(null, details)

    expect(details.cancel).not.toHaveBeenCalled()
  })

  // Base UI 1.9.0 resolves a snap point that is no longer offered to the first detent itself.
  it('falls back to the first detent when the detents change under the current one', async () => {
    const view = render(sheet(true), { wrapper: I18nTestProvider })
    snapTo(1)
    await offset('0px')

    view.rerender(sheet(true, ['half']))

    await waitFor(() =>
      expect(screen.getByRole('dialog').style.getPropertyValue('--drawer-snap-point-offset')).toBe(
        '400px',
      ),
    )
  })

  it('reopens at the first detent after a caller-driven close from another detent', async () => {
    const view = render(sheet(true), { wrapper: I18nTestProvider })
    await offset('400px')

    // What a swipe up to `full` reports when it ends.
    snapTo(1)
    await offset('0px')

    view.rerender(sheet(false))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    view.rerender(sheet(true))
    await offset('400px')
  })
})
