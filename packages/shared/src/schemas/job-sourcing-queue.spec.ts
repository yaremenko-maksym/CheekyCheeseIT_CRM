/*
 * `expectOnlyIssue` and `refusedAt` below ARE the assertions of this file — they
 * call `expect` internally. Teach the rule about them rather than disabling it,
 * so a test that genuinely asserts nothing is still caught.
 */
/* eslint vitest/expect-expect: ["error", { assertFunctionNames: ["expect", "expectOnlyIssue", "refusedAt"] }] */
import { describe, expect, it } from 'vitest'
import {
  jobQueueActionKindSchema,
  jobQueueActionSchema,
  jobQueueAssignmentSchema,
  jobQueueAssignmentStateSchema,
  jobQueueAssignmentWorkerSchema,
  jobQueueDismissalSchema,
  jobQueueGenerationEntryWorkerSchema,
  jobQueueGenerationSchema,
  jobQueueGenerationStatusSchema,
  jobQueueGenerationWorkerSchema,
  jobQueueScopeKindSchema,
  jobQueueScopeSchema,
  jobQueueTeamTriageSubscriptionSchema,
  createJobQueueTeamTriageSubscriptionSchema,
  revokeJobQueueTeamTriageSubscriptionSchema,
  jobSignalKindSchema,
} from './job-sourcing'

/**
 * r5 Task 1.2 (part 3) — the QUEUE workflow contracts: assignments, dismissals,
 * the append-only action log, published generations and their entries.
 *
 * Every cross-field rule here is also a database CHECK, proven against a real
 * catalog in `apps/api/src/database/job-queue-store.integration.spec.ts`. A row the
 * database accepted must serialize, and a DTO the wire accepted must store.
 *
 * Assertion style is the one `job-sourcing-collection.spec.ts` documents: a
 * refusal is asserted by its EXACT issue list, each cross-field rule gets a
 * passing counter-case, and every half-set combination of a pair is refused
 * on its own (lesson CR-M-1 of PR #1015: an equality of two booleans passes
 * when both sides are false).
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

const U1 = '11111111-2222-4333-8444-555555555555'
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const U3 = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
const NOW = '2026-10-17T12:00:00.000Z'
const LATER = '2026-10-17T13:00:00.000Z'
const PG_INT_MAX = 2_147_483_647
const PG_INT_MIN = -2_147_483_648

const TEAM = { kind: 'TEAM', teamId: U2 } as const
const STUDIO = { kind: 'STUDIO', teamId: null } as const

describe('enum members and order (mirrored by the pg enums)', () => {
  it.each([
    [jobQueueScopeKindSchema, ['TEAM', 'STUDIO']],
    [jobQueueAssignmentStateSchema, ['TAKEN', 'RELEASED']],
    [jobQueueGenerationStatusSchema, ['BUILDING', 'PUBLISHED', 'INVALIDATED']],
    [
      jobQueueActionKindSchema,
      [
        'OPENED',
        'TAKEN',
        'DEAD_LINK',
        'SPAM',
        'DISMISSED',
        'UNDONE',
        'RELEASED',
        'REASSIGNED',
        'SUPPRESSED',
        'TRIAGE_GRANTED',
        'TRIAGE_REVOKED',
        'TRIAGE_SUBSCRIBED',
        'TRIAGE_UNSUBSCRIBED',
      ],
    ],
  ])('%#', (schema, members) => {
    expect([...schema.options]).toEqual(members)
  })

  it('leaves the legacy signal kinds untouched (job_posting_signals is not this log)', () => {
    expect([...jobSignalKindSchema.options]).toEqual(['OPENED', 'TAKEN', 'DEAD_LINK', 'SPAM'])
    expect(jobSignalKindSchema.safeParse('DISMISSED').success).toBe(false)
  })
})

describe('jobQueueScopeSchema — TEAM names its team, STUDIO has none', () => {
  it('accepts both shapes', () => {
    expect(jobQueueScopeSchema.parse(TEAM)).toEqual(TEAM)
    expect(jobQueueScopeSchema.parse(STUDIO)).toEqual(STUDIO)
  })

  it('refuses a STUDIO scope that names a team', () => {
    refusedAt(jobQueueScopeSchema, { kind: 'STUDIO', teamId: U2 }, ['teamId'])
  })

  it('refuses a TEAM scope without a team', () => {
    refusedAt(jobQueueScopeSchema, { kind: 'TEAM', teamId: null }, ['teamId'])
    refusedAt(jobQueueScopeSchema, { kind: 'TEAM' }, ['teamId'])
    refusedAt(jobQueueScopeSchema, { kind: 'TEAM', teamId: 'not-a-uuid' }, ['teamId'])
  })

  it('refuses an unknown kind and an extra key', () => {
    expect(jobQueueScopeSchema.safeParse({ kind: 'GLOBAL', teamId: null }).success).toBe(false)
    expect(jobQueueScopeSchema.safeParse({ ...TEAM, seniorId: U1 }).success).toBe(false)
    expect(jobQueueScopeSchema.safeParse({ ...STUDIO, extra: 1 }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

const taken = {
  id: U1,
  opportunityId: U2,
  state: 'TAKEN',
  scope: TEAM,
  assigneeId: U3,
  takenAt: NOW,
  version: 1,
  releasedAt: null,
  releasedBy: null,
  releaseReason: null,
  reassignedAt: null,
  reassignedBy: null,
  reassignedFromId: null,
  updatedAt: NOW,
}
const released = {
  ...taken,
  state: 'RELEASED',
  releasedAt: LATER,
  releasedBy: U1,
  releaseReason: 'went on leave',
  version: 2,
}
const RELEASE_PAIR =
  'a RELEASED assignment records when it was released, and only a released one does'
const RELEASED_BY = 'a RELEASED assignment records who released it, and only a released one does'
const REASSIGN_TRIPLE =
  'reassignment metadata (when, by whom, from whom) is all present or all absent'

describe('jobQueueAssignmentWorkerSchema — the server-internal claim row', () => {
  it('accepts a TAKEN and a RELEASED row', () => {
    expect(jobQueueAssignmentWorkerSchema.parse(taken)).toEqual(taken)
    expect(jobQueueAssignmentWorkerSchema.parse(released)).toEqual(released)
    // An ADMIN claims under the STUDIO scope.
    expect(jobQueueAssignmentWorkerSchema.safeParse({ ...taken, scope: STUDIO }).success).toBe(true)
  })

  it('refuses every half-set release combination', () => {
    expectOnlyIssue(
      jobQueueAssignmentWorkerSchema,
      { ...released, releasedAt: null },
      RELEASE_PAIR,
      ['releasedAt'],
    )
    expectOnlyIssue(
      jobQueueAssignmentWorkerSchema,
      { ...released, releasedBy: null },
      RELEASED_BY,
      ['releasedBy'],
    )
    expectOnlyIssue(jobQueueAssignmentWorkerSchema, { ...taken, releasedAt: LATER }, RELEASE_PAIR, [
      'releasedAt',
    ])
    expectOnlyIssue(jobQueueAssignmentWorkerSchema, { ...taken, releasedBy: U1 }, RELEASED_BY, [
      'releasedBy',
    ])
  })

  it('accepts a full reassignment triple and refuses each lone member', () => {
    const reassigned = { ...taken, reassignedAt: LATER, reassignedBy: U1, reassignedFromId: U2 }
    expect(jobQueueAssignmentWorkerSchema.safeParse(reassigned).success).toBe(true)
    for (const only of [
      { reassignedAt: LATER },
      { reassignedBy: U1 },
      { reassignedFromId: U2 },
      { reassignedAt: LATER, reassignedBy: U1 },
      { reassignedBy: U1, reassignedFromId: U2 },
      { reassignedAt: LATER, reassignedFromId: U2 },
    ]) {
      expectOnlyIssue(jobQueueAssignmentWorkerSchema, { ...taken, ...only }, REASSIGN_TRIPLE, [
        'reassignedAt',
      ])
    }
  })

  it('bounds the version to a positive integer column', () => {
    refusedAt(jobQueueAssignmentWorkerSchema, { ...taken, version: 0 }, ['version'])
    expect(
      jobQueueAssignmentWorkerSchema.safeParse({ ...taken, version: PG_INT_MAX }).success,
    ).toBe(true)
    refusedAt(jobQueueAssignmentWorkerSchema, { ...taken, version: PG_INT_MAX + 1 }, ['version'])
  })

  it('carries a release reason on a RELEASED row only (a re-take clears it)', () => {
    expectOnlyIssue(
      jobQueueAssignmentWorkerSchema,
      { ...taken, releaseReason: 'left over' },
      'only a RELEASED assignment carries a release reason',
      ['releaseReason'],
    )
    // The reason is optional on a release.
    expect(
      jobQueueAssignmentWorkerSchema.safeParse({ ...released, releaseReason: null }).success,
    ).toBe(true)
  })

  it('bounds the release reason (blank refused, 500 accepted, 501 refused)', () => {
    refusedAt(jobQueueAssignmentWorkerSchema, { ...released, releaseReason: '   ' }, [
      'releaseReason',
    ])
    expect(
      jobQueueAssignmentWorkerSchema.safeParse({ ...released, releaseReason: 'r'.repeat(500) })
        .success,
    ).toBe(true)
    refusedAt(jobQueueAssignmentWorkerSchema, { ...released, releaseReason: 'r'.repeat(501) }, [
      'releaseReason',
    ])
  })
})

describe('jobQueueAssignmentSchema — the public claim shape', () => {
  it('carries no actor identity and no claimer team (cross-team disclosure)', () => {
    const parsed = jobQueueAssignmentSchema.parse(released)
    expect(parsed).toEqual({
      id: U1,
      opportunityId: U2,
      state: 'RELEASED',
      takenAt: NOW,
      releasedAt: LATER,
      version: 2,
    })
  })

  it('keeps the release pair on the public shape too', () => {
    const pub = {
      id: U1,
      opportunityId: U2,
      state: 'TAKEN',
      takenAt: NOW,
      releasedAt: LATER,
      version: 1,
    }
    expectOnlyIssue(jobQueueAssignmentSchema, pub, RELEASE_PAIR, ['releasedAt'])
    expectOnlyIssue(
      jobQueueAssignmentSchema,
      { ...pub, state: 'RELEASED', releasedAt: null },
      RELEASE_PAIR,
      ['releasedAt'],
    )
    expect(jobQueueAssignmentSchema.safeParse({ ...pub, releasedAt: null }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dismissals
// ---------------------------------------------------------------------------

const dismissal = {
  id: U1,
  opportunityId: U2,
  scope: TEAM,
  reason: 'not our stack',
  dismissedBy: U3,
  dismissedAt: NOW,
  version: 1,
  undoneAt: null,
  undoneBy: null,
}
const UNDO_PAIR = 'an undo records who undid it and when — both or neither'

describe('jobQueueDismissalSchema', () => {
  it('accepts a TEAM, a STUDIO and an undone dismissal', () => {
    expect(jobQueueDismissalSchema.parse(dismissal)).toEqual(dismissal)
    expect(jobQueueDismissalSchema.safeParse({ ...dismissal, scope: STUDIO }).success).toBe(true)
    expect(
      jobQueueDismissalSchema.safeParse({ ...dismissal, undoneAt: LATER, undoneBy: U1 }).success,
    ).toBe(true)
  })

  it('refuses each half of the undo pair alone', () => {
    expectOnlyIssue(jobQueueDismissalSchema, { ...dismissal, undoneAt: LATER }, UNDO_PAIR, [
      'undoneAt',
    ])
    expectOnlyIssue(jobQueueDismissalSchema, { ...dismissal, undoneBy: U1 }, UNDO_PAIR, [
      'undoneAt',
    ])
  })

  it('bounds the reason and the version', () => {
    refusedAt(jobQueueDismissalSchema, { ...dismissal, reason: '' }, ['reason'])
    expect(jobQueueDismissalSchema.safeParse({ ...dismissal, reason: 'r' }).success).toBe(true)
    refusedAt(jobQueueDismissalSchema, { ...dismissal, reason: 'r'.repeat(501) }, ['reason'])
    refusedAt(jobQueueDismissalSchema, { ...dismissal, version: 0 }, ['version'])
    refusedAt(jobQueueDismissalSchema, { ...dismissal, version: PG_INT_MAX + 1 }, ['version'])
  })

  it('refuses a scope whose shape is wrong for its kind', () => {
    refusedAt(jobQueueDismissalSchema, { ...dismissal, scope: { kind: 'STUDIO', teamId: U2 } }, [
      'scope',
      'teamId',
    ])
  })
})

// ---------------------------------------------------------------------------
// The append-only action log
// ---------------------------------------------------------------------------

const opened = {
  id: U1,
  kind: 'OPENED',
  opportunityId: U2,
  sourceRecordId: U3,
  subscriptionId: null,
  actorId: U3,
  scope: TEAM,
  subjectTeamId: null,
  subjectUserId: null,
  beforeVersion: null,
  afterVersion: null,
  idempotencyKey: 'opened:abc',
  reason: null,
  createdAt: NOW,
}
const takeAction = {
  ...opened,
  kind: 'TAKEN',
  sourceRecordId: null,
  beforeVersion: 0,
  afterVersion: 1,
  idempotencyKey: 'take-1',
}
const subscribed = {
  ...takeAction,
  kind: 'TRIAGE_SUBSCRIBED',
  opportunityId: null,
  subscriptionId: U1,
  scope: STUDIO,
  subjectTeamId: U2,
  beforeVersion: 0,
  afterVersion: 1,
}
const TARGET =
  'a subscription action targets a subscription only; every other action targets an opportunity and no subscription'
const CLICKED = 'OPENED / DEAD_LINK / SPAM reference the clicked source record'
const SUBJECT_TEAM = 'a TRIAGE_* action names the team it concerns, and only a TRIAGE_* action does'
const SUBJECT_USER = 'a REASSIGNED action names the new assignee, and only a REASSIGNED action does'
const VERSIONS =
  'telemetry (OPENED / DEAD_LINK / SPAM) carries no version; every other action moves the version forward'

describe('jobQueueActionSchema', () => {
  it('accepts one valid row per shape: telemetry, a claim, a subscription, a grant, a reassign', () => {
    expect(jobQueueActionSchema.parse(opened)).toEqual(opened)
    for (const kind of ['DEAD_LINK', 'SPAM'])
      expect(jobQueueActionSchema.safeParse({ ...opened, kind }).success).toBe(true)
    expect(jobQueueActionSchema.parse(takeAction)).toEqual(takeAction)
    expect(jobQueueActionSchema.parse(subscribed)).toEqual(subscribed)
    expect(
      jobQueueActionSchema.safeParse({ ...subscribed, kind: 'TRIAGE_UNSUBSCRIBED' }).success,
    ).toBe(true)
    const granted = { ...takeAction, kind: 'TRIAGE_GRANTED', scope: STUDIO, subjectTeamId: U2 }
    expect(jobQueueActionSchema.safeParse(granted).success).toBe(true)
    expect(jobQueueActionSchema.safeParse({ ...granted, kind: 'TRIAGE_REVOKED' }).success).toBe(
      true,
    )
    expect(
      jobQueueActionSchema.safeParse({ ...takeAction, kind: 'REASSIGNED', subjectUserId: U1 })
        .success,
    ).toBe(true)
    for (const kind of ['DISMISSED', 'UNDONE', 'RELEASED', 'SUPPRESSED'])
      expect(jobQueueActionSchema.safeParse({ ...takeAction, kind }).success).toBe(true)
    // An optional source record on a non-telemetry action is allowed (r5).
    expect(jobQueueActionSchema.safeParse({ ...takeAction, sourceRecordId: U3 }).success).toBe(true)
  })

  it('refuses every wrong target combination', () => {
    // An opportunity action without an opportunity.
    expectOnlyIssue(jobQueueActionSchema, { ...takeAction, opportunityId: null }, TARGET, [
      'opportunityId',
    ])
    // An opportunity action that also names a subscription.
    expectOnlyIssue(jobQueueActionSchema, { ...takeAction, subscriptionId: U1 }, TARGET, [
      'opportunityId',
    ])
    // A subscription action without its subscription.
    expectOnlyIssue(jobQueueActionSchema, { ...subscribed, subscriptionId: null }, TARGET, [
      'opportunityId',
    ])
    // A subscription action that also names an opportunity.
    expectOnlyIssue(jobQueueActionSchema, { ...subscribed, opportunityId: U2 }, TARGET, [
      'opportunityId',
    ])
    // A subscription action that names a source record.
    expectOnlyIssue(jobQueueActionSchema, { ...subscribed, sourceRecordId: U3 }, TARGET, [
      'opportunityId',
    ])
  })

  it('requires the clicked source record on every telemetry kind', () => {
    for (const kind of ['OPENED', 'DEAD_LINK', 'SPAM'])
      expectOnlyIssue(jobQueueActionSchema, { ...opened, kind, sourceRecordId: null }, CLICKED, [
        'sourceRecordId',
      ])
  })

  it('names the subject team on TRIAGE_* actions only', () => {
    expectOnlyIssue(jobQueueActionSchema, { ...subscribed, subjectTeamId: null }, SUBJECT_TEAM, [
      'subjectTeamId',
    ])
    expectOnlyIssue(
      jobQueueActionSchema,
      { ...takeAction, kind: 'TRIAGE_GRANTED', subjectTeamId: null },
      SUBJECT_TEAM,
      ['subjectTeamId'],
    )
    expectOnlyIssue(jobQueueActionSchema, { ...takeAction, subjectTeamId: U2 }, SUBJECT_TEAM, [
      'subjectTeamId',
    ])
  })

  it('names the new assignee on REASSIGNED only', () => {
    expectOnlyIssue(jobQueueActionSchema, { ...takeAction, kind: 'REASSIGNED' }, SUBJECT_USER, [
      'subjectUserId',
    ])
    expectOnlyIssue(jobQueueActionSchema, { ...takeAction, subjectUserId: U1 }, SUBJECT_USER, [
      'subjectUserId',
    ])
  })

  it('refuses every wrong version combination', () => {
    for (const v of [
      { beforeVersion: 0 },
      { afterVersion: 1 },
      { beforeVersion: 0, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionSchema, { ...opened, ...v }, VERSIONS, ['afterVersion'])
    for (const v of [
      { beforeVersion: null },
      { afterVersion: null },
      { beforeVersion: null, afterVersion: null },
      { beforeVersion: 1, afterVersion: 1 },
      { beforeVersion: 2, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionSchema, { ...takeAction, ...v }, VERSIONS, ['afterVersion'])
    expect(
      jobQueueActionSchema.safeParse({ ...takeAction, beforeVersion: 4, afterVersion: 5 }).success,
    ).toBe(true)
  })

  it('bounds the idempotency key, the reason and the version columns', () => {
    refusedAt(jobQueueActionSchema, { ...takeAction, idempotencyKey: '' }, ['idempotencyKey'])
    expect(jobQueueActionSchema.safeParse({ ...takeAction, idempotencyKey: 'k' }).success).toBe(
      true,
    )
    expect(
      jobQueueActionSchema.safeParse({ ...takeAction, idempotencyKey: 'k'.repeat(200) }).success,
    ).toBe(true)
    refusedAt(jobQueueActionSchema, { ...takeAction, idempotencyKey: 'k'.repeat(201) }, [
      'idempotencyKey',
    ])
    refusedAt(jobQueueActionSchema, { ...takeAction, reason: ' ' }, ['reason'])
    refusedAt(jobQueueActionSchema, { ...takeAction, reason: 'r'.repeat(501) }, ['reason'])
    expect(jobQueueActionSchema.safeParse({ ...takeAction, reason: 'r'.repeat(500) }).success).toBe(
      true,
    )
    refusedAt(jobQueueActionSchema, { ...takeAction, beforeVersion: -1 }, ['beforeVersion'])
    refusedAt(
      jobQueueActionSchema,
      { ...takeAction, beforeVersion: 1, afterVersion: PG_INT_MAX + 1 },
      ['afterVersion'],
    )
  })
})

// ---------------------------------------------------------------------------
// Generations and entries
// ---------------------------------------------------------------------------

const building = {
  id: U1,
  scope: TEAM,
  policySignature: 'membership:7|exclusions:3',
  ruleVersion: 'rank-v1',
  status: 'BUILDING',
  evaluatedAt: NOW,
  expiresAt: LATER,
  publishedAt: null,
  invalidatedAt: null,
  createdAt: NOW,
}
const published = { ...building, status: 'PUBLISHED', publishedAt: NOW }
const STATUS =
  'BUILDING has no publish or invalidation instant; PUBLISHED has a publish instant only; INVALIDATED has an invalidation instant'
const EXPIRY = 'a generation expires after it was evaluated'

describe('jobQueueGenerationWorkerSchema', () => {
  it('accepts each lifecycle state', () => {
    expect(jobQueueGenerationWorkerSchema.parse(building)).toEqual(building)
    expect(jobQueueGenerationWorkerSchema.parse(published)).toEqual(published)
    // Invalidated after publishing, or abandoned while building.
    for (const publishedAt of [NOW, null])
      expect(
        jobQueueGenerationWorkerSchema.safeParse({
          ...building,
          status: 'INVALIDATED',
          publishedAt,
          invalidatedAt: LATER,
        }).success,
      ).toBe(true)
  })

  it('refuses every wrong instant combination per status', () => {
    for (const bad of [
      { ...building, publishedAt: NOW },
      { ...building, invalidatedAt: NOW },
      { ...published, publishedAt: null },
      { ...published, invalidatedAt: LATER },
      { ...building, status: 'INVALIDATED' },
      { ...published, status: 'INVALIDATED' },
    ])
      expectOnlyIssue(jobQueueGenerationWorkerSchema, bad, STATUS, ['status'])
  })

  it('expires strictly after evaluation', () => {
    expectOnlyIssue(jobQueueGenerationWorkerSchema, { ...building, expiresAt: NOW }, EXPIRY, [
      'expiresAt',
    ])
  })

  it('bounds the policy signature and rule version', () => {
    refusedAt(jobQueueGenerationWorkerSchema, { ...building, policySignature: '' }, [
      'policySignature',
    ])
    refusedAt(jobQueueGenerationWorkerSchema, { ...building, policySignature: 'p'.repeat(201) }, [
      'policySignature',
    ])
    expect(
      jobQueueGenerationWorkerSchema.safeParse({ ...building, policySignature: 'p'.repeat(200) })
        .success,
    ).toBe(true)
    refusedAt(jobQueueGenerationWorkerSchema, { ...building, ruleVersion: '' }, ['ruleVersion'])
    refusedAt(jobQueueGenerationWorkerSchema, { ...building, ruleVersion: 'r'.repeat(101) }, [
      'ruleVersion',
    ])
    expect(
      jobQueueGenerationWorkerSchema.safeParse({ ...building, ruleVersion: 'r'.repeat(100) })
        .success,
    ).toBe(true)
  })
})

describe('jobQueueGenerationSchema — the public shape', () => {
  it('carries no policy signature and no lifecycle state', () => {
    expect(jobQueueGenerationSchema.parse(published)).toEqual({
      id: U1,
      evaluatedAt: NOW,
      expiresAt: LATER,
    })
  })

  it('keeps the expiry rule', () => {
    expectOnlyIssue(
      jobQueueGenerationSchema,
      { id: U1, evaluatedAt: LATER, expiresAt: NOW },
      EXPIRY,
      ['expiresAt'],
    )
  })
})

describe('jobQueueGenerationEntryWorkerSchema — rank is server-internal', () => {
  const entry = {
    generationId: U1,
    opportunityId: U2,
    rankScore: -5,
    orderKey: 0,
    firstSeenAt: NOW,
    opportunityRevision: 1,
  }

  it('accepts a negative score and the zeroth position', () => {
    expect(jobQueueGenerationEntryWorkerSchema.parse(entry)).toEqual(entry)
  })

  it('bounds score and order to the integer column', () => {
    for (const rankScore of [PG_INT_MIN, PG_INT_MAX])
      expect(jobQueueGenerationEntryWorkerSchema.safeParse({ ...entry, rankScore }).success).toBe(
        true,
      )
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, rankScore: PG_INT_MIN - 1 }, [
      'rankScore',
    ])
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, rankScore: PG_INT_MAX + 1 }, [
      'rankScore',
    ])
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, rankScore: 1.5 }, ['rankScore'])
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, orderKey: -1 }, ['orderKey'])
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, orderKey: PG_INT_MAX + 1 }, [
      'orderKey',
    ])
    refusedAt(jobQueueGenerationEntryWorkerSchema, { ...entry, opportunityRevision: 0 }, [
      'opportunityRevision',
    ])
  })
})

// ---------------------------------------------------------------------------
// Triage subscriptions (#1011 contracts) — the integer-column ceilings
// ---------------------------------------------------------------------------

describe('triage subscription contracts agree with the integer columns', () => {
  const row = {
    id: U1,
    teamId: U2,
    roleFamily: 'backend',
    sourceTypes: [],
    policyVersion: 0,
    subscriptionVersion: 1,
    actorId: U3,
    expiresAt: LATER,
    revokedAt: null,
    createdAt: NOW,
  }

  it('accepts policy version 0 and the column ceiling, refuses one past it', () => {
    expect(jobQueueTeamTriageSubscriptionSchema.safeParse(row).success).toBe(true)
    expect(
      jobQueueTeamTriageSubscriptionSchema.safeParse({ ...row, policyVersion: PG_INT_MAX }).success,
    ).toBe(true)
    refusedAt(jobQueueTeamTriageSubscriptionSchema, { ...row, policyVersion: PG_INT_MAX + 1 }, [
      'policyVersion',
    ])
  })

  it('starts the subscription version at 1, as the column does', () => {
    refusedAt(jobQueueTeamTriageSubscriptionSchema, { ...row, subscriptionVersion: 0 }, [
      'subscriptionVersion',
    ])
    refusedAt(
      jobQueueTeamTriageSubscriptionSchema,
      { ...row, subscriptionVersion: PG_INT_MAX + 1 },
      ['subscriptionVersion'],
    )
    refusedAt(
      revokeJobQueueTeamTriageSubscriptionSchema,
      { subscriptionId: U1, expectedSubscriptionVersion: 0, reason: 'x' },
      ['expectedSubscriptionVersion'],
    )
  })

  it('bounds the create request policy version to the column', () => {
    const create = {
      teamId: U2,
      roleFamily: 'backend',
      sourceTypes: [],
      policyVersion: PG_INT_MAX,
      expiresAt: LATER,
      reason: 'standing triage',
    }
    expect(createJobQueueTeamTriageSubscriptionSchema.safeParse(create).success).toBe(true)
    refusedAt(
      createJobQueueTeamTriageSubscriptionSchema,
      { ...create, policyVersion: PG_INT_MAX + 1 },
      ['policyVersion'],
    )
  })
})
