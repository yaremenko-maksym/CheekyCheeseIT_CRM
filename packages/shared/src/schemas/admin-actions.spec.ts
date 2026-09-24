import { describe, expect, it } from 'vitest'
import { changeRoleSchema, changeSalarySchema, setNoteSchema } from './admin-actions'

// task-i18n-stage4-task5: no spec file existed for this schema before this
// task — added alongside the zod.SALARY_OR_SHARE_REQUIRED code migration.

describe('changeSalarySchema', () => {
  it('accepts monthlySalary alone', () => {
    expect(() => changeSalarySchema.parse({ monthlySalary: 1000 })).not.toThrow()
  })

  it('accepts seniorSharePercent alone', () => {
    expect(() => changeSalarySchema.parse({ seniorSharePercent: 50 })).not.toThrow()
  })

  it('accepts both fields together', () => {
    expect(() =>
      changeSalarySchema.parse({ monthlySalary: 1000, seniorSharePercent: 50 }),
    ).not.toThrow()
  })

  it('rejects neither field present, with the SALARY_OR_SHARE_REQUIRED code', () => {
    const result = changeSalarySchema.safeParse({})
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.SALARY_OR_SHARE_REQUIRED',
    )
  })

  it('rejects seniorSharePercent above 100', () => {
    expect(() => changeSalarySchema.parse({ seniorSharePercent: 101 })).toThrow()
  })
})

describe('changeRoleSchema', () => {
  it('accepts a known role', () => {
    expect(() => changeRoleSchema.parse({ role: 'SENIOR' })).not.toThrow()
  })

  it('rejects an unknown role', () => {
    expect(() => changeRoleSchema.parse({ role: 'GHOST' })).toThrow()
  })
})

describe('setNoteSchema', () => {
  it('accepts a null note', () => {
    expect(() => setNoteSchema.parse({ note: null })).not.toThrow()
  })

  it('accepts a normal note', () => {
    expect(() => setNoteSchema.parse({ note: 'Follow up next week' })).not.toThrow()
  })

  it('rejects a note over 2000 characters', () => {
    expect(() => setNoteSchema.parse({ note: 'a'.repeat(2001) })).toThrow()
  })
})
