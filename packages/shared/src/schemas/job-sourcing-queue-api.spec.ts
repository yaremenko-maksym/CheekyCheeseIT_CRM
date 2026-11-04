import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  jobQueueActivitySchema,
  jobQueueCancelSubmissionRequestSchema,
  jobQueueCardResponseSchema,
  jobQueueCardSeniorSchema,
  jobQueueDismissalResponseSchema,
  jobQueueDismissRequestSchema,
  jobQueueEligibilitySchema,
  jobQueueItemSchema,
  jobQueueListItemSchema,
  jobQueueListQuerySchema,
  jobQueueListResponseSchema,
  jobQueueListSchema,
  jobQueueOpenedRequestSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueQuerySchema,
  jobQueueRecomputeResponseSchema,
  jobQueueScopeQuerySchema,
  jobQueueSeniorsContinuationSchema,
  jobQueueSourcesContinuationSchema,
  jobQueueStatusSchema,
  jobQueueSubmissionResponseSchema,
  jobQueueSubmissionSchema,
  jobQueueSubmitRequestSchema,
  jobQueueTabSchema,
  jobQueueUndoRequestSchema,
  jobSourceTypeSchema,
} from './job-sourcing'

/**
 * r5 Phase 6 T0 — the `/job-queue` wire contracts (per-senior submissions, no
 * cross-team signal). AC1: every shape round-trips and the legacy phase-1
 * shapes are untouched; AC4: no response shape can carry another team's
 * identity. Expected values are literals, never recomputed from the schema.
 */

const U1 = '11111111-2222-4333-8444-555555555555'
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const U3 = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
const NOW = '2026-11-04T12:00:00.000Z'
const LATER = '2026-11-04T13:00:00.000Z'
const URL = 'https://jobs.dou.ua/companies/acme/vacancies/1/'

const listItem = {
  opportunityId: U1,
  revision: 3,
  title: 'Senior TypeScript Engineer',
  companyName: 'Acme',
  location: null,
  primarySource: { sourceRecordId: U2, sourceType: 'DOU_RSS', url: URL },
  alsoSeenOnCount: 2,
  availability: 'OPEN',
  eligibility: 'LEAD',
  matchedSeniorCount: 4,
  submittedSeniorCount: 1,
  stopListedSeniorCount: 1,
  openedByTeam: true,
  hidden: false,
  publishedAt: null,
  firstSeenAt: NOW,
}
const submitted = {
  id: U3,
  opportunityId: U1,
  seniorId: U2,
  state: 'TAKEN',
  submittedAt: NOW,
  cancelledAt: null,
  version: 1,
  submittedByName: 'Olena Kovalchuk',
}
const cancelled = { ...submitted, state: 'RELEASED', cancelledAt: LATER, version: 2 }
const senior = {
  seniorId: U2,
  displayName: 'Taras S.',
  matchApproximate: false,
  matchedKeywords: ['typescript'],
  submission: submitted,
}
const card = {
  ...listItem,
  descriptionMd: '# Role',
  newerThanList: false,
  seniors: { items: [senior], totalCount: 1, nextCursor: null },
  sources: {
    items: [{ sourceRecordId: U2, sourceType: 'DOU_RSS', url: URL, linkedAt: NOW }],
    totalCount: 1,
    nextCursor: null,
  },
  possibleDuplicates: {
    items: [{ opportunityId: U3, title: 'Dup', companyName: null }],
    totalCount: 1,
  },
}

describe('enums (exact members, in order)', () => {
  it.each([
    [jobQueueTabSchema, ['NEW', 'SUBMITTED', 'HIDDEN']],
    [jobQueueEligibilitySchema, ['LEAD', 'TRIAGE']],
    [jobQueueActivitySchema, ['OPENED', 'NOT_OPENED']],
  ])('%#', (schema, members) => {
    expect([...schema.options]).toEqual(members)
  })
})

describe('legacy phase-1 queue shapes stay parseable (extend-in-place)', () => {
  it('keeps the legacy status enum and its "taken" fields untouched', () => {
    expect([...jobQueueStatusSchema.options]).toEqual(['NEW', 'IN_PROGRESS', 'DISMISSED'])
    expect(jobQueueQuerySchema.parse({})).toEqual({ status: 'NEW', limit: 20 })
    const legacy = {
      id: U1,
      sourceType: 'DOU_RSS',
      url: URL,
      title: 't',
      companyName: 'c',
      location: null,
      seniority: 'SENIOR',
      matchedKeywords: [],
      matchedSeniors: [],
      stackUnknown: false,
      alsoSeenOn: [],
      publishedAt: null,
      firstSeenAt: NOW,
      queueStatus: 'IN_PROGRESS',
      takenByName: 'x',
      takenAt: NOW,
    }
    expect(jobQueueItemSchema.parse(legacy)).toEqual(legacy)
    const page = {
      items: [legacy],
      nextCursor: null,
      counts: { NEW: 1, IN_PROGRESS: 2, DISMISSED: 0 },
    }
    expect(jobQueueListSchema.parse(page)).toEqual(page)
  })
})

describe('jobQueueListQuerySchema — GET /job-queue', () => {
  it('defaults to the NEW tab, 20 per page, no filters', () => {
    expect(jobQueueListQuerySchema.parse({})).toEqual({ tab: 'NEW', limit: 20 })
  })

  it('bounds the page size to 1..50 (query strings coerce)', () => {
    expect(jobQueueListQuerySchema.parse({ limit: '50' }).limit).toBe(50)
    expect(jobQueueListQuerySchema.parse({ limit: '1' }).limit).toBe(1)
    expect(jobQueueListQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false)
  })

  it('parses multi-select filters as trimmed, de-duplicated lists', () => {
    expect(
      jobQueueListQuerySchema.parse({
        source: 'DOU_RSS, DJINNI_RSS,DOU_RSS',
        eligibility: 'TRIAGE',
        availability: 'OPEN,UNKNOWN',
        activity: 'NOT_OPENED',
      }),
    ).toEqual({
      tab: 'NEW',
      limit: 20,
      source: ['DOU_RSS', 'DJINNI_RSS'],
      eligibility: ['TRIAGE'],
      availability: ['OPEN', 'UNKNOWN'],
      activity: ['NOT_OPENED'],
    })
  })

  it('refuses an empty or unknown filter member instead of reading it as "no restriction"', () => {
    for (const bad of [
      { source: '' },
      { source: 'DOU_RSS,' },
      { eligibility: 'EXCLUDED' },
      { availability: 'open' },
      { activity: 'TAKEN' },
    ]) {
      expect(jobQueueListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('accepts every source at once and bounds the raw list at 600 characters', () => {
    const all = jobSourceTypeSchema.options.join(',')
    expect(jobQueueListQuerySchema.parse({ source: all }).source).toHaveLength(
      jobSourceTypeSchema.options.length,
    )
    // 599 characters of repeated members: accepted and de-duplicated.
    expect(
      jobQueueListQuerySchema.parse({ source: 'DOU_RSS,'.repeat(74) + 'DOU_RSS' }).source,
    ).toEqual(['DOU_RSS'])
    // 601 characters: refused on the raw length, before any member is read.
    const r = jobQueueListQuerySchema.safeParse({ source: 'DOU_RSS,'.repeat(75) + 'S' })
    expect(r.error?.issues.map((i) => i.code)).toEqual(['too_big'])
  })

  it('trims the search, refuses a blank one, bounds it at 200', () => {
    expect(jobQueueListQuerySchema.parse({ search: '  acme ' }).search).toBe('acme')
    expect(jobQueueListQuerySchema.safeParse({ search: '   ' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ search: 'a'.repeat(200) }).success).toBe(true)
    expect(jobQueueListQuerySchema.safeParse({ search: 'a'.repeat(201) }).success).toBe(false)
  })

  it('takes the scope, tab, senior and cursor, and refuses anything else', () => {
    expect(
      jobQueueListQuerySchema.parse({ teamId: U1, tab: 'HIDDEN', seniorId: U2, cursor: 'c' }),
    ).toEqual({ teamId: U1, tab: 'HIDDEN', seniorId: U2, cursor: 'c', limit: 20 })
    expect(jobQueueListQuerySchema.safeParse({ tab: 'IN_PROGRESS' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ teamId: 'team-a' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
    expect(jobQueueListQuerySchema.safeParse({ cursor: 'c'.repeat(301) }).success).toBe(false)
    // Dropped filters (owner 2026-10-18) and any stray parameter are a 400.
    expect(jobQueueListQuerySchema.safeParse({ salary: 'unknown' }).success).toBe(false)
  })

  it('the card / continuation query takes the scope and a cursor only', () => {
    expect(jobQueueScopeQuerySchema.parse({ teamId: U1, cursor: 'c' })).toEqual({
      teamId: U1,
      cursor: 'c',
    })
    expect(jobQueueScopeQuerySchema.safeParse({ limit: '20' }).success).toBe(false)
  })
})

describe('response shapes round-trip', () => {
  it('list page, card, continuations, submission, dismissal, recompute', () => {
    const page = {
      items: [listItem],
      nextCursor: null,
      counts: { NEW: 3, SUBMITTED: 1, HIDDEN: 0 },
    }
    expect(jobQueueListResponseSchema.parse(page)).toEqual(page)
    expect(jobQueueCardResponseSchema.parse(card)).toEqual(card)
    expect(
      jobQueueCardResponseSchema.parse({ ...card, possibleDuplicates: null }).possibleDuplicates,
    ).toBeNull()
    expect(jobQueueSubmissionResponseSchema.parse({ submission: cancelled })).toEqual({
      submission: cancelled,
    })
    const dismissal = { opportunityId: U1, scope: 'TEAM', reason: 'SPAM', hidden: true, version: 2 }
    expect(jobQueueDismissalResponseSchema.parse(dismissal)).toEqual(dismissal)
    expect(jobQueueRecomputeResponseSchema.parse({ runId: U1 })).toEqual({ runId: U1 })
    const conflict = {
      code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
      possibleDuplicates: card.possibleDuplicates,
    }
    expect(jobQueuePossibleDuplicateConflictSchema.parse(conflict)).toEqual(conflict)
  })

  it('bounds the list page at 50 rows and the continuations at 200 seniors / 20 sources', () => {
    const page = (n: number) => ({
      items: Array.from({ length: n }, () => listItem),
      nextCursor: null,
      counts: { NEW: n, SUBMITTED: 0, HIDDEN: 0 },
    })
    expect(jobQueueListResponseSchema.safeParse(page(50)).success).toBe(true)
    expect(jobQueueListResponseSchema.safeParse(page(51)).success).toBe(false)
    const seniors = (n: number) => ({
      items: Array.from({ length: n }, () => senior),
      totalCount: n,
      nextCursor: null,
    })
    expect(jobQueueSeniorsContinuationSchema.safeParse(seniors(200)).success).toBe(true)
    expect(jobQueueSeniorsContinuationSchema.safeParse(seniors(201)).success).toBe(false)
    const sources = (n: number) => ({
      ...card.sources,
      items: Array.from({ length: n }, () => card.sources.items[0]),
    })
    expect(jobQueueSourcesContinuationSchema.safeParse(sources(20)).success).toBe(true)
    expect(jobQueueSourcesContinuationSchema.safeParse(sources(21)).success).toBe(false)
  })

  it('a submission records its cancellation time exactly when cancelled', () => {
    expect(jobQueueSubmissionSchema.parse(submitted)).toEqual(submitted)
    expect(jobQueueSubmissionSchema.parse(cancelled)).toEqual(cancelled)
    const msg = 'a cancelled submission records when, and only a cancelled one does'
    for (const bad of [
      { ...submitted, cancelledAt: LATER },
      { ...cancelled, cancelledAt: null },
    ]) {
      const r = jobQueueSubmissionSchema.safeParse(bad)
      expect(r.success).toBe(false)
      expect(r.error?.issues.map((i) => [i.message, i.path])).toEqual([[msg, ['cancelledAt']]])
    }
  })
})

describe('request shapes', () => {
  it('submit: idempotency key + expected revision; the duplicate confirmation defaults to false', () => {
    const body = { seniorId: U2, idempotencyKey: U3, expectedOpportunityRevision: 3 }
    expect(jobQueueSubmitRequestSchema.parse(body)).toEqual({
      ...body,
      confirmPossibleDuplicate: false,
    })
    expect(
      jobQueueSubmitRequestSchema.parse({
        ...body,
        teamId: U1,
        expectedVersion: 2,
        confirmPossibleDuplicate: true,
      }),
    ).toEqual({ ...body, teamId: U1, expectedVersion: 2, confirmPossibleDuplicate: true })
    for (const bad of [
      { ...body, idempotencyKey: 'retry-1' },
      { ...body, expectedOpportunityRevision: 0 },
      { ...body, expectedVersion: 0 },
      { ...body, seniorId: undefined },
      { ...body, confirmPossibleDuplicate: 'yes' },
    ]) {
      expect(jobQueueSubmitRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('cancel: needs the expected version and a key', () => {
    expect(
      jobQueueCancelSubmissionRequestSchema.parse({ idempotencyKey: U1, expectedVersion: 1 }),
    ).toEqual({
      idempotencyKey: U1,
      expectedVersion: 1,
    })
    expect(jobQueueCancelSubmissionRequestSchema.safeParse({ idempotencyKey: U1 }).success).toBe(
      false,
    )
  })

  it('dismiss: a scope and a FIXED reason — no free text', () => {
    const body = { scope: 'TEAM', reason: 'NOT_RELEVANT', idempotencyKey: U1 }
    expect(jobQueueDismissRequestSchema.parse(body)).toEqual(body)
    expect(
      jobQueueDismissRequestSchema.parse({ ...body, scope: 'STUDIO', expectedVersion: 3 }),
    ).toEqual({
      ...body,
      scope: 'STUDIO',
      expectedVersion: 3,
    })
    for (const bad of [
      { ...body, reason: 'not for us, the client is weird' },
      { ...body, reason: undefined },
      { ...body, scope: 'GLOBAL' },
      { ...body, note: 'free text' },
    ]) {
      expect(jobQueueDismissRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('undo: scope + expected version are required', () => {
    const body = { scope: 'TEAM', idempotencyKey: U1, expectedVersion: 2 }
    expect(jobQueueUndoRequestSchema.parse(body)).toEqual(body)
    expect(
      jobQueueUndoRequestSchema.safeParse({ ...body, expectedVersion: undefined }).success,
    ).toBe(false)
    expect(jobQueueUndoRequestSchema.safeParse({ ...body, scope: undefined }).success).toBe(false)
  })

  it('opened: the clicked source record', () => {
    expect(jobQueueOpenedRequestSchema.parse({ sourceRecordId: U2 })).toEqual({
      sourceRecordId: U2,
    })
    expect(jobQueueOpenedRequestSchema.safeParse({}).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC4 — no response shape can carry another team's identity
// ---------------------------------------------------------------------------

/** Every object key reachable in a schema, read off zod's own definitions. */
function keysOf(schema: z.core.$ZodType, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return []
  seen.add(schema)
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string }
  const child = (s: unknown) => keysOf(s as z.core.$ZodType, seen)
  switch (def.type) {
    case 'object': {
      const shape = def['shape'] as Record<string, unknown>
      return Object.entries(shape).flatMap(([k, v]) => [k, ...child(v)])
    }
    case 'array':
      return child(def['element'])
    case 'nullable':
    case 'optional':
    case 'default':
      return child(def['innerType'])
    case 'pipe':
      return [...child(def['in']), ...child(def['out'])]
    default:
      return []
  }
}

const RESPONSES = {
  jobQueueListResponseSchema,
  jobQueueListItemSchema,
  jobQueueCardResponseSchema,
  jobQueueCardSeniorSchema,
  jobQueueSeniorsContinuationSchema,
  jobQueueSourcesContinuationSchema,
  jobQueueSubmissionSchema,
  jobQueueSubmissionResponseSchema,
  jobQueueDismissalResponseSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueRecomputeResponseSchema,
}

/** Names that would identify another team or its people. */
const FOREIGN_IDENTITY =
  /assignee|actor|claim|taken|dismissedBy|undoneBy|releasedBy|reassign|teamId|teamName/i

describe('AC4: no response shape carries foreign identity', () => {
  it('the walker sees nested keys (positive control)', () => {
    expect(keysOf(jobQueueCardResponseSchema)).toEqual(
      expect.arrayContaining([
        'seniors',
        'items',
        'submission',
        'submittedByName',
        'primarySource',
        'url',
      ]),
    )
  })

  it.each(Object.entries(RESPONSES))(
    '%s has no field naming another team or its actors',
    (_name, schema) => {
      const offending = keysOf(schema).filter((k) => FOREIGN_IDENTITY.test(k))
      expect(offending).toEqual([])
    },
  )

  it('a server that adds a foreign field anyway is refused at the client (every object is strict)', () => {
    const leaks = { takenByName: 'Other HR', assigneeId: U3, teamId: U3, actorId: U3 }
    for (const [field, value] of Object.entries(leaks)) {
      const leak = { [field]: value }
      expect(jobQueueListItemSchema.safeParse({ ...listItem, ...leak }).success, field).toBe(false)
      expect(jobQueueCardResponseSchema.safeParse({ ...card, ...leak }).success, field).toBe(false)
      expect(jobQueueCardSeniorSchema.safeParse({ ...senior, ...leak }).success, field).toBe(false)
      expect(jobQueueSubmissionSchema.safeParse({ ...submitted, ...leak }).success, field).toBe(
        false,
      )
      expect(
        jobQueueCardResponseSchema.safeParse({
          ...card,
          sources: { ...card.sources, items: [{ ...card.sources.items[0], ...leak }] },
        }).success,
        field,
      ).toBe(false)
      expect(
        jobQueueCardResponseSchema.safeParse({
          ...card,
          possibleDuplicates: {
            ...card.possibleDuplicates,
            items: [{ ...card.possibleDuplicates.items[0], ...leak }],
          },
        }).success,
        field,
      ).toBe(false)
      expect(
        jobQueueListResponseSchema.safeParse({
          items: [],
          nextCursor: null,
          counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0, ...leak },
        }).success,
        field,
      ).toBe(false)
    }
  })

  it('there is no "taken" tab or status: foreign activity has no representation at all', () => {
    expect(jobQueueTabSchema.safeParse('IN_PROGRESS').success).toBe(false)
    expect(jobQueueTabSchema.safeParse('TAKEN').success).toBe(false)
  })
})
