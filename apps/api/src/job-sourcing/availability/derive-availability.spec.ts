import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { availabilityEvidenceSchema, type JobAvailability } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  deriveOpportunityAvailability,
  deriveRecordAvailability,
  transitionInventoryMissCounter,
  type InventoryMissCounter,
  type InventoryRunFact,
} from './derive-availability'

const RUN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = '2026-11-01T00:00:00.000Z'
const hoursAfter = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString()

const run = (over: Partial<InventoryRunFact> = {}): InventoryRunFact => ({
  runId: RUN(1),
  board: 'acme',
  configVersion: 1,
  outcome: 'SUCCEEDED',
  coverage: 'FULL_INVENTORY',
  recordPresent: false,
  inventorySize: 100,
  observedAt: T0,
  ...over,
})

const chain = (misses: number, over: Partial<InventoryMissCounter> = {}): InventoryMissCounter => ({
  board: 'acme',
  configVersion: 1,
  consecutiveMisses: misses,
  firstMissRunId: RUN(1),
  firstMissAt: T0,
  lastMissRunId: RUN(2),
  lastMissAt: hoursAfter(1),
  lastInventorySize: 100,
  ...over,
})

describe('deriveRecordAvailability', () => {
  const base = {
    coverage: 'FULL_INVENTORY' as const,
    runId: RUN(1),
    board: 'acme',
    configVersion: 1,
    observedAt: T0,
  }

  it('present => OPEN with OBSERVED_OPEN evidence that parses', () => {
    const d = deriveRecordAvailability({ ...base, present: true })
    expect(d.kind).toBe('open')
    if (d.kind !== 'open') throw new Error('unreachable')
    expect(d.availability).toBe('OPEN')
    expect(d.evidence.kind).toBe('OBSERVED_OPEN')
    expect(availabilityEvidenceSchema.parse(d.evidence)).toEqual(d.evidence)
  })

  it('present under a WINDOW run is still OPEN', () => {
    expect(deriveRecordAvailability({ ...base, coverage: 'WINDOW', present: true }).kind).toBe(
      'open',
    )
  })

  it('absent from a FULL_INVENTORY run => miss', () => {
    expect(deriveRecordAvailability({ ...base, present: false })).toEqual({ kind: 'miss' })
  })

  it.each(['WINDOW', 'PARTIAL'] as const)(
    'absent under %s => unchanged (EXPIRED is S8e)',
    (coverage) => {
      expect(deriveRecordAvailability({ ...base, coverage, present: false })).toEqual({
        kind: 'unchanged',
      })
    },
  )
})

describe('deriveOpportunityAvailability', () => {
  it.each<[JobAvailability[], JobAvailability]>([
    [['CLOSED', 'OPEN', 'EXPIRED'], 'OPEN'],
    [['CLOSED', 'EXPIRED'], 'EXPIRED'],
    [['CLOSED', 'CLOSED'], 'CLOSED'],
    [['CLOSED', 'UNKNOWN'], 'UNKNOWN'],
    [['EXPIRED', 'UNKNOWN'], 'UNKNOWN'],
    [['UNKNOWN', 'OPEN'], 'OPEN'],
    [[], 'UNKNOWN'],
  ])('%j => %s', (states, expected) => {
    expect(deriveOpportunityAvailability(states)).toBe(expected)
  })
})

describe('transitionInventoryMissCounter', () => {
  it('first miss with no counter starts a chain at 1', () => {
    const r = transitionInventoryMissCounter(null, run())
    expect(r.kind).toBe('advance')
    expect(r.next).toEqual({
      board: 'acme',
      configVersion: 1,
      consecutiveMisses: 1,
      firstMissRunId: RUN(1),
      firstMissAt: T0,
      lastMissRunId: RUN(1),
      lastMissAt: T0,
      lastInventorySize: 100,
    })
  })

  it('second miss keeps the chain start and advances', () => {
    const r = transitionInventoryMissCounter(
      chain(1, { lastMissRunId: RUN(1), lastMissAt: T0 }),
      run({ runId: RUN(2), observedAt: hoursAfter(12) }),
    )
    expect(r.kind).toBe('advance')
    expect(r.next).toMatchObject({
      consecutiveMisses: 2,
      firstMissRunId: RUN(1),
      firstMissAt: T0,
      lastMissRunId: RUN(2),
      lastMissAt: hoursAfter(12),
    })
  })

  it.each([
    ['WINDOW coverage', { coverage: 'WINDOW' as const }],
    ['PARTIAL coverage', { coverage: 'PARTIAL' as const }],
    ['FAILED outcome', { outcome: 'FAILED' }],
    ['PARTIAL outcome', { outcome: 'PARTIAL' }],
    ['other board', { board: 'other' }],
    ['other configVersion', { configVersion: 2 }],
  ])('%s never advances nor resets', (_n, over) => {
    const cur = chain(2)
    expect(
      transitionInventoryMissCounter(cur, run({ ...over, observedAt: hoursAfter(30) })),
    ).toEqual({
      kind: 'unchanged',
      next: cur,
    })
    expect(
      transitionInventoryMissCounter(
        cur,
        run({ ...over, recordPresent: true, observedAt: hoursAfter(30) }),
      ).kind,
    ).toBe('unchanged')
  })

  it('invalid run with no counter stays null', () => {
    expect(transitionInventoryMissCounter(null, run({ coverage: 'WINDOW' }))).toEqual({
      kind: 'unchanged',
      next: null,
    })
  })

  describe('>50% inventory drop', () => {
    it('inventory 49 vs 100 => review, counter untouched', () => {
      const cur = chain(2)
      expect(
        transitionInventoryMissCounter(cur, run({ inventorySize: 49, observedAt: hoursAfter(30) })),
      ).toEqual({
        kind: 'review',
        next: cur,
      })
    })

    it('exactly 50% is not a drop and advances', () => {
      expect(
        transitionInventoryMissCounter(
          chain(1),
          run({ inventorySize: 50, observedAt: hoursAfter(2) }),
        ).kind,
      ).toBe('advance')
    })

    it('does not close even when the third miss + 24h would otherwise close', () => {
      expect(
        transitionInventoryMissCounter(
          chain(2),
          run({ inventorySize: 10, observedAt: hoursAfter(30) }),
        ).kind,
      ).toBe('review')
    })
  })

  describe('closure floor', () => {
    it('3 misses but < 24h => advance, not close', () => {
      const r = transitionInventoryMissCounter(
        chain(2),
        run({ runId: RUN(3), observedAt: hoursAfter(23) }),
      )
      expect(r.kind).toBe('advance')
      expect(r.next?.consecutiveMisses).toBe(3)
    })

    it('2 misses over >24h => advance, not close', () => {
      expect(
        transitionInventoryMissCounter(chain(1), run({ runId: RUN(3), observedAt: hoursAfter(48) }))
          .kind,
      ).toBe('advance')
    })

    it('3 misses and exactly 24h => close with parseable INVENTORY_MISSING evidence', () => {
      const r = transitionInventoryMissCounter(
        chain(2),
        run({ runId: RUN(3), observedAt: hoursAfter(24), inventorySize: 95 }),
      )
      expect(r.kind).toBe('close')
      if (r.kind !== 'close') throw new Error('unreachable')
      expect(r.evidence).toEqual({
        kind: 'INVENTORY_MISSING',
        runId: RUN(3),
        board: 'acme',
        configVersion: 1,
        observedAt: hoursAfter(24),
        consecutiveMisses: 3,
        requiredMisses: 3,
        firstMissRunId: RUN(1),
        firstMissAt: T0,
        lastInventorySize: 95,
      })
      expect(availabilityEvidenceSchema.parse(r.evidence)).toEqual(r.evidence)
      expect(r.next.consecutiveMisses).toBe(3)
    })

    it('a 4th miss after 24h still closes', () => {
      expect(
        transitionInventoryMissCounter(chain(3), run({ runId: RUN(4), observedAt: hoursAfter(30) }))
          .kind,
      ).toBe('close')
    })
  })

  describe('present resets', () => {
    it('a chain resets to 0, clearing the chain pointers', () => {
      const r = transitionInventoryMissCounter(
        chain(2),
        run({ recordPresent: true, observedAt: hoursAfter(5) }),
      )
      expect(r.kind).toBe('reset')
      expect(r.next).toMatchObject({
        consecutiveMisses: 0,
        firstMissRunId: null,
        firstMissAt: null,
        lastMissRunId: null,
        lastMissAt: null,
      })
    })

    it('after a reset the next miss starts a fresh chain at 1', () => {
      const reset = transitionInventoryMissCounter(
        chain(2),
        run({ recordPresent: true, observedAt: hoursAfter(5) }),
      )
      const r = transitionInventoryMissCounter(
        reset.next,
        run({ runId: RUN(9), observedAt: hoursAfter(40) }),
      )
      expect(r.kind).toBe('advance')
      expect(r.next).toMatchObject({ consecutiveMisses: 1, firstMissRunId: RUN(9) })
    })

    it('present with a zero-miss counter is unchanged, not a reset', () => {
      const zero = chain(0, {
        firstMissRunId: null,
        firstMissAt: null,
        lastMissRunId: null,
        lastMissAt: null,
      })
      expect(transitionInventoryMissCounter(zero, run({ recordPresent: true }))).toEqual({
        kind: 'unchanged',
        next: zero,
      })
    })

    it('a zero-miss counter with stale chain pointers starts a fresh chain from this run', () => {
      const r = transitionInventoryMissCounter(
        chain(0),
        run({ runId: RUN(7), observedAt: hoursAfter(50) }),
      )
      expect(r.kind).toBe('advance')
      expect(r.next).toMatchObject({
        consecutiveMisses: 1,
        firstMissRunId: RUN(7),
        firstMissAt: hoursAfter(50),
      })
    })

    it('present with no chain is unchanged', () => {
      expect(transitionInventoryMissCounter(null, run({ recordPresent: true }))).toEqual({
        kind: 'unchanged',
        next: null,
      })
    })
  })

  describe('fix round 1 (security)', () => {
    it('SR-H-1: replay of the latest run is unchanged', () => {
      const cur = chain(2, { lastMissRunId: RUN(3), lastMissAt: hoursAfter(25) })
      expect(
        transitionInventoryMissCounter(cur, run({ runId: RUN(3), observedAt: hoursAfter(30) })),
      ).toEqual({ kind: 'unchanged', next: cur })
    })

    it('SR-H-1: an older or equal observedAt (new runId) is unchanged', () => {
      const cur = chain(2, { lastMissRunId: RUN(3), lastMissAt: hoursAfter(25) })
      for (const h of [24, 25]) {
        expect(
          transitionInventoryMissCounter(cur, run({ runId: RUN(4), observedAt: hoursAfter(h) })),
        ).toEqual({ kind: 'unchanged', next: cur })
      }
      expect(
        transitionInventoryMissCounter(cur, run({ runId: RUN(4), observedAt: hoursAfter(26) }))
          .kind,
      ).toBe('close')
    })

    it('SR-H-1: a replayed present run does not reset', () => {
      const cur = chain(2, { lastMissRunId: RUN(3), lastMissAt: hoursAfter(25) })
      expect(
        transitionInventoryMissCounter(
          cur,
          run({ runId: RUN(3), recordPresent: true, observedAt: hoursAfter(30) }),
        ).kind,
      ).toBe('unchanged')
    })

    it('SR-H-2: a single empty run (no counter) => review, no advance', () => {
      expect(transitionInventoryMissCounter(null, run({ inventorySize: 0 }))).toEqual({
        kind: 'review',
        next: null,
      })
    })

    it('SR-H-2: three empty runs over 48h never close', () => {
      let cur: InventoryMissCounter | null = null
      for (const [i, h] of [0, 24, 48].entries()) {
        const r = transitionInventoryMissCounter(
          cur,
          run({ runId: RUN(i + 1), inventorySize: 0, observedAt: hoursAfter(h) }),
        )
        expect(r.kind).toBe('review')
        cur = r.next
      }
      expect(cur).toBeNull()
    })

    it('SR-H-2: empty run after a chain with a zero baseline is review', () => {
      const cur = chain(2, { lastInventorySize: 0 })
      expect(
        transitionInventoryMissCounter(cur, run({ inventorySize: 0, observedAt: hoursAfter(30) })),
      ).toEqual({ kind: 'review', next: cur })
    })

    it('SR-M-1: step-shrink 100 -> 60 -> 30 trips review (baseline is the chain max)', () => {
      const a = transitionInventoryMissCounter(null, run({ inventorySize: 100 }))
      const b = transitionInventoryMissCounter(
        a.next,
        run({ runId: RUN(2), inventorySize: 60, observedAt: hoursAfter(10) }),
      )
      expect(b.kind).toBe('advance')
      expect(b.next?.lastInventorySize).toBe(100)
      const c = transitionInventoryMissCounter(
        b.next,
        run({ runId: RUN(3), inventorySize: 30, observedAt: hoursAfter(25) }),
      )
      expect(c).toEqual({ kind: 'review', next: b.next })
    })

    it('SR-M-1: a present record on a collapsed run => review, baseline untouched', () => {
      const cur = chain(2)
      expect(
        transitionInventoryMissCounter(
          cur,
          run({ recordPresent: true, inventorySize: 10, observedAt: hoursAfter(5) }),
        ),
      ).toEqual({ kind: 'review', next: cur })
    })

    it('SR-M-1: a normal reset keeps the baseline', () => {
      const r = transitionInventoryMissCounter(
        chain(2),
        run({ recordPresent: true, inventorySize: 80, observedAt: hoursAfter(5) }),
      )
      expect(r.kind).toBe('reset')
      expect(r.next?.lastInventorySize).toBe(100)
    })

    it('baseline rises with a larger inventory inside a chain', () => {
      const r = transitionInventoryMissCounter(
        chain(1),
        run({ inventorySize: 120, observedAt: hoursAfter(2) }),
      )
      expect(r.next?.lastInventorySize).toBe(120)
    })
  })
})

describe('purity', () => {
  it('imports nothing from drizzle / nest / database', () => {
    const src = readFileSync(join(__dirname, 'derive-availability.ts'), 'utf8')
    const imports = src.match(/from\s+'[^']+'/g) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i).not.toMatch(/drizzle|@nestjs|database|\.store/)
  })
})
