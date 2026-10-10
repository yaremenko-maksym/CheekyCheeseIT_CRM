/**
 * task-648-fix-round-3 (SR-L-4). WHO may even be told that a pending
 * senior-share proposal is open on a project.
 *
 * ADMIN and SENIOR only: ACCOUNTANT and HR can reach the response paths
 * (the propose-gate admits ACCOUNTANT outright) and JUNIOR is masked
 * wholesale, so this is an allow-list, not a denylist — the shape
 * `security-review` pattern 3 requires on every projection.
 */
export function canSeePendingSeniorShare(viewerRole: string | undefined): boolean {
  return viewerRole === 'ADMIN' || viewerRole === 'SENIOR'
}
