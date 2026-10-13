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
    const base = {
      items: [],
      primarySourceRecordId: null,
      relationVersion: 1,
      nextCursor: null,
    }
    expect(
      jobQueueSourcePageSchema.parse({ ...base, totalSourceCount: 3, totalAlsoSeenOnCount: 2 })
        .totalAlsoSeenOnCount,
    ).toBe(2)
    expect(
      jobQueueSourcePageSchema.safeParse({ ...base, totalSourceCount: 3, totalAlsoSeenOnCount: 3 })
        .success,
    ).toBe(false)
    expect(
      jobQueueSourcePageSchema.safeParse({ ...base, totalSourceCount: 0, totalAlsoSeenOnCount: 0 })
        .success,
    ).toBe(true)
    expect(
      jobQueueSourcePageSchema.safeParse({ ...base, totalSourceCount: 0, totalAlsoSeenOnCount: 1 })
        .success,
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
  it('possibleDuplicates preview is bounded; confirm is strict', () => {
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
