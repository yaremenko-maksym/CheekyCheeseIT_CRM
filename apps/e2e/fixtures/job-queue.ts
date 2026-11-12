import type { Page, Route } from '@playwright/test'
// apps/e2e deliberately has no @crm/shared dependency; the schemas are imported by path so every
// mock below is `.parse()`d against the exact contract the web client parses the response with.
// A mock that drifts from the schema throws here, in the test, not as a blank screen.
import {
  jobQueueCardResponseSchema,
  jobQueueCardSeniorSchema,
  jobQueueListItemSchema,
  jobQueueListResponseSchema,
  jobQueueSeniorOptionsResponseSchema,
  jobQueueSubmissionResponseSchema,
} from '../../../packages/shared/src/schemas/job-sourcing'
import { apiErrorEnvelopeSchema } from '../../../packages/shared/src/schemas/api-errors'
import { API_RE } from '../tests/fixtures/route-helpers'

/**
 * Vacancy queue (`/job-queue`) E2E fixtures, Task 7.6.
 *
 * Wave 1 (this file today): schema-parsed builders + a mocked route installer, for the
 * rendering-only scenarios (7, 8, 9, 13). Wave 2 (real API, scenarios 1-6, 10, 12) adds its
 * seed-backed helpers below the `REAL API` marker at the end of this file.
 */

// `ReturnType<parse>`, not `z.infer`: zod is not a dependency of apps/e2e
export type QueueListItem = ReturnType<typeof jobQueueListItemSchema.parse>
export type QueueListResponse = ReturnType<typeof jobQueueListResponseSchema.parse>
export type QueueCard = ReturnType<typeof jobQueueCardResponseSchema.parse>
export type QueueCardSenior = ReturnType<typeof jobQueueCardSeniorSchema.parse>

// ---------------------------------------------------------------------------
// MOCKED: ids and builders (mock-only uuids; never seeded)
// ---------------------------------------------------------------------------

export const MOCK_IDS = {
  opportunity: '7a000000-0000-4000-8000-000000000001',
  opportunity2: '7a000000-0000-4000-8000-000000000002',
  source: '7b000000-0000-4000-8000-000000000001',
  seniorA: '7c000000-0000-4000-8000-000000000001',
  seniorB: '7c000000-0000-4000-8000-000000000002',
  submission: '7d000000-0000-4000-8000-000000000001',
} as const

const T0 = '2026-11-10T09:00:00.000Z'
const ORIGINAL_URL = 'https://jobs.dou.ua/companies/example/vacancies/100001/'

export function listItem(overrides: Partial<QueueListItem> = {}): QueueListItem {
  return jobQueueListItemSchema.parse({
    opportunityId: MOCK_IDS.opportunity,
    revision: 1,
    title: 'Senior React Engineer',
    companyName: 'Example Co',
    location: 'Remote',
    primarySource: { sourceRecordId: MOCK_IDS.source, sourceType: 'DOU_RSS', url: ORIGINAL_URL },
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
    publishedAt: T0,
    firstSeenAt: T0,
    ...overrides,
  })
}

export function cardSenior(overrides: Partial<QueueCardSenior> = {}): QueueCardSenior {
  return jobQueueCardSeniorSchema.parse({
    seniorId: MOCK_IDS.seniorA,
    displayName: 'Senior Alpha',
    matchApproximate: false,
    matchedKeywords: ['React'],
    matchEvidence: [{ keyword: 'React', strength: 'CORE' }],
    submission: null,
    ...overrides,
  })
}

/** A card derived from a list item, so the row and the card agree unless a test says otherwise. */
export function card(
  overrides: Partial<QueueCard> = {},
  seniors: QueueCardSenior[] = [cardSenior()],
): QueueCard {
  const { seniors: seniorsOverride, ...rest } = overrides
  return jobQueueCardResponseSchema.parse({
    ...listItem(),
    descriptionMd: 'We are hiring a **React** engineer.',
    newerThanList: false,
    seniors: seniorsOverride ?? { items: seniors, totalCount: seniors.length, nextCursor: null },
    sources: {
      items: [
        {
          sourceRecordId: MOCK_IDS.source,
          sourceType: 'DOU_RSS',
          url: ORIGINAL_URL,
          linkedAt: T0,
        },
      ],
      totalCount: 1,
      nextCursor: null,
    },
    possibleDuplicates: null,
    lastSeenAt: T0,
    stackKeywords: ['React', 'TypeScript'],
    noMatchReason: seniors.length > 0 ? null : 'NO_MATCH',
    engagementForm: null,
    dismissal: null,
    ...rest,
  })
}

export function listResponse(
  items: QueueListItem[],
  overrides: Partial<QueueListResponse> = {},
): QueueListResponse {
  return jobQueueListResponseSchema.parse({
    items,
    nextCursor: null,
    counts: { NEW: items.length, SUBMITTED: 0, HIDDEN: 0 },
    generation: { ruleVersion: 'rules-v1', evaluatedAt: T0, capped: false },
    ...overrides,
  })
}

type ApiErrorCode = ReturnType<typeof apiErrorEnvelopeSchema.parse>['code']

/** The API error envelope the web client branches on by `code`, parsed like the client does. */
export function apiError(statusCode: number, code: ApiErrorCode) {
  return apiErrorEnvelopeSchema.parse({ statusCode, code, message: code })
}

/** An uncoded server failure (no envelope `code`): what an unexpected 5xx looks like. */
export function serverFailure(statusCode: number) {
  return { statusCode, message: 'Internal server error' }
}

// ---------------------------------------------------------------------------
// MOCKED: route installer
// ---------------------------------------------------------------------------

/** An explicit status + body; any other answer is a parsed body served as 200. */
export type Canned = { status: number; body: unknown; delayMs?: number }
export type Answer = Canned | object

function isCanned(a: Answer): a is Canned {
  return 'status' in a && 'body' in a
}

async function answer(route: Route, a: Answer) {
  const canned: Canned = isCanned(a) ? a : { status: 200, body: a }
  if (canned.delayMs) await new Promise((r) => setTimeout(r, canned.delayMs))
  await route.fulfill({
    status: canned.status,
    contentType: 'application/json',
    body: JSON.stringify(canned.body),
  })
}

/** Serves `answers` in order and keeps repeating the last one (a refetch sees the newest state). */
function sequence(answers: Answer[]): () => Answer {
  let i = 0
  return () => answers[Math.min(i++, answers.length - 1)]!
}

export interface QueueMocks {
  /** GET `/job-queue` answers, in order (the last one repeats). */
  list?: Answer[]
  /** GET `/job-queue/:id` answers, in order (the last one repeats). */
  card?: Answer[]
  /** POST `/job-queue/:id/submissions` answers, in order (the last one repeats). */
  submit?: Answer[]
}

/**
 * Installs the queue mocks on top of `mockAuthAs` (registered later, so it wins). Every
 * `/job-queue` call these mocks do not name gets a 501 — never `route.continue()`, so a mocked
 * spec cannot reach the real API by accident.
 */
export async function mockJobQueue(page: Page, mocks: QueueMocks = {}) {
  const list = sequence(mocks.list ?? [listResponse([listItem()])])
  const cardAnswer = sequence(mocks.card ?? [card()])
  const submit = sequence(
    mocks.submit ?? [
      jobQueueSubmissionResponseSchema.parse({
        submission: {
          id: MOCK_IDS.submission,
          opportunityId: MOCK_IDS.opportunity,
          seniorId: MOCK_IDS.seniorA,
          state: 'TAKEN',
          submittedAt: T0,
          cancelledAt: null,
          version: 1,
          submittedByName: 'HR',
        },
      }),
    ],
  )
  const uuid = '[0-9a-f-]{36}'

  await page.route(new RegExp(`${API_RE}/job-queue`), (r) =>
    answer(r, { status: 501, body: serverFailure(501) }),
  )
  await page.route(new RegExp(`${API_RE}/job-queue(\\?|$)`), (r) => answer(r, list()))
  await page.route(new RegExp(`${API_RE}/job-queue/seniors(\\?|$)`), (r) =>
    answer(r, {
      status: 200,
      body: jobQueueSeniorOptionsResponseSchema.parse({
        items: [{ id: MOCK_IDS.seniorA, name: 'Senior Alpha', teamName: 'Alpha Team' }],
      }),
    }),
  )
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}(\\?|$)`), (r) => answer(r, cardAnswer()))
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}/submissions(\\?|$)`), (r) => {
    const a = submit()
    // a parsed `{ submission }` body is wrapped as a 201, a Canned answer passes as-is
    return answer(r, isCanned(a) ? a : { status: 201, body: a })
  })
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}/opened(\\?|$)`), (r) =>
    r.fulfill({ status: 204 }),
  )
}

// ---------------------------------------------------------------------------
// REAL API (wave 2: seed-backed helpers for scenarios 1-6, 10, 12 go here)
// ---------------------------------------------------------------------------
