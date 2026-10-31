import { describe, expect, it } from 'vitest'
import { RunFencedError } from '../ownership/run-ownership'
import {
  PostingUnresolvableError,
  bridgeResultCounts,
  isTerminalDeliveryError,
} from './bridge-delivery'

describe('bridgeResultCounts (CR-M-2)', () => {
  it('a normal collection: duplicates = fetched - created - invalid (parity)', () => {
    expect(bridgeResultCounts(9, 6, 0)).toEqual({
      fetched: 9,
      created: 6,
      invalid: 0,
      duplicates: 3,
    })
    expect(bridgeResultCounts(9, 8, 0)).toEqual({
      fetched: 9,
      created: 8,
      invalid: 0,
      duplicates: 1,
    })
    expect(bridgeResultCounts(5, 3, 1)).toMatchObject({ duplicates: 1 })
  })

  it('a post-crash drain where created exceeds fetched clamps duplicates to 0 (never negative)', () => {
    expect(bridgeResultCounts(2, 3, 0).duplicates).toBe(0)
    expect(bridgeResultCounts(2, 5, 1).duplicates).toBe(0)
    expect(bridgeResultCounts(0, 2, 0).duplicates).toBe(0)
  })
})

/** A pg DatabaseError as `findPgError` recognises it: a 5-char SQLSTATE + a `severity`. */
function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' })
}

/** Drizzle wraps the driver error one level down on `.cause`. */
function drizzleWrapped(code: string): Error {
  return Object.assign(new Error('Failed query'), { cause: pgError(code) })
}

describe('isTerminalDeliveryError (CR-M-1)', () => {
  it('marks a data-level failure terminal (INVALID): SQLSTATE class 22 / 23', () => {
    expect(isTerminalDeliveryError(pgError('23505'))).toBe(true) // unique violation
    expect(isTerminalDeliveryError(pgError('23502'))).toBe(true) // not-null violation
    expect(isTerminalDeliveryError(pgError('22001'))).toBe(true) // string data right truncation
    expect(isTerminalDeliveryError(drizzleWrapped('23514'))).toBe(true) // check violation, wrapped
  })

  it('marks the unresolvable-posting dead end terminal', () => {
    expect(isTerminalDeliveryError(new PostingUnresolvableError('fp-x'))).toBe(true)
  })

  it('does NOT mark a transient infrastructure fault terminal — it must be retried', () => {
    expect(isTerminalDeliveryError(pgError('40P01'))).toBe(false) // deadlock
    expect(isTerminalDeliveryError(pgError('55P03'))).toBe(false) // lock_timeout
    expect(isTerminalDeliveryError(pgError('08006'))).toBe(false) // connection failure
    expect(isTerminalDeliveryError(drizzleWrapped('40P01'))).toBe(false)
  })

  it('does NOT mark a fencing / lost-lease error terminal', () => {
    expect(isTerminalDeliveryError(new RunFencedError())).toBe(false)
  })

  it('does NOT mark an unknown (non-pg) error terminal', () => {
    expect(isTerminalDeliveryError(new Error('boom'))).toBe(false)
    expect(isTerminalDeliveryError('a string')).toBe(false)
  })
})
