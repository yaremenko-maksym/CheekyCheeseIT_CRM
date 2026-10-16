/*
 * `failsWith` and `refusedAt` below ARE the assertions of this file — they call
 * `expect` internally. Teach the rule about them rather than disabling it, so a
 * test that genuinely asserts nothing is still caught.
 */
/* eslint vitest/expect-expect: ["error", { assertFunctionNames: ["expect", "failsWith", "refusedAt"] }] */
import { describe, expect, it } from 'vitest'
import {
  jobAccountKeySchema,
  jobAccountMeterSchema,
  jobCollectionAttemptSchema,
  jobCollectionCycleSchema,
  jobCollectionCycleStatusSchema,
  jobCollectionResultSchema,
  jobCollectionTriggerSchema,
  jobDirtyWorkEntityKindSchema,
  jobDirtyWorkItemSchema,
  jobDirtyWorkStatusSchema,
  jobMeterReservationSchema,
  jobMeterReservationStatusSchema,
  jobMeterUnitSchema,
  jobMeterWindowSchema,
  jobSourceAdminStateSchema,
  jobSourceBudgetWindowSchema,
  jobSourceHealthSchema,
  jobSourceReadinessSchema,
  jobSourceSchema,
} from './job-sourcing'

/**
 * r5 Task 1.1 / 1.2 (part 2) — the metering, cycle and attempt contracts.
 *
 * Every cross-field rule here is also a database CHECK (proven against a real
 * catalog in `apps/api/src/database/job-collection.integration.spec.ts`). The
 * duplication is the point: a row the database accepted must serialize, and a
 * DTO the wire accepted must store.
 *
 * ASSERTION STYLE — read before adding a case. A refusal is asserted by its
 * **issue path and message**, never by `success === false` alone. The reason is
 * concrete: `safeParse(...).success === false` is satisfied by *any* failure, so
 * it cannot tell "refused for the stated reason" from "refused because the
 * fixture was malformed" — and it leaves the whole `addIssue` payload
 * unobserved. The mutation gate caught exactly that on the first draft of this
 * file (73 surviving mutants: emptied issue objects, blanked messages, erased
 * paths, and `.max(n)` flipped to `.min(n)`, all invisible to a bare
 * success check). `failsWith` is what closes it.
 */

/**
 * The slice of a zod result these helpers read. Declared structurally rather
 * than imported: zod v4 dropped the `SafeParseReturnType` alias, and a local
 * shape keeps the helpers working across that rename.
 */
type Issue = { path: ReadonlyArray<PropertyKey>; message: string; code: string }
type ParseResult = { success: true } | { success: false; error: { issues: ReadonlyArray<Issue> } }
type Parseable = { safeParse: (value: unknown) => ParseResult }

/** Assert the value is refused, at `path`, for the stated reason. */
function failsWith(
  schema: Parseable,
  value: unknown,
  path: ReadonlyArray<string>,
  messageFragment: string,
) {
  const result = schema.safeParse(value)
  expect(result.success, 'expected the value to be refused').toBe(false)
  if (result.success) return
  const wanted = path.join('.')
  const issue = result.error.issues.find((i) => i.path.join('.') === wanted)
  expect(
    issue,
    `no issue at path "${wanted}" — got ${JSON.stringify(
      result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    )}`,
  ).toBeDefined()
  expect(issue?.code).toBe('custom')
  expect(issue?.message).toContain(messageFragment)
}

/** Assert the value is refused at `path` by a built-in (non-custom) rule. */
function refusedAt(schema: Parseable, value: unknown, path: ReadonlyArray<string>) {
  const result = schema.safeParse(value)
  expect(result.success, 'expected the value to be refused').toBe(false)
  if (result.success) return
  const wanted = path.join('.')
  expect(
    result.error.issues.map((i) => i.path.join('.')),
    `expected an issue at "${wanted}"`,
  ).toContain(wanted)
}

const UUID = '11111111-2222-4333-8444-555555555555'
const UUID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const NOW = '2026-10-16T12:00:00.000Z'

describe('enum members and order (mirrored by the pg enums)', () => {
  it.each([
    [jobCollectionTriggerSchema, ['SCHEDULED', 'MANUAL']],
    [jobCollectionCycleStatusSchema, ['OPEN', 'CLOSED']],
    [jobSourceReadinessSchema, ['CANDIDATE', 'VERIFIED', 'BLOCKED']],
    [jobSourceAdminStateSchema, ['ACTIVE', 'PAUSED', 'RETIRED']],
    [jobMeterUnitSchema, ['REQUEST', 'RECORD', 'MODEL_CALL', 'USD_MICROS']],
    [jobMeterWindowSchema, ['DAY', 'MONTH', 'LIFETIME']],
    [jobMeterReservationStatusSchema, ['RESERVED', 'SENT', 'USED', 'RELEASED', 'UNCERTAIN']],
    [
      jobDirtyWorkEntityKindSchema,
      ['SOURCE_RECORD', 'OPPORTUNITY', 'SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'],
    ],
    [jobDirtyWorkStatusSchema, ['PENDING', 'CLAIMED', 'DONE', 'FAILED', 'DEFERRED']],
  ])('%#', (schema, members) => {
    expect([...schema.options]).toEqual(members)
  })

  it('leaves the legacy per-window budget enum at DAY | MONTH', () => {
    // The legacy budget is the DOU path (r5 A1h) and gains no LIFETIME member:
    // lifetime accounting is a property of the new meter only.
    expect([...jobSourceBudgetWindowSchema.options]).toEqual(['DAY', 'MONTH'])
    expect(jobSourceBudgetWindowSchema.safeParse('LIFETIME').success).toBe(false)
  })
})

describe('legacy DTOs are untouched (C-01)', () => {
  it('keeps jobCollectionResultSchema.merged / .filtered defaulting to 0', () => {
    // The legacy shape, verbatim: `merged` and `filtered` are the only
    // optional fields, and they keep defaulting to 0 with their old meaning.
    const parsed = jobCollectionResultSchema.parse({
      sourceType: 'DOU_RSS',
      fetched: 10,
      created: 2,
      duplicates: 7,
      invalid: 1,
      suggestionsCreated: 4,
    })
    expect(parsed.merged).toBe(0)
    expect(parsed.filtered).toBe(0)
    // ... and still carry an explicit value when one is given.
    expect(
      jobCollectionResultSchema.parse({
        sourceType: 'DOU_RSS',
        fetched: 10,
        created: 2,
        duplicates: 7,
        invalid: 1,
        suggestionsCreated: 4,
        merged: 3,
        filtered: 5,
      }),
    ).toMatchObject({ merged: 3, filtered: 5 })
  })

  it('keeps jobSourceSchema parsing exactly as before, with no new required field', () => {
    const parsed = jobSourceSchema.parse({
      id: UUID,
      type: 'DOU_RSS',
      enabled: true,
      triggerMode: 'SCHEDULED',
      lastCollectedAt: null,
      minIntervalHours: null,
      disabledReason: null,
      budget: {
        state: 'ACTIVE',
        limit: null,
        window: null,
        used: 0,
        remaining: null,
        resetsAt: null,
      },
    })
    expect(parsed.id).toBe(UUID)
    // Health is a SEPARATE schema: an existing client needs to understand
    // nothing new to keep parsing this DTO.
    expect('readiness' in parsed).toBe(false)
  })
})

describe('jobAccountKeySchema — a bounded lowercase id, never a credential', () => {
  it.each(['jsearch:rapidapi-main', 'openrouter:studio', 'a', 'dou.rss_1', 'a'.repeat(100)])(
    'accepts %s',
    (key) => {
      expect(jobAccountKeySchema.parse(key)).toBe(key)
    },
  )

  it.each([
    ['Bearer ABC', 'uppercase and a space'],
    ['aGVsbG8+d29ybGQ=', 'base64'],
    ['https://user:pass@api.example.com', 'a URL'],
    ['a'.repeat(101), 'one over the 100-char bound'],
    ['', 'empty'],
    [' leading', 'leading whitespace'],
    ['-leading-dash', 'a leading separator'],
  ])('refuses %s (%s), stating why', (key) => {
    const result = jobAccountKeySchema.safeParse(key)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain(
      'must be a short lowercase account id without secrets',
    )
  })
})

describe('jobAccountMeterSchema — the spend guard on the wire', () => {
  const meter = {
    id: UUID,
    accountKey: 'jsearch:main',
    unit: 'REQUEST' as const,
    window: 'MONTH' as const,
    limit: 200,
    used: 100,
    reserved: 10,
    uncertain: 5,
    windowStartedAt: NOW,
    resetsAt: NOW,
    policyVersion: 1,
  }

  it('accepts a meter inside its limit, and one exactly at it', () => {
    expect(jobAccountMeterSchema.parse(meter).used).toBe(100)
    expect(jobAccountMeterSchema.parse({ ...meter, used: 185 }).used).toBe(185)
  })

  it('counts reserved and uncertain against the limit, not only used', () => {
    // 190 used + 10 reserved + 5 uncertain = 205 > 200, even though `used`
    // alone is under. Spending what is already held is the bug this prevents.
    failsWith(
      jobAccountMeterSchema,
      { ...meter, used: 190 },
      ['used'],
      'used + reserved + uncertain may not exceed the limit',
    )
  })

  it('lets an unlimited meter (null limit) hold any amount', () => {
    expect(
      jobAccountMeterSchema.safeParse({ ...meter, limit: null, used: 10_000_000 }).success,
    ).toBe(true)
  })

  it('refuses a LIFETIME meter that resets OR carries a window start', () => {
    failsWith(
      jobAccountMeterSchema,
      { ...meter, window: 'LIFETIME', windowStartedAt: null },
      ['window'],
      'a LIFETIME meter never resets and has no window start',
    )
    failsWith(
      jobAccountMeterSchema,
      { ...meter, window: 'LIFETIME', resetsAt: null },
      ['window'],
      'a LIFETIME meter never resets and has no window start',
    )
    // Both absent is the only valid LIFETIME shape.
    expect(
      jobAccountMeterSchema.safeParse({
        ...meter,
        window: 'LIFETIME',
        windowStartedAt: null,
        resetsAt: null,
      }).success,
    ).toBe(true)
  })

  it('refuses a negative counter and a non-positive policy version', () => {
    refusedAt(jobAccountMeterSchema, { ...meter, reserved: -1 }, ['reserved'])
    refusedAt(jobAccountMeterSchema, { ...meter, policyVersion: 0 }, ['policyVersion'])
    refusedAt(jobAccountMeterSchema, { ...meter, limit: -1 }, ['limit'])
  })
})

describe('jobMeterReservationSchema — reserve before I/O, settle exactly once', () => {
  const reservation = {
    id: UUID,
    meterId: UUID2,
    attemptId: 'attempt-1',
    runId: UUID2,
    cycleId: UUID,
    status: 'RESERVED' as const,
    amount: 5,
    usedAmount: 0,
    reservedAt: NOW,
    sentAt: null,
    settledAt: null,
  }

  it('accepts a fresh reservation that has not been sent', () => {
    expect(jobMeterReservationSchema.parse(reservation).usedAmount).toBe(0)
  })

  it('accepts a reservation with no run (a model call is not a collection attempt)', () => {
    expect(jobMeterReservationSchema.safeParse({ ...reservation, runId: null }).success).toBe(true)
  })

  it('requires a cycle on every reservation', () => {
    refusedAt(jobMeterReservationSchema, { ...reservation, cycleId: null }, ['cycleId'])
  })

  it('refuses used cost above the reserved amount, and allows it exactly at', () => {
    failsWith(
      jobMeterReservationSchema,
      { ...reservation, status: 'USED', sentAt: NOW, settledAt: NOW, usedAmount: 6 },
      ['usedAmount'],
      'used cost may not exceed the reserved amount',
    )
    expect(
      jobMeterReservationSchema.safeParse({
        ...reservation,
        status: 'USED',
        sentAt: NOW,
        settledAt: NOW,
        usedAmount: 5,
      }).success,
    ).toBe(true)
  })

  it('releases only provably unsent cost', () => {
    failsWith(
      jobMeterReservationSchema,
      { ...reservation, status: 'RELEASED', usedAmount: 3 },
      ['usedAmount'],
      'only provably unsent cost may be released',
    )
    // A RELEASED reservation that spent nothing is fine — and needs no send
    // instant, which is why RELEASED sits beside RESERVED in the rule below.
    expect(
      jobMeterReservationSchema.safeParse({ ...reservation, status: 'RELEASED' }).success,
    ).toBe(true)
  })

  it.each(['SENT', 'USED', 'UNCERTAIN'] as const)('requires a send instant for %s', (status) => {
    failsWith(
      jobMeterReservationSchema,
      { ...reservation, status, usedAmount: status === 'USED' ? 5 : 0, settledAt: NOW },
      ['sentAt'],
      'a request that left must carry its send instant',
    )
    expect(
      jobMeterReservationSchema.safeParse({
        ...reservation,
        status,
        sentAt: NOW,
        settledAt: NOW,
        usedAmount: status === 'USED' ? 5 : 0,
      }).success,
    ).toBe(true)
  })

  it('needs no send instant while merely RESERVED', () => {
    expect(jobMeterReservationSchema.safeParse({ ...reservation, sentAt: null }).success).toBe(true)
  })

  it('refuses a zero-cost reservation', () => {
    refusedAt(jobMeterReservationSchema, { ...reservation, amount: 0 }, ['amount'])
  })
})

describe('jobCollectionCycleSchema — one occurrence, attributed correctly', () => {
  const cycle = {
    id: UUID,
    trigger: 'SCHEDULED' as const,
    triggerKey: '2026-10-16T12:00',
    requestedBy: null,
    htmlCallReservation: 20,
    status: 'OPEN' as const,
    startedAt: NOW,
    closedAt: null,
  }

  it('accepts an open scheduled cycle with the shared 20-call reservation', () => {
    expect(jobCollectionCycleSchema.parse(cycle).htmlCallReservation).toBe(20)
  })

  it('ties MANUAL to an actor and SCHEDULED to none, in both directions', () => {
    failsWith(
      jobCollectionCycleSchema,
      { ...cycle, trigger: 'MANUAL' },
      ['requestedBy'],
      'a MANUAL cycle names its actor; a SCHEDULED cycle has none',
    )
    failsWith(
      jobCollectionCycleSchema,
      { ...cycle, requestedBy: UUID2 },
      ['requestedBy'],
      'a MANUAL cycle names its actor; a SCHEDULED cycle has none',
    )
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, trigger: 'MANUAL', requestedBy: UUID2 })
        .success,
    ).toBe(true)
  })

  it('pairs CLOSED with its closing instant, in both directions', () => {
    failsWith(
      jobCollectionCycleSchema,
      { ...cycle, status: 'CLOSED' },
      ['closedAt'],
      'a CLOSED cycle carries its closing instant',
    )
    failsWith(
      jobCollectionCycleSchema,
      { ...cycle, closedAt: NOW },
      ['closedAt'],
      'a CLOSED cycle carries its closing instant',
    )
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, status: 'CLOSED', closedAt: NOW }).success,
    ).toBe(true)
  })

  it('refuses a blank trigger key and a non-positive reservation', () => {
    refusedAt(jobCollectionCycleSchema, { ...cycle, triggerKey: '' }, ['triggerKey'])
    refusedAt(jobCollectionCycleSchema, { ...cycle, htmlCallReservation: 0 }, [
      'htmlCallReservation',
    ])
  })
})

describe('jobCollectionAttemptSchema — owned while running, ended when terminal', () => {
  const running = {
    id: UUID,
    sourceId: UUID2,
    cycleId: UUID,
    attemptId: 'attempt-1',
    configVersion: 1,
    adapterVersion: 'v1',
    trigger: 'SCHEDULED' as const,
    outcome: 'STARTED' as const,
    coverage: 'PARTIAL' as const,
    ownerToken: 'worker-1',
    fencingEpoch: 1,
    leaseExpiresAt: NOW,
    startedAt: NOW,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
  }
  const failed = {
    ...running,
    outcome: 'FAILED' as const,
    endedAt: NOW,
    errorCode: 'HTTP_403',
    errorMessage: 'provider refused: forbidden',
  }

  it('accepts a running attempt that is owned under a lease', () => {
    expect(jobCollectionAttemptSchema.parse(running).ownerToken).toBe('worker-1')
  })

  it('accepts a terminal attempt carrying a short typed error code and sentence', () => {
    // A short code must PARSE — otherwise a bound of `max(100)` is
    // indistinguishable from `min(100)`.
    const parsed = jobCollectionAttemptSchema.parse(failed)
    expect(parsed.errorCode).toBe('HTTP_403')
    expect(parsed.errorMessage).toBe('provider refused: forbidden')
  })

  it('refuses a running attempt with no owner, or no lease', () => {
    failsWith(
      jobCollectionAttemptSchema,
      { ...running, ownerToken: null },
      ['ownerToken'],
      'a running attempt is owned under a lease',
    )
    failsWith(
      jobCollectionAttemptSchema,
      { ...running, leaseExpiresAt: null },
      ['ownerToken'],
      'a running attempt is owned under a lease',
    )
  })

  it('lets a TERMINAL attempt keep no lease: the rule binds running attempts only', () => {
    expect(jobCollectionAttemptSchema.safeParse({ ...failed, leaseExpiresAt: null }).success).toBe(
      true,
    )
  })

  it('pairs a terminal outcome with an end instant, in both directions', () => {
    failsWith(
      jobCollectionAttemptSchema,
      { ...running, outcome: 'SUCCEEDED' },
      ['endedAt'],
      'a terminal attempt carries its end instant; a running one does not',
    )
    failsWith(
      jobCollectionAttemptSchema,
      { ...running, endedAt: NOW },
      ['endedAt'],
      'a terminal attempt carries its end instant; a running one does not',
    )
    expect(
      jobCollectionAttemptSchema.safeParse({ ...running, outcome: 'SUCCEEDED', endedAt: NOW })
        .success,
    ).toBe(true)
  })

  it('bounds the error code and the sanitized message (no raw upstream body)', () => {
    refusedAt(jobCollectionAttemptSchema, { ...failed, errorMessage: 'x'.repeat(501) }, [
      'errorMessage',
    ])
    refusedAt(jobCollectionAttemptSchema, { ...failed, errorCode: 'c'.repeat(101) }, ['errorCode'])
    // Exactly at the bound still parses.
    expect(
      jobCollectionAttemptSchema.safeParse({ ...failed, errorMessage: 'x'.repeat(500) }).success,
    ).toBe(true)
  })

  it('refuses a non-positive fencing epoch or config version', () => {
    refusedAt(jobCollectionAttemptSchema, { ...running, fencingEpoch: 0 }, ['fencingEpoch'])
    refusedAt(jobCollectionAttemptSchema, { ...running, configVersion: 0 }, ['configVersion'])
  })
})

describe('jobSourceHealthSchema — disabled, paused and readiness-blocked are separate', () => {
  const health = {
    sourceId: UUID,
    manifestId: null,
    namespace: '',
    manifestVersion: 1,
    policyVersion: 1,
    configVersion: 1,
    readiness: 'CANDIDATE' as const,
    readinessReason: null,
    adminState: 'ACTIVE' as const,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastNonemptyAt: null,
    nextAttemptAt: null,
    cooldownUntil: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
  }

  it('accepts a seeded candidate with no manifest identity yet (C-16)', () => {
    expect(jobSourceHealthSchema.parse(health).manifestId).toBeNull()
  })

  it('carries a claimed manifest identity once Task 3.7 backfills one, bounded', () => {
    // The nullable field needs a NON-null case too: with only `null` exercised,
    // `max(100)` is indistinguishable from `min(100)`.
    expect(jobSourceHealthSchema.parse({ ...health, manifestId: 'remoteok.v1' }).manifestId).toBe(
      'remoteok.v1',
    )
    refusedAt(jobSourceHealthSchema, { ...health, manifestId: 'm'.repeat(101) }, ['manifestId'])
    expect(
      jobSourceHealthSchema.safeParse({ ...health, manifestId: 'm'.repeat(100) }).success,
    ).toBe(true)
  })

  it('requires a stated reason before a source may be BLOCKED', () => {
    failsWith(
      jobSourceHealthSchema,
      { ...health, readiness: 'BLOCKED' },
      ['readinessReason'],
      'a BLOCKED source states why',
    )
    expect(
      jobSourceHealthSchema.safeParse({
        ...health,
        readiness: 'BLOCKED',
        readinessReason: 'no API key configured',
      }).success,
    ).toBe(true)
  })

  it('leaves a non-BLOCKED source free to carry no reason', () => {
    expect(jobSourceHealthSchema.safeParse({ ...health, readiness: 'VERIFIED' }).success).toBe(true)
  })

  it('reports succeeding-but-empty apart from succeeding at all', () => {
    // A SUCCEEDED attempt may carry zero items, so these two instants differ —
    // and "succeeding and finding nothing for a week" is visible only here.
    const parsed = jobSourceHealthSchema.parse({
      ...health,
      lastSuccessAt: NOW,
      lastNonemptyAt: null,
    })
    expect(parsed.lastSuccessAt).toBe(NOW)
    expect(parsed.lastNonemptyAt).toBeNull()
  })

  it('accepts a short typed last error and bounds the message', () => {
    const parsed = jobSourceHealthSchema.parse({
      ...health,
      lastErrorCode: 'HTTP_429',
      lastErrorMessage: 'rate limited',
    })
    expect(parsed.lastErrorCode).toBe('HTTP_429')
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorMessage: 'x'.repeat(501) }, [
      'lastErrorMessage',
    ])
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: 'c'.repeat(101) }, [
      'lastErrorCode',
    ])
  })

  it('refuses a negative failure count and a non-positive version', () => {
    refusedAt(jobSourceHealthSchema, { ...health, consecutiveFailures: -1 }, [
      'consecutiveFailures',
    ])
    refusedAt(jobSourceHealthSchema, { ...health, configVersion: 0 }, ['configVersion'])
  })
})

describe('jobDirtyWorkItemSchema — claimed under a lease, terminal when finished', () => {
  const item = {
    id: UUID,
    entityKind: 'OPPORTUNITY' as const,
    entityId: UUID2,
    targetVersion: 3,
    reason: 'revision',
    status: 'PENDING' as const,
    claimOwner: null,
    claimedAt: null,
    leaseExpiresAt: null,
    fencingEpoch: 1,
    retryCount: 0,
    cycleId: null,
    lastErrorCode: null,
    createdAt: NOW,
    completedAt: null,
  }
  const CLAIM_RULE = 'a CLAIMED item is owned under a lease, and only a CLAIMED item is'

  it('accepts a freshly enqueued pending item', () => {
    expect(jobDirtyWorkItemSchema.parse(item).status).toBe('PENDING')
  })

  it('needs BOTH an owner and a lease to be CLAIMED — one alone is not enough', () => {
    failsWith(jobDirtyWorkItemSchema, { ...item, status: 'CLAIMED' }, ['claimOwner'], CLAIM_RULE)
    failsWith(
      jobDirtyWorkItemSchema,
      { ...item, status: 'CLAIMED', claimOwner: 'w1', claimedAt: NOW },
      ['claimOwner'],
      CLAIM_RULE,
    )
    failsWith(
      jobDirtyWorkItemSchema,
      { ...item, status: 'CLAIMED', leaseExpiresAt: NOW },
      ['claimOwner'],
      CLAIM_RULE,
    )
    expect(
      jobDirtyWorkItemSchema.safeParse({
        ...item,
        status: 'CLAIMED',
        claimOwner: 'w1',
        claimedAt: NOW,
        leaseExpiresAt: NOW,
      }).success,
    ).toBe(true)
  })

  it('refuses an owner or a lease left behind on work that is not CLAIMED', () => {
    failsWith(
      jobDirtyWorkItemSchema,
      { ...item, claimOwner: 'w1', leaseExpiresAt: NOW },
      ['claimOwner'],
      CLAIM_RULE,
    )
    // A half-released item (owner cleared, lease left, or vice versa) stays
    // refused too — that asymmetry is how a stale lease comes back.
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, claimOwner: 'w1' }).success).toBe(true)
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, leaseExpiresAt: NOW }).success).toBe(true)
  })

  it.each(['DONE', 'FAILED', 'DEFERRED'] as const)(
    'treats %s as terminal: it carries a completion instant',
    (status) => {
      failsWith(
        jobDirtyWorkItemSchema,
        { ...item, status },
        ['completedAt'],
        'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
      )
      expect(jobDirtyWorkItemSchema.safeParse({ ...item, status, completedAt: NOW }).success).toBe(
        true,
      )
    },
  )

  it('refuses a completion instant on work that is still pending', () => {
    failsWith(
      jobDirtyWorkItemSchema,
      { ...item, completedAt: NOW },
      ['completedAt'],
      'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
    )
  })

  it('accepts a short typed last error code', () => {
    expect(
      jobDirtyWorkItemSchema.parse({ ...item, lastErrorCode: 'VERSION_STALE' }).lastErrorCode,
    ).toBe('VERSION_STALE')
    refusedAt(jobDirtyWorkItemSchema, { ...item, lastErrorCode: 'c'.repeat(101) }, [
      'lastErrorCode',
    ])
  })

  it('refuses a non-positive target version, a blank or oversized reason, a negative retry', () => {
    refusedAt(jobDirtyWorkItemSchema, { ...item, targetVersion: 0 }, ['targetVersion'])
    refusedAt(jobDirtyWorkItemSchema, { ...item, reason: '' }, ['reason'])
    refusedAt(jobDirtyWorkItemSchema, { ...item, reason: 'r'.repeat(101) }, ['reason'])
    refusedAt(jobDirtyWorkItemSchema, { ...item, retryCount: -1 }, ['retryCount'])
    refusedAt(jobDirtyWorkItemSchema, { ...item, fencingEpoch: 0 }, ['fencingEpoch'])
  })
})
