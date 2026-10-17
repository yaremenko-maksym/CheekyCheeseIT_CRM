/*
 * `expectOnlyIssue` and `refusedAt` below ARE the assertions of this file — they
 * call `expect` internally. Teach the rule about them rather than disabling it,
 * so a test that genuinely asserts nothing is still caught.
 */
/* eslint vitest/expect-expect: ["error", { assertFunctionNames: ["expect", "expectOnlyIssue", "refusedAt"] }] */
import { describe, expect, it } from 'vitest'
import {
  jobAccountKeySchema,
  jobAccountMeterSchema,
  jobCollectionAttemptSchema,
  jobCollectionAttemptWorkerSchema,
  jobCollectionCycleSchema,
  jobCollectionCycleStatusSchema,
  jobCollectionReportSchema,
  jobCollectionResultSchema,
  jobCollectionTriggerSchema,
  jobDirtyWorkEntityKindSchema,
  jobDirtyWorkItemSchema,
  jobDirtyWorkItemWorkerSchema,
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
 * **exact issue list** (code + message + path), never by `success === false`
 * alone. The reason is concrete: `safeParse(...).success === false` is satisfied
 * by *any* failure, so it cannot tell "refused for the stated reason" from
 * "refused because the fixture was malformed" — and it leaves the whole
 * `addIssue` payload unobserved. The mutation gate caught exactly that on the
 * first draft of this file: 73 surviving mutants — emptied issue objects,
 * blanked messages, erased paths, a wrong code, and `.max(n)` flipped to
 * `.min(n)` — every one invisible to a bare success check.
 *
 * Each cross-field invariant therefore gets three things:
 *   1. the exact `{code, message, path}` it produces when it fires;
 *   2. a PASSING counter-case proving it does not fire when it should not
 *      (without which `ConditionalExpression → true` survives);
 *   3. both operands of every `&&` exercised separately (without which the
 *      operator is indistinguishable from `||`).
 * And every bounded string gets its boundary from both sides, including a
 * 1-character value for `.min(1)` — otherwise `.min(1)` and `.min(100)` are
 * the same schema as far as the suite can tell.
 */

// ---------------------------------------------------------------------------
// Mutation-gate coverage: exact messages / paths / codes / boundaries.
// ---------------------------------------------------------------------------

/**
 * Same helper, same shape as `job-sourcing-store.spec.ts` (part 1) — one idiom
 * for this domain, not two. Asserting the WHOLE issue list with `toEqual`
 * (code + message + path) is what makes an emptied `addIssue({})`, a blanked
 * message, an erased path and a wrong code each fail.
 */
const issuesOf = (r: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (r.error?.issues ?? []).map((i) => {
    const { code, message, path } = i as { code: string; message: string; path: unknown[] }
    return { code, message, path }
  })

type Parseable = {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: readonly unknown[] } }
}

/** The one custom issue a cross-field invariant must produce — and nothing else. */
function expectOnlyIssue(
  schema: Parseable,
  value: unknown,
  message: string,
  path: ReadonlyArray<string>,
) {
  expect(issuesOf(schema.safeParse(value))).toEqual([{ code: 'custom', message, path: [...path] }])
}

/** Assert the value is refused at `path` by a built-in (non-custom) rule. */
function refusedAt(schema: Parseable, value: unknown, path: ReadonlyArray<string>) {
  const result = schema.safeParse(value)
  expect(result.success, 'expected the value to be refused').toBe(false)
  expect(issuesOf(result).map((i) => i.path.join('.'))).toContain(path.join('.'))
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
  it.each([
    'jsearch:rapidapi-main',
    'openrouter:studio',
    'a',
    'dou.rss_1',
    // Exactly 100 characters, the inclusive bound — and SEGMENTED, because an
    // unbroken run of 24+ is refused (SR-M-1). 4 x 'abcdefghijklmnopqrstuvw.'
    // = 96 + 'abcd' = 100.
    `${'abcdefghijklmnopqrstuvw.'.repeat(4)}abcd`,
    // 23 unbroken characters: one under the refusal, so the bound is observed
    // from the accepting side too.
    'a'.repeat(23),
  ])('accepts %s', (key) => {
    expect(jobAccountKeySchema.parse(key)).toBe(key)
  })

  it.each([
    ['0123456789abcdef01234567', 'a pasted raw hex key — 24 unbroken characters'],
    ['sk.live.0123456789abcdef01234567', 'a segmented prefix with a pasted key after it'],
    ['a'.repeat(24), 'the refusal boundary itself'],
  ])('refuses %s (%s) — an identity is segmented, a key is not', (key) => {
    const result = jobAccountKeySchema.safeParse(key)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((i) => i.message)).toContain(
      'must be segmented: a run of 24 or more characters without a separator is a pasted key',
    )
  })

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

describe('worker-internal fields cannot reach a non-worker response (SR-M-4)', () => {
  // `ownerToken`, `fencingEpoch` and `claimOwner` are lease-and-fencing
  // bookkeeping: they say WHO holds a row and with what authority, which is a
  // worker's business and nobody else's. No endpoint consumes them yet, so the
  // fix is structural — the public shape does not HAVE the fields, so a
  // response built from it cannot leak them by accident later.
  const attempt = {
    id: UUID,
    sourceId: UUID2,
    cycleId: UUID2,
    attemptId: 'attempt-1',
    configVersion: 1,
    adapterVersion: 'v1',
    trigger: 'SCHEDULED' as const,
    outcome: 'SUCCEEDED' as const,
    coverage: 'WINDOW' as const,
    ownerToken: 'secret-owner-token',
    fencingEpoch: 7,
    leaseExpiresAt: null,
    startedAt: NOW,
    endedAt: NOW,
    errorCode: null,
    errorMessage: null,
  }

  const item = {
    id: UUID,
    entityKind: 'OPPORTUNITY' as const,
    entityId: UUID2,
    targetVersion: 3,
    reason: 'revision',
    status: 'CLAIMED' as const,
    claimOwner: 'worker-42',
    claimedAt: NOW,
    leaseExpiresAt: NOW,
    fencingEpoch: 2,
    retryCount: 0,
    cycleId: null,
    lastErrorCode: null,
    createdAt: NOW,
    completedAt: null,
  }

  it('strips the attempt owner token and fencing epoch from the public shape', () => {
    const parsed = jobCollectionAttemptSchema.parse(attempt)
    expect(Object.keys(parsed)).not.toContain('ownerToken')
    expect(Object.keys(parsed)).not.toContain('fencingEpoch')
    // Everything an operator may rightly see survives.
    expect(parsed.outcome).toBe('SUCCEEDED')
    expect(parsed.attemptId).toBe('attempt-1')
    expect(parsed.leaseExpiresAt).toBeNull()
  })

  it('strips the dirty-work claim owner and fencing epoch from the public shape', () => {
    const parsed = jobDirtyWorkItemSchema.parse(item)
    expect(Object.keys(parsed)).not.toContain('claimOwner')
    expect(Object.keys(parsed)).not.toContain('fencingEpoch')
    expect(parsed.status).toBe('CLAIMED')
    expect(parsed.reason).toBe('revision')
  })

  it('keeps the worker shape carrying them, because the worker needs them', () => {
    expect(jobCollectionAttemptWorkerSchema.parse(attempt).ownerToken).toBe('secret-owner-token')
    expect(jobDirtyWorkItemWorkerSchema.parse(item).claimOwner).toBe('worker-42')
  })

  it('still enforces the invariants that survive the omission', () => {
    expectOnlyIssue(
      jobCollectionAttemptSchema,
      { ...attempt, endedAt: null },
      'a terminal attempt carries its end instant; a running one does not',
      ['endedAt'],
    )
    expectOnlyIssue(
      jobDirtyWorkItemSchema,
      { ...item, status: 'DONE' },
      'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
      ['completedAt'],
    )
  })
})

describe('numeric ceilings agree with the columns that store them (CR-M-2)', () => {
  // A PostgreSQL `integer` tops out at 2_147_483_647; the meter and reservation
  // counters are `bigint`, and JSON carries integers exactly only up to
  // Number.MAX_SAFE_INTEGER, which is therefore the contract's ceiling.
  const PG_INT_MAX = 2_147_483_647
  const JSON_INT_MAX = Number.MAX_SAFE_INTEGER

  const meter = {
    id: UUID,
    accountKey: 'jsearch:main',
    unit: 'USD_MICROS' as const,
    window: 'LIFETIME' as const,
    limit: null,
    used: 0,
    reserved: 0,
    uncertain: 0,
    windowStartedAt: null,
    resetsAt: null,
    policyVersion: 1,
  }

  it('lets a USD_MICROS meter hold far more than an integer column could (the ceiling CR-M-2 raised)', () => {
    // 2_147_483_648 micros is USD 2,147.48 — the point where the old `integer`
    // column raised 22003 on a value the contract had accepted.
    expect(jobAccountMeterSchema.parse({ ...meter, used: PG_INT_MAX + 1 }).used).toBe(
      PG_INT_MAX + 1,
    )
    expect(jobAccountMeterSchema.parse({ ...meter, used: JSON_INT_MAX }).used).toBe(JSON_INT_MAX)
  })

  it('needs no explicit ceiling on the bigint-backed counters: `.int()` already caps them', () => {
    // Zod v4's `.int()` refuses anything past Number.MAX_SAFE_INTEGER, which
    // is three orders of magnitude inside a bigint column. So widening the
    // columns — not narrowing the contract — is what made the two agree.
    expect(jobAccountMeterSchema.parse({ ...meter, used: JSON_INT_MAX }).used).toBe(JSON_INT_MAX)
    refusedAt(jobAccountMeterSchema, { ...meter, used: JSON_INT_MAX + 2 }, ['used'])
    refusedAt(jobAccountMeterSchema, { ...meter, limit: JSON_INT_MAX + 2 }, ['limit'])
  })

  it('keeps the reservation amounts inside the same bigint ceiling', () => {
    const reservation = {
      id: UUID,
      meterId: UUID2,
      attemptId: 'attempt-1',
      runId: null,
      cycleId: UUID2,
      status: 'RESERVED' as const,
      amount: JSON_INT_MAX,
      usedAmount: 0,
      reservedAt: NOW,
      sentAt: null,
      settledAt: null,
    }
    expect(jobMeterReservationSchema.parse(reservation).amount).toBe(JSON_INT_MAX)
    refusedAt(jobMeterReservationSchema, { ...reservation, amount: JSON_INT_MAX + 2 }, ['amount'])
  })

  it('caps the counters that stay in an INTEGER column at that column ceiling', () => {
    const cycle = {
      id: UUID,
      trigger: 'SCHEDULED' as const,
      triggerKey: 'slot-1',
      requestedBy: null,
      htmlCallReservation: PG_INT_MAX,
      status: 'OPEN' as const,
      startedAt: NOW,
      closedAt: null,
    }
    expect(jobCollectionCycleSchema.parse(cycle).htmlCallReservation).toBe(PG_INT_MAX)
    refusedAt(jobCollectionCycleSchema, { ...cycle, htmlCallReservation: PG_INT_MAX + 1 }, [
      'htmlCallReservation',
    ])
  })

  it('caps the attempt and health version counters at the same column ceiling', () => {
    const attempt = {
      id: UUID,
      sourceId: UUID2,
      cycleId: UUID2,
      attemptId: 'attempt-1',
      configVersion: PG_INT_MAX,
      adapterVersion: 'v1',
      trigger: 'SCHEDULED' as const,
      outcome: 'SUCCEEDED' as const,
      coverage: 'WINDOW' as const,
      ownerToken: null,
      fencingEpoch: 1,
      leaseExpiresAt: null,
      startedAt: NOW,
      endedAt: NOW,
      errorCode: null,
      errorMessage: null,
    }
    expect(jobCollectionAttemptWorkerSchema.parse(attempt).configVersion).toBe(PG_INT_MAX)
    refusedAt(jobCollectionAttemptWorkerSchema, { ...attempt, configVersion: PG_INT_MAX + 1 }, [
      'configVersion',
    ])

    const health = {
      sourceId: UUID,
      manifestId: null,
      namespace: '',
      manifestVersion: PG_INT_MAX,
      policyVersion: PG_INT_MAX,
      configVersion: PG_INT_MAX,
      readiness: 'CANDIDATE' as const,
      readinessReason: null,
      adminState: 'ACTIVE' as const,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastNonemptyAt: null,
      nextAttemptAt: null,
      cooldownUntil: null,
      consecutiveFailures: PG_INT_MAX,
      lastErrorCode: null,
      lastErrorMessage: null,
    }
    expect(jobSourceHealthSchema.parse(health).manifestVersion).toBe(PG_INT_MAX)
    for (const field of [
      'manifestVersion',
      'policyVersion',
      'configVersion',
      'consecutiveFailures',
    ] as const) {
      refusedAt(jobSourceHealthSchema, { ...health, [field]: PG_INT_MAX + 1 }, [field])
    }
  })

  it('caps the dirty-work retry count at the integer column ceiling', () => {
    const item = {
      id: UUID,
      entityKind: 'OPPORTUNITY' as const,
      entityId: UUID2,
      targetVersion: 1,
      reason: 'revision',
      status: 'PENDING' as const,
      claimOwner: null,
      claimedAt: null,
      leaseExpiresAt: null,
      fencingEpoch: 1,
      retryCount: PG_INT_MAX,
      cycleId: null,
      lastErrorCode: null,
      createdAt: NOW,
      completedAt: null,
    }
    expect(jobDirtyWorkItemWorkerSchema.parse(item).retryCount).toBe(PG_INT_MAX)
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, retryCount: PG_INT_MAX + 1 }, ['retryCount'])
  })

  it('caps the meter policy version at the integer column ceiling (CR-M-3)', () => {
    // CR-M-3: `job_account_meters.policy_version` is `integer` while the three
    // amount columns beside it are `bigint`, so this one field needs the
    // ceiling its neighbours do not.
    const meter = {
      id: UUID,
      accountKey: 'jsearch:main',
      unit: 'REQUEST' as const,
      window: 'MONTH' as const,
      limit: null,
      used: 0,
      reserved: 0,
      uncertain: 0,
      windowStartedAt: NOW,
      resetsAt: null,
      policyVersion: PG_INT_MAX,
    }
    expect(jobAccountMeterSchema.parse(meter).policyVersion).toBe(PG_INT_MAX)
    refusedAt(jobAccountMeterSchema, { ...meter, policyVersion: PG_INT_MAX + 1 }, ['policyVersion'])
  })

  it('caps every collection-report count at the integer column ceiling (CR-M-3)', () => {
    // CR-M-3: `received` and all six disposition buckets land in `integer`
    // columns on `job_collection_runs`, so each one needs the ceiling — not
    // just the two a reviewer happens to read.
    const atCeiling = {
      sourceId: UUID,
      outcome: 'SUCCEEDED' as const,
      coverage: 'WINDOW' as const,
      received: PG_INT_MAX,
      created: PG_INT_MAX,
      revised: 0,
      unchanged: 0,
      duplicates: 0,
      invalid: 0,
      persistenceErrors: 0,
    }
    expect(jobCollectionReportSchema.parse(atCeiling).created).toBe(PG_INT_MAX)
    for (const field of [
      'received',
      'created',
      'revised',
      'unchanged',
      'duplicates',
      'invalid',
      'persistenceErrors',
    ] as const) {
      refusedAt(jobCollectionReportSchema, { ...atCeiling, [field]: PG_INT_MAX + 1 }, [field])
    }
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
    expectOnlyIssue(
      jobAccountMeterSchema,
      { ...meter, used: 190 },
      'used + reserved + uncertain may not exceed the limit',
      ['used'],
    )
  })

  it('lets an unlimited meter (null limit) hold any amount', () => {
    expect(
      jobAccountMeterSchema.safeParse({ ...meter, limit: null, used: 10_000_000 }).success,
    ).toBe(true)
  })

  it('refuses a LIFETIME meter that resets OR carries a window start', () => {
    expectOnlyIssue(
      jobAccountMeterSchema,
      { ...meter, window: 'LIFETIME', windowStartedAt: null },
      'a LIFETIME meter never resets and has no window start',
      ['window'],
    )
    expectOnlyIssue(
      jobAccountMeterSchema,
      { ...meter, window: 'LIFETIME', resetsAt: null },
      'a LIFETIME meter never resets and has no window start',
      ['window'],
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
    expectOnlyIssue(
      jobMeterReservationSchema,
      { ...reservation, status: 'USED', sentAt: NOW, settledAt: NOW, usedAmount: 6 },
      'used cost may not exceed the reserved amount',
      ['usedAmount'],
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
    expectOnlyIssue(
      jobMeterReservationSchema,
      { ...reservation, status: 'RELEASED', usedAmount: 3 },
      'only provably unsent cost may be released',
      ['usedAmount'],
    )
    // CR-L-1: and a RELEASED reservation that DID leave is refused. The pair
    // rule said only "anything past RESERVED/RELEASED carries a send instant",
    // which left a released row free to claim both that the request left and
    // that nothing was spent.
    expectOnlyIssue(
      jobMeterReservationSchema,
      { ...reservation, status: 'RELEASED', sentAt: NOW },
      'a released reservation never left, so it carries no send instant',
      ['sentAt'],
    )
    // A RELEASED reservation that spent nothing is fine — and needs no send
    // instant, which is why RELEASED sits beside RESERVED in the rule below.
    expect(
      jobMeterReservationSchema.safeParse({ ...reservation, status: 'RELEASED' }).success,
    ).toBe(true)
  })

  it.each(['SENT', 'USED', 'UNCERTAIN'] as const)('requires a send instant for %s', (status) => {
    expectOnlyIssue(
      jobMeterReservationSchema,
      { ...reservation, status, usedAmount: status === 'USED' ? 5 : 0, settledAt: NOW },
      'a request that left must carry its send instant',
      ['sentAt'],
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

  it('takes a 1-character attempt id and refuses an empty one (.min(1) boundary)', () => {
    expect(jobMeterReservationSchema.safeParse({ ...reservation, attemptId: 'a' }).success).toBe(
      true,
    )
    expect(
      jobMeterReservationSchema.safeParse({ ...reservation, attemptId: 'a'.repeat(200) }).success,
    ).toBe(true)
    refusedAt(jobMeterReservationSchema, { ...reservation, attemptId: '' }, ['attemptId'])
    refusedAt(jobMeterReservationSchema, { ...reservation, attemptId: 'a'.repeat(201) }, [
      'attemptId',
    ])
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
    expectOnlyIssue(
      jobCollectionCycleSchema,
      { ...cycle, trigger: 'MANUAL' },
      'a MANUAL cycle names its actor; a SCHEDULED cycle has none',
      ['requestedBy'],
    )
    expectOnlyIssue(
      jobCollectionCycleSchema,
      { ...cycle, requestedBy: UUID2 },
      'a MANUAL cycle names its actor; a SCHEDULED cycle has none',
      ['requestedBy'],
    )
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, trigger: 'MANUAL', requestedBy: UUID2 })
        .success,
    ).toBe(true)
  })

  it('pairs CLOSED with its closing instant, in both directions', () => {
    expectOnlyIssue(
      jobCollectionCycleSchema,
      { ...cycle, status: 'CLOSED' },
      'a CLOSED cycle carries its closing instant',
      ['closedAt'],
    )
    expectOnlyIssue(
      jobCollectionCycleSchema,
      { ...cycle, closedAt: NOW },
      'a CLOSED cycle carries its closing instant',
      ['closedAt'],
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

  it('takes a 1-character trigger key and caps it at 200 (.min(1) boundary)', () => {
    expect(jobCollectionCycleSchema.safeParse({ ...cycle, triggerKey: 'k' }).success).toBe(true)
    expect(
      jobCollectionCycleSchema.safeParse({ ...cycle, triggerKey: 'k'.repeat(200) }).success,
    ).toBe(true)
    refusedAt(jobCollectionCycleSchema, { ...cycle, triggerKey: 'k'.repeat(201) }, ['triggerKey'])
  })
})

describe('jobCollectionAttemptWorkerSchema — owned while running, ended when terminal', () => {
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
    expect(jobCollectionAttemptWorkerSchema.parse(running).ownerToken).toBe('worker-1')
  })

  it('accepts a terminal attempt carrying a short typed error code and sentence', () => {
    // A short code must PARSE — otherwise a bound of `max(100)` is
    // indistinguishable from `min(100)`.
    const parsed = jobCollectionAttemptWorkerSchema.parse(failed)
    expect(parsed.errorCode).toBe('HTTP_403')
    expect(parsed.errorMessage).toBe('provider refused: forbidden')
  })

  it('refuses a running attempt with no owner, or no lease', () => {
    expectOnlyIssue(
      jobCollectionAttemptWorkerSchema,
      { ...running, ownerToken: null },
      'a running attempt is owned under a lease',
      ['ownerToken'],
    )
    expectOnlyIssue(
      jobCollectionAttemptWorkerSchema,
      { ...running, leaseExpiresAt: null },
      'a running attempt is owned under a lease',
      ['ownerToken'],
    )
  })

  it('lets a TERMINAL attempt keep no lease: the rule binds running attempts only', () => {
    expect(
      jobCollectionAttemptWorkerSchema.safeParse({ ...failed, leaseExpiresAt: null }).success,
    ).toBe(true)
  })

  it('pairs a terminal outcome with an end instant, in both directions', () => {
    expectOnlyIssue(
      jobCollectionAttemptWorkerSchema,
      { ...running, outcome: 'SUCCEEDED' },
      'a terminal attempt carries its end instant; a running one does not',
      ['endedAt'],
    )
    expectOnlyIssue(
      jobCollectionAttemptWorkerSchema,
      { ...running, endedAt: NOW },
      'a terminal attempt carries its end instant; a running one does not',
      ['endedAt'],
    )
    expect(
      jobCollectionAttemptWorkerSchema.safeParse({ ...running, outcome: 'SUCCEEDED', endedAt: NOW })
        .success,
    ).toBe(true)
  })

  it('bounds the error code and the sanitized message (no raw upstream body)', () => {
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorMessage: 'x'.repeat(501) }, [
      'errorMessage',
    ])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: 'C'.repeat(65) }, [
      'errorCode',
    ])
    // Exactly at the bound still parses.
    expect(
      jobCollectionAttemptWorkerSchema.safeParse({ ...failed, errorMessage: 'x'.repeat(500) })
        .success,
    ).toBe(true)
  })

  it('refuses a run error code that is not a typed one (SR-M-2 / SPEC-M-1)', () => {
    // The column is documented as holding a typed code from a documented status
    // or error classification. Free text — a lowercase upstream sentence, a
    // space, punctuation, or anything over 64 characters — is refused here as
    // it now is by the database CHECK.
    expect(
      jobCollectionAttemptWorkerSchema.safeParse({ ...failed, errorCode: 'A'.repeat(64) }).success,
    ).toBe(true)
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: 'A'.repeat(65) }, [
      'errorCode',
    ])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: 'http_403' }, ['errorCode'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: 'HTTP 403' }, ['errorCode'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: '403_HTTP' }, ['errorCode'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...failed, errorCode: '' }, ['errorCode'])
    // The refusal states WHY, in the one place the message is read: `refusedAt`
    // asserts the path only, so without this the message is an unobserved
    // string — a surviving StringLiteral mutant on the first gate run.
    const refused = jobCollectionAttemptWorkerSchema.safeParse({ ...failed, errorCode: 'http_403' })
    expect(refused.success).toBe(false)
    if (refused.success) return
    expect(refused.error.issues.map((i) => i.message)).toContain(
      'must be a typed upper-snake error code of at most 64 characters',
    )
  })

  it('refuses a non-positive fencing epoch or config version', () => {
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, fencingEpoch: 0 }, ['fencingEpoch'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, configVersion: 0 }, ['configVersion'])
  })

  it('takes 1-character owner / attempt / adapter values and refuses empty (.min(1))', () => {
    expect(
      jobCollectionAttemptWorkerSchema.safeParse({
        ...running,
        ownerToken: 'w',
        attemptId: 'a',
        adapterVersion: 'v',
      }).success,
    ).toBe(true)
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, ownerToken: '' }, ['ownerToken'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, attemptId: '' }, ['attemptId'])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, adapterVersion: '' }, [
      'adapterVersion',
    ])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, ownerToken: 'w'.repeat(201) }, [
      'ownerToken',
    ])
    refusedAt(jobCollectionAttemptWorkerSchema, { ...running, adapterVersion: 'v'.repeat(101) }, [
      'adapterVersion',
    ])
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
    // At the bound, and SEGMENTED: a 100-character unbroken run is refused by
    // the identity rule below, not by the length bound.
    expect(
      jobSourceHealthSchema.safeParse({ ...health, manifestId: `${'m'.repeat(19)}.`.repeat(5) })
        .success,
    ).toBe(true)
  })

  it('holds `manifestId` to the identity rule the column enforces (SR-L-2)', () => {
    // The column carries `ck_job_sources_manifest_id_format` and
    // `..._segmented`; the wire carried only `.max(100)`, so a value the
    // database refuses parsed here. Response-only or not, the two now agree.
    expect(
      jobSourceHealthSchema.parse({ ...health, manifestId: 'jsearch:rapidapi-main' }).manifestId,
    ).toBe('jsearch:rapidapi-main')
    refusedAt(jobSourceHealthSchema, { ...health, manifestId: 'a'.repeat(24) }, ['manifestId'])
    expect(jobSourceHealthSchema.safeParse({ ...health, manifestId: 'a'.repeat(23) }).success).toBe(
      true,
    )
    refusedAt(jobSourceHealthSchema, { ...health, manifestId: 'JSearch:Main' }, ['manifestId'])
    refusedAt(jobSourceHealthSchema, { ...health, manifestId: 'https://x/y' }, ['manifestId'])
    refusedAt(jobSourceHealthSchema, { ...health, manifestId: '.leading-dot' }, ['manifestId'])
  })

  it('requires a stated reason before a source may be BLOCKED', () => {
    expectOnlyIssue(
      jobSourceHealthSchema,
      { ...health, readiness: 'BLOCKED' },
      'a BLOCKED source states why',
      ['readinessReason'],
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
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: 'C'.repeat(65) }, [
      'lastErrorCode',
    ])
  })

  it('refuses a negative failure count and a non-positive version', () => {
    refusedAt(jobSourceHealthSchema, { ...health, consecutiveFailures: -1 }, [
      'consecutiveFailures',
    ])
    refusedAt(jobSourceHealthSchema, { ...health, configVersion: 0 }, ['configVersion'])
  })

  it('refuses a source-health error code that is not a typed one (SR-M-2 / SPEC-M-1)', () => {
    // The column is documented as holding a typed code from a documented status
    // or error classification. Free text — a lowercase upstream sentence, a
    // space, punctuation, or anything over 64 characters — is refused here as
    // it now is by the database CHECK.
    expect(
      jobSourceHealthSchema.safeParse({ ...health, lastErrorCode: 'A'.repeat(64) }).success,
    ).toBe(true)
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: 'A'.repeat(65) }, [
      'lastErrorCode',
    ])
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: 'http_403' }, ['lastErrorCode'])
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: 'HTTP 403' }, ['lastErrorCode'])
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: '403_HTTP' }, ['lastErrorCode'])
    refusedAt(jobSourceHealthSchema, { ...health, lastErrorCode: '' }, ['lastErrorCode'])
  })
})

describe('jobDirtyWorkItemWorkerSchema — claimed under a lease, terminal when finished', () => {
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
    expect(jobDirtyWorkItemWorkerSchema.parse(item).status).toBe('PENDING')
  })

  it('needs BOTH an owner and a lease to be CLAIMED — one alone is not enough', () => {
    expectOnlyIssue(jobDirtyWorkItemWorkerSchema, { ...item, status: 'CLAIMED' }, CLAIM_RULE, [
      'claimOwner',
    ])
    expectOnlyIssue(
      jobDirtyWorkItemWorkerSchema,
      { ...item, status: 'CLAIMED', claimOwner: 'w1', claimedAt: NOW },
      CLAIM_RULE,
      ['claimOwner'],
    )
    expectOnlyIssue(
      jobDirtyWorkItemWorkerSchema,
      { ...item, status: 'CLAIMED', leaseExpiresAt: NOW },
      CLAIM_RULE,
      ['claimOwner'],
    )
    expect(
      jobDirtyWorkItemWorkerSchema.safeParse({
        ...item,
        status: 'CLAIMED',
        claimOwner: 'w1',
        claimedAt: NOW,
        leaseExpiresAt: NOW,
      }).success,
    ).toBe(true)
  })

  it('refuses an owner or a lease left behind on work that is not CLAIMED', () => {
    expectOnlyIssue(
      jobDirtyWorkItemWorkerSchema,
      { ...item, claimOwner: 'w1', leaseExpiresAt: NOW },
      CLAIM_RULE,
      ['claimOwner'],
    )
    // CR-M-1. A HALF-SET claim on work that is not CLAIMED: the old predicate
    // was one equality of two booleans, so `status <> 'CLAIMED'` with an owner
    // and NO lease made both sides false, the equality held, and the state the
    // message calls impossible parsed. Each half alone is refused now.
    expectOnlyIssue(jobDirtyWorkItemWorkerSchema, { ...item, claimOwner: 'w1' }, CLAIM_RULE, [
      'claimOwner',
    ])
    expectOnlyIssue(jobDirtyWorkItemWorkerSchema, { ...item, leaseExpiresAt: NOW }, CLAIM_RULE, [
      'claimOwner',
    ])
    // ... on every non-CLAIMED status, not only PENDING.
    for (const status of ['DONE', 'FAILED', 'DEFERRED'] as const) {
      expectOnlyIssue(
        jobDirtyWorkItemWorkerSchema,
        { ...item, status, completedAt: NOW, claimOwner: 'w1' },
        CLAIM_RULE,
        ['claimOwner'],
      )
    }
    // And the legitimate released shape — both cleared — still parses.
    expect(
      jobDirtyWorkItemWorkerSchema.safeParse({
        ...item,
        status: 'DONE',
        completedAt: NOW,
        claimOwner: null,
        leaseExpiresAt: null,
      }).success,
    ).toBe(true)
  })

  it.each(['DONE', 'FAILED', 'DEFERRED'] as const)(
    'treats %s as terminal: it carries a completion instant',
    (status) => {
      expectOnlyIssue(
        jobDirtyWorkItemWorkerSchema,
        { ...item, status },
        'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
        ['completedAt'],
      )
      expect(
        jobDirtyWorkItemWorkerSchema.safeParse({ ...item, status, completedAt: NOW }).success,
      ).toBe(true)
    },
  )

  it('refuses a completion instant on work that is still pending', () => {
    expectOnlyIssue(
      jobDirtyWorkItemWorkerSchema,
      { ...item, completedAt: NOW },
      'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
      ['completedAt'],
    )
  })

  it('accepts a short typed last error code', () => {
    expect(
      jobDirtyWorkItemWorkerSchema.parse({ ...item, lastErrorCode: 'VERSION_STALE' }).lastErrorCode,
    ).toBe('VERSION_STALE')
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: 'C'.repeat(65) }, [
      'lastErrorCode',
    ])
  })

  it('refuses a dirty-work error code that is not a typed one (SR-M-2 / SPEC-M-1)', () => {
    // The column is documented as holding a typed code from a documented status
    // or error classification. Free text — a lowercase upstream sentence, a
    // space, punctuation, or anything over 64 characters — is refused here as
    // it now is by the database CHECK.
    expect(
      jobDirtyWorkItemWorkerSchema.safeParse({ ...item, lastErrorCode: 'A'.repeat(64) }).success,
    ).toBe(true)
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: 'A'.repeat(65) }, [
      'lastErrorCode',
    ])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: 'http_403' }, [
      'lastErrorCode',
    ])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: 'HTTP 403' }, [
      'lastErrorCode',
    ])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: '403_HTTP' }, [
      'lastErrorCode',
    ])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, lastErrorCode: '' }, ['lastErrorCode'])
  })

  it('refuses a non-positive target version, a blank or oversized reason, a negative retry', () => {
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, targetVersion: 0 }, ['targetVersion'])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, reason: '' }, ['reason'])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, reason: 'r'.repeat(101) }, ['reason'])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, retryCount: -1 }, ['retryCount'])
    refusedAt(jobDirtyWorkItemWorkerSchema, { ...item, fencingEpoch: 0 }, ['fencingEpoch'])
  })

  it('takes a 1-character reason and claim owner (.min(1) boundary)', () => {
    expect(jobDirtyWorkItemWorkerSchema.safeParse({ ...item, reason: 'r' }).success).toBe(true)
    expect(
      jobDirtyWorkItemWorkerSchema.safeParse({ ...item, reason: 'r'.repeat(100) }).success,
    ).toBe(true)
    expect(
      jobDirtyWorkItemWorkerSchema.safeParse({
        ...item,
        status: 'CLAIMED',
        claimOwner: 'w',
        claimedAt: NOW,
        leaseExpiresAt: NOW,
      }).success,
    ).toBe(true)
    refusedAt(
      jobDirtyWorkItemWorkerSchema,
      { ...item, status: 'CLAIMED', claimOwner: '', claimedAt: NOW, leaseExpiresAt: NOW },
      ['claimOwner'],
    )
    refusedAt(
      jobDirtyWorkItemWorkerSchema,
      {
        ...item,
        status: 'CLAIMED',
        claimOwner: 'w'.repeat(201),
        claimedAt: NOW,
        leaseExpiresAt: NOW,
      },
      ['claimOwner'],
    )
  })
})
