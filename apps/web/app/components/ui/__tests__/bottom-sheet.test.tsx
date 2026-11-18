/**
 * bottom-sheet.tsx — a refused close is cancelled, not ignored (PR #1401, fix round 2, SPEC-M-4).
 *
 * `Drawer.Root` is wrapped so every `onOpenChange` call records its reason and a spy on
 * `details.cancel`. Base UI skips the close (and, on a swipe, settles back on the snap point) only
 * when `cancel()` ran, so that call is the observable contract. A real swipe needs a real drag and
 * is a device check.
 */
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { BottomSheet } from '../bottom-sheet'

const calls = vi.hoisted(() => [] as Array<{ reason: string; cancel: MockInstance }>)

vi.mock('@base-ui/react/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@base-ui/react/drawer')>()
  function Root({ onOpenChange, ...props }: ComponentProps<typeof actual.Drawer.Root>) {
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

async function renderBottomSheet(dismissible: boolean) {
  const onOpenChange = vi.fn()
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
