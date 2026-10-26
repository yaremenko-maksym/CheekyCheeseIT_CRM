import { describe, expect, it } from 'vitest'
import { seniorTechStackSchema } from '@crm/shared'
import { SEED_USERS } from './users.data'

describe('SEED_USERS — SENIOR technology floor', () => {
  const seniors = SEED_USERS.filter((u) => u.role === 'SENIOR')

  it('seeds at least one SENIOR (the check below is not vacuous)', () => {
    expect(seniors.length).toBeGreaterThan(0)
  })

  it('every seeded SENIOR has at least 3 distinct technologies', () => {
    const below = seniors
      .filter((u) => !seniorTechStackSchema.safeParse(u.techStack ?? null).success)
      .map((u) => u.email)
    expect(below).toEqual([])
  })
})
