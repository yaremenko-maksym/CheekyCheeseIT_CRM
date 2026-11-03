import { describe, expect, it } from 'vitest'
import { CLAIM_REFUSALS, enableRefusal } from './ledger-policy'

/**
 * r5 Task 6.5 — the pure rule behind the ADMIN source switch: switching a source on never grants
 * readiness and never clears an access refusal. The ledger's `setEnabled` feeds it the locked row
 * and the claim gate's verdict; its SQL is pinned by job-run-ledger.switch.integration.spec.ts.
 */

const READY = { storedReadiness: 'CANDIDATE', gate: null, lastErrorCode: null } as const

describe('enableRefusal', () => {
  it('a ready source with no access refusal may be switched on', () => {
    expect(enableRefusal(READY)).toBeNull()
    expect(enableRefusal({ ...READY, storedReadiness: 'VERIFIED' })).toBeNull()
  })

  it('a stored BLOCKED readiness refuses, whatever the gate says', () => {
    expect(enableRefusal({ ...READY, storedReadiness: 'BLOCKED' })).toBe('NOT_READY')
  })

  it.each(CLAIM_REFUSALS)('a claim-gate refusal %s refuses as NOT_READY', (gate) => {
    expect(enableRefusal({ ...READY, gate })).toBe('NOT_READY')
  })

  it('an ACCESS_POLICY refusal pauses the source until an ADMIN reset clears it', () => {
    expect(enableRefusal({ ...READY, lastErrorCode: 'ACCESS_POLICY' })).toBe('AUTH_PAUSED')
  })

  it('readiness is reported before the access pause', () => {
    expect(
      enableRefusal({ storedReadiness: 'BLOCKED', gate: null, lastErrorCode: 'ACCESS_POLICY' }),
    ).toBe('NOT_READY')
  })

  it.each(['RATE_LIMIT', 'UPSTREAM', 'LEASE_EXPIRED', 'CANCELLED', 'HOST_PAUSED'])(
    'an ordinary failure code %s does not refuse (backoff and cooldown handle it)',
    (lastErrorCode) => {
      expect(enableRefusal({ ...READY, lastErrorCode })).toBeNull()
    },
  )
})
