import { describe, expect, it } from 'vitest'
import { SENIOR_MIN_TECHNOLOGIES, seniorTechStackSchema } from './users'

const ok = (stack: string[] | null) => seniorTechStackSchema.safeParse(stack).success

describe('seniorTechStackSchema — the SENIOR technology floor', () => {
  it('is three', () => {
    expect(SENIOR_MIN_TECHNOLOGIES).toBe(3)
  })

  it('refuses 0, 1 and 2 technologies, and null', () => {
    expect(ok(null)).toBe(false)
    expect(ok([])).toBe(false)
    expect(ok(['React'])).toBe(false)
    expect(ok(['React', 'Go'])).toBe(false)
  })

  it('accepts exactly 3 and more', () => {
    expect(ok(['React', 'Go', 'Docker'])).toBe(true)
    expect(ok(['React', 'Go', 'Docker', 'AWS'])).toBe(true)
  })

  it('does not count duplicates or blanks', () => {
    expect(ok(['a', 'a', 'a'])).toBe(false)
    expect(ok(['a', '', ' '])).toBe(false)
    expect(ok(['React', 'react', ' REACT ', 'Go'])).toBe(false)
  })

  it('counts aliases of one technology once, like the vacancy matcher', () => {
    expect(ok(['node', 'Node.js', 'Go'])).toBe(false)
    expect(ok(['node', 'Node.js', 'Go', 'Docker'])).toBe(true)
  })

  it('carries the zod error key the web form translates', () => {
    const result = seniorTechStackSchema.safeParse(['React'])
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('zod.SENIOR_MIN_TECHNOLOGIES')
  })
})
