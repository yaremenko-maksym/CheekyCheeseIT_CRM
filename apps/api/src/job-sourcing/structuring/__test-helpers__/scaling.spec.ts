import { describe, expect, it } from 'vitest'
import { cpuMs, expectScaling } from './scaling'

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
    // 200 ms of CPU, not of wall clock: on a loaded host a wall-clock spin gets a fraction of a
    // core and could cost less than the slack, so this case would stop proving anything.
    const busy = (): number => {
      const started = process.cpuUsage()
      let spins = 0
      while (process.cpuUsage(started).user < 200_000) spins += 1
      return spins
    }
    expect(() => expectScaling(() => undefined, busy, 8)).toThrow()
  })

  it('counts CPU time, not time the process spends descheduled', () => {
    // A 300 ms block costs (almost) no CPU, so it must not read as 300 ms: this is what keeps a
    // loaded host, which deschedules the long side more often than the short one, out of the ratio.
    const blocked = cpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300))
    expect(blocked).toBeLessThan(50)
    let spins = 0
    const spent = cpuMs(() => {
      const started = process.cpuUsage()
      while (process.cpuUsage(started).user < 100_000) spins += 1
    })
    expect(spent).toBeGreaterThanOrEqual(100)
    expect(spins).toBeGreaterThan(0)
  })
})
