/* `ok` and `no` below call `expect` internally; teach the rule about them rather than disabling it. */
/* eslint vitest/expect-expect: ["error", { assertFunctionNames: ["expect", "ok", "no"] }] */
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
  jobQueueSuppressRequestSchema,
  jobQueueTabSchema,
  jobQueueUndoRequestSchema,
  jobSourceTypeSchema,
  jobQueueForeignSubmissionSchema,
  DESCRIPTION_MD_MAX,
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

type Parseable = { safeParse: (value: unknown) => { success: boolean } }

/** A deep copy of `value` with `{ [field]: <uuid> }` added to the object at `path`. */
function injectAt(value: unknown, path: ReadonlyArray<string | number>, field: string): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>
  let target = copy
  for (const key of path) target = target[key] as Record<string | number, unknown>
  target[field] = U3
  return copy
}

const generationFacts = {
  ruleVersion: 'eval.1+l1.1',
  evaluatedAt: '2026-11-04T12:00:00.000Z',
  capped: false,
}
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
      generation: generationFacts,
    }
    expect(jobQueueListResponseSchema.parse(page)).toEqual(page)
    expect(jobQueueListResponseSchema.parse({ ...page, generation: null }).generation).toBeNull()
    expect(jobQueueListResponseSchema.safeParse({ ...page, generation: undefined }).success).toBe(
      false,
    )
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
      generation: null,
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

  it('suppress: a UUID idempotency key, nothing else', () => {
    expect(jobQueueSuppressRequestSchema.parse({ idempotencyKey: U1 })).toEqual({
      idempotencyKey: U1,
    })
    expect(jobQueueSuppressRequestSchema.safeParse({}).success).toBe(false)
    expect(jobQueueSuppressRequestSchema.safeParse({ idempotencyKey: 'not-a-uuid' }).success).toBe(
      false,
    )
  })

  it('opened: the clicked source record', () => {
    expect(jobQueueOpenedRequestSchema.parse({ sourceRecordId: U2 })).toEqual({
      sourceRecordId: U2,
    })
    expect(jobQueueOpenedRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('requests refuse an unknown key (CR-M-1)', () => {
  it.each([
    [
      'submit',
      jobQueueSubmitRequestSchema,
      { seniorId: U2, idempotencyKey: U3, expectedOpportunityRevision: 1 },
    ],
    ['cancel', jobQueueCancelSubmissionRequestSchema, { idempotencyKey: U1, expectedVersion: 1 }],
    [
      'dismiss',
      jobQueueDismissRequestSchema,
      { scope: 'TEAM', reason: 'SPAM', idempotencyKey: U1 },
    ],
    ['undo', jobQueueUndoRequestSchema, { scope: 'TEAM', idempotencyKey: U1, expectedVersion: 1 }],
    ['opened', jobQueueOpenedRequestSchema, { sourceRecordId: U2 }],
    ['suppress', jobQueueSuppressRequestSchema, { idempotencyKey: U1 }],
    ['list query', jobQueueListQuerySchema, {}],
    ['scope query', jobQueueScopeQuerySchema, {}],
  ] as const)('%s', (_name, schema: Parseable, body) => {
    expect(schema.safeParse(body).success, 'the clean body must parse').toBe(true)
    expect(schema.safeParse({ ...body, assigneeId: U3 }).success).toBe(false)
  })
})

describe('field bounds, both sides of each limit (CR-M-2)', () => {
  const s = (n: number) => 'x'.repeat(n)
  const ok = (schema: Parseable, value: unknown) =>
    expect(schema.safeParse(value).success).toBe(true)
  const no = (schema: Parseable, value: unknown) =>
    expect(schema.safeParse(value).success).toBe(false)

  it('multi-select raw list: 600 accepted, 601 refused', () => {
    // 599 characters of members + one trailing space (trimmed) = exactly 600.
    ok(jobQueueListQuerySchema, { source: 'DOU_RSS,'.repeat(74) + 'DOU_RSS ' })
    no(jobQueueListQuerySchema, { source: 'DOU_RSS,'.repeat(75) + 'S' })
  })

  it('cursor (query) and nextCursor (every page): short and 300 accepted, 301 refused', () => {
    for (const cursor of ['cc', s(300)]) ok(jobQueueListQuerySchema, { cursor })
    no(jobQueueListQuerySchema, { cursor: s(301) })
    for (const cursor of ['cc', s(300)]) ok(jobQueueScopeQuerySchema, { cursor })
    no(jobQueueScopeQuerySchema, { cursor: s(301) })
    const page = { items: [], counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 }, generation: null }
    const facts = (over: Record<string, unknown>) => ({
      ...page,
      nextCursor: null,
      generation: { ...generationFacts, ...over },
    })
    ok(jobQueueListResponseSchema, facts({ ruleVersion: s(100) }))
    no(jobQueueListResponseSchema, facts({ ruleVersion: s(101) }))
    no(jobQueueListResponseSchema, facts({ ruleVersion: '' }))
    no(jobQueueListResponseSchema, facts({ evaluatedAt: 'yesterday' }))
    no(jobQueueListResponseSchema, facts({ capped: 'false' }))
    for (const [schema, base] of [
      [jobQueueListResponseSchema, page],
      [jobQueueSeniorsContinuationSchema, card.seniors],
      [jobQueueSourcesContinuationSchema, card.sources],
    ] as const) {
      ok(schema, { ...base, nextCursor: 'c' })
      ok(schema, { ...base, nextCursor: s(300) })
      no(schema, { ...base, nextCursor: s(301) })
    }
  })

  it('title 500, companyName 255, location 500 on a list row', () => {
    ok(jobQueueListItemSchema, { ...listItem, title: s(500) })
    no(jobQueueListItemSchema, { ...listItem, title: s(501) })
    ok(jobQueueListItemSchema, { ...listItem, companyName: s(255) })
    no(jobQueueListItemSchema, { ...listItem, companyName: s(256) })
    ok(jobQueueListItemSchema, { ...listItem, location: 'Kyiv' })
    ok(jobQueueListItemSchema, { ...listItem, location: s(500) })
    no(jobQueueListItemSchema, { ...listItem, location: s(501) })
  })

  it('matchedKeywords: 200 items accepted, 201 refused', () => {
    const kw = (n: number) => ({
      ...senior,
      matchedKeywords: Array.from({ length: n }, () => 'ts'),
    })
    ok(jobQueueCardSeniorSchema, kw(200))
    no(jobQueueCardSeniorSchema, kw(201))
  })

  it('descriptionMd: the limit accepted, one more refused', () => {
    ok(jobQueueCardResponseSchema, { ...card, descriptionMd: s(DESCRIPTION_MD_MAX) })
    no(jobQueueCardResponseSchema, { ...card, descriptionMd: s(DESCRIPTION_MD_MAX + 1) })
    expect(DESCRIPTION_MD_MAX).toBe(50000)
  })
})

describe("another team's submission is a bare marker (SR-M-2)", () => {
  const withSubmission = (submission: unknown) => ({ ...senior, submission })

  it('accepts exactly { submittedElsewhere: true }', () => {
    expect(jobQueueForeignSubmissionSchema.parse({ submittedElsewhere: true })).toEqual({
      submittedElsewhere: true,
    })
    expect(
      jobQueueCardSeniorSchema.safeParse(withSubmission({ submittedElsewhere: true })).success,
    ).toBe(true)
    expect(jobQueueCardSeniorSchema.safeParse(withSubmission(null)).success).toBe(true)
  })

  it('refuses a false marker and any field of the foreign row riding along', () => {
    expect(jobQueueForeignSubmissionSchema.safeParse({ submittedElsewhere: false }).success).toBe(
      false,
    )
    expect(jobQueueForeignSubmissionSchema.safeParse({}).success).toBe(false)
    for (const field of [
      'id',
      'submittedAt',
      'cancelledAt',
      'version',
      'submittedByName',
      'seniorId',
    ]) {
      const leaky = {
        submittedElsewhere: true,
        [field]: (submitted as Record<string, unknown>)[field],
      }
      expect(jobQueueCardSeniorSchema.safeParse(withSubmission(leaky)).success, field).toBe(false)
    }
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
    case 'union':
      return (def['options'] as unknown[]).flatMap(child)
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
  jobQueueForeignSubmissionSchema,
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
        'submittedElsewhere',
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

  /**
   * CR-M-1. Every object a response can contain, each named by its path inside a valid
   * sample: the sample parses, and the same sample with ONE foreign key added at that
   * path is refused. Removing `.strict()` from any of these objects fails its row.
   */
  const page = {
    items: [listItem],
    nextCursor: null,
    counts: { NEW: 1, SUBMITTED: 0, HIDDEN: 0 },
    generation: generationFacts,
  }
  const conflict = {
    code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
    possibleDuplicates: card.possibleDuplicates,
  }
  const dismissal = { opportunityId: U1, scope: 'TEAM', reason: 'SPAM', hidden: true, version: 2 }
  const RESPONSE_SITES: ReadonlyArray<
    [string, Parseable, unknown, ReadonlyArray<string | number>]
  > = [
    ['list item', jobQueueListItemSchema, listItem, []],
    ['list item > primarySource', jobQueueListItemSchema, listItem, ['primarySource']],
    ['list page', jobQueueListResponseSchema, page, []],
    ['list page > counts', jobQueueListResponseSchema, page, ['counts']],
    ['list page > generation', jobQueueListResponseSchema, page, ['generation']],
    ['list page > items[0]', jobQueueListResponseSchema, page, ['items', 0]],
    [
      'list page > items[0] > primarySource',
      jobQueueListResponseSchema,
      page,
      ['items', 0, 'primarySource'],
    ],
    ['card', jobQueueCardResponseSchema, card, []],
    ['card > primarySource', jobQueueCardResponseSchema, card, ['primarySource']],
    ['card > seniors', jobQueueCardResponseSchema, card, ['seniors']],
    ['card > seniors > items[0]', jobQueueCardResponseSchema, card, ['seniors', 'items', 0]],
    [
      'card > seniors > items[0] > submission',
      jobQueueCardResponseSchema,
      card,
      ['seniors', 'items', 0, 'submission'],
    ],
    ['card > sources', jobQueueCardResponseSchema, card, ['sources']],
    ['card > sources > items[0]', jobQueueCardResponseSchema, card, ['sources', 'items', 0]],
    ['card > possibleDuplicates', jobQueueCardResponseSchema, card, ['possibleDuplicates']],
    [
      'card > possibleDuplicates > items[0]',
      jobQueueCardResponseSchema,
      card,
      ['possibleDuplicates', 'items', 0],
    ],
    ['seniors continuation', jobQueueSeniorsContinuationSchema, card.seniors, []],
    ['sources continuation', jobQueueSourcesContinuationSchema, card.sources, []],
    ['card senior (own submission)', jobQueueCardSeniorSchema, senior, ['submission']],
    [
      'card senior (foreign marker)',
      jobQueueCardSeniorSchema,
      { ...senior, submission: { submittedElsewhere: true } },
      ['submission'],
    ],
    ['submission', jobQueueSubmissionSchema, submitted, []],
    ['submission response', jobQueueSubmissionResponseSchema, { submission: submitted }, []],
    [
      'submission response > submission',
      jobQueueSubmissionResponseSchema,
      { submission: submitted },
      ['submission'],
    ],
    ['dismissal response', jobQueueDismissalResponseSchema, dismissal, []],
    ['recompute response', jobQueueRecomputeResponseSchema, { runId: U1 }, []],
    ['duplicate conflict', jobQueuePossibleDuplicateConflictSchema, conflict, []],
    [
      'duplicate conflict > preview',
      jobQueuePossibleDuplicateConflictSchema,
      conflict,
      ['possibleDuplicates'],
    ],
    [
      'duplicate conflict > preview > items[0]',
      jobQueuePossibleDuplicateConflictSchema,
      conflict,
      ['possibleDuplicates', 'items', 0],
    ],
  ]

  it.each(RESPONSE_SITES)(
    '%s: a foreign field added by the server is refused at the client',
    (_site, schema, sample, path) => {
      expect(schema.safeParse(sample).success, 'the clean sample must parse').toBe(true)
      for (const field of ['takenByName', 'assigneeId', 'teamId', 'actorId']) {
        expect(schema.safeParse(injectAt(sample, path, field)).success, field).toBe(false)
      }
    },
  )

  it('there is no "taken" tab or status: foreign activity has no representation at all', () => {
    expect(jobQueueTabSchema.safeParse('IN_PROGRESS').success).toBe(false)
    expect(jobQueueTabSchema.safeParse('TAKEN').success).toBe(false)
  })
})
