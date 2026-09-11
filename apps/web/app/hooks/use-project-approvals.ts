import axios from 'axios'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { PENDING_QUERY_KEY } from '@/hooks/use-pending-items'

/**
 * task-project-status-filter-ui. Cache key for the "default" (non-archived)
 * project list — backs the /projects page's Активные/На подтверждении/
 * Отклонённые tabs (bucketed client-side by `project.status`, see
 * routes/_authenticated/projects/index.tsx).
 *
 * `'active'` (not `'false'`) matches the label the /projects page has used
 * for this exact query since before this task — kept identical on purpose,
 * not reinvented.
 */
export const PROJECTS_DEFAULT_QUERY_KEY = ['projects', { archived: 'active' }] as const

/**
 * task-project-status-filter-ui. `POST /projects/:id/approve` and `/reject`
 * (PR #630) already exist with no `@Roles` restriction — the server itself
 * verifies the caller is an invited approver (senior/drop), 404 otherwise.
 * These hooks are the ONE place either mutation is called from, reused by
 * both surfaces the task requires (design spec §Что сделать item 3):
 *   - the small inline actions on the project's own ProjectRow card
 *     (`ProjectApprovalActions`, reachable by ADMIN/SENIOR who can open
 *     /projects at all)
 *   - `PendingProjectApprovalsPanel` on DropDashboard/SeniorDashboard — the
 *     DROP-reachable "запись согласования" surface (DROP has no route
 *     access to /projects at all, see useRoleGuard on that route)
 *   - the `/pending` screen's own PROJECT_APPROVAL rows (task-pending-screen)
 *
 * task-pending-screen: was invalidating `PENDING_APPROVALS_QUERY_KEY`
 * (`['approvals', 'pending']`) — that key, and the `usePendingProjectApprovals`
 * hook that owned it, are gone (SR-L-6: `PendingProjectApprovalsPanel` now
 * reads `GET /pending` via `usePendingItems()`, same as the `/pending`
 * screen). Invalidating `PENDING_QUERY_KEY` here is what keeps BOTH of those
 * surfaces in sync with a project approve/reject — same reasoning as before,
 * pointed at the query key that is actually live now.
 */
export function useApproveProjectDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<ProjectDto>(`/projects/${projectId}/approve`).then((r) => r.data),
    // Invalidate on success AND on an "already responded" 409 (see
    // isAlreadyRespondedError below) — it means the shared project list is
    // now stale, so the card AND the dashboard widget/`/pending` screen
    // self-correct on the very next render instead of continuing to show a
    // resolved item as still awaiting a decision.
    onSettled: (_data, error) => {
      if (!error || isAlreadyRespondedError(error)) {
        void qc.invalidateQueries({ queryKey: ['projects'] })
        void qc.invalidateQueries({ queryKey: PENDING_QUERY_KEY })
      }
    },
  })
}

export function useRejectProjectDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, reason }: { projectId: string; reason: string }) =>
      api.post<ProjectDto>(`/projects/${projectId}/reject`, { reason }).then((r) => r.data),
    onSettled: (_data, error) => {
      if (!error || isAlreadyRespondedError(error)) {
        void qc.invalidateQueries({ queryKey: ['projects'] })
        void qc.invalidateQueries({ queryKey: PENDING_QUERY_KEY })
      }
    },
  })
}

/**
 * SR-M-4 (PR #646 fix-round 1): NARROWED to 409 only — this used to also
 * treat 404 as harmless, which was wrong. `ApprovalsService.
 * loadLiveRowForUpdate` scopes its query to `approverUserId = <caller>`, so
 * a 404 ("Согласование не найдено или уже погашено") fires for TWO
 * genuinely different callers: (a) the viewer's own row was superseded by a
 * re-proposal — a real "this went stale, refresh" case — but ALSO (b) the
 * caller was NEVER an invited approver at all (no row for them ever
 * existed) — a real authorization failure, e.g. a stale UI state or a
 * direct API call from someone who should not have this button at all. The
 * backend cannot tell these apart from the response alone (same message,
 * same status), and silently swallowing BOTH meant an unauthorized click
 * produced no visible signal whatsoever — the element just vanished with no
 * toast, until the next reload. Treating 404 as a real, surfaced error
 * (toast) trades a rare false-positive toast on the legitimate staleness
 * case for never again hiding the illegitimate one — the safer default per
 * security review.
 *
 * 409 (`ConflictException`, "Согласование уже получило ответ") stays
 * harmless: it can ONLY mean the viewer's own row is no longer PENDING
 * (they responded), never "never had a row" — most commonly because the
 * project has TWO invited approvers (senior + drop) and the viewer already
 * acted while the project itself stayed DRAFT waiting on the other one
 * (partial agreement, business spec §4.1), so a since-stale list still
 * showed it as "needs your decision".
 */
export function isAlreadyRespondedError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 409
}
