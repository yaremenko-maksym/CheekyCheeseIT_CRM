import { expect } from 'vitest'

/** A hang, not a slow machine: the only wall-clock bound, deliberately loose. */
const ABSOLUTE_CAP_MS = 30_000
/** Absorbs timer noise and GC when the small input takes a few milliseconds. */
const SLACK_MS = 50
const RUNS = 3

/** Fastest of a few runs: the minimum filters scheduler and GC noise; the first run also warms. */
function fastestMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

/**
 * Asserts time(big) <= maxFactor * time(small) + slack, instead of a wall-clock bound that depends
 * on the machine. Build both inputs outside `small` / `big`, so only the work is timed. Linear work
 * on a 4x input takes ~4x; a quadratic one ~16x, so a factor of 8 tells them apart on any machine.
 */
export function expectScaling(small: () => unknown, big: () => unknown, maxFactor: number): void {
  const smallMs = fastestMs(small)
  const bigMs = fastestMs(big)
  expect(bigMs).toBeLessThanOrEqual(maxFactor * smallMs + SLACK_MS)
  expect(bigMs).toBeLessThan(ABSOLUTE_CAP_MS)
}
