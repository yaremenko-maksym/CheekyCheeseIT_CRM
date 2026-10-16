import { describe, expect, it } from 'vitest'
import {
  jobAccountKeySchema,
  jobAccountMeterSchema,
  jobCollectionAttemptSchema,
  jobCollectionCycleSchema,
  jobCollectionCycleStatusSchema,
  jobCollectionTriggerSchema,
  jobCollectionResultSchema,
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
 */

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
  it.each(['jsearch:rapidapi-main', 'openrouter:studio', 'a', 'dou.rss_1'])('accepts %s', (key) => {
    expect(jobAccountKeySchema.parse(key)).toBe(key)
  })

  it.each([
    ['Bearer ABC', 'uppercase and a space'],
    ['aGVsbG8+d29ybGQ=', 'base64'],
    ['https://user:pass@api.example.com', 'a URL'],
    ['a'.repeat(101), 'over the 100-char bound'],
    ['', 'empty'],
    [' leading', 'leading whitespace'],
    ['-leading-dash', 'a leading separator'],
  ])('refuses %s (%s)', (key) => {
    expect(jobAccountKeySchema.safeParse(key).success).toBe(false)
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

  it('accepts a meter inside its limit', () => {
    expect(jobAccountMeterSchema.parse(meter).used).toBe(100)
  })

  it('counts reserved and uncertain against the limit, not only used', () => {
    // 190 used + 10 reserved + 5 uncertain = 205 > 200, even though `used`
    // alone is under. Spending what is already held is the bug this prevents.
    const over = jobAccountMeterSchema.safeParse({ ...meter, used: 190 })
    expect(over.success).toBe(false)
  })

  it('lets an unlimited meter (null limit) hold any amount', () => {
    expect(
      jobAccountMeterSchema.safeParse({ ...meter, limit: null, used: 10_000_000 }).success,
    ).toBe(true)
  })

  it('refuses a LIFETIME meter that resets or carries a window start', () => {
    expect(
      jobAccountMeterSchema.safeParse({ ...meter, window: 'LIFETIME', windowStartedAt: null })
        .success,
    ).toBe(false)
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
    expect(jobAccountMeterSchema.safeParse({ ...meter, reserved: -1 }).success).toBe(false)
    expect(jobAccountMeterSchema.safeParse({ ...meter, policyVersion: 0 }).success).toBe(false)
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
    expect(jobMeterReservationSchema.safeParse({ ...reservation, cycleId: null }).success).toBe(
      false,
    )
  })

  it('refuses used cost above the reserved amount', () => {
    expect(
      jobMeterReservationSchema.safeParse({
        ...reservation,
        status: 'USED',
        sentAt: NOW,
        settledAt: NOW,
        usedAmount: 6,
      }).success,
    ).toBe(false)
  })

  it('releases only provably unsent cost', () => {
    expect(
      jobMeterReservationSchema.safeParse({
        ...reservation,
        status: 'RELEASED',
        usedAmount: 3,
      }).success,
    ).toBe(false)
    expect(
      jobMeterReservationSchema.safeParse({ ...reservation, status: 'RELEASED' }).success,
    ).toBe(true)
  })

  it.each(['SENT', 'USED', 'UNCERTAIN'] as const)('requires a send instant for %s', (status) => {
    expect(jobMeterReservationSchema.safeParse({ ...reservation, status }).success).toBe(false)
    expect(
      jobMeterReservationSchema.safeParse({ ...reservation, status, sentAt: NOW }).success,
    ).toBe(true)
  })

  it('refuses a zero-cost reservation', () => {
    expect(jobMeterReservationSchema.safeParse({ ...reservation, amount: 0 }).success).toBe(false)
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
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, trigger: 'MANUAL' }).success).toBe(false)
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, trigger: 'MANUAL', requestedBy: UUID2 })
        .success,
    ).toBe(true)
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, requestedBy: UUID2 }).success).toBe(false)
  })

  it('pairs CLOSED with its closing instant, in both directions', () => {
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, status: 'CLOSED' }).success).toBe(false)
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, closedAt: NOW }).success).toBe(false)
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, status: 'CLOSED', closedAt: NOW }).success,
    ).toBe(true)
  })

  it('refuses a blank trigger key and a non-positive reservation', () => {
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, triggerKey: '' }).success).toBe(false)
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, htmlCallReservation: 0 }).success).toBe(
      false,
    )
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

  it('accepts a running attempt that is owned under a lease', () => {
    expect(jobCollectionAttemptSchema.parse(running).ownerToken).toBe('worker-1')
  })

  it('refuses a running attempt with no owner or no lease', () => {
    expect(jobCollectionAttemptSchema.safeParse({ ...running, ownerToken: null }).success).toBe(
      false,
    )
    expect(jobCollectionAttemptSchema.safeParse({ ...running, leaseExpiresAt: null }).success).toBe(
      false,
    )
  })

  it('pairs a terminal outcome with an end instant, in both directions', () => {
    expect(jobCollectionAttemptSchema.safeParse({ ...running, outcome: 'SUCCEEDED' }).success).toBe(
      false,
    )
    expect(jobCollectionAttemptSchema.safeParse({ ...running, endedAt: NOW }).success).toBe(false)
    expect(
      jobCollectionAttemptSchema.safeParse({ ...running, outcome: 'SUCCEEDED', endedAt: NOW })
        .success,
    ).toBe(true)
  })

  it('refuses an error message long enough to be a raw upstream body', () => {
    expect(
      jobCollectionAttemptSchema.safeParse({
        ...running,
        outcome: 'FAILED',
        endedAt: NOW,
        errorCode: 'HTTP_403',
        errorMessage: 'x'.repeat(501),
      }).success,
    ).toBe(false)
  })

  it('refuses a non-positive fencing epoch or config version', () => {
    expect(jobCollectionAttemptSchema.safeParse({ ...running, fencingEpoch: 0 }).success).toBe(
      false,
    )
    expect(jobCollectionAttemptSchema.safeParse({ ...running, configVersion: 0 }).success).toBe(
      false,
    )
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

  it('requires a stated reason before a source may be BLOCKED', () => {
    expect(jobSourceHealthSchema.safeParse({ ...health, readiness: 'BLOCKED' }).success).toBe(false)
    expect(
      jobSourceHealthSchema.safeParse({
        ...health,
        readiness: 'BLOCKED',
        readinessReason: 'no API key configured',
      }).success,
    ).toBe(true)
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

  it('refuses a negative failure count and an unbounded last error', () => {
    expect(jobSourceHealthSchema.safeParse({ ...health, consecutiveFailures: -1 }).success).toBe(
      false,
    )
    expect(
      jobSourceHealthSchema.safeParse({ ...health, lastErrorMessage: 'x'.repeat(501) }).success,
    ).toBe(false)
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

  it('accepts a freshly enqueued pending item', () => {
    expect(jobDirtyWorkItemSchema.parse(item).status).toBe('PENDING')
  })

  it('pairs CLAIMED with an owner and a lease, and only CLAIMED', () => {
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, status: 'CLAIMED' }).success).toBe(false)
    expect(
      jobDirtyWorkItemSchema.safeParse({ ...item, claimOwner: 'w1', leaseExpiresAt: NOW }).success,
    ).toBe(false)
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

  it.each(['DONE', 'FAILED', 'DEFERRED'] as const)(
    'treats %s as terminal: it carries a completion instant',
    (status) => {
      expect(jobDirtyWorkItemSchema.safeParse({ ...item, status }).success).toBe(false)
      expect(jobDirtyWorkItemSchema.safeParse({ ...item, status, completedAt: NOW }).success).toBe(
        true,
      )
    },
  )

  it('refuses a completion instant on work that is still pending', () => {
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, completedAt: NOW }).success).toBe(false)
  })

  it('refuses a non-positive target version, a blank reason and a negative retry count', () => {
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, targetVersion: 0 }).success).toBe(false)
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, reason: '' }).success).toBe(false)
    expect(jobDirtyWorkItemSchema.safeParse({ ...item, retryCount: -1 }).success).toBe(false)
  })
})
