import { describe, expect, it } from 'vitest'
import { computeDailySalt, computeSessionHash } from './session-hash'

const SECRET = 'a-very-secret-value-not-checked-into-any-repo'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

describe('computeDailySalt', () => {
  it('is deterministic within the same UTC day', () => {
    const now = new Date('2026-07-24T08:00:00Z')
    const laterSameDay = new Date('2026-07-24T23:59:59Z')
    expect(computeDailySalt(SECRET, now)).toBe(computeDailySalt(SECRET, laterSameDay))
  })

  it('rotates across a UTC day boundary', () => {
    const day1 = new Date('2026-07-24T23:59:59Z')
    const day2 = new Date('2026-07-25T00:00:01Z')
    expect(computeDailySalt(SECRET, day1)).not.toBe(computeDailySalt(SECRET, day2))
  })

  it('differs with a different secret', () => {
    const now = new Date('2026-07-24T08:00:00Z')
    expect(computeDailySalt(SECRET, now)).not.toBe(computeDailySalt('other-secret', now))
  })
})

describe('computeSessionHash', () => {
  it('is deterministic for the same user + day (groups a session)', () => {
    const now = new Date('2026-07-24T08:00:00Z')
    const later = new Date('2026-07-24T20:00:00Z')
    expect(computeSessionHash(USER_A, SECRET, now)).toBe(computeSessionHash(USER_A, SECRET, later))
  })

  it('differs between two different users on the same day', () => {
    const now = new Date('2026-07-24T08:00:00Z')
    expect(computeSessionHash(USER_A, SECRET, now)).not.toBe(
      computeSessionHash(USER_B, SECRET, now),
    )
  })

  it('differs for the SAME user across a UTC day boundary (privacy — no long-term correlation)', () => {
    const day1 = new Date('2026-07-24T23:59:59Z')
    const day2 = new Date('2026-07-25T00:00:01Z')
    expect(computeSessionHash(USER_A, SECRET, day1)).not.toBe(
      computeSessionHash(USER_A, SECRET, day2),
    )
  })

  it('never contains the raw userId as a substring', () => {
    const hash = computeSessionHash(USER_A, SECRET)
    expect(hash).not.toContain(USER_A)
  })

  it('returns a 64-char hex sha256 digest', () => {
    expect(computeSessionHash(USER_A, SECRET)).toMatch(/^[0-9a-f]{64}$/)
  })
})
