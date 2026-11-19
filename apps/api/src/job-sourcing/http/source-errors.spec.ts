import { describe, expect, it } from 'vitest'
import { REFUSAL_STATUSES, SourceBlockedError, refusalKind } from './source-errors'

/**
 * CR-M-3: the refusal predicate has ONE owner, so it is pinned once, here, rather than through
 * each of its two call sites (`bounded-fetch`, `dou.provider`).
 */
describe('refusalKind (THE refusal predicate)', () => {
  const res = (status: number, headers: Record<string, string> = {}): Response =>
    new Response(null, { status, headers })

  for (const status of [401, 403, 451]) {
    it(`${status} alone is a STATUS refusal`, () => {
      expect(refusalKind(res(status))).toBe('STATUS')
    })
  }

  it('the three statuses are the set the house transport declares', () => {
    expect([...REFUSAL_STATUSES].sort((a, b) => a - b)).toEqual([401, 403, 451])
  })

  it('a challenge is a refusal under a status that is not one — 503', () => {
    expect(refusalKind(res(503, { 'cf-mitigated': 'challenge' }))).toBe('CHALLENGE')
  })

  it('a challenge is a refusal under 200, where the status itself claims success', () => {
    expect(refusalKind(res(200, { 'cf-mitigated': 'challenge' }))).toBe('CHALLENGE')
  })

  it('CHALLENGE wins over STATUS when both hold (the header is the more precise fact)', () => {
    expect(refusalKind(res(403, { 'cf-mitigated': 'challenge' }))).toBe('CHALLENGE')
  })

  it('another cf-mitigated value is not a refusal', () => {
    expect(refusalKind(res(200, { 'cf-mitigated': 'captcha' }))).toBeNull()
  })

  for (const status of [200, 304, 429, 500, 503]) {
    it(`${status} with no challenge header is not a refusal`, () => {
      expect(refusalKind(res(status))).toBeNull()
    })
  }
})

describe('SourceBlockedError message (CR-L-3: English, and it is persisted)', () => {
  it('a STATUS refusal names the refusal', () => {
    const err = new SourceBlockedError('jobs.dou.ua', 403)
    expect(err.refusal).toBe('STATUS')
    expect(err.message).toBe(
      'Source jobs.dou.ua refused access (HTTP 403) — the row is paused, no workaround is attempted',
    )
    expect(err.budgetExhausted).toBe(false)
  })

  it('a CHALLENGE names the challenge, so a 200 does not read as a contradiction', () => {
    const err = new SourceBlockedError('jobs.dou.ua', 200, null, 'CHALLENGE')
    expect(err.message).toBe(
      'Source jobs.dou.ua served an anti-bot challenge (HTTP 200) — the row is paused, no workaround is attempted',
    )
  })

  it('keeps the raw Retry-After text it was given', () => {
    expect(new SourceBlockedError('h.test', 403, '120').retryAfter).toBe('120')
    expect(new SourceBlockedError('h.test', 403).retryAfter).toBeNull()
  })
})
