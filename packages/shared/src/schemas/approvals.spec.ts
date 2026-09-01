import { describe, expect, it } from 'vitest'
import {
  approvalGroupStatusSchema,
  approvalSchema,
  approvalStatusSchema,
  approvalSubjectTypeSchema,
  approveApprovalInputSchema,
  proposeApprovalInputSchema,
  rejectApprovalInputSchema,
} from './approvals'

const uuid1 = '123e4567-e89b-12d3-a456-426614174001'
const uuid2 = '123e4567-e89b-12d3-a456-426614174002'
const uuid3 = '123e4567-e89b-12d3-a456-426614174003'
const datetime = '2026-09-01T14:30:00.000Z'

const validApproval = {
  id: uuid1,
  subjectType: 'PROJECT_CREATION',
  subjectId: uuid2,
  approverUserId: uuid3,
  status: 'PENDING' as const,
  rejectionReason: null,
  decidedAt: null,
  proposedByUserId: uuid1,
  supersededAt: null,
  createdAt: datetime,
}

describe('approvalSubjectTypeSchema', () => {
  it('accepts any non-empty caller-owned label', () => {
    expect(() => approvalSubjectTypeSchema.parse('PROJECT_CREATION')).not.toThrow()
    expect(() => approvalSubjectTypeSchema.parse('anything-goes')).not.toThrow()
  })

  it('rejects an empty string', () => {
    expect(() => approvalSubjectTypeSchema.parse('')).toThrow()
  })

  it('rejects a string over 50 chars', () => {
    expect(() => approvalSubjectTypeSchema.parse('x'.repeat(51))).toThrow()
  })

  it('trims surrounding whitespace', () => {
    expect(approvalSubjectTypeSchema.parse('  PROJECT  ')).toBe('PROJECT')
  })
})

describe('approvalStatusSchema', () => {
  it('accepts the three known statuses', () => {
    expect(() => approvalStatusSchema.parse('PENDING')).not.toThrow()
    expect(() => approvalStatusSchema.parse('APPROVED')).not.toThrow()
    expect(() => approvalStatusSchema.parse('REJECTED')).not.toThrow()
  })

  it('rejects an unknown status', () => {
    expect(() => approvalStatusSchema.parse('CANCELLED')).toThrow()
  })
})

describe('approvalGroupStatusSchema', () => {
  it('accepts the four known aggregate values', () => {
    for (const v of ['NONE', 'PENDING', 'APPROVED', 'REJECTED']) {
      expect(() => approvalGroupStatusSchema.parse(v)).not.toThrow()
    }
  })

  it('rejects an unknown aggregate value', () => {
    expect(() => approvalGroupStatusSchema.parse('PARTIAL')).toThrow()
  })
})

describe('approvalSchema', () => {
  it('accepts a valid PENDING row', () => {
    expect(() => approvalSchema.parse(validApproval)).not.toThrow()
  })

  it('accepts a decided row with a non-null decidedAt', () => {
    expect(() =>
      approvalSchema.parse({ ...validApproval, status: 'APPROVED', decidedAt: datetime }),
    ).not.toThrow()
  })

  it('accepts a rejected row with a reason', () => {
    expect(() =>
      approvalSchema.parse({
        ...validApproval,
        status: 'REJECTED',
        rejectionReason: 'Не согласен',
        decidedAt: datetime,
      }),
    ).not.toThrow()
  })

  it('accepts a superseded row (supersededAt set)', () => {
    expect(() => approvalSchema.parse({ ...validApproval, supersededAt: datetime })).not.toThrow()
  })

  it('rejects a non-uuid id', () => {
    expect(() => approvalSchema.parse({ ...validApproval, id: 'not-a-uuid' })).toThrow()
  })

  it('rejects a non-uuid subjectId', () => {
    expect(() => approvalSchema.parse({ ...validApproval, subjectId: 'not-a-uuid' })).toThrow()
  })

  it('rejects an empty-string rejectionReason (must be null or non-empty)', () => {
    expect(() => approvalSchema.parse({ ...validApproval, rejectionReason: '' })).toThrow()
  })

  it('rejects an unknown status', () => {
    expect(() => approvalSchema.parse({ ...validApproval, status: 'MAYBE' })).toThrow()
  })
})

describe('proposeApprovalInputSchema', () => {
  const validInput = {
    subjectType: 'PROJECT_CREATION',
    subjectId: uuid2,
    approverUserIds: [uuid1, uuid3],
    proposedByUserId: uuid2,
  }

  it('accepts a valid multi-approver proposal', () => {
    expect(() => proposeApprovalInputSchema.parse(validInput)).not.toThrow()
  })

  it('accepts a single-approver proposal', () => {
    expect(() =>
      proposeApprovalInputSchema.parse({ ...validInput, approverUserIds: [uuid1] }),
    ).not.toThrow()
  })

  it('rejects an empty approverUserIds array with the exact Russian message', () => {
    const result = proposeApprovalInputSchema.safeParse({ ...validInput, approverUserIds: [] })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Нужен хотя бы один подтверждающий')
  })

  it('rejects duplicate approverUserIds with the exact Russian message on the right field', () => {
    const result = proposeApprovalInputSchema.safeParse({
      ...validInput,
      approverUserIds: [uuid1, uuid1],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('approverUserIds не должен содержать повторов')
    expect(result.error?.issues[0]?.path).toEqual(['approverUserIds'])
  })

  it('rejects a non-uuid entry in approverUserIds', () => {
    expect(() =>
      proposeApprovalInputSchema.parse({ ...validInput, approverUserIds: ['not-a-uuid'] }),
    ).toThrow()
  })
})

describe('approveApprovalInputSchema', () => {
  it('accepts a valid approve input', () => {
    expect(() =>
      approveApprovalInputSchema.parse({
        subjectType: 'PROJECT_CREATION',
        subjectId: uuid1,
        approverUserId: uuid2,
      }),
    ).not.toThrow()
  })

  it('rejects a missing approverUserId', () => {
    expect(() =>
      approveApprovalInputSchema.parse({ subjectType: 'PROJECT_CREATION', subjectId: uuid1 }),
    ).toThrow()
  })
})

describe('rejectApprovalInputSchema', () => {
  const validReject = {
    subjectType: 'PROJECT_CREATION',
    subjectId: uuid1,
    approverUserId: uuid2,
    reason: 'Условия не устраивают',
  }

  it('accepts a valid rejection with a reason', () => {
    expect(() => rejectApprovalInputSchema.parse(validReject)).not.toThrow()
  })

  it('rejects a blank (whitespace-only) reason with the exact Russian message', () => {
    const result = rejectApprovalInputSchema.safeParse({ ...validReject, reason: '   ' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Причина отказа обязательна')
  })

  it('rejects an empty reason with the exact Russian message', () => {
    const result = rejectApprovalInputSchema.safeParse({ ...validReject, reason: '' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Причина отказа обязательна')
  })

  it('rejects a missing reason field', () => {
    const { reason: _reason, ...withoutReason } = validReject
    expect(() => rejectApprovalInputSchema.parse(withoutReason)).toThrow()
  })

  it('trims the reason', () => {
    const parsed = rejectApprovalInputSchema.parse({ ...validReject, reason: '  Причина  ' })
    expect(parsed.reason).toBe('Причина')
  })
})
