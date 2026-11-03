import { describe, expect, it } from 'vitest'
import {
  HTML_MODEL_CALLS_PER_CYCLE,
  InMemoryModelBudget,
  type Reservation,
} from './model-budget.port'

function reserveOrFail(budget: InMemoryModelBudget): Reservation {
  const reservation = budget.reserve()
  if (reservation === null) throw new Error('expected a reservation')
  return reservation
}

describe('InMemoryModelBudget', () => {
  it('the shared default is 20 calls per collection cycle', () => {
    expect(HTML_MODEL_CALLS_PER_CYCLE).toBe(20)
    const budget = new InMemoryModelBudget()
    for (let i = 0; i < 20; i += 1) budget.commit(reserveOrFail(budget))
    expect(budget.reserve()).toBeNull()
    expect(budget.snapshot()).toEqual({ committed: 20, reserved: 0, totalTokens: 0 })
  })

  it('open reservations count against the limit before they are settled', () => {
    const budget = new InMemoryModelBudget(2)
    const a = reserveOrFail(budget)
    reserveOrFail(budget)
    expect(budget.reserve()).toBeNull()
    budget.release(a)
    expect(budget.reserve()).not.toBeNull()
  })

  it('release returns the slot; commit consumes it', () => {
    const budget = new InMemoryModelBudget(1)
    budget.release(reserveOrFail(budget))
    expect(budget.snapshot()).toEqual({ committed: 0, reserved: 0, totalTokens: 0 })
    budget.commit(reserveOrFail(budget), { totalTokens: 42 })
    expect(budget.snapshot()).toEqual({ committed: 1, reserved: 0, totalTokens: 42 })
    expect(budget.reserve()).toBeNull()
  })

  it('no leak after many released failures', () => {
    const budget = new InMemoryModelBudget(3)
    for (let i = 0; i < 1_000; i += 1) budget.release(reserveOrFail(budget))
    expect(budget.snapshot()).toEqual({ committed: 0, reserved: 0, totalTokens: 0 })
  })

  it('a reservation settles once: a second commit or a commit after release counts nothing', () => {
    const budget = new InMemoryModelBudget(5)
    const a = reserveOrFail(budget)
    budget.commit(a, { totalTokens: 7 })
    budget.commit(a, { totalTokens: 7 })
    const b = reserveOrFail(budget)
    budget.release(b)
    budget.commit(b, { totalTokens: 9 })
    expect(budget.snapshot()).toEqual({ committed: 1, reserved: 0, totalTokens: 7 })
  })

  it('a reservation from another budget is not accepted', () => {
    const mine = new InMemoryModelBudget(1)
    const other = new InMemoryModelBudget(1)
    const held = reserveOrFail(mine)
    other.commit(held)
    other.release(held)
    expect(other.snapshot()).toEqual({ committed: 0, reserved: 0, totalTokens: 0 })
    expect(mine.snapshot()).toEqual({ committed: 0, reserved: 1, totalTokens: 0 })
  })

  it('each reservation is a distinct frozen token', () => {
    const budget = new InMemoryModelBudget(2)
    const a = reserveOrFail(budget)
    const b = reserveOrFail(budget)
    expect(a).not.toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
    expect(budget.snapshot().reserved).toBe(2)
  })

  it('a limit of 0 allows no call', () => {
    expect(new InMemoryModelBudget(0).reserve()).toBeNull()
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects the limit %s',
    (limit) => {
      expect(() => new InMemoryModelBudget(limit)).toThrow(/non-negative integer/)
    },
  )
})
