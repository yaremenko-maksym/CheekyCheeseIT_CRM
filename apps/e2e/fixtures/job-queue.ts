import { randomUUID } from 'node:crypto'
import type { APIRequestContext, APIResponse, Page, Route } from '@playwright/test'
// apps/e2e deliberately has no @crm/shared dependency; the schemas are imported by path so every
// mock below is `.parse()`d against the exact contract the web client parses the response with.
// A mock that drifts from the schema throws here, in the test, not as a blank screen.
import {
  jobQueueCardResponseSchema,
  jobQueueCardSeniorSchema,
  jobQueueDismissalResponseSchema,
  jobQueueListItemSchema,
  jobQueueListResponseSchema,
  jobQueueSeniorOptionsResponseSchema,
  jobQueueSubmissionResponseSchema,
  jobQueueTeamTriageGrantSchema,
  jobSourceListSchema,
  jobSourceSchema,
} from '../../../packages/shared/src/schemas/job-sourcing'
import { jobSourceSwitchResultSchema } from '../../../packages/shared/src/schemas/job-source-admin'
import { apiErrorEnvelopeSchema } from '../../../packages/shared/src/schemas/api-errors'
import { API_RE } from '../tests/fixtures/route-helpers'
import { REAL_API_BASE } from '../tests/fixtures/api-helpers/common'

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
    availability: null,
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
  /**
   * The list once the test calls `recover()` on the returned handle: every list GET before it
   * answers `list`, every one after answers this — so the query's own retries and refetches cannot
   * consume the failure before the user's refresh / retry click.
   */
  listAfterRecover?: Answer
  /** GET `/job-queue/:id` answers, in order (the last one repeats). */
  card?: Answer[]
  /**
   * The card once a submit POST has arrived: every card GET before the submit answers `card`, every
   * one after answers this. Driven by the action, not by how many GETs the page happened to make
   * (`gcTime: 0` and the scoped key can refetch the card before the click).
   */
  cardAfterSubmit?: Answer
  /** POST `/job-queue/:id/submissions` answers, in order (the last one repeats). */
  submit?: Answer[]
}

/**
 * Installs the queue mocks on top of `mockAuthAs` (registered later, so it wins). Every
 * `/job-queue` call these mocks do not name gets a 501 — never `route.continue()`, so a mocked
 * spec cannot reach the real API by accident.
 */
export async function mockJobQueue(
  page: Page,
  mocks: QueueMocks = {},
): Promise<{ recover: () => void }> {
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
  let submitted = false
  let recovered = false

  await page.route(new RegExp(`${API_RE}/job-queue`), (r) =>
    answer(r, { status: 501, body: serverFailure(501) }),
  )
  await page.route(new RegExp(`${API_RE}/job-queue(\\?|$)`), (r) =>
    answer(r, recovered && mocks.listAfterRecover ? mocks.listAfterRecover : list()),
  )
  await page.route(new RegExp(`${API_RE}/job-queue/seniors(\\?|$)`), (r) =>
    answer(r, {
      status: 200,
      body: jobQueueSeniorOptionsResponseSchema.parse({
        items: [{ id: MOCK_IDS.seniorA, name: 'Senior Alpha', teamName: 'Alpha Team' }],
      }),
    }),
  )
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}(\\?|$)`), (r) =>
    answer(r, submitted && mocks.cardAfterSubmit ? mocks.cardAfterSubmit : cardAnswer()),
  )
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}/submissions(\\?|$)`), (r) => {
    submitted = true
    const a = submit()
    // a parsed `{ submission }` body is wrapped as a 201, a Canned answer passes as-is
    return answer(r, isCanned(a) ? a : { status: 201, body: a })
  })
  await page.route(new RegExp(`${API_RE}/job-queue/${uuid}/opened(\\?|$)`), (r) =>
    r.fulfill({ status: 204 }),
  )
  return {
    recover: () => {
      recovered = true
    },
  }
}

// ---------------------------------------------------------------------------
// REAL API (wave 2: seed-backed helpers for scenarios 1-6, 10, 12)
// ---------------------------------------------------------------------------

/**
 * The Task 7.6a seed contract (`apps/api/src/database/seed/job-queue.data.ts`): rows are found by
 * TITLE and people by display name through the real API at run time, never by a hardcoded id.
 */
export const SEED_QUEUE = {
  reactPlatform: 'Seed: React Platform Engineer',
  dataPipeline: 'Seed: Data Pipeline Engineer',
  unclearStack: 'Seed: Unclear Stack Vacancy',
  unsafeDescription: 'Seed: Unsafe Description',
  uncertainMatch: 'Seed: Uncertain Match',
} as const

export const SEED_PEOPLE = {
  oleksiy: 'Oleksiy Kovalenko',
  taras: 'Taras Savchuk',
  artem: 'Artem Kravchenko',
  anna: 'Anna Lysenko',
} as const

export const SEED_TEAMS = {
  kovalenko: 'Team Kovalenko',
  kravchenko: 'Team Kravchenko',
} as const

type QueueTab = 'NEW' | 'SUBMITTED' | 'HIDDEN'
type Scoped = { teamId?: string | undefined }

const QUEUE_API = `${REAL_API_BASE}/api/job-queue`

/** The body of an answer with the expected status; anything else fails the test with the body. */
async function ok(res: APIResponse, status: number, label: string): Promise<unknown> {
  if (res.status() !== status) {
    throw new Error(`${label}: HTTP ${res.status()} (expected ${status}) — ${await res.text()}`)
  }
  return res.json()
}

export async function queueList(
  req: APIRequestContext,
  { teamId, tab = 'NEW' }: Scoped & { tab?: QueueTab } = {},
): Promise<QueueListResponse> {
  const params: Record<string, string> = { tab, ...(teamId ? { teamId } : {}) }
  const body = await ok(await req.get(QUEUE_API, { params }), 200, `GET /job-queue ${tab}`)
  return jobQueueListResponseSchema.parse(body)
}

/** The row with this seed title in one tab, or `undefined` when the actor does not see it there. */
export async function queueRow(
  req: APIRequestContext,
  title: string,
  scope: Scoped & { tab?: QueueTab } = {},
): Promise<QueueListItem | undefined> {
  return (await queueList(req, scope)).items.find((i) => i.title === title)
}

/** Every vacancy the actor may see, across the three tabs, sorted by title. */
export async function visibleTitles(req: APIRequestContext, scope: Scoped = {}): Promise<string[]> {
  const tabs = await Promise.all(
    (['NEW', 'SUBMITTED', 'HIDDEN'] as const).map((tab) => queueList(req, { ...scope, tab })),
  )
  return tabs.flatMap((t) => t.items.map((i) => i.title)).sort()
}

export async function queueCard(
  req: APIRequestContext,
  opportunityId: string,
  { teamId }: Scoped = {},
): Promise<QueueCard> {
  const res = await req.get(`${QUEUE_API}/${opportunityId}`, {
    params: teamId ? { teamId } : {},
  })
  return jobQueueCardResponseSchema.parse(await ok(res, 200, 'GET /job-queue/:id'))
}

export function seniorNamed(c: QueueCard, displayName: string): QueueCardSenior {
  const s = c.seniors.items.find((i) => i.displayName === displayName)
  if (!s) throw new Error(`card ${c.title}: no matched senior "${displayName}"`)
  return s
}

export async function teamIdByName(req: APIRequestContext, name: string): Promise<string> {
  const body = (await ok(await req.get(`${REAL_API_BASE}/api/teams`), 200, 'GET /teams')) as
    { id: string; name: string }[] | { items: { id: string; name: string }[] }
  const team = (Array.isArray(body) ? body : body.items).find((t) => t.name === name)
  if (!team) throw new Error(`team "${name}" is not visible to this actor`)
  return team.id
}

/** Cancels the actor team's live (TAKEN) submission of this senior, if there is one. */
export async function cancelLiveSubmission(
  req: APIRequestContext,
  opportunityId: string,
  seniorName: string,
  { teamId }: Scoped = {},
): Promise<void> {
  const s = seniorNamed(await queueCard(req, opportunityId, { teamId }), seniorName).submission
  if (!s || 'submittedElsewhere' in s || s.state !== 'TAKEN') return
  const res = await req.post(`${QUEUE_API}/${opportunityId}/submissions/${s.id}/cancel`, {
    data: {
      ...(teamId ? { teamId } : {}),
      idempotencyKey: randomUUID(),
      expectedVersion: s.version,
    },
  })
  jobQueueSubmissionResponseSchema.parse(await ok(res, 200, 'cancel submission'))
}

/** Undoes the actor team's live TEAM-scope dismissal of this vacancy, if there is one. */
export async function undoLiveDismissal(
  req: APIRequestContext,
  opportunityId: string,
  { teamId }: Scoped = {},
): Promise<void> {
  // the card's `dismissal` keeps an undone row too; only the HIDDEN tab says it is live
  const hidden = await queueList(req, { teamId, tab: 'HIDDEN' })
  if (!hidden.items.some((i) => i.opportunityId === opportunityId)) return
  const d = (await queueCard(req, opportunityId, { teamId })).dismissal
  if (!d || d.scope !== 'TEAM') throw new Error('a hidden vacancy without a TEAM dismissal')
  const res = await req.post(`${QUEUE_API}/${opportunityId}/undo`, {
    data: {
      ...(teamId ? { teamId } : {}),
      scope: 'TEAM',
      idempotencyKey: randomUUID(),
      expectedVersion: d.version,
    },
  })
  jobQueueDismissalResponseSchema.parse(await ok(res, 200, 'undo dismissal'))
}

/**
 * Revokes whatever live grant `teamId` holds on the vacancy; `null` when there is none. No API
 * reads a grant, and a revoke matches only the grant's current version (anything else is a 409
 * with no effect), so every version is tried up to `maxVersion` — no assumption about which
 * versions a live grant can carry. A 429 is retried with a bounded backoff; only a 409 means
 * "not this version", any other status throws.
 */
export async function revokeLiveTriage(
  req: APIRequestContext,
  opportunityId: string,
  teamId: string,
  maxVersion = 200,
): Promise<number | null> {
  const revoke = (version: number) =>
    req.delete(`${QUEUE_API}/${opportunityId}/team-triage/${teamId}`, {
      data: {
        expectedGrantVersion: version,
        reason: 'Task 7.6 E2E pre-clean',
        idempotencyKey: randomUUID(),
      },
    })
  for (let version = 1; version <= maxVersion; version += 1) {
    let res = await revoke(version)
    for (let retry = 0; res.status() === 429 && retry < 5; retry += 1) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** retry))
      res = await revoke(version)
    }
    if (res.status() === 409) continue
    jobQueueTeamTriageGrantSchema.parse(await ok(res, 200, 'revoke live team triage'))
    return version
  }
  return null
}

export async function revokeTriage(
  req: APIRequestContext,
  opportunityId: string,
  teamId: string,
  expectedGrantVersion: number,
): Promise<void> {
  const res = await req.delete(`${QUEUE_API}/${opportunityId}/team-triage/${teamId}`, {
    data: {
      expectedGrantVersion,
      reason: 'Task 7.6 E2E cleanup',
      idempotencyKey: randomUUID(),
    },
  })
  jobQueueTeamTriageGrantSchema.parse(await ok(res, 200, 'revoke team triage'))
}

// ---------------------------------------------------------------------------
// MOCKED job sources (scenario 12 switch): the seed has no `job_sources` row and the API cannot
// create one, so only the switch's rendering is mocked; its RBAC is proven on the real API.
// ---------------------------------------------------------------------------

export type JobSource = ReturnType<typeof jobSourceSchema.parse>

export function jobSource(overrides: Partial<JobSource> = {}): JobSource {
  return jobSourceSchema.parse({
    id: MOCK_IDS.source,
    type: 'DOU_RSS',
    enabled: true,
    triggerMode: 'SCHEDULED',
    lastCollectedAt: T0,
    disabledReason: null,
    budget: {
      state: 'ACTIVE',
      limit: 500,
      window: 'MONTH',
      used: 10,
      remaining: 490,
      resetsAt: null,
    },
    readiness: 'VERIFIED',
    readinessReason: null,
    adminState: 'ACTIVE',
    ...overrides,
  })
}

/**
 * A one-source server: GET `/job-sourcing/sources` answers the current state, PATCH
 * `/job-sourcing/sources/:id` applies `{ enabled }` — or, when `refuseEnable` is set, answers an
 * enable with that 409 and changes nothing, like `JobSourceAdminService.setEnabled`.
 */
export async function mockJobSources(
  page: Page,
  initial: JobSource,
  refuseEnable?: 'JOB_SOURCE_NOT_READY' | 'JOB_SOURCE_AUTH_PAUSED',
) {
  let current = initial
  await page.route(new RegExp(`${API_RE}/job-sourcing/sources(\\?|$)`), (r) =>
    answer(r, jobSourceListSchema.parse({ items: [current] })),
  )
  await page.route(new RegExp(`${API_RE}/job-sourcing/sources/${current.id}(\\?|$)`), (r) => {
    const { enabled } = r.request().postDataJSON() as { enabled: boolean }
    if (enabled && refuseEnable) {
      return answer(r, { status: 409, body: apiError(409, refuseEnable) })
    }
    const changed = current.enabled !== enabled
    current = jobSource({ ...current, enabled })
    return answer(
      r,
      jobSourceSwitchResultSchema.parse({ id: current.id, enabled, changed, cancelledRuns: 0 }),
    )
  })
}
