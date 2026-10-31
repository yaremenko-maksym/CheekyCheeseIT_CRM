import { describe, expect, it } from 'vitest'
import {
  alertStateOf,
  emailBudgetLeft,
  isAlertEntry,
  MAX_ALERT_EMAILS_PER_KYIV_DAY,
} from './health-alert-policy'

describe('alertStateOf (ADR section 11: which states alert)', () => {
  it.each(['FAILING', 'CAPPED', 'BLOCKED', 'EMPTY', 'PAUSED'])('%s alerts', (state) => {
    expect(alertStateOf({ state, reason: null })).toBe(state)
  })

  it('DEGRADED alerts only with SCHEMA_DRIFT', () => {
    expect(alertStateOf({ state: 'DEGRADED', reason: 'SCHEMA_DRIFT' })).toBe('DEGRADED')
    expect(alertStateOf({ state: 'DEGRADED', reason: 'SLOW' })).toBeNull()
    expect(alertStateOf({ state: 'DEGRADED', reason: null })).toBeNull()
  })

  it.each(['HEALTHY', 'SILENT'])('%s does not alert', (state) => {
    expect(alertStateOf({ state, reason: null })).toBeNull()
  })

  it('a first-ever event has no state and does not alert', () => {
    expect(alertStateOf({ state: null, reason: null })).toBeNull()
  })
})

describe('isAlertEntry (one alert per transition)', () => {
  it('HEALTHY to FAILING enters FAILING', () => {
    expect(
      isAlertEntry({ state: 'HEALTHY', reason: null }, { state: 'FAILING', reason: null }),
    ).toBe('FAILING')
  })

  it('the very first event straight into a bad state is an entry', () => {
    expect(isAlertEntry({ state: null, reason: null }, { state: 'EMPTY', reason: null })).toBe(
      'EMPTY',
    )
  })

  it('FAILING to FAILING with a new reason is NOT a new entry', () => {
    expect(
      isAlertEntry(
        { state: 'FAILING', reason: null },
        { state: 'FAILING', reason: 'ACCESS_CHANGED' },
      ),
    ).toBeNull()
  })

  it('FAILING to CAPPED enters CAPPED', () => {
    expect(
      isAlertEntry({ state: 'FAILING', reason: null }, { state: 'CAPPED', reason: null }),
    ).toBe('CAPPED')
  })

  it('recovery is not an alert', () => {
    expect(
      isAlertEntry({ state: 'FAILING', reason: null }, { state: 'HEALTHY', reason: null }),
    ).toBeNull()
  })

  it('DEGRADED(SLOW) to DEGRADED(SCHEMA_DRIFT) enters; the reverse does not', () => {
    expect(
      isAlertEntry(
        { state: 'DEGRADED', reason: 'SLOW' },
        { state: 'DEGRADED', reason: 'SCHEMA_DRIFT' },
      ),
    ).toBe('DEGRADED')
    expect(
      isAlertEntry(
        { state: 'DEGRADED', reason: 'SCHEMA_DRIFT' },
        { state: 'DEGRADED', reason: 'SLOW' },
      ),
    ).toBeNull()
  })

  it('a non-alerting target never enters', () => {
    expect(
      isAlertEntry({ state: 'HEALTHY', reason: null }, { state: 'SILENT', reason: 'NO_NEW_ITEMS' }),
    ).toBeNull()
  })
})

describe('emailBudgetLeft (at most 3 alert emails per source per Kyiv day)', () => {
  it('the cap is 3', () => {
    expect(MAX_ALERT_EMAILS_PER_KYIV_DAY).toBe(3)
  })

  it.each([
    [0, true],
    [1, true],
    [2, true],
    [3, false],
    [4, false],
  ])('%i earlier alerts today -> email %s', (earlier, expected) => {
    expect(emailBudgetLeft(earlier)).toBe(expected)
  })
})
