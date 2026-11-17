import { describe, expect, it } from 'vitest'
import { seniorAvailabilityResponseSchema, seniorAvailabilitySchema } from './senior-availability'

// CR-H-2 (PR #1337): the union had no spec at all, so every mutant on it survived or never ran.
describe('seniorAvailabilitySchema (vacancy-queue design §5.2)', () => {
  it('FREE with a valid day parses as written', () => {
    expect(seniorAvailabilitySchema.parse({ status: 'FREE', availableFrom: '2026-11-01' })).toEqual(
      {
        status: 'FREE',
        availableFrom: '2026-11-01',
      },
    )
  })

  it('FREE without a day fails', () => {
    expect(seniorAvailabilitySchema.safeParse({ status: 'FREE' }).success).toBe(false)
  })

  it.each(['2026-13-01', '01.11.2026', '2026-11-01T00:00:00Z', ''])(
    'FREE with a malformed day %j fails',
    (availableFrom) => {
      expect(seniorAvailabilitySchema.safeParse({ status: 'FREE', availableFrom }).success).toBe(
        false,
      )
    },
  )

  it('FREE with an unknown key fails (strict)', () => {
    expect(
      seniorAvailabilitySchema.safeParse({ status: 'FREE', availableFrom: '2026-11-01', note: 'x' })
        .success,
    ).toBe(false)
  })

  it('BUSY parses with no day', () => {
    expect(seniorAvailabilitySchema.parse({ status: 'BUSY' })).toEqual({ status: 'BUSY' })
  })

  it('BUSY with a day fails (strict)', () => {
    expect(
      seniorAvailabilitySchema.safeParse({ status: 'BUSY', availableFrom: '2026-11-01' }).success,
    ).toBe(false)
  })

  it.each([{ status: 'AWAY' }, { status: 'free', availableFrom: '2026-11-01' }, {}, null])(
    'an unknown status or an empty body %j fails',
    (body) => {
      expect(seniorAvailabilitySchema.safeParse(body).success).toBe(false)
    },
  )

  it('the response accepts null (never set) and nothing else outside the union', () => {
    expect(seniorAvailabilityResponseSchema.parse(null)).toBeNull()
    expect(seniorAvailabilityResponseSchema.safeParse(undefined).success).toBe(false)
  })
})
