/**
 * pending.spec.ts — task-pending-screen (position 7c). Schema-level boundary
 * coverage for `pendingItemSchema` / `pendingResponseSchema`, in the style
 * `pending-share.spec.ts` settled on: the service-level tests exercise these
 * schemas only through realistic mid-range payloads, so this file's job is
 * the edges (percent 0/100/101/-1, empty `actions`, the optional fields).
 *
 * SR-L-3 (PR #667 fix-round 2, security review round 1): `pendingItemSchema`
 * used to be a single flat `z.object` where `currentPercent` / `pendingPercent`
 * / `viewerSharePercent` / `seniorName` were ALL `.optional()` regardless of
 * `kind` — the doc comment claimed the PROJECT_APPROVAL/SHARE_APPROVAL split
 * was "structural, not just by omission at read-time", which was false: a
 * future edit to `buildItemForSubject` that attached a counterparty percent
 * to a PROJECT_APPROVAL row would have sailed through `.parse()` unchanged.
 * Converted to `z.discriminatedUnion('kind', [...])` so each `kind` gets its
 * OWN object shape — the tests below assert the shape, not just the values.
 */
import { describe, expect, it } from 'vitest'
import { pendingItemSchema, pendingResponseSchema } from './pending'

const uuid1 = 'a0000000-0000-4000-8000-000000000001'
const uuid2 = 'a0000000-0000-4000-8000-000000000002'
const approvalId1 = 'b0000000-0000-4000-8000-000000000001'
const createdAt = '2026-09-01T10:00:00.000Z'

const projectApprovalItem = {
  kind: 'PROJECT_APPROVAL' as const,
  approvalId: approvalId1,
  subjectType: 'PROJECT' as const,
  subjectId: uuid1,
  title: 'GamingTec',
  createdAt,
  actions: ['approve', 'reject', 'open'] as const,
  link: '/projects/' + uuid1,
  viewerSharePercent: null,
  seniorName: null,
}

const shareApprovalItem = {
  kind: 'SHARE_APPROVAL' as const,
  approvalId: approvalId1,
  subjectType: 'PROJECT' as const,
  subjectId: uuid1,
  title: 'Доля по проекту «GamingTec»',
  createdAt,
  actions: ['approve', 'reject', 'open'] as const,
  link: '/projects/' + uuid1,
  currentPercent: 26,
  pendingPercent: 30,
}

const contractItem = {
  kind: 'CONTRACT_TO_SIGN' as const,
  subjectType: 'USER' as const,
  subjectId: uuid2,
  title: 'Контракт сотрудника',
  createdAt,
  actions: ['open'] as const,
  link: '/profile',
}

describe('pendingItemSchema — PROJECT_APPROVAL', () => {
  it('accepts a minimal PROJECT_APPROVAL row (viewerSharePercent/seniorName both null)', () => {
    expect(pendingItemSchema.parse(projectApprovalItem)).toEqual(projectApprovalItem)
  })

  it('accepts viewerSharePercent / seniorName populated (integration decision 2)', () => {
    const withShare = { ...projectApprovalItem, viewerSharePercent: 26, seniorName: 'Senior One' }
    expect(pendingItemSchema.parse(withShare)).toEqual(withShare)
  })

  it('rejects a viewerSharePercent outside 0..100', () => {
    expect(() =>
      pendingItemSchema.parse({ ...projectApprovalItem, viewerSharePercent: 101 }),
    ).toThrow()
    expect(() =>
      pendingItemSchema.parse({ ...projectApprovalItem, viewerSharePercent: -1 }),
    ).toThrow()
  })

  it('rejects a PROJECT_APPROVAL row missing viewerSharePercent entirely — required (nullable), not optional', () => {
    const { viewerSharePercent: _omitted, ...withoutField } = projectApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it('rejects a PROJECT_APPROVAL row missing seniorName entirely — required (nullable), not optional', () => {
    const { seniorName: _omitted, ...withoutField } = projectApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it('rejects a PROJECT_APPROVAL row missing approvalId — required for this kind (only CONTRACT_TO_SIGN omits it)', () => {
    const { approvalId: _omitted, ...withoutField } = projectApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it('SR-L-3: strips currentPercent/pendingPercent from a PROJECT_APPROVAL row — those keys do not exist on this variant, not merely unpopulated', () => {
    const contaminated = { ...projectApprovalItem, currentPercent: 55, pendingPercent: 60 }
    const result = pendingItemSchema.parse(contaminated)
    expect(result).not.toHaveProperty('currentPercent')
    expect(result).not.toHaveProperty('pendingPercent')
    expect(result).toEqual(projectApprovalItem)
  })

  it("requires subjectType to be exactly 'PROJECT' for this kind — the raw approvals column mapping is fixed (integration decision 1)", () => {
    expect(() => pendingItemSchema.parse({ ...projectApprovalItem, subjectType: 'USER' })).toThrow()
  })
})

describe('pendingItemSchema — SHARE_APPROVAL', () => {
  it('accepts a SHARE_APPROVAL row carrying both percent fields at their boundaries (0 and 100)', () => {
    const row = { ...shareApprovalItem, currentPercent: 0, pendingPercent: 100 }
    expect(pendingItemSchema.parse(row)).toEqual(row)
  })

  it('rejects a percent below 0', () => {
    expect(() => pendingItemSchema.parse({ ...shareApprovalItem, currentPercent: -1 })).toThrow()
  })

  it('rejects a percent above 100', () => {
    expect(() => pendingItemSchema.parse({ ...shareApprovalItem, pendingPercent: 101 })).toThrow()
  })

  it('rejects a SHARE_APPROVAL row missing currentPercent entirely — required, not optional', () => {
    const { currentPercent: _omitted, ...withoutField } = shareApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it('rejects a SHARE_APPROVAL row missing pendingPercent entirely — required, not optional', () => {
    const { pendingPercent: _omitted, ...withoutField } = shareApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it('rejects a SHARE_APPROVAL row missing approvalId', () => {
    const { approvalId: _omitted, ...withoutField } = shareApprovalItem
    expect(() => pendingItemSchema.parse(withoutField)).toThrow()
  })

  it("accepts subjectType 'USER' — a base-share row routes its action through /users/:id, a project one through /projects/:id (integration decision 1)", () => {
    const userShareRow = { ...shareApprovalItem, subjectType: 'USER' as const }
    const projectShareRow = { ...shareApprovalItem, subjectType: 'PROJECT' as const }
    expect(pendingItemSchema.parse(userShareRow)).toEqual(userShareRow)
    expect(pendingItemSchema.parse(projectShareRow)).toEqual(projectShareRow)
  })

  it('rejects a row with no subjectType — required, not an optional string (integration decision 1)', () => {
    const { subjectType: _omitted, ...withoutSubjectType } = shareApprovalItem
    expect(() => pendingItemSchema.parse(withoutSubjectType)).toThrow()
  })

  it("rejects a subjectType outside the closed 'USER' | 'PROJECT' set — the raw approvals column is not this contract", () => {
    expect(() =>
      pendingItemSchema.parse({ ...shareApprovalItem, subjectType: 'PROJECT_SENIOR_SHARE' }),
    ).toThrow()
  })

  it('rejects an empty actions array — every row has at least `open`', () => {
    expect(() => pendingItemSchema.parse({ ...shareApprovalItem, actions: [] })).toThrow()
  })

  it('rejects an unknown action string', () => {
    expect(() => pendingItemSchema.parse({ ...shareApprovalItem, actions: ['remind'] })).toThrow()
  })

  it("accepts 'cancel' as a valid action — proposedByMe share-approval rows use ['cancel', 'open']", () => {
    const row = { ...shareApprovalItem, actions: ['cancel', 'open'] as const }
    expect(pendingItemSchema.parse(row)).toEqual(row)
  })

  it('accepts optional proposedBy / waitingFor independently', () => {
    const mineRow = { ...shareApprovalItem, proposedBy: 'Admin Adminovich' }
    const proposedByMeRow = { ...shareApprovalItem, waitingFor: ['Senior One', 'Drop One'] }
    expect(pendingItemSchema.parse(mineRow)).toEqual(mineRow)
    expect(pendingItemSchema.parse(proposedByMeRow)).toEqual(proposedByMeRow)
  })

  it('SR-L-3: strips viewerSharePercent/seniorName from a SHARE_APPROVAL row — PROJECT_APPROVAL-only fields, not merely unpopulated', () => {
    const contaminated = { ...shareApprovalItem, viewerSharePercent: 40, seniorName: 'Someone' }
    const result = pendingItemSchema.parse(contaminated)
    expect(result).not.toHaveProperty('viewerSharePercent')
    expect(result).not.toHaveProperty('seniorName')
    expect(result).toEqual(shareApprovalItem)
  })
})

describe('pendingItemSchema — CONTRACT_TO_SIGN', () => {
  it('accepts CONTRACT_TO_SIGN with no approvalId (contracts are not approvals rows)', () => {
    expect(pendingItemSchema.parse(contractItem)).toEqual(contractItem)
  })

  it("requires subjectType to be exactly 'USER' for this kind", () => {
    expect(() => pendingItemSchema.parse({ ...contractItem, subjectType: 'PROJECT' })).toThrow()
  })

  it('SR-L-3: strips approvalId/percent/share fields from a CONTRACT_TO_SIGN row — none of them exist on this variant', () => {
    const contaminated = {
      ...contractItem,
      approvalId: approvalId1,
      currentPercent: 10,
      pendingPercent: 20,
      viewerSharePercent: 30,
      seniorName: 'Someone',
    }
    const result = pendingItemSchema.parse(contaminated)
    expect(result).toEqual(contractItem)
  })
})

describe('pendingItemSchema — kind (closed set, shared across variants)', () => {
  it('rejects an unknown kind — the closed set is deliberate (see schema doc)', () => {
    expect(() =>
      pendingItemSchema.parse({ ...projectApprovalItem, kind: 'DROP_SHARE_APPROVAL' }),
    ).toThrow()
  })

  it('rejects a row missing kind entirely — the discriminant itself is required', () => {
    const { kind: _omitted, ...withoutKind } = projectApprovalItem
    expect(() => pendingItemSchema.parse(withoutKind)).toThrow()
  })
})

describe('pendingResponseSchema', () => {
  it('accepts an empty response (nothing pending in either list)', () => {
    expect(pendingResponseSchema.parse({ mine: [], proposedByMe: [] })).toEqual({
      mine: [],
      proposedByMe: [],
    })
  })

  it('accepts proposedByMe populated independently of mine, mixing kinds', () => {
    const items = [shareApprovalItem, { ...projectApprovalItem, waitingFor: ['Senior One'] }]
    expect(pendingResponseSchema.parse({ mine: [], proposedByMe: items })).toEqual({
      mine: [],
      proposedByMe: items,
    })
  })

  it('rejects a response missing proposedByMe — never omitted, task file: "одна форма ответа"', () => {
    expect(() => pendingResponseSchema.parse({ mine: [] })).toThrow()
  })
})
