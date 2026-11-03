import { describe, expect, it } from 'vitest'
import { expectScaling } from './scaling'

/** The helper is an oracle for the ReDoS specs, so it is tested like one: it must be able to fail. */
describe('expectScaling (test helper)', () => {
  it('times each side exactly three times, the small side first', () => {
    const calls: string[] = []
    expectScaling(
      () => calls.push('small'),
      () => calls.push('big'),
      8,
    )
    expect(calls).toEqual(['small', 'small', 'small', 'big', 'big', 'big'])
  })

  it('fails when the big side costs more than factor x small + slack', () => {
    const busy = (): number => {
      const until = performance.now() + 200
      let spins = 0
      while (performance.now() < until) spins += 1
      return spins
    }
    expect(() => expectScaling(() => undefined, busy, 8)).toThrow()
  })
})
