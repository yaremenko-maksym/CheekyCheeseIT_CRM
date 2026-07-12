/**
 * Unit tests for drop-candidates filter logic on the project detail page.
 *
 * Tests:
 * 1. dropCandidates returns only role==='DROP' users from allUsers.
 * 2. When project.dropId !== null — dropCandidates should be empty
 *    (button hidden, not shown in picker — conditional render upstream).
 * 3. availableToAdd excludes role==='DROP' (prevents 400 from POST /members).
 * 4. availableToAdd still includes JUNIOR/HR/ACCOUNTANT as before (regression).
 */
import { describe, it, expect } from 'vitest'

type UserForAdd = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
  hasActiveProject: boolean
}

type ProjectMember = {
  userId: string
  role: string
  leftAt: Date | null
}

/** Mirror of the dropCandidates logic in $projectId.tsx */
function getDropCandidates(
  allUsers: UserForAdd[],
  dropId: string | null | undefined,
): UserForAdd[] {
  // Button is hidden when dropId != null, so piker only opens when no drop.
  if (dropId != null) return []
  return allUsers.filter((u) => u.role === 'DROP')
}

/** Mirror of the availableToAdd filter in $projectId.tsx (after DROP exclusion fix) */
function getAvailableToAdd(
  allUsers: UserForAdd[],
  activeMembers: ProjectMember[],
  hasActiveJunior: boolean,
): UserForAdd[] {
  return allUsers.filter((u) => {
    if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
    if (u.role === 'DROP') return false // DROP goes through PATCH /projects/:id, not POST /members
    if (activeMembers.some((m) => m.userId === u.id)) return false
    if (u.role === 'JUNIOR') {
      if (hasActiveJunior) return false
      if (u.hasActiveProject) return false
    }
    return true
  })
}

const makeUser = (id: string, role: string, hasActiveProject = false): UserForAdd => ({
  id,
  displayName: `User ${id}`,
  email: `${id}@test.com`,
  role,
  avatarUrl: null,
  avatarDocumentId: null,
  hasActiveProject,
})

const SAMPLE_USERS: UserForAdd[] = [
  makeUser('drop1', 'DROP'),
  makeUser('drop2', 'DROP'),
  makeUser('junior1', 'JUNIOR'),
  makeUser('hr1', 'HR'),
  makeUser('acc1', 'ACCOUNTANT'),
  makeUser('senior1', 'SENIOR'),
  makeUser('admin1', 'ADMIN'),
]

describe('getDropCandidates — filter for attach-drop picker', () => {
  it('returns only DROP-role users from allUsers when project has no drop', () => {
    const candidates = getDropCandidates(SAMPLE_USERS, null)
    expect(candidates).toHaveLength(2)
    candidates.forEach((u) => expect(u.role).toBe('DROP'))
    expect(candidates.map((u) => u.id)).toContain('drop1')
    expect(candidates.map((u) => u.id)).toContain('drop2')
  })

  it('returns empty array when project already has a drop assigned (dropId !== null)', () => {
    const candidates = getDropCandidates(SAMPLE_USERS, 'drop1')
    expect(candidates).toHaveLength(0)
  })

  it('returns empty array when allUsers has no DROP users', () => {
    const noDropUsers = SAMPLE_USERS.filter((u) => u.role !== 'DROP')
    const candidates = getDropCandidates(noDropUsers, null)
    expect(candidates).toHaveLength(0)
  })

  it('treats undefined dropId same as null — returns DROP candidates', () => {
    const candidates = getDropCandidates(SAMPLE_USERS, undefined)
    expect(candidates).toHaveLength(2)
    candidates.forEach((u) => expect(u.role).toBe('DROP'))
  })
})

describe('getAvailableToAdd — member picker filter (regression: DROP fix)', () => {
  const activeMembers: ProjectMember[] = []

  it('excludes DROP role from availableToAdd (prevents 400 from POST /members)', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, false)
    const roles = available.map((u) => u.role)
    expect(roles).not.toContain('DROP')
  })

  it('excludes ADMIN and SENIOR from availableToAdd', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, false)
    const roles = available.map((u) => u.role)
    expect(roles).not.toContain('ADMIN')
    expect(roles).not.toContain('SENIOR')
  })

  it('includes HR in availableToAdd (regression: not broken by DROP fix)', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, false)
    expect(available.some((u) => u.role === 'HR')).toBe(true)
  })

  it('includes ACCOUNTANT in availableToAdd (regression: not broken by DROP fix)', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, false)
    expect(available.some((u) => u.role === 'ACCOUNTANT')).toBe(true)
  })

  it('includes JUNIOR when hasActiveJunior=false and no active project', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, false)
    expect(available.some((u) => u.role === 'JUNIOR')).toBe(true)
  })

  it('excludes JUNIOR when hasActiveJunior=true', () => {
    const available = getAvailableToAdd(SAMPLE_USERS, activeMembers, true)
    expect(available.some((u) => u.role === 'JUNIOR')).toBe(false)
  })

  it('excludes JUNIOR when they already have an active project', () => {
    const usersWithBusyJunior = [
      ...SAMPLE_USERS.filter((u) => u.id !== 'junior1'),
      makeUser('junior1', 'JUNIOR', true),
    ]
    const available = getAvailableToAdd(usersWithBusyJunior, activeMembers, false)
    expect(available.some((u) => u.role === 'JUNIOR')).toBe(false)
  })

  it('excludes already-active members from availableToAdd', () => {
    const withActiveMember: ProjectMember[] = [{ userId: 'hr1', role: 'HR', leftAt: null }]
    const available = getAvailableToAdd(SAMPLE_USERS, withActiveMember, false)
    expect(available.some((u) => u.id === 'hr1')).toBe(false)
  })
})
