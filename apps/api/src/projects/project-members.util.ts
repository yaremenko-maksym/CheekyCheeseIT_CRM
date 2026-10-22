import { HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'

/**
 * Pure project-membership validations (extracted verbatim from
 * `ProjectsService.addMember` / `removeMember`, leaf P-L5). Synchronous, no
 * I/O: every function takes already-loaded rows and throws the same
 * `apiError` the inline checks threw. Plain business validation — no
 * viewer-dependent authorization or masking lives here.
 */

/** Active-membership row slice as loaded in `project.members` (with user). */
export interface MemberRowSlice {
  leftAt: Date | null
  user?: { role: string } | null
}

/**
 * The user being added must not be archived (employment ended) and must have
 * a role that can sit on a project. Archived check fires FIRST.
 */
export function assertCanAddMember(user: { archivedAt: Date | null; role: string }): void {
  if (user.archivedAt) {
    throw apiError('ARCHIVED_USER_CANNOT_JOIN_PROJECT', HttpStatus.BAD_REQUEST)
  }
  if (user.role !== 'JUNIOR' && user.role !== 'HR' && user.role !== 'ACCOUNTANT') {
    throw apiError('PROJECT_MEMBER_ROLE_RESTRICTED', HttpStatus.BAD_REQUEST)
  }
}

/** JUNIOR: at most one active junior per project. */
export function assertNoActiveJunior(members: readonly MemberRowSlice[]): void {
  const existingJunior = members.find((m) => m.leftAt === null && m.user?.role === 'JUNIOR')
  if (existingJunior) {
    throw apiError('PROJECT_HAS_ACTIVE_JUNIOR', HttpStatus.BAD_REQUEST)
  }
}

/** The last active HR / ACCOUNTANT of a project cannot be removed. */
export function assertCanRemoveMember(
  userToRemove: { role: string } | undefined,
  members: readonly MemberRowSlice[],
): void {
  if (userToRemove?.role === 'HR' || userToRemove?.role === 'ACCOUNTANT') {
    const activeOfRole = members.filter(
      (m) => m.leftAt === null && m.user?.role === userToRemove.role,
    )
    if (activeOfRole.length <= 1) {
      throw apiError('CANNOT_REMOVE_LAST_ROLE_MEMBER', HttpStatus.BAD_REQUEST)
    }
  }
}
