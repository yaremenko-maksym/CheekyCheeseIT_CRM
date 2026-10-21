/*
 * `expectOnlyIssue` and `refusedAt` below ARE the assertions of this file — they
 * call `expect` internally. Teach the rule about them rather than disabling it,
 * so a test that genuinely asserts nothing is still caught.
 */
/* eslint vitest/expect-expect: ["error", { assertFunctionNames: ["expect", "expectOnlyIssue", "refusedAt"] }] */
import { describe, expect, it } from 'vitest'
import {
  jobQueueActionKindSchema,
  jobQueueActionWorkerSchema,
  jobQueueAssignmentSchema,
  jobQueueAssignmentStateSchema,
  jobQueueAssignmentWorkerSchema,
  jobQueueDismissalSchema,
  jobQueueDismissalWorkerSchema,
  jobQueueGenerationEntryWorkerSchema,
  jobQueueGenerationSchema,
  jobQueueGenerationStatusSchema,
  jobQueueGenerationWorkerSchema,
  jobQueueScopeKindSchema,
  jobQueueScopeSchema,
  jobQueueTeamTriageSubscriptionSchema,
  jobQueueTeamTriageSubscriptionWorkerSchema,
  createJobQueueTeamTriageSubscriptionSchema,
  createJobQueueTeamTriageGrantSchema,
  revokeJobQueueTeamTriageGrantSchema,
  revokeJobQueueTeamTriageSubscriptionSchema,
  jobSignalKindSchema,
} from './job-sourcing'

/**
 * r5 Task 1.2 (part 3) — the QUEUE workflow contracts: assignments, dismissals,
 * the action log (append-only by intent; not yet enforced by the database),
 * published generations and their entries.
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
        // r5 Task 1.4b-ii, appended LAST: the redaction evidence row. The member
        // list is pinned in ORDER on purpose, so this line is the record that the
        // value was added deliberately rather than a reorder slipping through.
        'REASON_REDACTED',
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

describe('jobQueueDismissalWorkerSchema — the stored row', () => {
  it('accepts a TEAM, a STUDIO and an undone dismissal', () => {
    expect(jobQueueDismissalWorkerSchema.parse(dismissal)).toEqual(dismissal)
    expect(jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, scope: STUDIO }).success).toBe(
      true,
    )
    expect(
      jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, undoneAt: LATER, undoneBy: U1 })
        .success,
    ).toBe(true)
  })

  it('refuses each half of the undo pair alone', () => {
    expectOnlyIssue(jobQueueDismissalWorkerSchema, { ...dismissal, undoneAt: LATER }, UNDO_PAIR, [
      'undoneAt',
    ])
    expectOnlyIssue(jobQueueDismissalWorkerSchema, { ...dismissal, undoneBy: U1 }, UNDO_PAIR, [
      'undoneAt',
    ])
  })

  it('bounds the reason and the version', () => {
    refusedAt(jobQueueDismissalWorkerSchema, { ...dismissal, reason: '' }, ['reason'])
    expect(jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, reason: 'r' }).success).toBe(
      true,
    )
    refusedAt(jobQueueDismissalWorkerSchema, { ...dismissal, reason: 'r'.repeat(501) }, ['reason'])
    refusedAt(jobQueueDismissalWorkerSchema, { ...dismissal, version: 0 }, ['version'])
    refusedAt(jobQueueDismissalWorkerSchema, { ...dismissal, version: PG_INT_MAX + 1 }, ['version'])
  })

  it('refuses a scope whose shape is wrong for its kind', () => {
    refusedAt(
      jobQueueDismissalWorkerSchema,
      { ...dismissal, scope: { kind: 'STUDIO', teamId: U2 } },
      ['scope', 'teamId'],
    )
  })
})

describe('jobQueueDismissalSchema — the public shape (CR-M-2 / SR-M-4)', () => {
  it('carries no actor identity', () => {
    expect(jobQueueDismissalSchema.parse({ ...dismissal, undoneAt: LATER, undoneBy: U1 })).toEqual({
      id: U1,
      opportunityId: U2,
      scope: TEAM,
      reason: 'not our stack',
      dismissedAt: NOW,
      version: 1,
      undoneAt: LATER,
    })
  })
})

describe('stored text is described, not normalised (CR-L-2)', () => {
  it('returns a stored reason byte for byte — no trim on read', () => {
    expect(jobQueueDismissalWorkerSchema.parse({ ...dismissal, reason: '  padded  ' }).reason).toBe(
      '  padded  ',
    )
    expect(
      jobQueueAssignmentWorkerSchema.parse({ ...released, releaseReason: ' why ' }).releaseReason,
    ).toBe(' why ')
  })

  it('accepts a value whose only character is NBSP — Postgres stores it as non-blank', () => {
    // Measured on PG16 (en_US.utf8): U+00A0 is NOT in [[:space:]], so the
    // column CHECK accepts it. JS `\s` treats it as whitespace, so a `/\S/`
    // row rule would have refused a row the database stored.
    expect(
      jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, reason: '\u00a0' }).success,
    ).toBe(true)
  })

  it('refuses an all-ASCII-whitespace value — blank in every Postgres locale', () => {
    for (const reason of [' ', '\t\n', ' \r\f\v '])
      expect(
        issuesOf(jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, reason })),
        JSON.stringify(reason),
      ).toEqual([{ code: 'invalid_format', message: 'must not be blank', path: ['reason'] }])
  })
})

// ---------------------------------------------------------------------------
// The action log (append-only by intent; not yet enforced — see job-queue.ts)
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
  subjectActionId: null,
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
/** The redaction evidence row (r5 Task 1.4b-ii): it names an action row, nothing else. */
const redaction = {
  ...opened,
  kind: 'REASON_REDACTED',
  opportunityId: null,
  sourceRecordId: null,
  subscriptionId: null,
  subjectActionId: U1,
  beforeVersion: null,
  afterVersion: null,
  idempotencyKey: 'dsar-2026-000123',
}
const TARGET =
  'a subscription action targets a subscription only; a REASON_REDACTED action targets the action row it redacts; every other action targets an opportunity and no subscription'
const CLICKED = 'OPENED / DEAD_LINK / SPAM reference the clicked source record'
const SUBJECT_TEAM = 'a TRIAGE_* action names the team it concerns, and only a TRIAGE_* action does'
const SUBJECT_USER = 'a REASSIGNED action names the new assignee, and only a REASSIGNED action does'
const VERSIONS =
  'telemetry (OPENED / DEAD_LINK / SPAM) and REASON_REDACTED carry no version; SUPPRESSED may carry none; every other action moves the version forward'

describe('jobQueueActionWorkerSchema — server-internal (actor, key, subject user)', () => {
  it('accepts one valid row per shape: telemetry, a claim, a subscription, a grant, a reassign', () => {
    expect(jobQueueActionWorkerSchema.parse(opened)).toEqual(opened)
    for (const kind of ['DEAD_LINK', 'SPAM'])
      expect(jobQueueActionWorkerSchema.safeParse({ ...opened, kind }).success).toBe(true)
    expect(jobQueueActionWorkerSchema.parse(takeAction)).toEqual(takeAction)
    expect(jobQueueActionWorkerSchema.parse(subscribed)).toEqual(subscribed)
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...subscribed, kind: 'TRIAGE_UNSUBSCRIBED' }).success,
    ).toBe(true)
    const granted = { ...takeAction, kind: 'TRIAGE_GRANTED', scope: STUDIO, subjectTeamId: U2 }
    expect(jobQueueActionWorkerSchema.safeParse(granted).success).toBe(true)
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...granted, kind: 'TRIAGE_REVOKED' }).success,
    ).toBe(true)
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, kind: 'REASSIGNED', subjectUserId: U1 })
        .success,
    ).toBe(true)
    for (const kind of ['DISMISSED', 'UNDONE', 'RELEASED', 'SUPPRESSED'])
      expect(jobQueueActionWorkerSchema.safeParse({ ...takeAction, kind }).success).toBe(true)
    // An optional source record on a non-telemetry action is allowed (r5).
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, sourceRecordId: U3 }).success,
    ).toBe(true)
  })

  it('refuses every wrong target combination', () => {
    // An opportunity action without an opportunity.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...takeAction, opportunityId: null }, TARGET, [
      'opportunityId',
    ])
    // An opportunity action that also names a subscription.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...takeAction, subscriptionId: U1 }, TARGET, [
      'opportunityId',
    ])
    // A subscription action without its subscription.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...subscribed, subscriptionId: null }, TARGET, [
      'opportunityId',
    ])
    // A subscription action that also names an opportunity.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...subscribed, opportunityId: U2 }, TARGET, [
      'opportunityId',
    ])
    // A subscription action that names a source record.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...subscribed, sourceRecordId: U3 }, TARGET, [
      'opportunityId',
    ])
  })

  it('requires the clicked source record on every telemetry kind', () => {
    for (const kind of ['OPENED', 'DEAD_LINK', 'SPAM'])
      expectOnlyIssue(
        jobQueueActionWorkerSchema,
        { ...opened, kind, sourceRecordId: null },
        CLICKED,
        ['sourceRecordId'],
      )
  })

  it('names the subject team on TRIAGE_* actions only', () => {
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      { ...subscribed, subjectTeamId: null },
      SUBJECT_TEAM,
      ['subjectTeamId'],
    )
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      { ...takeAction, kind: 'TRIAGE_GRANTED', subjectTeamId: null },
      SUBJECT_TEAM,
      ['subjectTeamId'],
    )
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      { ...takeAction, subjectTeamId: U2 },
      SUBJECT_TEAM,
      ['subjectTeamId'],
    )
  })

  it('names the new assignee on REASSIGNED only', () => {
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      { ...takeAction, kind: 'REASSIGNED' },
      SUBJECT_USER,
      ['subjectUserId'],
    )
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      { ...takeAction, subjectUserId: U1 },
      SUBJECT_USER,
      ['subjectUserId'],
    )
  })

  it('refuses every wrong version combination', () => {
    for (const v of [
      { beforeVersion: 0 },
      { afterVersion: 1 },
      { beforeVersion: 0, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionWorkerSchema, { ...opened, ...v }, VERSIONS, ['afterVersion'])
    for (const v of [
      { beforeVersion: null },
      { afterVersion: null },
      { beforeVersion: null, afterVersion: null },
      { beforeVersion: 1, afterVersion: 1 },
      { beforeVersion: 2, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionWorkerSchema, { ...takeAction, ...v }, VERSIONS, [
        'afterVersion',
      ])
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, beforeVersion: 4, afterVersion: 5 })
        .success,
    ).toBe(true)
  })

  it('lets SUPPRESSED carry no version, or a forward pair, and nothing else (SPEC-M-1)', () => {
    const suppressed = { ...takeAction, kind: 'SUPPRESSED', scope: STUDIO }
    for (const v of [
      { beforeVersion: null, afterVersion: null },
      { beforeVersion: 0, afterVersion: 1 },
    ])
      expect(jobQueueActionWorkerSchema.safeParse({ ...suppressed, ...v }).success).toBe(true)
    for (const v of [
      { beforeVersion: 0, afterVersion: null },
      { beforeVersion: null, afterVersion: 1 },
      { beforeVersion: 1, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionWorkerSchema, { ...suppressed, ...v }, VERSIONS, [
        'afterVersion',
      ])
    // A triage grant targets `grant_version`: it stays versioned.
    expectOnlyIssue(
      jobQueueActionWorkerSchema,
      {
        ...takeAction,
        kind: 'TRIAGE_GRANTED',
        scope: STUDIO,
        subjectTeamId: U2,
        beforeVersion: null,
        afterVersion: null,
      },
      VERSIONS,
      ['afterVersion'],
    )
  })

  it('bounds the idempotency key, the reason and the version columns', () => {
    refusedAt(jobQueueActionWorkerSchema, { ...takeAction, idempotencyKey: '' }, ['idempotencyKey'])
    // ASCII-whitespace-only is blank in every Postgres locale, so a stored row can
    // never hold it: the row schema refusing it can never reject a stored row.
    expect(
      issuesOf(jobQueueActionWorkerSchema.safeParse({ ...takeAction, idempotencyKey: ' \t ' })),
    ).toEqual([{ code: 'invalid_format', message: 'must not be blank', path: ['idempotencyKey'] }])
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, idempotencyKey: 'k' }).success,
    ).toBe(true)
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, idempotencyKey: 'k'.repeat(200) })
        .success,
    ).toBe(true)
    refusedAt(jobQueueActionWorkerSchema, { ...takeAction, idempotencyKey: 'k'.repeat(201) }, [
      'idempotencyKey',
    ])
    refusedAt(jobQueueActionWorkerSchema, { ...takeAction, reason: ' ' }, ['reason'])
    refusedAt(jobQueueActionWorkerSchema, { ...takeAction, reason: 'r'.repeat(501) }, ['reason'])
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...takeAction, reason: 'r'.repeat(500) }).success,
    ).toBe(true)
    refusedAt(jobQueueActionWorkerSchema, { ...takeAction, beforeVersion: -1 }, ['beforeVersion'])
    refusedAt(
      jobQueueActionWorkerSchema,
      { ...takeAction, beforeVersion: 1, afterVersion: PG_INT_MAX + 1 },
      ['afterVersion'],
    )
  })
})

// ---------------------------------------------------------------------------
// The redaction evidence row (r5 Task 1.4b-ii)
//
// Each accepted shape below is paired with the near-misses the branch must STILL
// refuse. The refusals are the half that matters: a branch widened one clause
// too far is indistinguishable from a correct one until the wrong row arrives,
// and this log is append-only, so the wrong row cannot be taken back out.
// ---------------------------------------------------------------------------

describe('jobQueueActionWorkerSchema — REASON_REDACTED points at an action row', () => {
  it('accepts the evidence row: a subject action, no opportunity, no versions', () => {
    expect(jobQueueActionWorkerSchema.parse(redaction)).toEqual(redaction)
  })

  it('still refuses a redaction that names no subject action at all', () => {
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...redaction, subjectActionId: null }, TARGET, [
      'subjectActionId',
    ])
  })

  it('still refuses a redaction that also reaches outside this log', () => {
    // One clause per target column the third branch forces to NULL. Without
    // these, a redaction could carry an opportunity (or a source record, or a
    // subscription) and the row would claim two subjects at once.
    for (const v of [{ opportunityId: U2 }, { sourceRecordId: U3 }, { subscriptionId: U1 }])
      expectOnlyIssue(jobQueueActionWorkerSchema, { ...redaction, ...v }, TARGET, [
        'subjectActionId',
      ])
  })

  it('still refuses a redaction carrying versions — MUST be unversioned, unlike SUPPRESSED', () => {
    // The distinction this pins: SUPPRESSED MAY carry a moving pair, a redaction
    // may NOT. If `kind <> 'REASON_REDACTED'` is dropped from the last branch of
    // ck_job_queue_actions_versions, a moving pair starts passing and this goes red.
    for (const v of [
      { beforeVersion: 0, afterVersion: 1 },
      { beforeVersion: 4, afterVersion: 5 },
      { beforeVersion: 0, afterVersion: null },
      { beforeVersion: null, afterVersion: 1 },
    ])
      expectOnlyIssue(jobQueueActionWorkerSchema, { ...redaction, ...v }, VERSIONS, [
        'afterVersion',
      ])
  })

  it('still refuses a redaction naming a subject team or a subject user', () => {
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...redaction, subjectTeamId: U2 }, SUBJECT_TEAM, [
      'subjectTeamId',
    ])
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...redaction, subjectUserId: U2 }, SUBJECT_USER, [
      'subjectUserId',
    ])
  })

  it('leaves every OTHER kind unable to carry a subject action', () => {
    // The two pre-existing target branches were NARROWED by this change, and
    // this is that narrowing: the new column belongs to the redaction alone.
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...takeAction, subjectActionId: U1 }, TARGET, [
      'opportunityId',
    ])
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...opened, subjectActionId: U1 }, TARGET, [
      'opportunityId',
    ])
    expectOnlyIssue(jobQueueActionWorkerSchema, { ...subscribed, subjectActionId: U1 }, TARGET, [
      'opportunityId',
    ])
  })

  it('keeps the clicked-source rule off the redaction — TELEMETRY_ACTIONS is not its set', () => {
    // If REASON_REDACTED were folded into the telemetry set, this row would be
    // required to name a clicked source record, and the shape above would be
    // refused rather than accepted. That is why it got its own branch.
    expect(jobQueueActionWorkerSchema.safeParse(redaction).success).toBe(true)
    expect(
      issuesOf(jobQueueActionWorkerSchema.safeParse({ ...redaction, sourceRecordId: U3 })).map(
        (i) => i.message,
      ),
    ).not.toContain(CLICKED)
  })

  it('accepts a redaction in either scope, and leaves the scope rule unchanged', () => {
    // Deliberately NOT constrained to STUDIO — see the schema header.
    expect(jobQueueActionWorkerSchema.safeParse({ ...redaction, scope: STUDIO }).success).toBe(true)
    expect(jobQueueActionWorkerSchema.safeParse({ ...redaction, scope: TEAM }).success).toBe(true)
  })

  it('accepts a dangling subject action id — the subject is purged first, by design', () => {
    // There is no FK, so zod cannot and must not require the referent to exist.
    expect(
      jobQueueActionWorkerSchema.safeParse({ ...redaction, subjectActionId: U3 }).success,
    ).toBe(true)
  })

  it('refuses a subject action id that is not a uuid', () => {
    refusedAt(jobQueueActionWorkerSchema, { ...redaction, subjectActionId: 'not-a-uuid' }, [
      'subjectActionId',
    ])
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
    for (const field of ['policySignature', 'ruleVersion'])
      expect(
        issuesOf(jobQueueGenerationWorkerSchema.safeParse({ ...building, [field]: '   ' })),
      ).toEqual([{ code: 'invalid_format', message: 'must not be blank', path: [field] }])
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

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

/**
 * The code points Postgres's `[[:space:]]` matches on the catalog these
 * columns live in — ENUMERATED on PG16 / en_US.utf8 (every BMP code point
 * tested with `chr(cp) ~ '[[:space:]]'`), not assumed. The column CHECK
 * `~ '[^[:space:]]'` refuses a value made only of these.
 */
const PG_BLANK = [
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u0085',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u205f',
  '\u3000',
]

describe('request reasons refuse what the column refuses (CR-M-3)', () => {
  const create = {
    teamId: U2,
    roleFamily: 'backend',
    sourceTypes: [],
    policyVersion: 1,
    expiresAt: LATER,
    reason: 'standing triage',
  }
  const grant = {
    opportunityId: U1,
    teamId: U2,
    expectedOpportunityRevision: 1,
    policyVersion: 1,
    reason: 'triage',
    expiresAt: LATER,
  }
  const revokeGrant = { opportunityId: U1, teamId: U2, expectedGrantVersion: 1, reason: 'x' }
  const revokeSub = { subscriptionId: U1, expectedSubscriptionVersion: 1, reason: 'x' }
  const BLANK = { code: 'custom', message: 'must not be blank', path: ['reason'] }

  it('refuses U+0085 alone — JS trim() keeps it, Postgres treats it as blank', () => {
    // The reviewer's reproduction: this parsed, then the column answered 23514.
    for (const [schema, body] of [
      [createJobQueueTeamTriageSubscriptionSchema, create],
      [revokeJobQueueTeamTriageSubscriptionSchema, revokeSub],
      [createJobQueueTeamTriageGrantSchema, grant],
      [revokeJobQueueTeamTriageGrantSchema, revokeGrant],
    ] as const)
      expect(issuesOf(schema.safeParse({ ...body, reason: '\u0085' }))).toEqual([BLANK])
  })

  it('refuses EVERY code point Postgres treats as blank, alone and mixed', () => {
    // ASCII whitespace is removed by trim() and refused by min(1) as too_small,
    // so only the non-ASCII members reach the refine; all must be refused.
    for (const c of PG_BLANK.filter((c) => c.charCodeAt(0) > 0x7f))
      expect(
        createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...create, reason: c }).success,
        `U+${c.charCodeAt(0).toString(16)}`,
      ).toBe(false)
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...create, reason: PG_BLANK.join('') })
        .success,
    ).toBe(false)
  })

  it('refuses every blank code point INSIDE a value trim() cannot shorten', () => {
    // U+0085 is not JS whitespace, so trim() leaves '\u0085<c>\u0085' intact and
    // the refine alone decides — this is where an ASCII member of the class is
    // observable (the mutation gate found `\v` unobserved without it).
    for (const c of PG_BLANK)
      expect(
        issuesOf(
          createJobQueueTeamTriageSubscriptionSchema.safeParse({
            ...create,
            reason: `\u0085${c}\u0085`,
          }),
        ),
        `U+${c.charCodeAt(0).toString(16)}`,
      ).toEqual([BLANK])
    // ... and the letter the `\v` -> `\V` mutant would have treated as blank.
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...create, reason: '\u0085V\u0085' })
        .success,
    ).toBe(true)
  })

  it('still accepts a reason with one real character among the blanks', () => {
    expect(
      createJobQueueTeamTriageSubscriptionSchema.parse({ ...create, reason: '\u0085x\u3000' })
        .reason,
    ).toBe('\u0085x') // trim() strips U+3000 but keeps U+0085
    // NBSP is NOT blank to Postgres, but JS trim() strips it: a lone NBSP is
    // refused (too_small) — stricter than the column, which is the safe side.
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...create, reason: '\u00a0' }).success,
    ).toBe(false)
  })

  it('applies the same rule to roleFamily, whose column has the same CHECK', () => {
    expect(
      issuesOf(
        createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...create, roleFamily: '\u0085' }),
      ),
    ).toEqual([{ code: 'custom', message: 'must not be blank', path: ['roleFamily'] }])
  })
})

describe('stored text counts characters, not UTF-16 code units (SR-L-6)', () => {
  // Zod v4's string `.max()` already counts CODE POINTS (measured: max(2)
  // accepts two U+1F600, which are four UTF-16 units) — the same unit as the
  // column's `length()`. No code change; these pin the boundary so a Zod
  // upgrade that changed the unit would fail here.

  it('accepts 500 astral characters (1000 UTF-16 units) — the column does', () => {
    const emoji = '\u{1F600}'.repeat(500)
    expect(emoji.length).toBe(1000)
    expect(jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, reason: emoji }).success).toBe(
      true,
    )
  })

  it('refuses the 501st character, counted as a code point', () => {
    for (const reason of ['\u{1F600}'.repeat(501), 'r'.repeat(501)])
      expect(
        issuesOf(jobQueueDismissalWorkerSchema.safeParse({ ...dismissal, reason })).map(
          (i) => `${i.code}:${i.path.join('.')}`,
        ),
      ).toEqual(['too_big:reason'])
  })
})

describe('triage subscription: worker vs public shape (SR-M-6)', () => {
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

  it('keeps the creating ADMIN on the worker shape only', () => {
    expect(jobQueueTeamTriageSubscriptionWorkerSchema.parse(row)).toEqual(row)
    refusedAt(jobQueueTeamTriageSubscriptionWorkerSchema, { ...row, actorId: undefined }, [
      'actorId',
    ])
    const { actorId: _actor, ...publicRow } = row
    expect(jobQueueTeamTriageSubscriptionSchema.parse(row)).toEqual(publicRow)
  })
})
