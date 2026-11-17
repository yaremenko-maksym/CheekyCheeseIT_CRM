import { describe, expect, it } from 'vitest'
import { engagementFormOf } from './layer1'

// Task 7.3b SPEC-M-1: the card's «Форма співпраці» from the provider's own `employmentType` text.
// The value set is the one the adapters in `providers/**` and their fixtures carry, not prod data.
describe('engagementFormOf', () => {
  it.each([
    // adapter values: Lever `commitment`, SmartRecruiters `typeOfEmployment`, Personio, Recruitee
    ['Permanent', 'EMPLOYMENT'],
    ['permanent', 'EMPLOYMENT'],
    ['fulltime_permanent', 'EMPLOYMENT'],
    ['Permanent or fixed-term', 'EMPLOYMENT'],
    ['B2B', 'B2B'],
    ['b2b contract', 'B2B'],
    ['ФОП', 'B2B'],
    ['B2B, contractor', 'B2B'],
    ['Employment contract', 'EMPLOYMENT'],
    ['Employee', 'EMPLOYMENT'],
    ['W2', 'EMPLOYMENT'],
    ['Трудовий договір', 'EMPLOYMENT'],
  ] as const)('%s → %s', (text, form) => {
    expect(engagementFormOf(text)).toBe(form)
  })

  it.each([
    // a schedule, not a form (every adapter's most common value)
    'full_time',
    'Full-time',
    'Full time',
    'FullTime',
    'FULLTIME',
    'FULL_TIME',
    'FT',
    'part_time',
    'Full-Time or Part-Time',
    // a contractor alone is neither B2B nor employment
    'Contract',
    'Contractor',
    'CONTRACTOR',
    'Freelance',
    'Full Time,Contractor',
    'Permanent, Contractor',
    // a duration or a trainee status names no form
    'Fixed-term',
    'fulltime_fixed_term',
    'Intern',
    'Internships',
    'Working Student',
    // both forms: the card states one or none
    'Employment contract or B2B',
    'Employee / contractor',
    // a negated form states nothing
    'no B2B',
    'not permanent',
    'Fixed-term, not permanent',
    // unknown text, blank and missing
    'Remote',
    '   ',
    '',
    null,
    undefined,
  ])('%s → no form (no chip)', (text) => {
    expect(engagementFormOf(text)).toBeNull()
  })
})
