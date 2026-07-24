import { describe, expect, it } from 'vitest'
import { computeDurationMs, computeRouteTransition } from './route-duration'

describe('computeDurationMs', () => {
  it('computes the elapsed ms between enter and leave', () => {
    expect(computeDurationMs(1_000, 5_500)).toBe(4_500)
  })

  it('rounds fractional ms', () => {
    expect(computeDurationMs(1_000, 1_000.6)).toBe(1)
  })

  it('clamps to zero for a negative (out-of-order) delta instead of going negative', () => {
    expect(computeDurationMs(5_000, 1_000)).toBe(0)
  })

  it('returns zero for a same-instant enter/leave', () => {
    expect(computeDurationMs(1_000, 1_000)).toBe(0)
  })
})

describe('computeRouteTransition', () => {
  it('on the FIRST navigation (previous=null) — no leave event, only enter', () => {
    const { leave, enter } = computeRouteTransition(null, '/team', 1_000)
    expect(leave).toBeNull()
    expect(enter).toEqual({ route: '/team' })
  })

  it('on a subsequent navigation — leaves the OLD route with its dwell time, enters the NEW one', () => {
    const previous = { route: '/team', enteredAtMs: 1_000 }
    const { leave, enter } = computeRouteTransition(previous, '/finance', 4_000)
    expect(leave).toEqual({ route: '/team', durationMs: 3_000 })
    expect(enter).toEqual({ route: '/finance' })
  })

  it('never mutates the `previous` object passed in', () => {
    const previous = { route: '/team', enteredAtMs: 1_000 }
    const snapshot = { ...previous }
    computeRouteTransition(previous, '/finance', 4_000)
    expect(previous).toEqual(snapshot)
  })
})
