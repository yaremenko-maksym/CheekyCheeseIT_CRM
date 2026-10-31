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

  // Pin every reason to the state it indicates, and to itself as the reason code, so that neither
  // a reason removed from a group nor a reason string blanked out passes unseen.
  it.each(['EMPTY_RESPONSE', 'BOARD_GONE'] as const)('%s → EMPTY', (reason) => {
    expect(classifyHealth(facts({ reasons: [reason] }))).toEqual({
      state: 'EMPTY',
      reasonCode: reason,
    })
  })

  it.each([
    'SCHEMA_DRIFT',
    'THROTTLED',
    'SLOW',
    'PAYLOAD_GROWTH',
    'VOLUME_DROP',
    'DEADLINE_NEAR',
  ] as const)('%s → DEGRADED', (reason) => {
    expect(classifyHealth(facts({ reasons: [reason] }))).toEqual({
      state: 'DEGRADED',
      reasonCode: reason,
    })
  })

  it.each(['NO_NEW_ITEMS', 'STALE_FEED'] as const)('%s → SILENT', (reason) => {
    expect(classifyHealth(facts({ reasons: [reason] }))).toEqual({
      state: 'SILENT',
      reasonCode: reason,
    })
  })

  it('SCHEMA_DRIFT is the dominant DEGRADED reason over the others', () => {
    expect(
      classifyHealth(
        facts({ reasons: ['DEADLINE_NEAR', 'PAYLOAD_GROWTH', 'SCHEMA_DRIFT', 'SLOW'] }),
      ).reasonCode,
    ).toBe('SCHEMA_DRIFT')
  })

  it('CAPPED carries ACCESS_CHANGED when present, else null', () => {
    expect(classifyHealth(facts({ atFailureCap: true, reasons: ['ACCESS_CHANGED'] }))).toEqual({
      state: 'CAPPED',
      reasonCode: 'ACCESS_CHANGED',
    })
    expect(classifyHealth(facts({ atFailureCap: true }))).toEqual({
      state: 'CAPPED',
      reasonCode: null,
    })
  })

  it('PAUSED carries THROTTLED when present, else null', () => {
    expect(classifyHealth(facts({ hostPaused: true, reasons: ['THROTTLED'] }))).toEqual({
      state: 'PAUSED',
      reasonCode: 'THROTTLED',
    })
    expect(classifyHealth(facts({ hostPaused: true }))).toEqual({
      state: 'PAUSED',
      reasonCode: null,
    })
  })

  it('FAILING carries null when no ACCESS_CHANGED reason is present', () => {
    expect(classifyHealth(facts({ consecutiveFailures: 2 }))).toEqual({
      state: 'FAILING',
      reasonCode: null,
    })
  })
})
