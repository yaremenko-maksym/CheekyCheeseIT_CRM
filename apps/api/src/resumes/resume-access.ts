/**
 * Resume access rules (task-resume-base §4) — kept in ONE pure function so the
 * rule is stated once, is unit-testable without a DB, and cannot drift between
 * the read path, the write path, the PDF path and the source-download path.
 *
 * | Role                     | Own resume  | Another's   |
 * | ADMIN, HR                | read/write  | read/write  |
 * | SENIOR                   | read only   | NONE        |
 * | JUNIOR, DROP | NONE        | NONE        |
 *
 * [owner 2026-11-14] A SENIOR only VIEWS their resume; ADMIN and HR write it.
 * So `mode` decides the SENIOR row: `'read'` compares ids, anything else is false.
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
 * `mode` matters for a SENIOR only: ADMIN and HR read and write any resume,
 * a SENIOR reads their own and writes none (fail-closed: only `'read'` grants).
 */
export function canAccessResume(
  viewer: Pick<SessionUser, 'id' | 'role'>,
  targetUserId: string,
  mode: ResumeAccessMode,
): boolean {
  if (RESUME_MANAGER_ROLES.has(viewer.role)) return true
  // SENIOR: reads own resume only. This comparison IS the check — see file header.
  if (viewer.role === 'SENIOR') return mode === 'read' && viewer.id === targetUserId
  // JUNIOR, DROP and anything added later: no resume surface.
  return false
}

/**
 * True when `viewer` may Confirm a staged check result (spec §4, owner Q-C):
 * ADMIN and HR only — a senior cannot mark their own resume VERIFIED.
 */
export function canConfirmResume(viewer: Pick<SessionUser, 'role'>): boolean {
  return RESUME_MANAGER_ROLES.has(viewer.role)
}
