/**
 * pending.spec.ts — task-pending-screen (position 7c). Schema-level boundary
 * coverage for `pendingItemSchema` / `pendingResponseSchema`, in the style
 * `pending-share.spec.ts` settled on: the service-level tests exercise these
 * schemas only through realistic mid-range payloads, so this file's job is
 * the edges (percent 0/100/101/-1, empty `actions`, the optional fields).
 */
import { describe, expect, it } from 'vitest'
import { pendingItemSchema, pendingResponseSchema } from './pending'

const uuid1 = 'a0000000-0000-4000-8000-000000000001'
const uuid2 = 'a0000000-0000-4000-8000-000000000002'
const createdAt = '2026-09-01T10:00:00.000Z'

const baseItem = {
  kind: 'PROJECT_APPROVAL' as const,
  subjectType: 'PROJECT' as const,
  subjectId: uuid1,
  title: 'GamingTec',
  createdAt,
  actions: ['approve', 'reject', 'open'] as const,
  link: '/projects/' + uuid1,
}

describe('pendingItemSchema', () => {
  it('accepts a minimal PROJECT_APPROVAL row with no percent fields', () => {
    expect(pendingItemSchema.parse(baseItem)).toEqual(baseItem)
  })

  it('accepts a SHARE_APPROVAL row carrying both percent fields at their boundaries (0 and 100)', () => {
    const row = {
      ...baseItem,
      kind: 'SHARE_APPROVAL' as const,
      currentPercent: 0,
      pendingPercent: 100,
    }
    expect(pendingItemSchema.parse(row)).toEqual(row)
  })

  it('rejects a percent below 0', () => {
    expect(() =>
      pendingItemSchema.parse({ ...baseItem, kind: 'SHARE_APPROVAL', currentPercent: -1 }),
    ).toThrow()
  })

  it('rejects a percent above 100', () => {
    expect(() =>
      pendingItemSchema.parse({ ...baseItem, kind: 'SHARE_APPROVAL', pendingPercent: 101 }),
    ).toThrow()
  })

  it('rejects an empty actions array — every row has at least `open`', () => {
    expect(() => pendingItemSchema.parse({ ...baseItem, actions: [] })).toThrow()
  })

  it('rejects an unknown action string', () => {
    expect(() => pendingItemSchema.parse({ ...baseItem, actions: ['remind'] })).toThrow()
  })

  it("accepts 'cancel' as a valid action — proposedByMe share-approval rows use ['cancel', 'open']", () => {
    const row = {
      ...baseItem,
      kind: 'SHARE_APPROVAL' as const,
      actions: ['cancel', 'open'] as const,
    }
    expect(pendingItemSchema.parse(row)).toEqual(row)
  })

  it('rejects an unknown kind — the closed set is deliberate (see schema doc)', () => {
    expect(() => pendingItemSchema.parse({ ...baseItem, kind: 'DROP_SHARE_APPROVAL' })).toThrow()
  })

  it('accepts optional proposedBy / waitingFor independently', () => {
    const mineRow = { ...baseItem, proposedBy: 'Admin Adminovich' }
    const proposedByMeRow = { ...baseItem, waitingFor: ['Senior One', 'Drop One'] }
    expect(pendingItemSchema.parse(mineRow)).toEqual(mineRow)
    expect(pendingItemSchema.parse(proposedByMeRow)).toEqual(proposedByMeRow)
  })

  it("accepts subjectType 'USER' — a base-share row routes its action through /users/:id, a project one through /projects/:id (integration decision 1)", () => {
    const userShareRow = {
      ...baseItem,
      kind: 'SHARE_APPROVAL' as const,
      subjectType: 'USER' as const,
    }
    const projectShareRow = {
      ...baseItem,
      kind: 'SHARE_APPROVAL' as const,
      subjectType: 'PROJECT' as const,
    }
    expect(pendingItemSchema.parse(userShareRow)).toEqual(userShareRow)
    expect(pendingItemSchema.parse(projectShareRow)).toEqual(projectShareRow)
  })

  it('rejects a row with no subjectType — required, not an optional string (integration decision 1)', () => {
    const { subjectType: _omitted, ...withoutSubjectType } = baseItem
    expect(() => pendingItemSchema.parse(withoutSubjectType)).toThrow()
  })

  it("rejects a subjectType outside the closed 'USER' | 'PROJECT' set — the raw approvals column is not this contract", () => {
    expect(() =>
      pendingItemSchema.parse({ ...baseItem, subjectType: 'PROJECT_SENIOR_SHARE' }),
    ).toThrow()
  })

  it('accepts viewerSharePercent / seniorName on a PROJECT_APPROVAL row, and null for both (integration decision 2)', () => {
    const withShare = { ...baseItem, viewerSharePercent: 26, seniorName: 'Senior One' }
    const masked = { ...baseItem, viewerSharePercent: null, seniorName: null }
    expect(pendingItemSchema.parse(withShare)).toEqual(withShare)
    expect(pendingItemSchema.parse(masked)).toEqual(masked)
  })

  it('rejects a viewerSharePercent outside 0..100 — same bounds as the two percent fields', () => {
    expect(() => pendingItemSchema.parse({ ...baseItem, viewerSharePercent: 101 })).toThrow()
    expect(() => pendingItemSchema.parse({ ...baseItem, viewerSharePercent: -1 })).toThrow()
  })

  it('accepts CONTRACT_TO_SIGN with no approvalId (contracts are not approvals rows)', () => {
    const row = {
      kind: 'CONTRACT_TO_SIGN' as const,
      subjectType: 'USER' as const,
      subjectId: uuid2,
      title: 'Контракт сотрудника',
      createdAt,
      actions: ['open'] as const,
      link: '/profile',
    }
    expect(pendingItemSchema.parse(row)).toEqual(row)
  })
})

describe('pendingResponseSchema', () => {
  it('accepts an empty response (nothing pending in either list)', () => {
    expect(pendingResponseSchema.parse({ mine: [], proposedByMe: [] })).toEqual({
      mine: [],
      proposedByMe: [],
    })
  })

  it('accepts proposedByMe populated independently of mine', () => {
    const item = { ...baseItem, waitingFor: ['Senior One'] }
    expect(pendingResponseSchema.parse({ mine: [], proposedByMe: [item] })).toEqual({
      mine: [],
      proposedByMe: [item],
    })
  })

  it('rejects a response missing proposedByMe — never omitted, task file: "одна форма ответа"', () => {
    expect(() => pendingResponseSchema.parse({ mine: [] })).toThrow()
  })
})
