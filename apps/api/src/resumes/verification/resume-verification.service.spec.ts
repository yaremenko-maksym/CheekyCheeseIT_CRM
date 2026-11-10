import { describe, expect, it } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { draftReset, isVerificationBusy, pickTemplateName } from './resume-verification.service'

// sha256(id) mod 4, computed once by hand: ...01 -> 2, ...02 -> 0, ...11 -> 3, ...12 -> 1.
const ID_MOD_2 = '7b3d91c4-2e5f-4a00-aa00-000000000001'
const ID_MOD_0 = '7b3d91c4-2e5f-4a00-aa00-000000000002'
const ID_MOD_3 = '7b3d91c4-2e5f-4a00-aa00-000000000011'
const ID_MOD_1 = '7b3d91c4-2e5f-4a00-aa00-000000000012'
const RUN = '0b9a1c3e-0000-4000-8000-000000000001'

describe('isVerificationBusy', () => {
  it.each([
    ['DRAFT', null, false],
    ['FAILED', null, false],
    ['AWAITING_CONFIRM', RUN, false],
    ['VERIFIED', null, false],
    ['QUEUED', RUN, true],
    ['CHECKING', RUN, true],
    // A template run on a VERIFIED resume (Task 16) keeps the status.
    ['VERIFIED', RUN, true],
  ] as const)('%s with run %s -> %s', (verificationStatus, verificationRunId, busy) => {
    expect(isVerificationBusy({ verificationStatus, verificationRunId })).toBe(busy)
  })
})

describe('pickTemplateName', () => {
  it('new resume in a team using classic×2, modern×1 gets compact or technical deterministically', () => {
    const counts = { classic: 2, modern: 1 }
    expect(pickTemplateName(counts, ID_MOD_2)).toBe('compact')
    expect(pickTemplateName(counts, ID_MOD_3)).toBe('technical')
    expect(pickTemplateName(counts, ID_MOD_0)).toBe('compact')
    expect(pickTemplateName(counts, ID_MOD_1)).toBe('compact')
    expect(pickTemplateName(counts, ID_MOD_3)).toBe('technical')
  })

  it('with no team the hash alone picks the catalog entry', () => {
    expect(pickTemplateName({}, ID_MOD_0)).toBe('classic')
    expect(pickTemplateName({}, ID_MOD_1)).toBe('modern')
    expect(pickTemplateName({}, ID_MOD_2)).toBe('compact')
    expect(pickTemplateName({}, ID_MOD_3)).toBe('technical')
  })

  it('the single least-used name wins over the hash', () => {
    expect(pickTemplateName({ classic: 1, modern: 1, compact: 1 }, ID_MOD_0)).toBe('technical')
    expect(pickTemplateName({ classic: 3, modern: 0, compact: 2, technical: 1 }, ID_MOD_3)).toBe(
      'modern',
    )
  })
})

describe('draftReset', () => {
  it('bumps the version in SQL, so a concurrent bump is never lost', () => {
    const version = draftReset().version as SQL
    expect(new PgDialect().sqlToQuery(version).sql).toBe('"senior_resumes"."version" + 1')
  })

  it('clears the run fields and every staged column', () => {
    expect(draftReset()).toMatchObject({
      verificationStatus: 'DRAFT',
      verificationRunId: null,
      verificationKind: null,
      verificationTargetPath: null,
      verificationBaseVersion: null,
      verificationQueuedAt: null,
      verificationStartedAt: null,
      verificationErrorCode: null,
      verificationReport: null,
      stagedContent: null,
      stagedLayout: null,
      stagedTemplateName: null,
      stagedPdfS3Key: null,
      stagedEditedPaths: [],
    })
  })
})
