import { describe, expect, it } from 'vitest'
import {
  DESCRIPTION_MD_MAX,
  dismissJobQueueItemSchema,
  externalHttpsUrlSchema,
  jobCollectionResultSchema,
  jobPostingSchema,
  jobQueueCardSchema,
  jobQueueItemSchema,
  jobSeniorityLevelSchema,
  jobQueueStatusSchema,
  jobSignalKindSchema,
  jobQueueListSchema,
  jobQueueDismissReasonSchema,
  jobQueueQuerySchema,
  jobSourceTypeSchema,
  jobSourceBudgetSchema,
  jobSourceBudgetStateSchema,
  jobSourceBudgetWindowSchema,
  jobSourceSchema,
  jobSourceTriggerModeSchema,
  jobSuggestionListSchema,
  jobSuggestionSchema,
} from './job-sourcing'
import { MAX_STACK_KEYWORD_CHARS, MAX_STACK_KEYWORDS } from '../utils/stack-keywords'

/**
 * The wire contract for task-vacancy-matching, asserted as behaviour.
 *
 * Raised by the mutation gate: the bounds and enum members in this file were
 * declarations nobody checked. `max` could become `min`, `1` could become `0`,
 * and an enum could lose a member with every test still green — which is how a
 * contract silently stops contracting. Each limit below is asserted from BOTH
 * sides, because a bound only means something if the value past it is refused.
 */

const suggestion = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  seniorId: '11111111-1111-4111-8111-111111111111',
  status: 'NEW' as const,
  statusChangedAt: null,
  statusChangedByName: null,
  createdAt: '2026-08-12T09:00:00.000Z',
  matchScore: 0.5,
  matchedKeywords: ['java'],
  posting: {
    id: '22222222-2222-4222-8222-222222222222',
    sourceType: 'DOU_RSS' as const,
    externalId: 'https://jobs.dou.ua/companies/acme/vacancies/1',
    url: 'https://jobs.dou.ua/companies/acme/vacancies/1',
    title: 'Senior Java Developer',
    companyName: 'Acme',
    location: null,
    descriptionMd: '',
    publishedAt: null,
    collectedAt: '2026-08-12T09:00:00.000Z',
  },
  ...over,
})

describe('matchScore is a share, so it is bounded at BOTH ends', () => {
  it('accepts the ends of the range and a value between them', () => {
    for (const matchScore of [0, 0.5, 1]) {
      expect(jobSuggestionSchema.safeParse(suggestion({ matchScore })).success).toBe(true)
    }
  })

  it('refuses anything above 1 — a share cannot exceed the whole', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: 1.0001 })).success).toBe(false)
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: 2 })).success).toBe(false)
  })

  it('refuses anything below 0', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: -0.0001 })).success).toBe(false)
  })

  it('accepts null — "not ranked" is a different fact from "scored zero"', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: null })).success).toBe(true)
  })
})

describe('keyword arrays are capped in length AND in element size', () => {
  const keyword = (n: number) => 'a'.repeat(n)

  it('accepts a keyword of exactly the maximum length', () => {
    const dto = suggestion({ matchedKeywords: [keyword(MAX_STACK_KEYWORD_CHARS)] })
    expect(jobSuggestionSchema.safeParse(dto).success).toBe(true)
  })

  it('refuses a keyword one character too long', () => {
    const dto = suggestion({ matchedKeywords: [keyword(MAX_STACK_KEYWORD_CHARS + 1)] })
    expect(jobSuggestionSchema.safeParse(dto).success).toBe(false)
  })

  it('accepts exactly the maximum number of keywords, and refuses one more', () => {
    const fill = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`)
    expect(
      jobSuggestionSchema.safeParse(suggestion({ matchedKeywords: fill(MAX_STACK_KEYWORDS) }))
        .success,
    ).toBe(true)
    expect(
      jobSuggestionSchema.safeParse(suggestion({ matchedKeywords: fill(MAX_STACK_KEYWORDS + 1) }))
        .success,
    ).toBe(false)
  })

  it('applies the same two caps to the senior stack on the list envelope', () => {
    const envelope = (stackKeywords: string[]) => ({
      items: [],
      lowMatch: [],
      lowMatchCount: 0,
      total: 0,
      threshold: 0.2,
      stackKeywords,
    })
    expect(
      jobSuggestionListSchema.safeParse(envelope([keyword(MAX_STACK_KEYWORD_CHARS)])).success,
    ).toBe(true)
    expect(
      jobSuggestionListSchema.safeParse(envelope([keyword(MAX_STACK_KEYWORD_CHARS + 1)])).success,
    ).toBe(false)
    expect(
      jobSuggestionListSchema.safeParse(
        envelope(Array.from({ length: MAX_STACK_KEYWORDS + 1 }, (_, i) => `k${i}`)),
      ).success,
    ).toBe(false)
  })
})

describe('the budget enums carry exactly the members the code branches on', () => {
  it('budget window: DAY and MONTH, nothing else', () => {
    expect(jobSourceBudgetWindowSchema.options).toEqual(['DAY', 'MONTH'])
    for (const value of ['DAY', 'MONTH']) {
      expect(jobSourceBudgetWindowSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['WEEK', 'YEAR', 'day', '']) {
      expect(jobSourceBudgetWindowSchema.safeParse(value).success).toBe(false)
    }
  })

  it('trigger mode: SCHEDULED, MANUAL, BOTH — dropping one silently re-enables a source', () => {
    expect(jobSourceTriggerModeSchema.options).toEqual(['SCHEDULED', 'MANUAL', 'BOTH'])
    for (const value of ['SCHEDULED', 'MANUAL', 'BOTH']) {
      expect(jobSourceTriggerModeSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['NEVER', 'manual', '']) {
      expect(jobSourceTriggerModeSchema.safeParse(value).success).toBe(false)
    }
  })

  it('budget state: the four cases the panel renders differently', () => {
    expect(jobSourceBudgetStateSchema.options).toEqual([
      'UNLIMITED',
      'ACTIVE',
      'EXHAUSTED',
      'MISCONFIGURED',
    ])
    for (const value of ['UNLIMITED', 'ACTIVE', 'EXHAUSTED', 'MISCONFIGURED']) {
      expect(jobSourceBudgetStateSchema.safeParse(value).success).toBe(true)
    }
    expect(jobSourceBudgetStateSchema.safeParse('BROKEN').success).toBe(false)
  })
})

describe('the source DTO keeps its shape', () => {
  const budget = {
    state: 'ACTIVE' as const,
    limit: 200,
    window: 'MONTH' as const,
    used: 153,
    remaining: 47,
    resetsAt: '2026-09-01T00:00:00.000Z',
  }
  const source = {
    id: '55555555-5555-4555-8555-555555555555',
    type: 'DOU_RSS' as const,
    enabled: true,
    triggerMode: 'SCHEDULED' as const,
    lastCollectedAt: null,
    disabledReason: null,
    budget,
  }

  it('accepts a fully-populated source', () => {
    expect(jobSourceSchema.safeParse(source).success).toBe(true)
  })

  it('refuses a budget missing its state — the field the UI branches on', () => {
    const { state: _state, ...withoutState } = budget
    expect(jobSourceBudgetSchema.safeParse(withoutState).success).toBe(false)
    expect(jobSourceSchema.safeParse({ ...source, budget: withoutState }).success).toBe(false)
  })

  it('refuses a source missing its trigger mode', () => {
    const { triggerMode: _mode, ...withoutMode } = source
    expect(jobSourceSchema.safeParse(withoutMode).success).toBe(false)
  })

  it('refuses a negative remaining count', () => {
    expect(jobSourceBudgetSchema.safeParse({ ...budget, remaining: -1 }).success).toBe(false)
    expect(jobSourceBudgetSchema.safeParse({ ...budget, used: -1 }).success).toBe(false)
  })
})

describe('vacancy-sourcing contracts', () => {
  it('knows all 31 source types, DOU_RSS first', () => {
    expect(jobSourceTypeSchema.options).toHaveLength(31)
    expect(jobSourceTypeSchema.options[0]).toBe('DOU_RSS')
    expect(jobSourceTypeSchema.options).toContain('WTTJ_HTML')
  })

  it('collection result defaults the new counters to 0 (old payloads still parse)', () => {
    const parsed = jobCollectionResultSchema.parse({
      sourceType: 'DOU_RSS',
      fetched: 1,
      created: 1,
      duplicates: 0,
      invalid: 0,
      suggestionsCreated: 0,
    })
    expect(parsed.merged).toBe(0)
    expect(parsed.filtered).toBe(0)
  })

  it('queue item rejects a non-https also-seen-on url', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      sourceType: 'REMOTEOK_API',
      url: 'https://x.test/a',
      title: 't',
      companyName: 'c',
      location: null,
      seniority: 'SENIOR',
      matchedKeywords: [],
      matchedSeniors: [],
      stackUnknown: false,
      publishedAt: null,
      firstSeenAt: '2026-10-04T00:00:00.000Z',
      queueStatus: 'NEW',
      takenByName: null,
      takenAt: null,
      descriptionMd: 'd',
    }
    expect(() =>
      jobQueueCardSchema.parse({
        ...base,
        alsoSeenOn: [{ source: 'DJINNI_RSS', url: 'javascript:alert(1)' }],
      }),
    ).toThrow()
    expect(
      jobQueueCardSchema.parse({
        ...base,
        alsoSeenOn: [{ source: 'DJINNI_RSS', url: 'https://djinni.co/j/1' }],
      }).alsoSeenOn,
    ).toHaveLength(1)
  })

  it('queue query defaults to NEW / 20 and caps limit at 50', () => {
    expect(jobQueueQuerySchema.parse({})).toMatchObject({ status: 'NEW', limit: 20 })
    expect(() => jobQueueQuerySchema.parse({ limit: '51' })).toThrow()
    expect(jobQueueQuerySchema.parse({ limit: '50' }).limit).toBe(50)
    expect(() => jobQueueQuerySchema.parse({ limit: '0' })).toThrow()
  })

  it('dismiss defaults the reason to NOT_RELEVANT', () => {
    expect(dismissJobQueueItemSchema.parse({}).reason).toBe('NOT_RELEVANT')
  })

  it('list schema carries per-status counters', () => {
    expect(
      jobQueueListSchema.parse({
        items: [],
        nextCursor: null,
        counts: { NEW: 0, IN_PROGRESS: 0, DISMISSED: 0 },
      }).counts.NEW,
    ).toBe(0)
  })
})

/**
 * Pins for the vacancy-queue contract. Every list/bound is asserted from BOTH
 * sides against LITERALS written here (not derived from the schema), because an
 * enum member or a `max()` is only a contract if the value past it is refused.
 */
describe('vacancy-queue contract pins', () => {
  const UUID = '11111111-1111-4111-8111-111111111111'
  const NOW = '2026-10-04T00:00:00.000Z'
  const item = (over: Record<string, unknown> = {}) => ({
    id: UUID,
    sourceType: 'REMOTEOK_API',
    url: 'https://x.test/a',
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
    queueStatus: 'NEW',
    takenByName: null,
    takenAt: null,
    ...over,
  })
  const ok = (over: Record<string, unknown>) => jobQueueItemSchema.safeParse(item(over)).success

  it('source types are exactly these 31, in this order', () => {
    expect([...jobSourceTypeSchema.options]).toEqual([
      'DOU_RSS',
      'REMOTEOK_API',
      'REMOTIVE_API',
      'HIMALAYAS_API',
      'JOBICY_API',
      'ARBEITNOW_API',
      'WORKINGNOMADS_API',
      'JOBGETHER_API',
      'HN_HIRING',
      'GREENHOUSE_ATS',
      'LEVER_ATS',
      'ASHBY_ATS',
      'WORKABLE_ATS',
      'SMARTRECRUITERS_ATS',
      'RECRUITEE_ATS',
      'PERSONIO_ATS',
      'JOOBLE_API',
      'JSEARCH_API',
      'THEIRSTACK_API',
      'MUSE_API',
      'REED_API',
      'DJINNI_RSS',
      'WWR_RSS',
      'EUREMOTEJOBS_RSS',
      'JUSTJOIN_HTML',
      'NOFLUFF_HTML',
      'LANDINGJOBS_HTML',
      'NEXTLEVELJOBS_HTML',
      'DICE_HTML',
      'THEHUB_HTML',
      'WTTJ_HTML',
    ])
  })

  it('small enums are exactly their literals', () => {
    expect([...jobSeniorityLevelSchema.options]).toEqual(['MIDDLE', 'SENIOR', 'LEAD', 'UNKNOWN'])
    expect([...jobQueueStatusSchema.options]).toEqual(['NEW', 'IN_PROGRESS', 'DISMISSED'])
    expect([...jobSignalKindSchema.options]).toEqual(['OPENED', 'TAKEN', 'DEAD_LINK', 'SPAM'])
  })

  it('the collection counters are non-negative integers', () => {
    const base = {
      sourceType: 'DOU_RSS',
      fetched: 0,
      created: 0,
      duplicates: 0,
      invalid: 0,
      suggestionsCreated: 0,
    }
    for (const k of ['merged', 'filtered']) {
      expect(jobCollectionResultSchema.safeParse({ ...base, [k]: 3 }).success).toBe(true)
      expect(jobCollectionResultSchema.safeParse({ ...base, [k]: 0 }).success).toBe(true)
      expect(jobCollectionResultSchema.safeParse({ ...base, [k]: -1 }).success).toBe(false)
      expect(jobCollectionResultSchema.safeParse({ ...base, [k]: 1.5 }).success).toBe(false)
    }
    expect(jobCollectionResultSchema.parse({ ...base, merged: 4, filtered: 5 })).toMatchObject({
      merged: 4,
      filtered: 5,
    })
  })

  it('a source carries a bounded disabled reason', () => {
    // `minIntervalHours` was removed in U7 (the cadence now lives on the ADMIN source page as
    // `jobSourceProfileSummarySchema`); only the disabled-reason bound remains on this DTO.
    const src = (over: Record<string, unknown>) =>
      jobSourceSchema.safeParse({
        id: UUID,
        type: 'DOU_RSS',
        enabled: false,
        triggerMode: 'SCHEDULED',
        lastCollectedAt: null,
        disabledReason: null,
        budget: {
          state: 'UNLIMITED',
          limit: null,
          window: null,
          used: 0,
          remaining: null,
          resetsAt: null,
        },
        ...over,
      }).success
    expect(src({ disabledReason: 'x'.repeat(500) })).toBe(true)
    expect(src({ disabledReason: 'x'.repeat(501) })).toBe(false)
    expect(src({ disabledReason: undefined })).toBe(false)
  })

  it('queue item: a valid row parses; ids are uuids; urls are https', () => {
    expect(ok({})).toBe(true)
    expect(ok({ id: 'not-a-uuid' })).toBe(false)
    expect(ok({ url: 'http://x.test/a' })).toBe(false)
    expect(ok({ sourceType: 'NOPE' })).toBe(false)
    expect(ok({ seniority: 'JUNIOR' })).toBe(false)
    expect(ok({ queueStatus: 'DONE' })).toBe(false)
  })

  it('queue item: text fields are capped', () => {
    expect(ok({ title: 'x'.repeat(500) })).toBe(true)
    expect(ok({ title: 'x'.repeat(501) })).toBe(false)
    expect(ok({ companyName: 'x'.repeat(255) })).toBe(true)
    expect(ok({ companyName: 'x'.repeat(256) })).toBe(false)
    expect(ok({ location: 'x'.repeat(500) })).toBe(true)
    expect(ok({ location: 'x'.repeat(501) })).toBe(false)
    expect(ok({ takenByName: 'x'.repeat(255) })).toBe(true)
    expect(ok({ takenByName: 'x'.repeat(256) })).toBe(false)
  })

  it('queue item: datetimes are ISO strings, nullable where stated', () => {
    expect(ok({ publishedAt: NOW })).toBe(true)
    expect(ok({ publishedAt: 'yesterday' })).toBe(false)
    expect(ok({ takenAt: NOW })).toBe(true)
    expect(ok({ takenAt: 'yesterday' })).toBe(false)
    expect(ok({ firstSeenAt: 'yesterday' })).toBe(false)
    expect(ok({ firstSeenAt: null })).toBe(false)
  })

  it('queue item: keyword / senior / also-seen-on lists are capped and typed', () => {
    const kw = (n: number) => Array.from({ length: n }, () => 'k')
    expect(ok({ matchedKeywords: kw(200) })).toBe(true)
    expect(ok({ matchedKeywords: kw(201) })).toBe(false)
    expect(ok({ matchedKeywords: ['k'.repeat(MAX_STACK_KEYWORD_CHARS)] })).toBe(true)
    expect(ok({ matchedKeywords: ['k'.repeat(MAX_STACK_KEYWORD_CHARS + 1)] })).toBe(false)

    const senior = { id: UUID, displayName: 'N' }
    expect(ok({ matchedSeniors: Array.from({ length: 200 }, () => senior) })).toBe(true)
    expect(ok({ matchedSeniors: Array.from({ length: 201 }, () => senior) })).toBe(false)
    expect(ok({ matchedSeniors: [{ id: 'x', displayName: 'N' }] })).toBe(false)
    expect(ok({ matchedSeniors: [{ id: UUID, displayName: 'n'.repeat(255) }] })).toBe(true)
    expect(ok({ matchedSeniors: [{ id: UUID, displayName: 'n'.repeat(256) }] })).toBe(false)

    const seen = { source: 'DJINNI_RSS', url: 'https://djinni.co/j/1' }
    expect(ok({ alsoSeenOn: Array.from({ length: 20 }, () => seen) })).toBe(true)
    expect(ok({ alsoSeenOn: Array.from({ length: 21 }, () => seen) })).toBe(false)
    expect(ok({ alsoSeenOn: [{ source: 'NOPE', url: 'https://djinni.co/j/1' }] })).toBe(false)
    expect(ok({ stackUnknown: 'no' })).toBe(false)
  })

  it('the card adds a required markdown description to the row', () => {
    expect(jobQueueCardSchema.safeParse({ ...item(), descriptionMd: '' }).success).toBe(true)
    expect(jobQueueCardSchema.safeParse(item()).success).toBe(false)
  })

  it('descriptionMd is bounded: exactly DESCRIPTION_MD_MAX passes, one more is rejected', () => {
    expect(DESCRIPTION_MD_MAX).toBe(50000)
    const at = 'a'.repeat(50000)
    const over = 'a'.repeat(50001)
    expect(jobQueueCardSchema.safeParse({ ...item(), descriptionMd: at }).success).toBe(true)
    expect(jobQueueCardSchema.safeParse({ ...item(), descriptionMd: over }).success).toBe(false)
    const posting = {
      id: UUID,
      sourceType: 'DJINNI_RSS',
      externalId: 'https://djinni.co/j/1',
      url: 'https://djinni.co/j/1',
      title: 't',
      companyName: 'c',
      location: null,
      descriptionMd: at,
      publishedAt: null,
      collectedAt: '2026-10-04T00:00:00.000Z',
      takenByName: null,
      takenAt: null,
    }
    expect(jobPostingSchema.safeParse(posting).success).toBe(true)
    expect(jobPostingSchema.safeParse({ ...posting, descriptionMd: over }).success).toBe(false)
  })

  it('list: counters are non-negative integers and the cursor is capped', () => {
    const list = (over: Record<string, unknown>) =>
      jobQueueListSchema.safeParse({
        items: [],
        nextCursor: null,
        counts: { NEW: 0, IN_PROGRESS: 0, DISMISSED: 0 },
        ...over,
      }).success
    expect(list({ nextCursor: 'c'.repeat(300) })).toBe(true)
    expect(list({ nextCursor: 'c'.repeat(301) })).toBe(false)
    for (const k of ['NEW', 'IN_PROGRESS', 'DISMISSED']) {
      const counts = { NEW: 0, IN_PROGRESS: 0, DISMISSED: 0 }
      expect(list({ counts: { ...counts, [k]: 7 } })).toBe(true)
      expect(list({ counts: { ...counts, [k]: -1 } })).toBe(false)
      expect(list({ counts: { ...counts, [k]: 0.5 } })).toBe(false)
    }
    expect(list({ items: [item()] })).toBe(true)
    expect(list({ items: [item({ id: 'x' })] })).toBe(false)
  })

  it('query: status is an enum with NEW default, cursor capped, limit 1..50 coerced', () => {
    expect(jobQueueQuerySchema.parse({ status: 'DISMISSED' }).status).toBe('DISMISSED')
    expect(jobQueueQuerySchema.safeParse({ status: 'ALL' }).success).toBe(false)
    expect(jobQueueQuerySchema.safeParse({ cursor: 'c'.repeat(300) }).success).toBe(true)
    expect(jobQueueQuerySchema.safeParse({ cursor: 'c'.repeat(301) }).success).toBe(false)
    expect(jobQueueQuerySchema.parse({}).cursor).toBeUndefined()
    expect(jobQueueQuerySchema.parse({ limit: '1' }).limit).toBe(1)
    expect(jobQueueQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(jobQueueQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false)
    expect(jobQueueQuerySchema.parse({ limit: 50 }).limit).toBe(50)
    expect(jobQueueQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
  })

  it('dismiss: the reasons are exactly these three, in this order (R11-M-7)', () => {
    // The exact set, not just "these are accepted and one invented name is
    // not": a FOURTH reason used to pass the whole suite, which is the one
    // change a reason enum actually undergoes.
    expect([...jobQueueDismissReasonSchema.options]).toEqual(['NOT_RELEVANT', 'SPAM', 'DEAD_LINK'])
    for (const reason of jobQueueDismissReasonSchema.options) {
      expect(dismissJobQueueItemSchema.parse({ reason }).reason).toBe(reason)
    }
    expect(dismissJobQueueItemSchema.safeParse({ reason: 'BORING' }).success).toBe(false)
    expect(dismissJobQueueItemSchema.parse({}).reason).toBe('NOT_RELEVANT')
  })
})

/**
 * R11-H-4 — a navigation URL may not carry embedded credentials.
 *
 * `externalHttpsUrlSchema` is the guard on the value the browser hands to
 * `window.open`, and it used to be `/^https:\/\/\S+$/i`, whose `\S+` matches an
 * authority containing `@`: `https://user:pw@example.com/a` parsed. The stored
 * column it comes out of (`HTTPS_URL_PATTERN` in
 * `apps/api/src/database/schema/job-opportunities.ts`) already refused that, so
 * the client-side guard was the weaker of the two. These tests pin the two to
 * the same authority shape, from both sides: a credentialed authority is
 * refused, and a `@` in the PATH — legitimate, and produced by real postings —
 * still parses.
 */
describe('navigation urls reject embedded credentials (R11-H-4)', () => {
  const UUID = '11111111-1111-4111-8111-111111111111'
  const NOW = '2026-10-04T00:00:00.000Z'
  const CREDS = 'https://user:pw@example.com/a'
  const BARE_USER = 'https://user@example.com/a'

  it('the shared field schema refuses credentials in the authority', () => {
    expect(externalHttpsUrlSchema.safeParse(CREDS).success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse(BARE_USER).success).toBe(false)
  })

  it('a `@` in the path, query or fragment still parses', () => {
    expect(externalHttpsUrlSchema.safeParse('https://host.test/a@b').success).toBe(true)
    expect(externalHttpsUrlSchema.safeParse('https://host.test/jobs?ref=a@b').success).toBe(true)
    expect(externalHttpsUrlSchema.safeParse('https://host.test/jobs#a@b').success).toBe(true)
  })

  it('an ordinary posting URL with a path, a query and a fragment still parses', () => {
    expect(
      externalHttpsUrlSchema.safeParse('https://jobs.dou.ua/companies/acme/vacancies/1?kept=1#top')
        .success,
    ).toBe(true)
    // What `canonicalizePostingUrl` produces: lowercased host, kept params, no
    // trailing slash. Tightening the authority must not refuse its output.
    expect(externalHttpsUrlSchema.safeParse('https://host.test/path?kept=params').success).toBe(
      true,
    )
    expect(externalHttpsUrlSchema.safeParse('https://host.test').success).toBe(true)
  })

  it('an empty or whitespace authority is refused, as the column refuses it', () => {
    expect(externalHttpsUrlSchema.safeParse('https://').success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('https:// x').success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('https:///path').success).toBe(false)
  })

  it('whitespace in the path is refused, which `.url()` alone permits', () => {
    // `.url()` accepts `https://host.test/a b` — WHATWG percent-encodes the
    // space — so the `\\S*` in the tail of the pattern is what refuses it, as
    // the column's `[^[:space:]]*` does.
    expect(externalHttpsUrlSchema.safeParse('https://host.test/a b').success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('https://host.test/a%20b').success).toBe(true)
  })

  it('the scheme check still blocks javascript: and data:', () => {
    expect(externalHttpsUrlSchema.safeParse('javascript:alert(1)').success).toBe(false)
    expect(
      externalHttpsUrlSchema.safeParse('data:text/html,<script>alert(1)</script>').success,
    ).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('http://host.test/a').success).toBe(false)
  })

  it('the scheme must be at the START: an https url smuggled inside another scheme is refused', () => {
    // The `^` anchor, and `.url()` does NOT stand behind it: MEASURED, every
    // string below passes `z.string().url()` on its own, because each is a
    // structurally valid URL. Drop the anchor and the refinement starts matching
    // the https URL these carry as a PAYLOAD — a `javascript:` document reaching
    // `window.open` in our origin, which is the exact threat this field exists to
    // stop. The javascript:/data: cases above do not catch it: neither of them
    // contains an https URL, so a mutant that deleted the anchor survived them.
    expect(externalHttpsUrlSchema.safeParse('javascript:https://evil.test/a').success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('data:text/html,https://host.test/a').success).toBe(
      false,
    )
    expect(externalHttpsUrlSchema.safeParse('x\nhttps://evil.test/a').success).toBe(false)
    expect(externalHttpsUrlSchema.safeParse('nothttps://host.test/a').success).toBe(false)
  })

  it('a leading newline or space parses, and the value is normalized to the clean url', () => {
    // Not a smuggling case, and worth stating so nobody "fixes" it: `.url()` in
    // zod v4 REPLACES the value with the WHATWG-parsed href, and WHATWG strips
    // leading whitespace. So the refinement — and everything downstream — sees
    // the clean URL, never the prefixed one. MEASURED, both ways round.
    expect(externalHttpsUrlSchema.parse('\nhttps://host.test/a')).toBe('https://host.test/a')
    expect(externalHttpsUrlSchema.parse(' https://host.test/a')).toBe('https://host.test/a')
  })

  it('the refusal names the rule, so the message is part of the contract', () => {
    const refused = externalHttpsUrlSchema.safeParse(CREDS)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).toBe(
      'URL must be https, with a host and no embedded credentials',
    )
  })

  it('the 2048 cap holds at the bound and one past it', () => {
    const head = 'https://host.test/'
    const at = head + 'a'.repeat(2048 - head.length)
    expect(at).toHaveLength(2048)
    expect(externalHttpsUrlSchema.safeParse(at).success).toBe(true)
    expect(externalHttpsUrlSchema.safeParse(at + 'a').success).toBe(false)
  })

  it('every field built on it refuses a credentialed url: posting, queue item, also-seen-on', () => {
    const posting = {
      id: UUID,
      sourceType: 'DOU_RSS',
      externalId: 'https://jobs.dou.ua/x/1',
      url: 'https://jobs.dou.ua/x/1',
      title: 't',
      companyName: 'c',
      location: null,
      descriptionMd: '',
      publishedAt: null,
      collectedAt: NOW,
    }
    expect(jobPostingSchema.safeParse(posting).success).toBe(true)
    expect(jobPostingSchema.safeParse({ ...posting, url: CREDS }).success).toBe(false)
    expect(jobPostingSchema.safeParse({ ...posting, url: BARE_USER }).success).toBe(false)

    const row = {
      id: UUID,
      sourceType: 'REMOTEOK_API',
      url: 'https://x.test/a',
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
      queueStatus: 'NEW',
      takenByName: null,
      takenAt: null,
    }
    expect(jobQueueItemSchema.safeParse(row).success).toBe(true)
    expect(jobQueueItemSchema.safeParse({ ...row, url: CREDS }).success).toBe(false)
    expect(jobQueueItemSchema.safeParse({ ...row, url: BARE_USER }).success).toBe(false)
    expect(
      jobQueueItemSchema.safeParse({
        ...row,
        alsoSeenOn: [{ source: 'DJINNI_RSS', url: CREDS }],
      }).success,
    ).toBe(false)
    expect(
      jobQueueItemSchema.safeParse({
        ...row,
        alsoSeenOn: [{ source: 'DJINNI_RSS', url: BARE_USER }],
      }).success,
    ).toBe(false)
    expect(
      jobQueueItemSchema.safeParse({
        ...row,
        alsoSeenOn: [{ source: 'DJINNI_RSS', url: 'https://djinni.co/j/1@2' }],
      }).success,
    ).toBe(true)
  })
})
