import { describe, expect, it } from 'vitest'
import {
  confirmPossibleDuplicateSchema,
  jobAvailabilitySchema,
  jobCollectionCoverageSchema,
  jobCollectionOutcomeSchema,
  jobCollectionReportSchema,
  jobIdentityKindSchema,
  jobOpportunityLinkDecisionSchema,
  jobOpportunityMatchOutcomeSchema,
  jobQueueScopedQuerySchema,
  jobQueueSeniorPageSchema,
  jobQueueSourcePageSchema,
  jobQueueTeamTriageGrantSchema,
  jobQueueTeamTriageSubscriptionSchema,
  jobQueueTeamTriageSubscriptionWorkerSchema,
  jobSourceIdentitySchema,
  jobSourceRevisionSchema,
  createJobQueueTeamTriageGrantSchema,
  revokeJobQueueTeamTriageGrantSchema,
  createJobQueueTeamTriageSubscriptionSchema,
  revokeJobQueueTeamTriageSubscriptionSchema,
  jobQueueQuerySchema,
  jobPossibleDuplicatesPreviewSchema,
} from './job-sourcing'

/**
 * r5 Task 1.1 — contracts of the new vacancy-sourcing store (job_opportunities
 * family). Every bound is asserted from both sides.
 */

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const SHA = 'a'.repeat(64)
const NOW = '2026-10-14T10:00:00.000Z'

describe('store enums (order = pg enum order)', () => {
  it('has exactly the specified members in order', () => {
    expect(jobAvailabilitySchema.options).toEqual(['OPEN', 'UNKNOWN', 'CLOSED', 'EXPIRED'])
    expect(jobCollectionOutcomeSchema.options).toEqual([
      'STARTED',
      'PARTIAL',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
    ])
    expect(jobCollectionCoverageSchema.options).toEqual(['FULL_INVENTORY', 'WINDOW', 'PARTIAL'])
    expect(jobIdentityKindSchema.options).toEqual(['NATIVE_ID', 'URL_FALLBACK'])
    expect(jobOpportunityMatchOutcomeSchema.options).toEqual(['LEAD', 'TRIAGE', 'EXCLUDED'])
    expect(jobOpportunityLinkDecisionSchema.options).toEqual(['AUTO', 'CONFIRMED'])
  })
})

describe('jobSourceIdentitySchema', () => {
  const ok = {
    sourceType: 'GREENHOUSE_ATS',
    namespace: 'acme',
    identityKind: 'NATIVE_ID',
    identityKey: '12345',
  }
  it('accepts a scoped native identity', () => {
    expect(jobSourceIdentitySchema.safeParse(ok).success).toBe(true)
  })
  it('namespace defaults to empty (global providers) and is capped at 200', () => {
    expect(jobSourceIdentitySchema.parse({ ...ok, namespace: undefined }).namespace).toBe('')
    expect(jobSourceIdentitySchema.safeParse({ ...ok, namespace: 'n'.repeat(200) }).success).toBe(
      true,
    )
    expect(jobSourceIdentitySchema.safeParse({ ...ok, namespace: 'n'.repeat(201) }).success).toBe(
      false,
    )
  })
  it('identity key is non-empty and capped at 2048', () => {
    expect(jobSourceIdentitySchema.safeParse({ ...ok, identityKey: '' }).success).toBe(false)
    expect(
      jobSourceIdentitySchema.safeParse({ ...ok, identityKey: 'k'.repeat(2048) }).success,
    ).toBe(true)
    expect(
      jobSourceIdentitySchema.safeParse({ ...ok, identityKey: 'k'.repeat(2049) }).success,
    ).toBe(false)
  })
  it('rejects unknown provider / kind and unknown keys', () => {
    expect(jobSourceIdentitySchema.safeParse({ ...ok, sourceType: 'NOPE' }).success).toBe(false)
    expect(jobSourceIdentitySchema.safeParse({ ...ok, identityKind: 'GUESS' }).success).toBe(false)
    expect(jobSourceIdentitySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
})

describe('jobSourceRevisionSchema', () => {
  const ok = {
    id: U1,
    sourceRecordId: U2,
    adapterVersion: 'greenhouse@1',
    normalizerVersion: 'norm@1',
    contentHash: SHA,
    descriptionSha256: SHA,
    title: 'Senior Engineer',
    companyName: null,
    location: null,
    applicationUrl: 'https://example.com/apply',
    publishedAtRaw: 'yesterday',
    publishedAt: null,
    fieldProvenance: { title: U1 },
    receivedSeq: 1,
    receivedAt: NOW,
  }
  it('accepts a valid revision', () => {
    expect(jobSourceRevisionSchema.safeParse(ok).success).toBe(true)
  })
  it('content hash must be 64 lowercase hex', () => {
    expect(jobSourceRevisionSchema.safeParse({ ...ok, contentHash: 'A'.repeat(64) }).success).toBe(
      false,
    )
    expect(jobSourceRevisionSchema.safeParse({ ...ok, contentHash: 'a'.repeat(63) }).success).toBe(
      false,
    )
  })
  it('navigation URLs are https-only (untrusted content)', () => {
    expect(
      jobSourceRevisionSchema.safeParse({ ...ok, applicationUrl: 'javascript:alert(1)' }).success,
    ).toBe(false)
    expect(
      jobSourceRevisionSchema.safeParse({ ...ok, applicationUrl: 'http://example.com/a' }).success,
    ).toBe(false)
  })
  it('title is bounded to 500, receivedSeq is a positive integer', () => {
    expect(jobSourceRevisionSchema.safeParse({ ...ok, title: 't'.repeat(500) }).success).toBe(true)
    expect(jobSourceRevisionSchema.safeParse({ ...ok, title: 't'.repeat(501) }).success).toBe(false)
    expect(jobSourceRevisionSchema.safeParse({ ...ok, receivedSeq: 0 }).success).toBe(false)
  })
  it('field provenance maps a field to a revision uuid only', () => {
    expect(
      jobSourceRevisionSchema.safeParse({ ...ok, fieldProvenance: { title: 'x' } }).success,
    ).toBe(false)
  })
})

describe('jobCollectionReportSchema', () => {
  const ok = {
    sourceId: U1,
    outcome: 'SUCCEEDED',
    coverage: 'FULL_INVENTORY',
    received: 10,
    created: 4,
    revised: 3,
    unchanged: 1,
    duplicates: 1,
    invalid: 1,
    persistenceErrors: 0,
  }
  it('a SUCCEEDED report may carry zero items', () => {
    const zero = {
      ...ok,
      received: 0,
      created: 0,
      revised: 0,
      unchanged: 0,
      duplicates: 0,
      invalid: 0,
    }
    expect(jobCollectionReportSchema.safeParse(zero).success).toBe(true)
  })
  it('requires exactly one disposition per input item', () => {
    expect(jobCollectionReportSchema.safeParse(ok).success).toBe(true)
    expect(jobCollectionReportSchema.safeParse({ ...ok, received: 11 }).success).toBe(false)
    expect(jobCollectionReportSchema.safeParse({ ...ok, received: 9 }).success).toBe(false)
  })
  it('persistence errors are counted separately from invalid records and are inside the sum', () => {
    const r = { ...ok, outcome: 'PARTIAL', created: 3, persistenceErrors: 1 }
    expect(jobCollectionReportSchema.safeParse(r).success).toBe(true)
  })
  it('a SUCCEEDED outcome cannot hide persistence errors', () => {
    const r = { ...ok, created: 3, persistenceErrors: 1 }
    expect(jobCollectionReportSchema.safeParse(r).success).toBe(false)
  })
  it('rejects negatives / fractions / unknown outcome', () => {
    expect(jobCollectionReportSchema.safeParse({ ...ok, invalid: -1, received: 8 }).success).toBe(
      false,
    )
    expect(jobCollectionReportSchema.safeParse({ ...ok, outcome: 'DONE' }).success).toBe(false)
    expect(jobCollectionReportSchema.safeParse({ ...ok, created: 4.5 }).success).toBe(false)
  })
})

describe('team scope', () => {
  it('scoped query keeps the legacy query rules and requires teamId', () => {
    expect(jobQueueScopedQuerySchema.safeParse({ teamId: U1 }).success).toBe(true)
    expect(jobQueueScopedQuerySchema.safeParse({}).success).toBe(false)
    expect(jobQueueScopedQuerySchema.safeParse({ teamId: 'x' }).success).toBe(false)
    expect(jobQueueScopedQuerySchema.parse({ teamId: U1 }).limit).toBe(20)
    expect(jobQueueScopedQuerySchema.safeParse({ teamId: U1, limit: 51 }).success).toBe(false)
    // legacy query is untouched: still has no teamId requirement
    expect(jobQueueQuerySchema.safeParse({}).success).toBe(true)
  })
})

describe('paged associations', () => {
  it('senior page requires the total matched count', () => {
    expect(
      jobQueueSeniorPageSchema.safeParse({
        items: [{ id: U1, displayName: 'A' }],
        totalMatchedSeniorCount: 1,
        nextCursor: null,
      }).success,
    ).toBe(true)
    expect(jobQueueSeniorPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false)
  })
  it('source page derives alsoSeenOn count = max(total-1, 0)', () => {
    // A positive total carries a primary and a zero total carries none (R11-L-3,
    // pinned in its own describe below), so each case here supplies the matching
    // primary: this test is about the count, not about the primary.
    const base = {
      items: [],
      relationVersion: 1,
      nextCursor: null,
    }
    const withPrimary = { ...base, primarySourceRecordId: U1 }
    const noPrimary = { ...base, primarySourceRecordId: null }
    expect(
      jobQueueSourcePageSchema.parse({
        ...withPrimary,
        totalSourceCount: 3,
        totalAlsoSeenOnCount: 2,
      }).totalAlsoSeenOnCount,
    ).toBe(2)
    expect(
      jobQueueSourcePageSchema.safeParse({
        ...withPrimary,
        totalSourceCount: 3,
        totalAlsoSeenOnCount: 3,
      }).success,
    ).toBe(false)
    expect(
      jobQueueSourcePageSchema.safeParse({
        ...noPrimary,
        totalSourceCount: 0,
        totalAlsoSeenOnCount: 0,
      }).success,
    ).toBe(true)
    expect(
      jobQueueSourcePageSchema.safeParse({
        ...noPrimary,
        totalSourceCount: 0,
        totalAlsoSeenOnCount: 1,
      }).success,
    ).toBe(false)
  })
  it('source page items carry https-only urls', () => {
    const item = {
      sourceRecordId: U1,
      sourceType: 'DJINNI_RSS',
      url: 'javascript:alert(1)',
      linkedAt: NOW,
    }
    expect(
      jobQueueSourcePageSchema.safeParse({
        items: [item],
        totalSourceCount: 1,
        totalAlsoSeenOnCount: 0,
        primarySourceRecordId: U1,
        relationVersion: 1,
        nextCursor: null,
      }).success,
    ).toBe(false)
  })
  it('possibleDuplicates preview is bounded; confirm refuses an extra key and a self-duplicate', () => {
    // R11-M-8: the previous title claimed `confirm is strict` while the body
    // never passed an unknown key, so `.strict()` could have been dropped with
    // the test still green. The claim is now asserted, and the title says what
    // the body does.
    expect(
      confirmPossibleDuplicateSchema.safeParse({
        opportunityId: U1,
        duplicateOpportunityId: U2,
        expectedRelationVersion: 1,
        extra: 1,
      }).success,
    ).toBe(false)
    expect(
      confirmPossibleDuplicateSchema.safeParse({
        opportunityId: U1,
        duplicateOpportunityId: U2,
        expectedRelationVersion: 1,
      }).success,
    ).toBe(true)
    expect(
      confirmPossibleDuplicateSchema.safeParse({
        opportunityId: U1,
        duplicateOpportunityId: U1,
        expectedRelationVersion: 1,
      }).success,
    ).toBe(false)
    const dup = { opportunityId: U2, title: 'Dev', companyName: null }
    expect(
      jobPossibleDuplicatesPreviewSchema.safeParse({ items: [dup], totalCount: 1 }).success,
    ).toBe(true)
    expect(
      jobPossibleDuplicatesPreviewSchema.safeParse({
        items: Array(5).fill(dup),
        totalCount: 9,
      }).success,
    ).toBe(true)
    expect(
      jobPossibleDuplicatesPreviewSchema.safeParse({
        items: Array(6).fill(dup),
        totalCount: 9,
      }).success,
    ).toBe(false)
    expect(
      jobPossibleDuplicatesPreviewSchema.safeParse({ items: [dup], totalCount: 0 }).success,
    ).toBe(false)
  })
})

describe('team triage grants and subscriptions', () => {
  const grant = {
    opportunityId: U1,
    teamId: U2,
    expectedOpportunityRevision: 1,
    policyVersion: 1,
    reason: 'wrong team',
    expiresAt: NOW,
  }
  it('create grant: strict, bounded reason, expiry required', () => {
    expect(createJobQueueTeamTriageGrantSchema.safeParse(grant).success).toBe(true)
    expect(createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, extra: 1 }).success).toBe(
      false,
    )
    expect(
      createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, reason: 'r'.repeat(500) }).success,
    ).toBe(true)
    expect(
      createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, reason: 'r'.repeat(501) }).success,
    ).toBe(false)
    expect(createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, reason: '' }).success).toBe(
      false,
    )
    expect(
      createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, expiresAt: undefined }).success,
    ).toBe(false)
  })
  it('revoke grant needs the expected grant version', () => {
    const r = { opportunityId: U1, teamId: U2, expectedGrantVersion: 2, reason: 'done' }
    expect(revokeJobQueueTeamTriageGrantSchema.safeParse(r).success).toBe(true)
    expect(
      revokeJobQueueTeamTriageGrantSchema.safeParse({ ...r, expectedGrantVersion: undefined })
        .success,
    ).toBe(false)
  })
  it('grant row: carries evidence/policy/revision/expiry', () => {
    expect(
      jobQueueTeamTriageGrantSchema.safeParse({
        id: U1,
        opportunityId: U2,
        teamId: U3,
        assignedBy: U1,
        policyVersion: 1,
        opportunityRevision: 1,
        grantVersion: 1,
        evidence: {},
        expiresAt: NOW,
        revokedAt: null,
        createdAt: NOW,
      }).success,
    ).toBe(true)
  })
  it('subscription create: source filter bounded by the provider count (31)', () => {
    const s = {
      teamId: U1,
      roleFamily: 'backend',
      sourceTypes: ['DJINNI_RSS'],
      policyVersion: 1,
      expiresAt: NOW,
      reason: 'standing triage',
    }
    expect(createJobQueueTeamTriageSubscriptionSchema.safeParse(s).success).toBe(true)
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...s, sourceTypes: [] }).success,
    ).toBe(true)
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({
        ...s,
        sourceTypes: Array(32).fill('DJINNI_RSS'),
      }).success,
    ).toBe(false)
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...s, roleFamily: 'r'.repeat(101) })
        .success,
    ).toBe(false)
  })
  it('subscription revoke + row', () => {
    expect(
      revokeJobQueueTeamTriageSubscriptionSchema.safeParse({
        subscriptionId: U1,
        expectedSubscriptionVersion: 1,
        reason: 'x',
      }).success,
    ).toBe(true)
    expect(
      jobQueueTeamTriageSubscriptionSchema.safeParse({
        id: U1,
        teamId: U2,
        roleFamily: 'backend',
        sourceTypes: [],
        policyVersion: 1,
        subscriptionVersion: 1,
        actorId: U3,
        expiresAt: NOW,
        revokedAt: null,
        createdAt: NOW,
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mutation-gate coverage: exact messages / paths / boundaries / output shapes.
// ---------------------------------------------------------------------------

const issuesOf = (r: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (r.error?.issues ?? []).map((i) => {
    const { code, message, path } = i as { code: string; message: string; path: unknown[] }
    return { code, message, path }
  })

describe('mutation coverage: revision', () => {
  const rev = {
    id: U1,
    sourceRecordId: U2,
    adapterVersion: 'greenhouse@1',
    normalizerVersion: 'norm@1',
    contentHash: SHA,
    descriptionSha256: SHA,
    title: 'Senior Engineer',
    companyName: 'Acme',
    location: 'Kyiv',
    applicationUrl: 'https://example.com/apply',
    publishedAtRaw: 'yesterday',
    publishedAt: null,
    fieldProvenance: { title: U1 },
    receivedSeq: 1,
    receivedAt: NOW,
  }

  it('hash is anchored on both ends and carries its message', () => {
    expect(jobSourceRevisionSchema.safeParse({ ...rev, contentHash: `g${SHA}` }).success).toBe(
      false,
    )
    expect(jobSourceRevisionSchema.safeParse({ ...rev, contentHash: `${SHA}g` }).success).toBe(
      false,
    )
    const bad = jobSourceRevisionSchema.safeParse({ ...rev, contentHash: 'zz' })
    expect(issuesOf(bad)[0]?.message).toBe('must be 64 lowercase hex characters')
  })

  it('companyName / location accept ordinary values and are capped at 255 / 500', () => {
    const parsed = jobSourceRevisionSchema.parse(rev)
    expect(parsed.companyName).toBe('Acme')
    expect(parsed.location).toBe('Kyiv')
    expect(
      jobSourceRevisionSchema.safeParse({ ...rev, companyName: 'c'.repeat(255) }).success,
    ).toBe(true)
    expect(
      jobSourceRevisionSchema.safeParse({ ...rev, companyName: 'c'.repeat(256) }).success,
    ).toBe(false)
    expect(jobSourceRevisionSchema.safeParse({ ...rev, location: 'l'.repeat(500) }).success).toBe(
      true,
    )
    expect(jobSourceRevisionSchema.safeParse({ ...rev, location: 'l'.repeat(501) }).success).toBe(
      false,
    )
  })

  it('field provenance holds at most 40 entries, with a message', () => {
    const entries = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, U1]))
    expect(
      jobSourceRevisionSchema.safeParse({ ...rev, fieldProvenance: entries(40) }).success,
    ).toBe(true)
    const over = jobSourceRevisionSchema.safeParse({ ...rev, fieldProvenance: entries(41) })
    expect(over.success).toBe(false)
    expect(issuesOf(over).map((i) => i.message)).toContain('too many provenance entries')
  })
})

describe('mutation coverage: collection report issues', () => {
  const ok = {
    sourceId: U1,
    outcome: 'SUCCEEDED',
    coverage: 'FULL_INVENTORY',
    received: 10,
    created: 4,
    revised: 3,
    unchanged: 1,
    duplicates: 1,
    invalid: 1,
    persistenceErrors: 0,
  }
  it('a wrong disposition sum reports one custom issue on `received`', () => {
    expect(issuesOf(jobCollectionReportSchema.safeParse({ ...ok, received: 11 }))).toEqual([
      {
        code: 'custom',
        message: 'exactly one disposition per received item',
        path: ['received'],
      },
    ])
  })
  it('a SUCCEEDED report with persistence errors reports one custom issue on `persistenceErrors`', () => {
    expect(
      issuesOf(jobCollectionReportSchema.safeParse({ ...ok, created: 3, persistenceErrors: 1 })),
    ).toEqual([
      {
        code: 'custom',
        message: 'a SUCCEEDED attempt cannot carry persistence errors',
        path: ['persistenceErrors'],
      },
    ])
  })
})

describe('mutation coverage: pages and duplicates', () => {
  const sourceBase = {
    items: [],
    totalSourceCount: 3,
    totalAlsoSeenOnCount: 2,
    // A positive total requires a primary (R11-L-3), so this base carries one.
    primarySourceRecordId: U3,
    relationVersion: 1,
  }
  it('nextCursor is capped at 300 on both pages and accepts ordinary cursors', () => {
    const seniorPage = (nextCursor: string) =>
      jobQueueSeniorPageSchema.safeParse({ items: [], totalMatchedSeniorCount: 0, nextCursor })
    expect(seniorPage('abc').success).toBe(true)
    expect(seniorPage('c'.repeat(300)).success).toBe(true)
    expect(seniorPage('c'.repeat(301)).success).toBe(false)
    const sourcePage = (nextCursor: string) =>
      jobQueueSourcePageSchema.safeParse({ ...sourceBase, nextCursor })
    expect(sourcePage('abc').success).toBe(true)
    expect(sourcePage('c'.repeat(300)).success).toBe(true)
    expect(sourcePage('c'.repeat(301)).success).toBe(false)
  })
  it('a wrong alsoSeenOn count reports its message on totalAlsoSeenOnCount', () => {
    expect(
      issuesOf(
        jobQueueSourcePageSchema.safeParse({
          ...sourceBase,
          totalAlsoSeenOnCount: 3,
          nextCursor: null,
        }),
      ),
    ).toEqual([
      {
        code: 'custom',
        message: 'totalAlsoSeenOnCount must equal max(totalSourceCount - 1, 0)',
        path: ['totalAlsoSeenOnCount'],
      },
    ])
  })
  it('possible duplicate keeps its fields and bounds title 500 / companyName 255', () => {
    const dup = { opportunityId: U2, title: 'Dev', companyName: 'Acme' }
    const preview = (d: unknown) =>
      jobPossibleDuplicatesPreviewSchema.safeParse({ items: [d], totalCount: 1 })
    const parsed = jobPossibleDuplicatesPreviewSchema.parse({ items: [dup], totalCount: 1 })
    expect(parsed.items).toEqual([dup])
    expect(preview({ ...dup, companyName: 'c'.repeat(255) }).success).toBe(true)
    expect(preview({ ...dup, companyName: 'c'.repeat(256) }).success).toBe(false)
    expect(preview({ ...dup, title: 't'.repeat(500) }).success).toBe(true)
    expect(preview({ ...dup, title: 't'.repeat(501) }).success).toBe(false)
    expect(preview({ title: 'Dev', companyName: null }).success).toBe(false)
  })
  it('self-duplicate is rejected with its message on duplicateOpportunityId', () => {
    expect(
      issuesOf(
        confirmPossibleDuplicateSchema.safeParse({
          opportunityId: U1,
          duplicateOpportunityId: U1,
          expectedRelationVersion: 1,
        }),
      ),
    ).toEqual([
      {
        code: 'custom',
        message: 'an opportunity cannot be a duplicate of itself',
        path: ['duplicateOpportunityId'],
      },
    ])
  })
})

describe('mutation coverage: triage', () => {
  const grant = {
    opportunityId: U1,
    teamId: U2,
    expectedOpportunityRevision: 1,
    policyVersion: 1,
    reason: 'wrong team',
    expiresAt: NOW,
  }
  it('reason is trimmed and a whitespace-only reason is rejected', () => {
    expect(createJobQueueTeamTriageGrantSchema.parse({ ...grant, reason: '  why  ' }).reason).toBe(
      'why',
    )
    expect(createJobQueueTeamTriageGrantSchema.safeParse({ ...grant, reason: '   ' }).success).toBe(
      false,
    )
  })
  it('roleFamily is trimmed, whitespace-only is rejected, and capped at 100', () => {
    const s = {
      teamId: U1,
      roleFamily: 'backend',
      sourceTypes: [],
      policyVersion: 1,
      expiresAt: NOW,
      reason: 'standing triage',
    }
    expect(
      createJobQueueTeamTriageSubscriptionSchema.parse({ ...s, roleFamily: '  backend  ' })
        .roleFamily,
    ).toBe('backend')
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...s, roleFamily: '   ' }).success,
    ).toBe(false)
    expect(
      createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...s, roleFamily: 'r'.repeat(100) })
        .success,
    ).toBe(true)
  })
  it('grant row round-trips every field and rejects a missing one', () => {
    const row = {
      id: U1,
      opportunityId: U2,
      teamId: U3,
      assignedBy: U1,
      policyVersion: 1,
      opportunityRevision: 2,
      grantVersion: 3,
      evidence: { why: 'x' },
      expiresAt: NOW,
      revokedAt: null,
      createdAt: NOW,
    }
    expect(jobQueueTeamTriageGrantSchema.parse(row)).toEqual(row)
    expect(
      jobQueueTeamTriageGrantSchema.safeParse({ ...row, grantVersion: undefined }).success,
    ).toBe(false)
  })
  it('subscription row round-trips every field and rejects a missing one', () => {
    const row = {
      id: U1,
      teamId: U2,
      roleFamily: 'backend',
      sourceTypes: ['DJINNI_RSS'],
      policyVersion: 1,
      subscriptionVersion: 2,
      actorId: U3,
      expiresAt: NOW,
      revokedAt: null,
      createdAt: NOW,
    }
    // SR-M-6 (PR #1017 fix round 2): the full row, actor included, is the
    // WORKER shape; the plain name drops `actorId`.
    expect(jobQueueTeamTriageSubscriptionWorkerSchema.parse(row)).toEqual(row)
    expect(
      jobQueueTeamTriageSubscriptionWorkerSchema.safeParse({ ...row, actorId: undefined }).success,
    ).toBe(false)
    expect(
      jobQueueTeamTriageSubscriptionWorkerSchema.safeParse({ ...row, roleFamily: 'r'.repeat(101) })
        .success,
    ).toBe(false)
  })
})

/**
 * R11-H-4 — the same credential guard, at the store shapes that carry a URL:
 * `jobSourceRevisionSchema.applicationUrl` (nullable) and
 * `jobQueueSourceItemSchema.url`, reached through `jobQueueSourcePageSchema`.
 */
describe('store urls reject embedded credentials (R11-H-4)', () => {
  const CREDS = 'https://user:pw@example.com/apply'
  const BARE_USER = 'https://user@example.com/apply'
  const rev = {
    id: U1,
    sourceRecordId: U2,
    adapterVersion: 'greenhouse@1',
    normalizerVersion: 'norm@1',
    contentHash: SHA,
    descriptionSha256: SHA,
    title: 'Senior Engineer',
    companyName: null,
    location: null,
    applicationUrl: 'https://example.com/apply',
    publishedAtRaw: 'yesterday',
    publishedAt: null,
    fieldProvenance: { title: U1 },
    receivedSeq: 1,
    receivedAt: NOW,
  }
  const page = (url: string) =>
    jobQueueSourcePageSchema.safeParse({
      items: [{ sourceRecordId: U1, sourceType: 'DJINNI_RSS', url, linkedAt: NOW }],
      totalSourceCount: 1,
      totalAlsoSeenOnCount: 0,
      primarySourceRecordId: U1,
      relationVersion: 1,
      nextCursor: null,
    })

  it('applicationUrl refuses credentials, keeps null and keeps an ordinary url', () => {
    expect(jobSourceRevisionSchema.safeParse(rev).success).toBe(true)
    expect(jobSourceRevisionSchema.safeParse({ ...rev, applicationUrl: null }).success).toBe(true)
    expect(jobSourceRevisionSchema.safeParse({ ...rev, applicationUrl: CREDS }).success).toBe(false)
    expect(jobSourceRevisionSchema.safeParse({ ...rev, applicationUrl: BARE_USER }).success).toBe(
      false,
    )
    // A `@` in the path is legitimate and must survive the tightening.
    expect(
      jobSourceRevisionSchema.safeParse({ ...rev, applicationUrl: 'https://host.test/a@b' })
        .success,
    ).toBe(true)
  })

  it('a source page item refuses credentials and keeps a path-level `@`', () => {
    expect(page('https://djinni.co/j/1').success).toBe(true)
    expect(page(CREDS).success).toBe(false)
    expect(page(BARE_USER).success).toBe(false)
    expect(page('https://djinni.co/j/1@2').success).toBe(true)
  })
})

/**
 * R11-M-9 — the two page item caps. `nextCursor` was pinned at 300/301 above;
 * the item arrays themselves were declarations nobody checked.
 */
describe('page item arrays are bounded (R11-M-9)', () => {
  it('senior page items: 200 pass, 201 are refused', () => {
    const senior = { id: U1, displayName: 'A' }
    const seniorPage = (n: number) =>
      jobQueueSeniorPageSchema.safeParse({
        items: Array.from({ length: n }, () => senior),
        totalMatchedSeniorCount: n,
        nextCursor: null,
      })
    expect(seniorPage(200).success).toBe(true)
    expect(seniorPage(201).success).toBe(false)
  })

  it('source page items: 50 pass, 51 are refused', () => {
    const sourceItem = {
      sourceRecordId: U1,
      sourceType: 'DJINNI_RSS',
      url: 'https://djinni.co/j/1',
      linkedAt: NOW,
    }
    const sourcePage = (n: number) =>
      jobQueueSourcePageSchema.safeParse({
        items: Array.from({ length: n }, () => sourceItem),
        totalSourceCount: n,
        totalAlsoSeenOnCount: Math.max(n - 1, 0),
        primarySourceRecordId: U1,
        relationVersion: 1,
        nextCursor: null,
      })
    expect(sourcePage(50).success).toBe(true)
    expect(sourcePage(51).success).toBe(false)
  })
})

/**
 * R11-M-8 — `.strict()` on the triage request shapes. They were strict in the
 * code and nothing would have noticed the modifier being dropped, which on a
 * request shape means an unknown key reaching a handler silently.
 */
describe('triage requests refuse unknown keys (R11-M-8)', () => {
  const REASON = 'policy review'
  it('revokeJobQueueTeamTriageGrantSchema', () => {
    const ok = {
      opportunityId: U1,
      teamId: U2,
      expectedGrantVersion: 1,
      reason: REASON,
    }
    expect(revokeJobQueueTeamTriageGrantSchema.safeParse(ok).success).toBe(true)
    expect(revokeJobQueueTeamTriageGrantSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })

  it('createJobQueueTeamTriageSubscriptionSchema', () => {
    const ok = {
      teamId: U1,
      roleFamily: 'backend',
      sourceTypes: [],
      policyVersion: 1,
      expiresAt: NOW,
      reason: REASON,
    }
    expect(createJobQueueTeamTriageSubscriptionSchema.safeParse(ok).success).toBe(true)
    expect(createJobQueueTeamTriageSubscriptionSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
      false,
    )
  })

  it('revokeJobQueueTeamTriageSubscriptionSchema', () => {
    const ok = {
      subscriptionId: U1,
      expectedSubscriptionVersion: 1,
      reason: REASON,
    }
    expect(revokeJobQueueTeamTriageSubscriptionSchema.safeParse(ok).success).toBe(true)
    expect(revokeJobQueueTeamTriageSubscriptionSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
      false,
    )
  })
})

/**
 * R11-L-3 — `primarySourceRecordId` is coupled to `totalSourceCount`.
 *
 * DECIDED, not implied: the primary exists exactly when the page has sources.
 * A positive `totalSourceCount` REQUIRES a primary (the opportunity's own
 * source record), and a zero total FORBIDS one — an opportunity with no source
 * rows has nothing a primary could point at, and the neighbouring invariant
 * `totalAlsoSeenOnCount = max(totalSourceCount - 1, 0)` already reads the
 * primary as one of the counted sources. Both halves report on
 * `primarySourceRecordId`, in the style of that refine.
 */
describe('a primary source exists exactly when the page has sources (R11-L-3)', () => {
  const base = { items: [], relationVersion: 1, nextCursor: null }
  const page = (over: Record<string, unknown>) =>
    jobQueueSourcePageSchema.safeParse({ ...base, ...over })

  it('a positive total with a null primary reports one custom issue on primarySourceRecordId', () => {
    expect(
      issuesOf(page({ totalSourceCount: 1, totalAlsoSeenOnCount: 0, primarySourceRecordId: null })),
    ).toEqual([
      {
        code: 'custom',
        message: 'a positive totalSourceCount requires primarySourceRecordId',
        path: ['primarySourceRecordId'],
      },
    ])
  })

  it('a zero total with a primary reports one custom issue on primarySourceRecordId', () => {
    expect(
      issuesOf(page({ totalSourceCount: 0, totalAlsoSeenOnCount: 0, primarySourceRecordId: U1 })),
    ).toEqual([
      {
        code: 'custom',
        message: 'a zero totalSourceCount forbids primarySourceRecordId',
        path: ['primarySourceRecordId'],
      },
    ])
  })

  it('the two matching combinations parse', () => {
    expect(
      page({ totalSourceCount: 4, totalAlsoSeenOnCount: 3, primarySourceRecordId: U1 }).success,
    ).toBe(true)
    expect(
      page({ totalSourceCount: 0, totalAlsoSeenOnCount: 0, primarySourceRecordId: null }).success,
    ).toBe(true)
  })
})
