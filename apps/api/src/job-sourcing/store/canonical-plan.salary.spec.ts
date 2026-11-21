import { describe, expect, it } from 'vitest'
import type { SalaryObservation } from '../normalize/salary'
import { type MemberSnapshot, canonicalFields, salaryColumns } from './canonical-plan'

/** Sources-17 AC4: the salary is ONE atomic claim, never assembled per bound. */
function member(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    recordId: 'r1',
    revisionId: 'v1',
    receivedSeq: 1,
    receivedAt: new Date('2026-10-20T00:00:00Z'),
    provider: 'REMOTIVE_API',
    namespace: 'ns',
    nativeId: '1',
    title: 'Go Engineer',
    companyName: 'Acme',
    location: 'Remote',
    sourceUrl: 'https://fixture.test/jobs/1',
    applicationUrl: null,
    descriptionSha256: null,
    publishedAt: null,
    tags: [],
    salary: null,
    ...over,
  }
}

const eur: SalaryObservation = { min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' }
const usd: SalaryObservation = { min: 4000, max: 5500, currency: 'USD', period: 'MONTH' }

describe('canonicalFields: salary', () => {
  it('one member with a salary gives its salary, and the winning revision', () => {
    const c = canonicalFields([member({ salary: eur, revisionId: 'v9' })], null)
    expect(c.salary).toEqual(eur)
    expect(c.fieldRevisions['salary']).toBe('v9')
  })

  it('two members stating the same salary agree', () => {
    const c = canonicalFields(
      [member({ salary: eur }), member({ recordId: 'r2', revisionId: 'v2', salary: { ...eur } })],
      null,
    )
    expect(c.salary).toEqual(eur)
  })

  it('two equal-authority members with different salaries give null, both candidates kept', () => {
    const c = canonicalFields(
      [member({ salary: eur }), member({ recordId: 'r2', revisionId: 'v2', salary: usd })],
      null,
    )
    expect(c.salary).toBeNull()
    expect(c.fieldRevisions['salary']).toEqual({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
      candidates: ['r1', 'r2'],
    })
  })

  it('never mixes bounds: a member with only a min and one with only a max conflict', () => {
    const c = canonicalFields(
      [
        member({ salary: { ...eur, max: null } }),
        member({ recordId: 'r2', revisionId: 'v2', salary: { ...eur, min: null } }),
      ],
      null,
    )
    expect(c.salary).toBeNull()
  })

  it('a member without a salary does not contradict one that states it', () => {
    const c = canonicalFields(
      [member({ salary: eur }), member({ recordId: 'r2', revisionId: 'v2' })],
      null,
    )
    expect(c.salary).toEqual(eur)
  })

  it('no member with a salary gives null with NO_CLAIMS', () => {
    const c = canonicalFields([member()], null)
    expect(c.salary).toBeNull()
    expect(c.fieldRevisions['salary']).toEqual({
      status: 'UNKNOWN',
      reason: 'NO_CLAIMS',
      candidates: [],
    })
  })
})

describe('salaryColumns', () => {
  it('maps a salary to its five columns, monthly top from max else min', () => {
    expect(salaryColumns(eur)).toEqual({
      min: 4000,
      max: 5500,
      currency: 'EUR',
      period: 'MONTH',
      monthlyTop: 5500,
    })
    expect(salaryColumns({ ...eur, max: null, period: 'YEAR', min: 60_000 }).monthlyTop).toBe(5000)
  })

  it('maps no salary to five nulls', () => {
    expect(salaryColumns(null)).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
      monthlyTop: null,
    })
  })
})
