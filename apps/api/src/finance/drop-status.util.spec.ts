import { describe, expect, it } from 'vitest'

import {
  mapDropIncomeStatus,
  mapDropObligationStatus,
  mapDropPaymentStatus,
} from './drop-status.util'

describe('mapDropIncomeStatus', () => {
  it.each([
    ['VALIDATED', 'validated'],
    ['PAID', 'paid'],
    ['REJECTED', 'rejected'],
    ['PENDING', 'pending'],
  ])('%s -> %s', (db, expected) => {
    expect(mapDropIncomeStatus(db)).toBe(expected)
  })

  it.each(['PENDING_PAYMENT', 'LOCKED', 'PENDING_CASH_CONFIRM', '', 'garbage'])(
    'unexpected status %j falls back to pending',
    (db) => {
      expect(mapDropIncomeStatus(db)).toBe('pending')
    },
  )
})

describe('mapDropObligationStatus', () => {
  it.each([
    ['PAID', 'paid'],
    ['REJECTED', 'rejected'],
    ['PENDING_PAYMENT', 'pending'],
  ])('%s -> %s', (db, expected) => {
    expect(mapDropObligationStatus(db)).toBe(expected)
  })

  it('never produces validated: VALIDATED falls to the pending default', () => {
    expect(mapDropObligationStatus('VALIDATED')).toBe('pending')
  })

  it.each(['PENDING', 'PENDING_CASH_CONFIRM', 'LOCKED', '', 'garbage'])(
    'unexpected status %j falls back to pending',
    (db) => {
      expect(mapDropObligationStatus(db)).toBe('pending')
    },
  )
})

describe('mapDropPaymentStatus', () => {
  it.each([
    ['PAID', 'confirmed'],
    ['REJECTED', 'failed'],
    ['PENDING_PAYMENT', 'pending'],
    // Explicit phase 4-B cash-confirmation gate: still waiting, never confirmed.
    ['PENDING_CASH_CONFIRM', 'pending'],
  ])('%s -> %s', (db, expected) => {
    expect(mapDropPaymentStatus(db)).toBe(expected)
  })

  it.each(['LOCKED', 'PENDING', 'VALIDATED', '', 'garbage'])(
    'unreachable status %j falls back to pending',
    (db) => {
      expect(mapDropPaymentStatus(db)).toBe('pending')
    },
  )
})
