/**
 * Source-fetch-strategy U4 CR-M-4 — the manifest/provider facts that make BOARD_GONE, STALE_FEED
 * and DEADLINE_NEAR live. Pure; no database.
 */
import { describe, expect, it } from 'vitest'
import { freshnessMaxAgeMsFor, isEmployerBoard, policyDeadlineFor } from './provider-facts'

const HOUR = 60 * 60 * 1000

describe('isEmployerBoard', () => {
  it('is true for the ATS board family and false for feeds/APIs', () => {
    expect(isEmployerBoard('GREENHOUSE_ATS')).toBe(true)
    expect(isEmployerBoard('RECRUITEE_ATS')).toBe(true)
    expect(isEmployerBoard('REMOTIVE_API')).toBe(false)
    expect(isEmployerBoard('DOU_RSS')).toBe(false)
  })
})

describe('freshnessMaxAgeMsFor', () => {
  it('is the provider feed-delay where declared, else null', () => {
    expect(freshnessMaxAgeMsFor('REMOTIVE_API')).toBe(24 * HOUR)
    expect(freshnessMaxAgeMsFor('JOBICY_API')).toBe(3 * HOUR)
    expect(freshnessMaxAgeMsFor('GREENHOUSE_ATS')).toBeNull()
  })
})

describe('policyDeadlineFor', () => {
  it('is the known policy deadline where declared, else null', () => {
    expect(policyDeadlineFor('RECRUITEE_ATS')?.toISOString()).toBe('2027-02-10T00:00:00.000Z')
    expect(policyDeadlineFor('REMOTIVE_API')).toBeNull()
  })
})
