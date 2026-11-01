import { describe, expect, it } from 'vitest'
import type { InventoryMissCounter } from './derive-availability'
import {
  type RunRow,
  fold,
  parseInventoryRunFact,
  rowToCounter,
  seedCounter,
} from './inventory-counter-updater'

const BOARD = 'greenhouse:acme'
const run = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
const DAY = 24 * 60 * 60 * 1000
const at = (ms: number) => new Date(ms).toISOString()

function missRun(n: number, ms: number, inventorySize = 100): RunRow {
  return {
    fact: {
      runId: run(n),
      board: BOARD,
      configVersion: 1,
      outcome: 'SUCCEEDED',
      coverage: 'FULL_INVENTORY',
      recordPresent: false,
      inventorySize,
      observedAt: at(ms),
    },
    cycleId: `00000000-0000-4000-8000-0000000000c${n}`,
  }
}

function presentRun(n: number, ms: number, inventorySize = 100): RunRow {
  return {
    ...missRun(n, ms, inventorySize),
    fact: { ...missRun(n, ms, inventorySize).fact, recordPresent: true },
  }
}

describe('parseInventoryRunFact (boundary)', () => {
  const good = missRun(1, 0).fact
  it('accepts a well-formed fact', () => {
    expect(parseInventoryRunFact(good)).toEqual(good)
  })
  it('rejects a NaN inventorySize', () => {
    expect(() => parseInventoryRunFact({ ...good, inventorySize: Number.NaN })).toThrow()
  })
  it('rejects an infinite inventorySize', () => {
    expect(() =>
      parseInventoryRunFact({ ...good, inventorySize: Number.POSITIVE_INFINITY }),
    ).toThrow()
  })
  it('rejects a negative inventorySize', () => {
    expect(() => parseInventoryRunFact({ ...good, inventorySize: -1 })).toThrow()
  })
  it('rejects a non-ISO observedAt', () => {
    expect(() => parseInventoryRunFact({ ...good, observedAt: 'not-a-date' })).toThrow()
  })
  it('rejects a blank board', () => {
    expect(() => parseInventoryRunFact({ ...good, board: '   ' })).toThrow()
  })
})

describe('rowToCounter (paired-pointer invariant)', () => {
  const base = {
    board: BOARD,
    config_version: 1,
    consecutive_misses: 2,
    first_miss_run_id: run(1),
    first_miss_at: new Date(0),
    last_miss_run_id: run(2),
    last_miss_at: new Date(DAY),
    last_inventory_size: 100,
  }
  it('maps a well-formed row, Date -> ISO', () => {
    const c = rowToCounter(base)
    expect(c).toEqual<InventoryMissCounter>({
      board: BOARD,
      configVersion: 1,
      consecutiveMisses: 2,
      firstMissRunId: run(1),
      firstMissAt: at(0),
      lastMissRunId: run(2),
      lastMissAt: at(DAY),
      lastInventorySize: 100,
    })
  })
  it('rejects a half-null last-miss pointer', () => {
    expect(() => rowToCounter({ ...base, last_miss_at: null })).toThrow(/half-null last-miss/)
  })
  it('rejects a half-null first-miss pointer', () => {
    expect(() => rowToCounter({ ...base, first_miss_run_id: null })).toThrow(/half-null first-miss/)
  })
})

describe('seedCounter (drop-guard baseline)', () => {
  const input = { sourceRecordId: run(1), sourceId: run(2), board: BOARD, configVersion: 1 }
  it('seeds a zeroed counter carrying the baseline when a healthy size exists', () => {
    expect(seedCounter(input, 100)).toEqual<InventoryMissCounter>({
      board: BOARD,
      configVersion: 1,
      consecutiveMisses: 0,
      firstMissRunId: null,
      firstMissAt: null,
      lastMissRunId: null,
      lastMissAt: null,
      lastInventorySize: 100,
    })
  })
  it('returns null with no baseline', () => {
    expect(seedCounter(input, null)).toBeNull()
  })
  it('returns null for a non-positive baseline', () => {
    expect(seedCounter(input, 0)).toBeNull()
  })
})

describe('fold', () => {
  it('no runs -> unchanged, counter unchanged, not dirty', () => {
    const f = fold(null, [])
    expect(f).toMatchObject({
      net: 'unchanged',
      counter: null,
      dirty: false,
      reviewed: false,
      close: null,
    })
  })

  it('a single miss from null advances a fresh chain', () => {
    const f = fold(null, [missRun(1, 0)])
    expect(f.net).toBe('advance')
    expect(f.dirty).toBe(true)
    expect(f.close).toBeNull()
    expect(f.counter?.consecutiveMisses).toBe(1)
    expect(f.counter?.firstMissRunId).toBe(run(1))
  })

  it('three misses >=24h apart close with evidence and the closing cycle', () => {
    const f = fold(null, [missRun(1, 0), missRun(2, DAY / 2), missRun(3, DAY + 1)])
    expect(f.net).toBe('close')
    expect(f.dirty).toBe(true)
    expect(f.counter?.consecutiveMisses).toBe(3)
    expect(f.close?.evidence.kind).toBe('INVENTORY_MISSING')
    expect(f.close?.cycleId).toBe('00000000-0000-4000-8000-0000000000c3')
  })

  it('a present run after a close resets the chain and clears the close', () => {
    const f = fold(null, [
      missRun(1, 0),
      missRun(2, DAY / 2),
      missRun(3, DAY + 1),
      presentRun(4, DAY + 2),
    ])
    expect(f.net).toBe('reset')
    expect(f.dirty).toBe(true)
    expect(f.close).toBeNull()
    expect(f.counter?.consecutiveMisses).toBe(0)
  })

  it('a >50% drop against the seed baseline reviews without advancing', () => {
    const seed = seedCounter(
      { sourceRecordId: run(1), sourceId: run(2), board: BOARD, configVersion: 1 },
      100,
    )
    const f = fold(seed, [missRun(1, DAY, 40)])
    expect(f.net).toBe('review')
    expect(f.dirty).toBe(false)
    expect(f.reviewed).toBe(true)
    expect(f.close).toBeNull()
  })

  it('present-only runs from null write nothing', () => {
    const f = fold(null, [presentRun(1, 0), presentRun(2, DAY)])
    expect(f.net).toBe('unchanged')
    expect(f.dirty).toBe(false)
    expect(f.counter).toBeNull()
  })
})
