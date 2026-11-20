import { describe, expect, it } from 'vitest'
import {
  GAP_JITTER_SHARE,
  jitteredGapMs,
  START_OFFSET_MAX_MS,
  START_OFFSET_SHARE,
  startOffsetMs,
} from './jitter'

describe('jitter helpers', () => {
  describe('constants', () => {
    it('pins the agreed constants', () => {
      expect(START_OFFSET_SHARE).toBe(0.1)
      expect(START_OFFSET_MAX_MS).toBe(600_000)
      expect(GAP_JITTER_SHARE).toBe(0.5)
    })
  })

  describe('startOffsetMs', () => {
    it('returns 0 for a 0 or negative window', () => {
      expect(startOffsetMs(0, () => 0.5)).toBe(0)
      expect(startOffsetMs(0)).toBe(0)
      expect(startOffsetMs(-100, () => 0.5)).toBe(0)
    })

    it('returns 0 when random is 0', () => {
      expect(startOffsetMs(60_000, () => 0)).toBe(0)
      expect(startOffsetMs(3_600_000, () => 0)).toBe(0)
    })

    it('bounds at random = 0.999999 for a window below the 10-minute cap', () => {
      // window = 60_000 ms (1 min) -> 10% is 6_000 ms
      const offset = startOffsetMs(60_000, () => 0.999999)
      expect(offset).toBe(5999)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(6_000)
    })

    it('caps the offset at 10 minutes (600_000 ms) for large windows', () => {
      // 1000 minutes = 60_000_000 ms; 10% would be 6_000_000 ms, but capped at 600_000 ms
      const maxWin = 60_000_000
      expect(startOffsetMs(maxWin, () => 0)).toBe(0)
      expect(startOffsetMs(maxWin, () => 0.5)).toBe(300_000)
      expect(startOffsetMs(maxWin, () => 1)).toBe(600_000)
      expect(startOffsetMs(maxWin, () => 0.999999)).toBe(599_999)

      // Exactly at the 10-minute cap boundary: window = 6_000_000 ms (100 min) -> 10% is 600_000 ms
      expect(startOffsetMs(6_000_000, () => 1)).toBe(600_000)
      expect(startOffsetMs(12_000_000, () => 1)).toBe(600_000)
    })

    it('calculates the exact proportional offset for standard windows', () => {
      // 1 hour window = 3_600_000 ms -> 10% = 360_000 ms
      const windowMs = 3_600_000
      expect(startOffsetMs(windowMs, () => 0.25)).toBe(90_000)
      expect(startOffsetMs(windowMs, () => 0.5)).toBe(180_000)
      expect(startOffsetMs(windowMs, () => 0.75)).toBe(270_000)
    })

    it('floors fractional milliseconds (kills Math.floor removal mutant)', () => {
      // 15 ms window * 0.1 = 1.5 ms maxOffset. 1.5 * 0.5 = 0.75 ms.
      // Math.floor(0.75) = 0, whereas without Math.floor it would be 0.75.
      expect(startOffsetMs(15, () => 0.5)).toBe(0)
      // 25 ms window * 0.1 = 2.5 ms maxOffset. 2.5 * 0.5 = 1.25 ms.
      // Math.floor(1.25) = 1.
      expect(startOffsetMs(25, () => 0.5)).toBe(1)
    })

    it('uses Math.random by default', () => {
      const offset = startOffsetMs(60_000)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThanOrEqual(6_000)
    })
  })

  describe('jitteredGapMs', () => {
    it('returns 0 for a 0 or negative minGapMs', () => {
      expect(jitteredGapMs(0, () => 0.5)).toBe(0)
      expect(jitteredGapMs(0)).toBe(0)
      expect(jitteredGapMs(-100, () => 0.5)).toBe(0)
    })

    it('returns exactly minGapMs at random = 0 (never below minimum)', () => {
      expect(jitteredGapMs(1000, () => 0)).toBe(1000)
      expect(jitteredGapMs(3000, () => 0)).toBe(3000)
    })

    it('returns exactly 1.5x minGapMs at random = 1 (at most 1.5x)', () => {
      expect(jitteredGapMs(1000, () => 1)).toBe(1500)
      expect(jitteredGapMs(3000, () => 1)).toBe(4500)
    })

    it('scales linearly between minGapMs and 1.5x at random = 0.5', () => {
      expect(jitteredGapMs(1000, () => 0.5)).toBe(1250)
      expect(jitteredGapMs(3000, () => 0.5)).toBe(3750)
    })

    it('bounds within [minGapMs, 1.5 * minGapMs] at random = 0.999999', () => {
      const gap = jitteredGapMs(1000, () => 0.999999)
      expect(gap).toBe(1500)
      expect(gap).toBeGreaterThanOrEqual(1000)
      expect(gap).toBeLessThanOrEqual(1500)
    })

    it('rounds fractional milliseconds up (kills the Math.ceil removal / floor mutants)', () => {
      // 3 ms * (1 + 0.5 * 0.5) = 3.75 ms -> 4.
      expect(jitteredGapMs(3, () => 0.5)).toBe(4)
    })

    it('never undercuts a fractional minimum such as a decimal Crawl-delay (SR-M-1)', () => {
      // Crawl-delay 3.0005 s = 3000.5 ms; floor would give 3000, below the minimum.
      expect(jitteredGapMs(3000.5, () => 0)).toBe(3001)
    })

    it('uses Math.random by default', () => {
      const gap = jitteredGapMs(1000)
      expect(gap).toBeGreaterThanOrEqual(1000)
      expect(gap).toBeLessThanOrEqual(1500)
    })
  })
})
