import { describe, expect, it } from 'vitest'
import { shouldKeepPosting } from './retention'

const cutoff = new Date('2026-07-06T00:00:00Z')
const old = new Date('2026-06-01T00:00:00Z')
const fresh = new Date('2026-09-01T00:00:00Z')

describe('shouldKeepPosting', () => {
  it('drops an old NEW posting nobody decided on', () =>
    expect(
      shouldKeepPosting({ collectedAt: old, queueStatus: 'NEW', decidedBySenior: false }, cutoff),
    ).toBe(false))
  it('keeps anything newer than the cutoff', () =>
    expect(
      shouldKeepPosting({ collectedAt: fresh, queueStatus: 'NEW', decidedBySenior: false }, cutoff),
    ).toBe(true))
  it('keeps a posting collected exactly at the cutoff', () =>
    expect(
      shouldKeepPosting(
        { collectedAt: cutoff, queueStatus: 'NEW', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true))
  it('keeps old IN_PROGRESS and DISMISSED — a dismissed ad must not come back as new', () => {
    expect(
      shouldKeepPosting(
        { collectedAt: old, queueStatus: 'IN_PROGRESS', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true)
    expect(
      shouldKeepPosting(
        { collectedAt: old, queueStatus: 'DISMISSED', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true)
  })
  it('keeps old postings a senior already answered (existing AC4 rule)', () =>
    expect(
      shouldKeepPosting({ collectedAt: old, queueStatus: 'NEW', decidedBySenior: true }, cutoff),
    ).toBe(true))
})
