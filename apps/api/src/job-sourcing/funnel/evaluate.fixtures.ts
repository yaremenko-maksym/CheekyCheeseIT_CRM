import type { JobExclusionDto } from '@crm/shared'
import type { CanonicalRevision, EvaluateInput } from './evaluate'
import type { SeniorTechProfile } from './tech-match'

export const NOW = new Date('2026-10-20T12:00:00Z')

export const SENIOR_A = '11111111-1111-4111-8111-111111111111'
export const SENIOR_B = '22222222-2222-4222-8222-222222222222'
export const SENIOR_C = '44444444-4444-4444-8444-444444444444'
export const TEAM_1 = '33333333-3333-4333-8333-333333333333'
export const TEAM_2 = '55555555-5555-4555-8555-555555555555'
export const TEAM_3 = '66666666-6666-4666-8666-666666666666'

export const profile = (
  seniorId: string,
  techStack: string[],
  teamIds: string[],
): SeniorTechProfile => ({ seniorId, teamIds, techStack })

export const exclusion = (over: Partial<JobExclusionDto>): JobExclusionDto => ({
  id: '77777777-7777-4777-8777-777777777777',
  scope: 'GLOBAL',
  seniorId: null,
  kind: 'KEYWORD',
  value: 'x',
  normalizedValue: 'x',
  origin: 'MANUAL',
  sourceLabel: null,
  createdAt: null,
  ...over,
})

/** A posting that names its stack, is remote, and is not a layer-1 reject. */
export const javaRevision = (over: Partial<CanonicalRevision> = {}): CanonicalRevision => ({
  opportunityId: 'opp-1',
  revisionId: 'rev-1',
  companyName: 'Acme',
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
  availability: 'OPEN',
  firstSeenAt: new Date('2026-10-19T12:00:00Z'),
  firstSeenKind: 'NORMAL',
  trustedPublishedAt: null,
  ...over,
})

/** No tags, no requirements, no keyword: layer 2 cannot judge it. */
export const unknownStackRevision = (over: Partial<CanonicalRevision> = {}): CanonicalRevision =>
  javaRevision({
    fields: {
      ...javaRevision().fields,
      title: 'Senior Developer',
      descriptionMd: 'Join our friendly team and build great things. Fully remote.',
      tags: [],
    },
    ...over,
  })

export const roster = () => ({
  rosterSeniorIds: [SENIOR_A, SENIOR_B, SENIOR_C],
  profiles: [
    profile(SENIOR_A, ['java', 'kotlin'], [TEAM_1]),
    profile(SENIOR_B, ['python'], [TEAM_2]),
    profile(SENIOR_C, ['java'], [TEAM_1, TEAM_3]),
  ],
})

export const input = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  recordKey: 'rec-1',
  evaluationTime: NOW,
  revision: javaRevision(),
  ...roster(),
  exclusions: [],
  teamTriageGrants: [],
  ...over,
})
