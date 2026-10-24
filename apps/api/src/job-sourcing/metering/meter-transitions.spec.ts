import { describe, expect, it } from 'vitest'
import {
  isInCurrentWindow,
  planMarkSent,
  planSettlement,
  reservationKey,
  reservationKeyPrefix,
} from './meter-transitions'

/**
 * The reservation state machine, as a table written out by hand from r5 Task 3.5 ("release only
 * provably unsent cost, exactly-once conversion to used, uncertain hold until reconciliation").
 * The integration spec proves the same moves against real counters; this one is what the
 * mutation gate can see.
 */
describe('planSettlement', () => {
  it('RESERVED -> USED in the current window: release the hold, spend it, stamp send + settle', () => {
    expect(planSettlement('RESERVED', 'USED', true)).toEqual({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUncertain: false,
      addUsed: true,
      stampSent: true,
      stampSettled: true,
      recordUsed: true,
    })
  })

  it('RESERVED -> USED for a reservation of an EARLIER window does not spend in this one', () => {
    expect(planSettlement('RESERVED', 'USED', false)).toMatchObject({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUsed: false,
      recordUsed: true,
    })
  })

  it('RESERVED -> RELEASED frees the hold and never stamps a send', () => {
    expect(planSettlement('RESERVED', 'RELEASED', true)).toEqual({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUncertain: false,
      addUsed: false,
      stampSent: false,
      stampSettled: true,
      recordUsed: false,
    })
  })

  it('RESERVED -> UNCERTAIN moves the hold to `uncertain` and leaves it unsettled', () => {
    expect(planSettlement('RESERVED', 'UNCERTAIN', true)).toEqual({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUncertain: true,
      addUsed: false,
      stampSent: true,
      stampSettled: false,
      recordUsed: false,
    })
  })

  it('SENT -> UNCERTAIN and SENT -> USED are legal', () => {
    expect(planSettlement('SENT', 'UNCERTAIN', true)).toMatchObject({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUncertain: true,
    })
    expect(planSettlement('SENT', 'USED', true)).toMatchObject({
      kind: 'apply',
      releaseFrom: 'reserved',
      addUsed: true,
    })
  })

  it('SENT -> RELEASED is refused: the request left, its cost is not provably unsent', () => {
    expect(planSettlement('SENT', 'RELEASED', true)).toEqual({ kind: 'illegal' })
  })

  it('UNCERTAIN -> USED releases the uncertain hold, not the reserved one', () => {
    expect(planSettlement('UNCERTAIN', 'USED', true)).toEqual({
      kind: 'apply',
      releaseFrom: 'uncertain',
      addUncertain: false,
      addUsed: true,
      stampSent: true,
      stampSettled: true,
      recordUsed: true,
    })
    expect(planSettlement('UNCERTAIN', 'USED', false)).toMatchObject({ addUsed: false })
  })

  it('UNCERTAIN -> RELEASED is refused', () => {
    expect(planSettlement('UNCERTAIN', 'RELEASED', true)).toEqual({ kind: 'illegal' })
  })

  it('a reservation already where it is asked to go is a no-op (exactly once)', () => {
    expect(planSettlement('USED', 'USED', true)).toEqual({ kind: 'noop' })
    expect(planSettlement('RELEASED', 'RELEASED', true)).toEqual({ kind: 'noop' })
    expect(planSettlement('UNCERTAIN', 'UNCERTAIN', true)).toEqual({ kind: 'noop' })
  })

  it('nothing leaves a settled state except to itself', () => {
    expect(planSettlement('USED', 'UNCERTAIN', true)).toEqual({ kind: 'illegal' })
    expect(planSettlement('USED', 'RELEASED', true)).toEqual({ kind: 'illegal' })
    expect(planSettlement('RELEASED', 'USED', true)).toEqual({ kind: 'illegal' })
    expect(planSettlement('RELEASED', 'UNCERTAIN', true)).toEqual({ kind: 'illegal' })
  })
})

describe('planMarkSent', () => {
  it('RESERVED -> SENT applies; SENT again is a no-op', () => {
    expect(planMarkSent('RESERVED')).toBe('apply')
    expect(planMarkSent('SENT')).toBe('noop')
  })

  it.each(['USED', 'RELEASED', 'UNCERTAIN'] as const)('%s cannot be marked sent', (from) => {
    expect(planMarkSent(from)).toBe('illegal')
  })
})

describe('isInCurrentWindow', () => {
  const start = new Date('2026-10-23T00:00:00.000Z')

  it('a meter with no window start (LIFETIME) has only one window', () => {
    expect(isInCurrentWindow(null, new Date('2000-01-01T00:00:00Z'))).toBe(true)
  })

  it('reserved exactly at the window start belongs to it; one ms earlier does not', () => {
    expect(isInCurrentWindow(start, new Date('2026-10-23T00:00:00.000Z'))).toBe(true)
    expect(isInCurrentWindow(start, new Date('2026-10-22T23:59:59.999Z'))).toBe(false)
  })
})

describe('reservation keys', () => {
  it('spells <attempt>#<unit>#<n>', () => {
    expect(reservationKey('att-1', 'RECORD', 3)).toBe('att-1#RECORD#3')
    expect(reservationKeyPrefix('att-1', 'RECORD')).toBe('att-1#RECORD#')
  })

  it('one attempt prefix never matches another attempt whose id it prefixes', () => {
    expect(
      reservationKey('att-10', 'REQUEST', 1).startsWith(reservationKeyPrefix('att-1', 'REQUEST')),
    ).toBe(false)
  })
})
