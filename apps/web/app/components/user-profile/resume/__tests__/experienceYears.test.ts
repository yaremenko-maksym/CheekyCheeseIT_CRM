import { describe, expect, it } from 'vitest'
import { experienceYears } from '../ResumeConfirmStep'

const NOW = new Date(2026, 10, 14) // November 2026

const job = (start: string | null, end: string | null, current = false) => ({ start, end, current })

describe('experienceYears (F-1, confirm summary)', () => {
  it('no experience gives no years', () => {
    expect(experienceYears([], NOW)).toBe(0)
  })

  it('counts both edge months: Jan 2020 to Dec 2022 is 3 years', () => {
    expect(experienceYears([job('2020-01', '2022-12')], NOW)).toBe(3)
  })

  it('rounds down: Jan 2020 to Nov 2022 is 2 years 11 months, so 2', () => {
    expect(experienceYears([job('2020-01', '2022-11')], NOW)).toBe(2)
  })

  it('counts overlapping months once', () => {
    // 2018-01..2020-12 (36) and 2020-01..2021-12 (24) overlap by 12: 48 months.
    expect(experienceYears([job('2018-01', '2020-12'), job('2020-01', '2021-12')], NOW)).toBe(4)
  })

  it('adds disjoint jobs and skips the gap', () => {
    // 2010-01..2011-12 (24) + 2015-01..2015-12 (12) = 36 months.
    expect(experienceYears([job('2015-01', '2015-12'), job('2010-01', '2011-12')], NOW)).toBe(3)
  })

  it('a current job runs to this month', () => {
    // 2018-12..2026-11 = 96 months.
    expect(experienceYears([job('2018-12', null, true)], NOW)).toBe(8)
  })

  it('a job without a start, or without an end that is not current, is skipped', () => {
    expect(experienceYears([job(null, '2020-12'), job('2010-01', null)], NOW)).toBe(0)
  })
})
