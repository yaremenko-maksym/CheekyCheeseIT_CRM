import { describe, expect, it } from 'vitest'
import { careersUrl } from './careers-url'

describe('careersUrl', () => {
  it('builds the canonical URL with a REQUIRED trailing slash', () => {
    expect(careersUrl('https://cheekycheese.tech', 'senior-react-developer')).toBe(
      'https://cheekycheese.tech/careers/senior-react-developer/',
    )
  })

  it('strips a trailing slash already present on the origin (no double slash)', () => {
    expect(careersUrl('https://cheekycheese.tech/', 'senior-react-developer')).toBe(
      'https://cheekycheese.tech/careers/senior-react-developer/',
    )
  })

  it('works with a non-default origin (e.g. a staging override)', () => {
    expect(careersUrl('https://staging.cheekycheese.tech', 'lead-backend-engineer')).toBe(
      'https://staging.cheekycheese.tech/careers/lead-backend-engineer/',
    )
  })
})
