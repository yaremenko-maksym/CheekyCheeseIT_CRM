import { describe, expect, it } from 'vitest'
import {
  JOB_SOURCE_RESET_REASON_MAX,
  excludedJobSourceListSchema,
  resetJobSourceFailuresSchema,
} from './job-source-admin'

describe('resetJobSourceFailuresSchema (Task 2.5 T9 AC 3)', () => {
  it('accepts a reason of 1..500 characters and trims it', () => {
    expect(resetJobSourceFailuresSchema.parse({ reason: '  provider fixed  ' })).toEqual({
      reason: 'provider fixed',
    })
    expect(JOB_SOURCE_RESET_REASON_MAX).toBe(500)
    expect(resetJobSourceFailuresSchema.parse({ reason: 'x'.repeat(500) }).reason).toHaveLength(500)
  })

  it.each([
    ['no body', undefined],
    ['no reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['an over-long reason', { reason: 'x'.repeat(501) }],
    ['a non-string reason', { reason: 42 }],
    ['an unknown key', { reason: 'ok', consecutiveFailures: 0 }],
  ])('refuses %s', (_label, body) => {
    expect(resetJobSourceFailuresSchema.safeParse(body).success).toBe(false)
  })
})

describe('excludedJobSourceListSchema', () => {
  const item = {
    sourceId: 'e7f8a9b0-1c2d-4e3f-8c00-0000000000f1',
    type: 'REMOTIVE_API',
    hostKey: 'remotive.com',
    reasons: ['FAILURE_CAP', 'OVERDUE'],
    consecutiveFailures: 3,
    lastErrorCode: 'LEASE_EXPIRED',
    nextAttemptAt: '2026-10-20T00:00:00.000Z',
    pausedUntil: null,
    pauseReason: null,
    pauseSourceId: null,
  }

  it('accepts a listed source', () => {
    expect(excludedJobSourceListSchema.parse({ items: [item] }).items[0]).toEqual(item)
  })

  it.each(['FAILURE_CAP', 'HOST_PAUSED', 'CLAIM_REFUSED', 'OVERDUE'])('accepts reason %s', (r) => {
    expect(
      excludedJobSourceListSchema.parse({ items: [{ ...item, reasons: [r] }] }).items[0]?.reasons,
    ).toEqual([r])
  })

  it('bounds the pause reason to a 64-character code', () => {
    const paused = {
      ...item,
      pausedUntil: '2026-10-26T00:00:00.000Z',
      pauseReason: 'HTTP_429',
      pauseSourceId: item.sourceId,
    }
    expect(excludedJobSourceListSchema.parse({ items: [paused] }).items[0]?.pauseReason).toBe(
      'HTTP_429',
    )
    expect(
      excludedJobSourceListSchema.safeParse({ items: [{ ...paused, pauseReason: 'X'.repeat(65) }] })
        .success,
    ).toBe(false)
  })

  it('refuses an unknown reason and an empty reason list', () => {
    expect(
      excludedJobSourceListSchema.safeParse({ items: [{ ...item, reasons: ['WHATEVER'] }] })
        .success,
    ).toBe(false)
    expect(
      excludedJobSourceListSchema.safeParse({ items: [{ ...item, reasons: [] }] }).success,
    ).toBe(false)
  })

  it('does not carry fields outside the allow-list', () => {
    const parsed = excludedJobSourceListSchema.parse({
      items: [{ ...item, config: { apiKey: 'secret' }, adminStateHistory: [] }],
    })
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual(Object.keys(item).sort())
  })
})
