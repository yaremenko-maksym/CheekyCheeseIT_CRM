/**
 * TxDateField — the reveal contract of the reason field.
 *
 * jsdom cannot see an animation, so the real library is replaced by a double
 * that records the props it was given. What is pinned is the contract the
 * design spec states (docs/design/admin-edit-tx-date.md §7): the exact reveal
 * and exit frames, the timing, the first-render behaviour, and that a reduced-
 * motion preference removes the exit animation and the duration instead of
 * merely slowing them.
 */
import { Children, type ReactElement, type ReactNode } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const state = vi.hoisted(() => ({
  reduced: false as boolean | null,
  motion: null as Record<string, unknown> | null,
  presence: null as { initial: unknown; keys: string[] } | null,
}))

vi.mock('framer-motion', () => ({
  useReducedMotion: () => state.reduced,
  AnimatePresence: ({ children, initial }: { children: ReactNode; initial?: boolean }) => {
    state.presence = {
      initial,
      keys: Children.toArray(children).map((child) => String((child as ReactElement).key)),
    }
    return <>{children}</>
  },
  motion: {
    div: (props: Record<string, unknown> & { children?: ReactNode }) => {
      state.motion = props
      return <div data-testid={props['data-testid'] as string}>{props.children}</div>
    },
  },
}))

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: () => <input type="date" />,
}))

import { TxDateField } from '../TxDateField'

beforeEach(async () => {
  await loadCatalog('uk')
  state.reduced = false
  state.motion = null
  state.presence = null
})

function renderChanged() {
  render(
    <TxDateField
      value="2026-08-01"
      stored="2026-10-20"
      reason=""
      onChange={() => {}}
      onReasonChange={() => {}}
    />,
    { wrapper: I18nTestProvider },
  )
}

describe('TxDateField — reason reveal contract', () => {
  it('reveals with the spec frames and timing', () => {
    renderChanged()
    expect(state.motion).toMatchObject({
      initial: { opacity: 0, height: 0, y: -4 },
      animate: { opacity: 1, height: 'auto', y: 0 },
      exit: { opacity: 0, height: 0, y: -4 },
      transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
      className: '-mx-0.5 -mb-0.5 space-y-1.5 overflow-hidden px-0.5 pb-0.5',
    })
  })

  it('does not animate on the first render and keys the reveal for the exit', () => {
    renderChanged()
    expect(state.presence?.initial).toBe(false)
    expect(state.presence?.keys.join()).toContain('admin-edit-tx-date-reason')
  })

  it('drops the exit animation and the duration under reduced motion', () => {
    state.reduced = true
    renderChanged()
    expect(state.motion).not.toHaveProperty('exit')
    expect(state.motion).toMatchObject({ transition: { duration: 0 } })
  })

  it('treats an unknown preference (null on the first render) as animated', () => {
    state.reduced = null
    renderChanged()
    expect(state.motion).toHaveProperty('exit')
    expect(state.motion).toMatchObject({ transition: { duration: 0.18 } })
  })
})
