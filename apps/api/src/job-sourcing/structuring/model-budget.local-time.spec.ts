import { describe, expect, it } from 'vitest'
import { InMemoryModelBudget, type Reservation } from './model-budget.port'

function held(budget: InMemoryModelBudget): Reservation {
  const reservation = budget.reserve()
  if (reservation === null) throw new Error('expected a reservation')
  return reservation
}

describe('InMemoryModelBudget: local time (ADR 5.5.6)', () => {
  it('refuses the next reservation once the cycle reaches the limit', () => {
    const budget = new InMemoryModelBudget(20, 100)
    budget.commit(held(budget), { localMs: 99 })
    const next = held(budget)
    budget.commit(next, { localMs: 1 })
    expect(budget.reserve()).toBeNull()
  })

  it('a call with no local time spends none of it', () => {
    const budget = new InMemoryModelBudget(20, 1)
    budget.commit(held(budget), { totalTokens: 5 })
    budget.commit(held(budget))
    expect(budget.reserve()).not.toBeNull()
  })

  it('a released reservation spends none of it', () => {
    const budget = new InMemoryModelBudget(20, 0.5)
    budget.release(held(budget))
    expect(budget.reserve()).not.toBeNull()
  })

  it('a second commit of one reservation adds no local time', () => {
    const budget = new InMemoryModelBudget(20, 100)
    const reservation = held(budget)
    budget.commit(reservation, { localMs: 60 })
    budget.commit(reservation, { localMs: 60 })
    expect(budget.reserve()).not.toBeNull()
  })

  it('has no limit unless the wiring passes one', () => {
    const budget = new InMemoryModelBudget(2)
    budget.commit(held(budget), { localMs: Number.MAX_SAFE_INTEGER })
    expect(budget.reserve()).not.toBeNull()
  })

  it('a zero limit refuses at once', () => {
    expect(new InMemoryModelBudget(20, 0).reserve()).toBeNull()
  })

  it.each([-1, Number.NaN])('refuses the limit %d', (limit) => {
    expect(() => new InMemoryModelBudget(20, limit)).toThrow(
      `local time limit must not be negative, got ${String(limit)}`,
    )
  })
})
