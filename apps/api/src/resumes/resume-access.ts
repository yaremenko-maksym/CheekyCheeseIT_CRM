/**
 * Resume access rules (task-resume-base §4) — kept in ONE pure function so the
 * rule is stated once, is unit-testable without a DB, and cannot drift between
 * the read path, the write path, the PDF path and the source-download path.
 *
 * | Роль                     | Своё резюме   | Чужое         |
 * | ADMIN, HR                | чтение/запись | чтение/запись |
 * | SENIOR                   | чтение/запись | НЕТ           |
 * | JUNIOR, ACCOUNTANT, DROP | НЕТ           | НЕТ           |
 *
 * THE POINT OF THIS FILE: the SENIOR row is a COMPARISON, not a call. PR #493
 * (`job-sourcing.service.ts:248`) shipped the exact anti-pattern this guards
 * against — it invoked a helper that, for a SENIOR, returns that senior's OWN
 * id, and then threw the result away. Calling something is not checking
 * anything; the returned identity has to be COMPARED with the requested one.
 * Hence `canAccessResume` returns a boolean derived from
 * `viewer.id === targetUserId`, and every caller must branch on it.
 */
import type { SessionUser } from '@crm/shared'

export type ResumeAccessMode = 'read' | 'write'

/** Roles that may read AND write ANY senior's resume. */
const RESUME_MANAGER_ROLES = new Set(['ADMIN', 'HR'])

/**
 * True when `viewer` may access the resume owned by `targetUserId`.
 *
 * `mode` exists for readability at the call sites (and to keep the signature
 * stable if read/write ever diverge); today the table grants read and write
 * together for every role that has access at all.
 */
export function canAccessResume(
  viewer: Pick<SessionUser, 'id' | 'role'>,
  targetUserId: string,
  _mode: ResumeAccessMode,
): boolean {
  if (RESUME_MANAGER_ROLES.has(viewer.role)) return true
  // SENIOR: own resume only. This comparison IS the check — see file header.
  if (viewer.role === 'SENIOR') return viewer.id === targetUserId
  // JUNIOR, ACCOUNTANT, DROP and anything added later: no resume surface.
  return false
}
