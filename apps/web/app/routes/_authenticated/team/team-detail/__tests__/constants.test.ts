import { describe, expect, it } from 'vitest'
import { ROLE_VARIANT, container, item } from '../constants'

describe('ROLE_VARIANT', () => {
  it('maps each role to its badge variant', () => {
    expect(ROLE_VARIANT).toEqual({
      ADMIN: 'admin',
      SENIOR: 'senior',
      JUNIOR: 'junior',
      HR: 'hr',
      ACCOUNTANT: 'accountant',
      DROP: 'drop',
    })
  })
})

describe('framer-motion variants', () => {
  it('container fades in and staggers children by 0.1s', () => {
    expect(container).toEqual({
      hidden: { opacity: 0 },
      show: { opacity: 1, transition: { staggerChildren: 0.1 } },
    })
  })

  it('item slides up 16px over 0.35s with the standard ease curve', () => {
    expect(item).toEqual({
      hidden: { opacity: 0, y: 16 },
      show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] } },
    })
  })
})
