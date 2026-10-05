import type { ProjectDetailDto, SessionUser } from '@crm/shared'

/**
 * Derived RBAC/visibility flags for the project-detail page. Pure (no React
 * state/effects) but named `use*` because the page calls it like a hook, in
 * the same position as the inline derivations it replaces — i.e. before the
 * `denied` early-return (Rules of Hooks).
 *
 * Expressions are moved verbatim from `$projectId.tsx`; the server remains
 * the source of truth for every one of these decisions.
 */
export interface ProjectPermissions {
  isAdmin: boolean
  canManage: boolean
  /** ACCOUNTANT can also open the edit dialog (field-scoped RBAC on the backend). */
  canOpenEdit: boolean
  canRemoveMembers: boolean
  /**
   * HR and JUNIOR do not see project finance (backend emits rate/currency/share
   * as null for them). ADMIN/ACCOUNTANT/SENIOR see everything (SENIOR read-only).
   */
  canSeeProjectFinance: boolean
  canEditOverride: boolean
  /** Subject (seniorId / dropId) excluded; ADMIN/HR/JUNIOR get access. */
  canAccessLegend: boolean
  /** ADMIN/HR managers only; the component self-hides on a backend 403. */
  canManageCredentials: boolean
}

export function useProjectPermissions(
  user: SessionUser | null | undefined,
  project: Pick<ProjectDetailDto, 'seniorId' | 'dropId'> | null | undefined,
): ProjectPermissions {
  const isAdmin = user?.role === 'ADMIN'
  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const canOpenEdit = canManage || user?.role === 'ACCOUNTANT'
  const canRemoveMembers = isAdmin
  const canSeeProjectFinance = user?.role !== 'HR' && user?.role !== 'JUNIOR'
  const canEditOverride = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'
  const isSubject =
    // Stryker disable next-line OptionalChaining: `project?.dropId != null` already short-circuits to false for a nullish project, so the second `project?.dropId` is never evaluated with project == null — unobservable.
    user?.id === project?.seniorId || (project?.dropId != null && user?.id === project?.dropId)
  const canAccessLegend =
    !!project &&
    !isSubject &&
    (user?.role === 'ADMIN' || user?.role === 'HR' || user?.role === 'JUNIOR')
  const canManageCredentials = !!project && (user?.role === 'ADMIN' || user?.role === 'HR')

  return {
    isAdmin,
    canManage,
    canOpenEdit,
    canRemoveMembers,
    canSeeProjectFinance,
    canEditOverride,
    canAccessLegend,
    canManageCredentials,
  }
}
