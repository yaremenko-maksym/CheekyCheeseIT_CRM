import { describe, expect, it } from 'vitest'
import { formatDay, sourceAlertParams } from './source-health-params'

describe('formatDay', () => {
  it('formats a Kyiv calendar date by locale, never as raw ISO', () => {
    expect(formatDay('2026-10-26', 'uk')).toBe('26 жовтня')
    expect(formatDay('2026-10-26', 'en')).toBe('October 26')
    expect(formatDay('2026-01-01', 'en')).toBe('January 1')
  })

  it('places an instant on the Kyiv calendar first', () => {
    expect(formatDay('2026-10-27T22:30:00.000Z', 'en')).toBe('October 28')
    expect(formatDay('2026-10-27T21:30:00.000Z', 'en')).toBe('October 27')
  })
})

describe('sourceAlertParams', () => {
  const base = { sourceName: 'remotive_api', state: 'CAPPED' }

  it('with both facts: the branch is "yes" and the day is formatted for the reader', () => {
    expect(
      sourceAlertParams({ ...base, failures: 5, since: '2026-10-28T08:15:00.000Z' }, 'en'),
    ).toEqual({
      source: 'remotive_api',
      state: 'CAPPED',
      hasCount: 'yes',
      failures: 5,
      since: 'October 28',
    })
  })

  it('with a zero failure count the fact is still present (zero is a number, not an absence)', () => {
    expect(
      sourceAlertParams({ ...base, failures: 0, since: '2026-10-28T08:15:00.000Z' }, 'uk').hasCount,
    ).toBe('yes')
  })

  it.each([
    ['neither', {}],
    ['null facts', { failures: null, since: null }],
    ['only the count', { failures: 5 }],
    ['only the day', { since: '2026-10-28T08:15:00.000Z' }],
  ])('%s: the branch is "no", so the sentence claims nothing it does not know', (_n, facts) => {
    expect(sourceAlertParams({ ...base, ...facts }, 'en').hasCount).toBe('no')
  })

  it('absent facts become neutral parameters', () => {
    expect(sourceAlertParams(base, 'en')).toEqual({
      source: 'remotive_api',
      state: 'CAPPED',
      hasCount: 'no',
      failures: 0,
      since: '',
    })
  })
})
