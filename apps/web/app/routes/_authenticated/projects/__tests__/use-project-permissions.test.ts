/**
 * Characterization of the RBAC/visibility flags extracted from `$projectId.tsx`
 * (Mikado leaf 7). Pins CURRENT behavior per role x project state. Expected
 * values are hand-written literals, not recomputed from the role rules.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { useProjectPermissions, type ProjectPermissions } from '../use-project-permissions'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'

const asUser = (role: string, id: string = ME) => ({ id, role }) as unknown as SessionUser

type Proj = Parameters<typeof useProjectPermissions>[1]
const proj = (seniorId: string | null, dropId: string | null): Proj => ({ seniorId, dropId })

const ALL_FALSE: ProjectPermissions = {
  isAdmin: false,
  canManage: false,
  canOpenEdit: false,
  canRemoveMembers: false,
  canSeeProjectFinance: false,
  canEditOverride: false,
  canAccessLegend: false,
  canManageCredentials: false,
}

// Role-only flags (independent of project state).
const ROLE_FLAGS: Record<
  string,
  Omit<ProjectPermissions, 'canAccessLegend' | 'canManageCredentials'>
> = {
  ADMIN: {
    isAdmin: true,
    canManage: true,
    canOpenEdit: true,
    canRemoveMembers: true,
    canSeeProjectFinance: true,
    canEditOverride: true,
  },
  SENIOR: {
    isAdmin: false,
    canManage: false,
    canOpenEdit: false,
    canRemoveMembers: false,
    canSeeProjectFinance: true,
    canEditOverride: false,
  },
  JUNIOR: {
    isAdmin: false,
    canManage: false,
    canOpenEdit: false,
    canRemoveMembers: false,
    canSeeProjectFinance: false,
    canEditOverride: false,
  },
  HR: {
    isAdmin: false,
    canManage: true,
    canOpenEdit: true,
    canRemoveMembers: false,
    canSeeProjectFinance: false,
    canEditOverride: false,
  },
  ACCOUNTANT: {
    isAdmin: false,
    canManage: false,
    canOpenEdit: true,
    canRemoveMembers: false,
    canSeeProjectFinance: true,
    canEditOverride: true,
  },
}

// Legend: ADMIN/HR/JUNIOR when project loaded and viewer is not the subject.
// Credentials: ADMIN/HR when project loaded.
const LEGEND_ROLES = ['ADMIN', 'HR', 'JUNIOR']
const CREDENTIAL_ROLES = ['ADMIN', 'HR']

const STATES: Array<{ name: string; project: Proj; subject: boolean; loaded: boolean }> = [
  { name: 'project not loaded (undefined)', project: undefined, subject: false, loaded: false },
  { name: 'project not loaded (null)', project: null, subject: false, loaded: false },
  { name: 'viewer is the senior', project: proj(ME, null), subject: true, loaded: true },
  { name: 'viewer is the drop', project: proj(OTHER, ME), subject: true, loaded: true },
  { name: 'viewer is a third party', project: proj(OTHER, THIRD), subject: false, loaded: true },
  {
    name: 'drop-less project, third party',
    project: proj(OTHER, null),
    subject: false,
    loaded: true,
  },
]

describe('useProjectPermissions', () => {
  for (const role of Object.keys(ROLE_FLAGS)) {
    describe(role, () => {
      for (const s of STATES) {
        it(`${s.name}`, () => {
          const expected: ProjectPermissions = {
            ...ROLE_FLAGS[role]!,
            canAccessLegend: s.loaded && !s.subject && LEGEND_ROLES.includes(role),
            canManageCredentials: s.loaded && CREDENTIAL_ROLES.includes(role),
          }
          expect(useProjectPermissions(asUser(role), s.project)).toEqual(expected)
        })
      }
    })
  }

  it('pins literal legend/credentials values for the boundary roles', () => {
    const third = proj(OTHER, THIRD)
    expect(useProjectPermissions(asUser('ADMIN'), third)).toMatchObject({
      canAccessLegend: true,
      canManageCredentials: true,
    })
    expect(useProjectPermissions(asUser('HR'), third)).toMatchObject({
      canAccessLegend: true,
      canManageCredentials: true,
    })
    expect(useProjectPermissions(asUser('JUNIOR'), third)).toMatchObject({
      canAccessLegend: true,
      canManageCredentials: false,
    })
    expect(useProjectPermissions(asUser('SENIOR'), third)).toMatchObject({
      canAccessLegend: false,
      canManageCredentials: false,
    })
    expect(useProjectPermissions(asUser('ACCOUNTANT'), third)).toMatchObject({
      canAccessLegend: false,
      canManageCredentials: false,
    })
  })

  it('an ADMIN/HR/JUNIOR who is the senior or the drop loses legend access only', () => {
    for (const role of LEGEND_ROLES) {
      expect(useProjectPermissions(asUser(role), proj(ME, null)).canAccessLegend).toBe(false)
      expect(useProjectPermissions(asUser(role), proj(OTHER, ME)).canAccessLegend).toBe(false)
    }
    expect(useProjectPermissions(asUser('ADMIN'), proj(ME, null)).canManageCredentials).toBe(true)
  })

  it('a null dropId never makes the viewer a subject (even with a nullish viewer id)', () => {
    // viewer id undefined must not equal a null dropId
    const noId = { role: 'ADMIN' } as unknown as SessionUser
    expect(useProjectPermissions(noId, proj(OTHER, null)).canAccessLegend).toBe(true)
  })

  it('an id-less viewer is not the subject of a project whose dropId is absent (undefined)', () => {
    // undefined === undefined must NOT count as "viewer is the drop"
    const noId = { role: 'ADMIN' } as unknown as SessionUser
    const noDrop = { seniorId: OTHER } as unknown as Proj
    expect(useProjectPermissions(noId, noDrop).canAccessLegend).toBe(true)
  })

  it('no user: every flag is false except canSeeProjectFinance (role !== HR/JUNIOR)', () => {
    const third = proj(OTHER, THIRD)
    const expected = { ...ALL_FALSE, canSeeProjectFinance: true }
    expect(useProjectPermissions(null, third)).toEqual(expected)
    expect(useProjectPermissions(undefined, third)).toEqual(expected)
    expect(useProjectPermissions(null, undefined)).toEqual(expected)
  })

  it('DROP role gets no management/finance-edit/legend/credentials access', () => {
    expect(useProjectPermissions(asUser('DROP'), proj(OTHER, THIRD))).toEqual({
      ...ALL_FALSE,
      canSeeProjectFinance: true,
    })
  })
})
