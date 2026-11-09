import type {
  JobQueueCardResponseDto,
  JobQueueCardSeniorDto,
  JobQueueSubmissionDto,
} from '@crm/shared'

export const OPP = '11111111-1111-4111-8111-111111111111'
export const PRIMARY_SRC = '22222222-2222-4222-8222-222222222222'

export function senior(over: Partial<JobQueueCardSeniorDto> = {}): JobQueueCardSeniorDto {
  return {
    seniorId: 'aaaaaaaa-0000-4000-8000-000000000001',
    displayName: 'Олена Коваль',
    matchApproximate: false,
    matchedKeywords: ['React'],
    submission: null,
    ...over,
  }
}

export function submission(over: Partial<JobQueueSubmissionDto> = {}): JobQueueSubmissionDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    opportunityId: OPP,
    seniorId: 'aaaaaaaa-0000-4000-8000-000000000001',
    state: 'TAKEN',
    submittedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    cancelledAt: null,
    version: 1,
    submittedByName: null,
    ...over,
  }
}

export function source(
  n: number,
  over: Partial<JobQueueCardResponseDto['sources']['items'][number]> = {},
) {
  const hex = n.toString(16).padStart(12, '0')
  return {
    sourceRecordId: `44444444-4444-4444-8444-${hex}`,
    sourceType: 'DJINNI_RSS' as const,
    url: `https://djinni.co/jobs/${n}`,
    linkedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  }
}

export const PRIMARY = source(0, {
  sourceRecordId: PRIMARY_SRC,
  sourceType: 'DOU_RSS',
  url: 'https://jobs.dou.ua/1',
})

export function cardFixture(over: Partial<JobQueueCardResponseDto> = {}): JobQueueCardResponseDto {
  return {
    opportunityId: OPP,
    revision: 3,
    title: 'Senior React Engineer',
    companyName: 'Acme',
    location: null,
    primarySource: {
      sourceRecordId: PRIMARY_SRC,
      sourceType: 'DOU_RSS',
      url: 'https://jobs.dou.ua/1',
    },
    applicationUrl: null,
    alsoSeenOnCount: 0,
    availability: 'OPEN',
    eligibility: 'LEAD',
    seniority: 'SENIOR',
    matchedKeywords: ['React', 'TypeScript'],
    matchedSeniorCount: 1,
    submittedSeniorCount: 0,
    stopListedSeniorCount: 0,
    openedByTeam: false,
    hidden: false,
    publishedAt: '2026-11-01T10:00:00.000Z',
    firstSeenAt: '2026-11-01T10:00:00.000Z',
    descriptionMd: '**Build** things',
    newerThanList: false,
    seniors: { items: [senior()], totalCount: 1, nextCursor: null },
    sources: { items: [PRIMARY], totalCount: 1, nextCursor: null },
    possibleDuplicates: null,
    ...over,
  }
}

/** A `useContinuation` result double: nothing fetched yet. */
export function idleContinuation<T>(pages: T[] = [], over: Record<string, unknown> = {}) {
  return {
    data: pages.length ? { pages, pageParams: [] } : undefined,
    hasNextPage: false,
    isFetching: false,
    isError: false,
    accessLost: false,
    fetchNextPage: () => Promise.resolve(),
    refetch: () => Promise.resolve(),
    ...over,
  }
}
