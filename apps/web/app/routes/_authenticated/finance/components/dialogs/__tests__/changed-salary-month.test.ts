import { describe, expect, it } from 'vitest'
import { changedSalaryMonth } from '../changed-salary-month'

const salary = (salaryMonth: string | null) => ({ type: 'SALARY' as const, salaryMonth })

describe('changedSalaryMonth (SR-M-1, PR #1093)', () => {
  it('returns the new month when a SALARY row month was changed', () => {
    expect(changedSalaryMonth(salary('2026-09'), '2026-10')).toBe('2026-10')
  })

  it('returns the month when the stored month is null and one was entered', () => {
    expect(changedSalaryMonth(salary(null), '2026-10')).toBe('2026-10')
  })

  it('returns undefined when the month is unchanged — even a legacy value the schema would reject', () => {
    expect(changedSalaryMonth(salary('2026-13'), '2026-13')).toBeUndefined()
    expect(changedSalaryMonth(salary('2026-09'), '2026-09')).toBeUndefined()
  })

  it('returns undefined when the field was cleared (empty), even though it differs from the stored value', () => {
    expect(changedSalaryMonth(salary('2026-09'), '')).toBeUndefined()
  })

  it('returns undefined for a null/undefined tx (no optional-chaining crash)', () => {
    expect(changedSalaryMonth(null, '2026-10')).toBeUndefined()
    expect(changedSalaryMonth(undefined, '2026-10')).toBeUndefined()
  })

  it('returns undefined for a non-SALARY row even if a differing month value is passed', () => {
    expect(
      changedSalaryMonth({ type: 'EXPENSE', salaryMonth: '2026-09' }, '2026-10'),
    ).toBeUndefined()
    expect(
      changedSalaryMonth({ type: 'ADMIN_INCOME', salaryMonth: null }, '2026-10'),
    ).toBeUndefined()
  })
})
