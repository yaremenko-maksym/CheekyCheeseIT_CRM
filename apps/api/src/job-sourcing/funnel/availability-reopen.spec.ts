import { describe, expect, it } from 'vitest'
import { type CanonicalRevision, type EvaluateInput, evaluate } from './evaluate'

/**
 * r5 Task 4.6 S8f — the funnel's reading of availability across a close -> reopen cycle. The
 * funnel is pure over the revision it is given: `AVAILABILITY_CLOSED` is its one unavailability
 * signal (CLOSED and EXPIRED), and an OPEN revision evaluates exactly as it did before the close,
 * because availability is not an input to any later stage. That is the funnel half of "a reopened
 * opportunity re-surfaces the same decisions"; the DB half (matches untouched, revision bumped)
 * is in `record-reopen-updater.integration.spec.ts`.
 */
const SENIOR = '11111111-1111-4111-8111-111111111111'

const revision = (availability: CanonicalRevision['availability']): CanonicalRevision => ({
  opportunityId: 'opp-1',
  revisionId: 'rev-1',
  companyName: 'Acme',
  url: 'https://example.com/jobs/1',
  sourceType: 'EXAMPLE',
  fields: {
    title: 'Senior Java Developer',
    location: null,
    descriptionMd: 'Requirements: Java, Spring. Fully remote.',
    remote: true,
    employmentType: null,
    seniorityHint: 'senior',
    tags: ['java'],
    dates: [],
  },
  availability,
  firstSeenAt: new Date('2026-10-19T12:00:00Z'),
  firstSeenKind: 'NORMAL',
  trustedPublishedAt: null,
})

const input = (availability: CanonicalRevision['availability']): EvaluateInput => ({
  recordKey: 'rec-1',
  evaluationTime: new Date('2026-10-20T12:00:00Z'),
  revision: revision(availability),
  rosterSeniorIds: [SENIOR],
  profiles: [{ seniorId: SENIOR, teamIds: [], techStack: ['java'] }],
  exclusions: [],
  teamTriageGrants: [],
  unavailable: [],
})

describe('funnel availability signal (Task 4.6 S8f, AC 4)', () => {
  it.each(['CLOSED', 'EXPIRED'] as const)(
    '%s is unavailable: EXCLUDED with AVAILABILITY_CLOSED naming the state',
    (availability) => {
      const r = evaluate(input(availability))
      expect(r.kind).toBe('EXCLUDED')
      if (r.kind !== 'EXCLUDED') return
      expect(r.reasons).toEqual([
        {
          code: 'AVAILABILITY_CLOSED',
          evidence: [`availability=${availability}`],
          ruleVersion: 'eval.1',
        },
      ])
    },
  )

  it.each(['OPEN', 'UNKNOWN'] as const)('%s is available: no AVAILABILITY_CLOSED reason', (a) => {
    const r = evaluate(input(a))
    expect(r.kind).toBe('EVALUATED')
  })

  it('a reopened opportunity evaluates exactly as it did before it closed', () => {
    const before = evaluate(input('OPEN'))
    expect(evaluate(input('CLOSED')).kind).toBe('EXCLUDED')
    expect(evaluate(input('EXPIRED')).kind).toBe('EXCLUDED')
    const reopened = evaluate(input('OPEN'))
    expect(reopened).toEqual(before)
    expect(reopened.kind).toBe('EVALUATED')
  })
})
