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
  jobQueueManualCardRequestSchema,
  jobQueueOpenedRequestSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueQuerySchema,
  jobQueueRecomputeResponseSchema,
  jobQueueScopeQuerySchema,
  jobQueueSeniorOptionsResponseSchema,
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
  JOB_QUEUE_ROW_KEYWORDS_MAX,
  JOB_QUEUE_SENIOR_FILTER_MAX,
  JOB_QUEUE_SENIOR_OPTIONS_MAX,
} from './job-sourcing'
import { MAX_STACK_KEYWORD_CHARS } from '../utils/stack-keywords'

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
  applicationUrl: null,
  alsoSeenOnCount: 2,
  availability: 'OPEN',
  eligibility: 'LEAD',
  seniority: 'SENIOR',
  matchedKeywords: ['react', 'typescript'],
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
  matchEvidence: [{ keyword: 'typescript', strength: 'CORE' }],
  submission: submitted,
}
/** The submit conflict's preview: the shared duplicate item, without the card's own-scope names. */
const plainDuplicates = {
  items: [{ opportunityId: U3, title: 'Dup', companyName: null }],
  totalCount: 1,
}
const card = {
  ...listItem,
  descriptionMd: '# Role',
  newerThanList: false,
  lastSeenAt: LATER,
  stackKeywords: ['react', 'typescript', 'aws'],
  noMatchReason: null,
  engagementForm: 'B2B',
  dismissal: { scope: 'TEAM', version: 2 },
  seniors: { items: [senior], totalCount: 1, nextCursor: null },
  sources: {
    items: [{ sourceRecordId: U2, sourceType: 'DOU_RSS', url: URL, linkedAt: NOW }],
    totalCount: 1,
    nextCursor: null,
  },
  possibleDuplicates: {
    items: [{ opportunityId: U3, title: 'Dup', companyName: null, submittedSeniorNames: [] }],
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

  it('parses the senior filter as a trimmed, lower-cased, de-duplicated uuid list', () => {
    expect(jobQueueListQuerySchema.parse({ seniorIds: U1 }).seniorIds).toEqual([U1])
    expect(
      jobQueueListQuerySchema.parse({ seniorIds: `${U1}, ${U2},${U1},${U2.toUpperCase()}` })
        .seniorIds,
    ).toEqual([U1, U2])
  })

  it('refuses an empty, malformed or old-style senior filter (400, never "no restriction")', () => {
    for (const bad of [
      { seniorIds: '' },
      { seniorIds: `${U1},` },
      { seniorIds: 'not-a-uuid' },
      { seniorIds: `${U1},not-a-uuid` },
      { seniorId: U1 },
    ]) {
      expect(jobQueueListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('bounds the senior filter by count: the limit accepted, one more refused', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => U1.slice(0, -4) + String(i).padStart(4, '0'))
    expect(JOB_QUEUE_SENIOR_FILTER_MAX).toBe(50)
    expect(jobQueueListQuerySchema.parse({ seniorIds: ids(50).join(',') }).seniorIds).toHaveLength(
      50,
    )
    const over = jobQueueListQuerySchema.safeParse({ seniorIds: ids(51).join(',') })
    expect(over.error?.issues.map((i) => i.code)).toEqual(['too_big'])
  })

  it('bounds the senior filter by raw length, before any member is read', () => {
    // 50 canonical ids and their 49 commas are exactly 1849 characters.
    const atLimit = `${U1},`.repeat(49) + U1
    expect(atLimit).toHaveLength(1849)
    expect(jobQueueListQuerySchema.parse({ seniorIds: atLimit }).seniorIds).toEqual([U1])
    const long = jobQueueListQuerySchema.safeParse({ seniorIds: atLimit + ' ' })
    expect(long.error?.issues.map((i) => i.code)).toEqual(['too_big'])
  })

  it('takes the scope, tab, seniors and cursor, and refuses anything else', () => {
    expect(
      jobQueueListQuerySchema.parse({ teamId: U1, tab: 'HIDDEN', seniorIds: U2, cursor: 'c' }),
    ).toEqual({ teamId: U1, tab: 'HIDDEN', seniorIds: [U2], cursor: 'c', limit: 20 })
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
      possibleDuplicates: plainDuplicates,
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

/**
 * r5 Phase 6 manual card — POST `/job-queue/manual`. A card is never created without one
 * submission, and a submission never without a resume: both are refused by THIS schema (400),
 * before any route logic runs.
 */
describe('manual card request (POST /job-queue/manual)', () => {
  const submission = { teamId: U1, seniorId: U2, resumeId: U3 }
  const body = {
    title: 'Staff Engineer',
    companyName: 'Acme',
    descriptionMd: 'Found on a LinkedIn post.',
    idempotencyKey: U1,
    submission,
  }

  it('parses the minimal body; the application URL is optional', () => {
    expect(jobQueueManualCardRequestSchema.parse(body)).toEqual({
      ...body,
      confirmPossibleDuplicate: false,
    })
    expect(
      jobQueueManualCardRequestSchema.parse({ ...body, applicationUrl: URL }).applicationUrl,
    ).toBe(URL)
  })

  it('carries the possible-duplicate confirmation like a submit; a non-boolean is refused', () => {
    expect(
      jobQueueManualCardRequestSchema.parse({ ...body, confirmPossibleDuplicate: true })
        .confirmPossibleDuplicate,
    ).toBe(true)
    expect(
      jobQueueManualCardRequestSchema.safeParse({ ...body, confirmPossibleDuplicate: 'yes' })
        .success,
    ).toBe(false)
  })

  it('trims title and company name', () => {
    const parsed = jobQueueManualCardRequestSchema.parse({
      ...body,
      title: '  Staff Engineer ',
      companyName: ' Acme  ',
    })
    expect([parsed.title, parsed.companyName]).toEqual(['Staff Engineer', 'Acme'])
  })

  it.each([
    ['no submission', { ...body, submission: undefined }],
    ['a null submission', { ...body, submission: null }],
    ['a submission array', { ...body, submission: [submission] }],
    ['no resume', { ...body, submission: { teamId: U1, seniorId: U2 } }],
    ['a null resume', { ...body, submission: { ...submission, resumeId: null } }],
    ['a non-uuid resume', { ...body, submission: { ...submission, resumeId: 'cv.pdf' } }],
    ['no senior', { ...body, submission: { teamId: U1, resumeId: U3 } }],
    ['no team', { ...body, submission: { seniorId: U2, resumeId: U3 } }],
    ['an unknown submission key', { ...body, submission: { ...submission, assigneeId: U3 } }],
    ['an unknown top-level key', { ...body, teamId: U1 }],
    ['no idempotency key', { ...body, idempotencyKey: undefined }],
    ['a non-uuid idempotency key', { ...body, idempotencyKey: 'retry-1' }],
    ['no title', { ...body, title: undefined }],
    ['a blank title', { ...body, title: '   ' }],
    ['no company name', { ...body, companyName: undefined }],
    ['a blank company name', { ...body, companyName: ' ' }],
    ['no description', { ...body, descriptionMd: undefined }],
    ['an empty description', { ...body, descriptionMd: '' }],
    ['an http URL', { ...body, applicationUrl: 'http://jobs.example.test/1' }],
    ['a javascript: URL', { ...body, applicationUrl: 'javascript:alert(1)' }],
    ['a null URL', { ...body, applicationUrl: null }],
  ])('refuses %s', (_name, bad) => {
    expect(jobQueueManualCardRequestSchema.safeParse(bad).success).toBe(false)
  })

  it('bounds: title 500, company name 255, URL 2048, description DESCRIPTION_MD_MAX', () => {
    const s = (n: number) => 'x'.repeat(n)
    const ok = (over: Record<string, unknown>) =>
      jobQueueManualCardRequestSchema.safeParse({ ...body, ...over }).success
    expect([ok({ title: s(500) }), ok({ title: s(501) })]).toEqual([true, false])
    expect([ok({ companyName: s(255) }), ok({ companyName: s(256) })]).toEqual([true, false])
    const url = (n: number) => 'https://jobs.example.test/' + s(n - 26)
    expect([ok({ applicationUrl: url(2048) }), ok({ applicationUrl: url(2049) })]).toEqual([
      true,
      false,
    ])
    expect([ok({ descriptionMd: s(50000) }), ok({ descriptionMd: s(50001) })]).toEqual([
      true,
      false,
    ])
  })
})

describe('a manual card is a list row without a source (r5 Phase 6)', () => {
  it('accepts a null primary source and a stated application URL', () => {
    const manual = { ...listItem, primarySource: null, applicationUrl: URL, alsoSeenOnCount: 0 }
    expect(jobQueueListItemSchema.parse(manual)).toEqual(manual)
    const manualCard = {
      ...card,
      ...manual,
      sources: { items: [], totalCount: 0, nextCursor: null },
    }
    expect(jobQueueCardResponseSchema.parse(manualCard)).toEqual(manualCard)
  })

  it('refuses a missing application URL key and a non-https one', () => {
    const { applicationUrl: _omitted, ...withoutUrl } = listItem
    expect(jobQueueListItemSchema.safeParse(withoutUrl).success).toBe(false)
    expect(
      jobQueueListItemSchema.safeParse({ ...listItem, applicationUrl: 'http://a.example/1' })
        .success,
    ).toBe(false)
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

describe('jobQueueSeniorOptionsResponseSchema — GET /job-queue/seniors', () => {
  const option = { id: U1, name: 'Olena K.', teamName: 'Team Alpha' }

  it('carries the id, the display name and the team name, and nothing else', () => {
    expect(jobQueueSeniorOptionsResponseSchema.parse({ items: [option] })).toEqual({
      items: [option],
    })
    expect(jobQueueSeniorOptionsResponseSchema.parse({ items: [] })).toEqual({ items: [] })
    for (const field of ['email', 'teamId', 'role', 'profile']) {
      const leaky = { items: [{ ...option, [field]: 'x' }] }
      expect(jobQueueSeniorOptionsResponseSchema.safeParse(leaky).success, field).toBe(false)
    }
    expect(jobQueueSeniorOptionsResponseSchema.safeParse({ items: [], extra: 1 }).success).toBe(
      false,
    )
  })

  it('refuses a non-uuid id; bounds the name and the team name at 255; a team may be null', () => {
    const parse = (o: object) => jobQueueSeniorOptionsResponseSchema.safeParse({ items: [o] })
    expect(parse({ ...option, id: 'senior-1' }).success).toBe(false)
    expect(parse({ ...option, name: 'x'.repeat(255) }).success).toBe(true)
    expect(parse({ ...option, name: 'x'.repeat(256) }).success).toBe(false)
    expect(parse({ ...option, teamName: 'x'.repeat(255) }).success).toBe(true)
    expect(parse({ ...option, teamName: 'x'.repeat(256) }).success).toBe(false)
    // a senior with no live membership (STUDIO only) has no team, never a placeholder string
    expect(parse({ ...option, teamName: null }).success).toBe(true)
    expect(parse({ id: U1, name: 'Olena K.' }).success).toBe(false)
  })

  it('bounds the list: the limit accepted, one more refused', () => {
    const items = (n: number) => Array.from({ length: n }, () => option)
    expect(JOB_QUEUE_SENIOR_OPTIONS_MAX).toBe(200)
    expect(jobQueueSeniorOptionsResponseSchema.safeParse({ items: items(200) }).success).toBe(true)
    expect(jobQueueSeniorOptionsResponseSchema.safeParse({ items: items(201) }).success).toBe(false)
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

  it('a list row carries a known seniority: UNKNOWN included, a funnel-only level refused', () => {
    for (const seniority of ['MIDDLE', 'SENIOR', 'LEAD', 'UNKNOWN']) {
      ok(jobQueueListItemSchema, { ...listItem, seniority })
    }
    no(jobQueueListItemSchema, { ...listItem, seniority: 'JUNIOR' })
    no(jobQueueListItemSchema, { ...listItem, seniority: undefined })
  })

  it('a list row bounds matchedKeywords: 20 items of 100 chars, and requires the field', () => {
    const keywords = (n: number) => Array.from({ length: n }, () => 'ts')
    ok(jobQueueListItemSchema, { ...listItem, matchedKeywords: [] })
    ok(jobQueueListItemSchema, { ...listItem, matchedKeywords: keywords(20) })
    no(jobQueueListItemSchema, { ...listItem, matchedKeywords: keywords(21) })
    ok(jobQueueListItemSchema, { ...listItem, matchedKeywords: [s(100)] })
    no(jobQueueListItemSchema, { ...listItem, matchedKeywords: [s(101)] })
    no(jobQueueListItemSchema, { ...listItem, matchedKeywords: undefined })
    expect(JOB_QUEUE_ROW_KEYWORDS_MAX).toBe(20)
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

  it('stackKeywords: 60 items accepted, 61 refused; one keyword over the char cap refused', () => {
    const stack = (n: number) => Array.from({ length: n }, (_, i) => `k${String(i)}`)
    ok(jobQueueCardResponseSchema, { ...card, stackKeywords: [] })
    ok(jobQueueCardResponseSchema, { ...card, stackKeywords: stack(60) })
    no(jobQueueCardResponseSchema, { ...card, stackKeywords: stack(61) })
    ok(jobQueueCardResponseSchema, { ...card, stackKeywords: [s(MAX_STACK_KEYWORD_CHARS)] })
    no(jobQueueCardResponseSchema, { ...card, stackKeywords: [s(MAX_STACK_KEYWORD_CHARS + 1)] })
  })

  it('matchEvidence: 200 items accepted, 201 refused; strength is CORE or OPTIONAL only', () => {
    const ev = (n: number) => ({
      ...senior,
      matchEvidence: Array.from({ length: n }, () => ({ keyword: 'ts', strength: 'CORE' })),
    })
    ok(jobQueueCardSeniorSchema, ev(200))
    no(jobQueueCardSeniorSchema, ev(201))
    ok(jobQueueCardSeniorSchema, {
      ...senior,
      matchEvidence: [{ keyword: 'go', strength: 'OPTIONAL' }],
    })
    no(jobQueueCardSeniorSchema, { ...senior, matchEvidence: [{ keyword: 'go', strength: 'X' }] })
    no(jobQueueCardSeniorSchema, { ...senior, matchEvidence: undefined })
    no(jobQueueCardSeniorSchema, {
      ...senior,
      matchEvidence: [{ keyword: s(MAX_STACK_KEYWORD_CHARS + 1), strength: 'CORE' }],
    })
  })

  it('a senior team is optional (absent for a TEAM scope), nullable, and capped', () => {
    ok(jobQueueCardSeniorSchema, senior)
    ok(jobQueueCardSeniorSchema, { ...senior, team: null })
    ok(jobQueueCardSeniorSchema, { ...senior, team: { teamId: U1, teamName: s(255) } })
    no(jobQueueCardSeniorSchema, { ...senior, team: { teamId: U1, teamName: s(256) } })
    no(jobQueueCardSeniorSchema, { ...senior, team: { teamId: 'x', teamName: 'A' } })
    no(jobQueueCardSeniorSchema, { ...senior, team: { teamId: U1, teamName: 'A', seniorId: U1 } })
  })

  it('noMatchReason: the three empty states or null, nothing else', () => {
    for (const reason of ['STOP_LISTED', 'TRIAGE', 'NO_MATCH', null]) {
      ok(jobQueueCardResponseSchema, { ...card, noMatchReason: reason })
    }
    no(jobQueueCardResponseSchema, { ...card, noMatchReason: 'OTHER' })
    no(jobQueueCardResponseSchema, { ...card, noMatchReason: undefined })
  })

  it('engagementForm: B2B, EMPLOYMENT or null; the raw provider text never passes', () => {
    for (const form of ['B2B', 'EMPLOYMENT', null]) {
      ok(jobQueueCardResponseSchema, { ...card, engagementForm: form })
    }
    no(jobQueueCardResponseSchema, { ...card, engagementForm: 'full_time' })
    no(jobQueueCardResponseSchema, { ...card, engagementForm: undefined })
  })

  it('dismissal: null or { scope, version >= 1 }', () => {
    ok(jobQueueCardResponseSchema, { ...card, dismissal: null })
    ok(jobQueueCardResponseSchema, { ...card, dismissal: { scope: 'STUDIO', version: 1 } })
    no(jobQueueCardResponseSchema, { ...card, dismissal: { scope: 'TEAM', version: 0 } })
    no(jobQueueCardResponseSchema, { ...card, dismissal: { scope: 'NONE', version: 1 } })
    no(jobQueueCardResponseSchema, { ...card, dismissal: undefined })
  })

  it('a card duplicate names own-scope submitted seniors; the submit conflict does not', () => {
    const dupWith = (names: unknown) => ({
      ...card,
      possibleDuplicates: {
        items: [
          { opportunityId: U3, title: 'Dup', companyName: null, submittedSeniorNames: names },
        ],
        totalCount: 1,
      },
    })
    ok(jobQueueCardResponseSchema, dupWith(['Ann', 'Bob']))
    no(jobQueueCardResponseSchema, dupWith([s(256)]))
    no(jobQueueCardResponseSchema, dupWith(undefined))
  })

  it('lastSeenAt is a required datetime', () => {
    no(jobQueueCardResponseSchema, { ...card, lastSeenAt: undefined })
    no(jobQueueCardResponseSchema, { ...card, lastSeenAt: 'yesterday' })
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
  jobQueueSeniorOptionsResponseSchema,
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

/**
 * Fields that match FOREIGN_IDENTITY by name but only ever name the VIEWER's own team. The senior
 * picker's `teamName`: a TEAM scope (every HR) reads only its own team's name (the SQL pins the
 * membership to the scope team; the RBAC integration spec asserts it), and only STUDIO, which is
 * ADMIN-only and sees every team anyway, names any other.
 */
const OWN_TEAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  jobQueueSeniorOptionsResponseSchema: ['teamName'],
  // Task 7.3b: a card senior's `team` (§5.6 headings) is filled in the STUDIO scope only, which is
  // ADMIN-only; a TEAM scope (every HR) omits the key (the card-fields integration spec asserts it).
  jobQueueCardResponseSchema: ['teamId', 'teamName'],
  jobQueueCardSeniorSchema: ['teamId', 'teamName'],
  jobQueueSeniorsContinuationSchema: ['teamId', 'teamName'],
}

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
    (name, schema) => {
      const offending = keysOf(schema).filter(
        (k) => FOREIGN_IDENTITY.test(k) && !OWN_TEAM_FIELDS[name]?.includes(k),
      )
      expect(offending).toEqual([])
    },
  )

  it('the own-team exemption is exactly the picker team name and the ADMIN-only card team, and nothing else', () => {
    expect(OWN_TEAM_FIELDS).toEqual({
      jobQueueSeniorOptionsResponseSchema: ['teamName'],
      jobQueueCardResponseSchema: ['teamId', 'teamName'],
      jobQueueCardSeniorSchema: ['teamId', 'teamName'],
      jobQueueSeniorsContinuationSchema: ['teamId', 'teamName'],
    })
    expect(keysOf(jobQueueSeniorOptionsResponseSchema)).toContain('teamName')
  })

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
    possibleDuplicates: plainDuplicates,
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
    ['card > dismissal', jobQueueCardResponseSchema, card, ['dismissal']],
    [
      'card > seniors > items[0] > matchEvidence[0]',
      jobQueueCardResponseSchema,
      card,
      ['seniors', 'items', 0, 'matchEvidence', 0],
    ],
    // `team` itself declares teamId, so its own strictness is pinned in the field-bounds block.
    [
      'card senior (ADMIN team heading)',
      jobQueueCardSeniorSchema,
      { ...senior, team: { teamId: U1, teamName: 'Alpha' } },
      [],
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
