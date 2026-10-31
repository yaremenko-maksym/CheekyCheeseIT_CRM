/**
 * Source-fetch-strategy U4 AC 2 — the precedence table of section 10, with the required case:
 * a source both CAPPED and SILENT is CAPPED.
 */
import { describe, expect, it } from 'vitest'
import { classifyHealth } from './classify-health'
import type { HealthReason, HealthStateFacts } from './types'

function facts(overrides: Partial<HealthStateFacts> = {}): HealthStateFacts {
  return {
    adminState: 'ACTIVE',
    blocked: false,
    atFailureCap: false,
    hostPaused: false,
    consecutiveFailures: 0,
    reasons: [],
    ...overrides,
  }
}

describe('classifyHealth', () => {
  it('AC 2: a source both CAPPED and SILENT is CAPPED', () => {
    const verdict = classifyHealth(
      facts({ atFailureCap: true, reasons: ['NO_NEW_ITEMS'] as HealthReason[] }),
    )
    expect(verdict.state).toBe('CAPPED')
  })

  it('BLOCKED when admin_state is not ACTIVE', () => {
    expect(classifyHealth(facts({ adminState: 'PAUSED' })).state).toBe('BLOCKED')
    expect(classifyHealth(facts({ adminState: 'RETIRED' })).state).toBe('BLOCKED')
  })

  it('BLOCKED beats everything, including a failure cap', () => {
    expect(classifyHealth(facts({ blocked: true, atFailureCap: true })).state).toBe('BLOCKED')
  })

  it('PAUSED beats FAILING', () => {
    expect(classifyHealth(facts({ hostPaused: true, consecutiveFailures: 2 })).state).toBe('PAUSED')
  })

  it('FAILING with reason ACCESS_CHANGED when a 401/403 run failed', () => {
    const verdict = classifyHealth(facts({ consecutiveFailures: 1, reasons: ['ACCESS_CHANGED'] }))
    expect(verdict).toEqual({ state: 'FAILING', reasonCode: 'ACCESS_CHANGED' })
  })

  it('EMPTY on EMPTY_RESPONSE, above DEGRADED and SILENT', () => {
    const verdict = classifyHealth(
      facts({ reasons: ['EMPTY_RESPONSE', 'SCHEMA_DRIFT', 'NO_NEW_ITEMS'] }),
    )
    expect(verdict).toEqual({ state: 'EMPTY', reasonCode: 'EMPTY_RESPONSE' })
  })

  it('DEGRADED with SCHEMA_DRIFT as the dominant reason', () => {
    const verdict = classifyHealth(facts({ reasons: ['SLOW', 'SCHEMA_DRIFT'] }))
    expect(verdict).toEqual({ state: 'DEGRADED', reasonCode: 'SCHEMA_DRIFT' })
  })

  it('SILENT when only a silent signal fired', () => {
    expect(classifyHealth(facts({ reasons: ['STALE_FEED'] }))).toEqual({
      state: 'SILENT',
      reasonCode: 'STALE_FEED',
    })
  })

  it('HEALTHY when nothing fired', () => {
    expect(classifyHealth(facts())).toEqual({ state: 'HEALTHY', reasonCode: null })
  })
})
