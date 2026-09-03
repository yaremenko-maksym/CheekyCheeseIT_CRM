import axios from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * task-project-status-filter-ui. Shared cache key for the "default" (non-
 * archived) project list — the SAME fetch backs the /projects page's
 * Активные/Ожидают подтверждения/Отклонённые tabs (bucketed client-side by
 * `project.status`, see routes/_authenticated/projects/index.tsx) AND
 * `usePendingProjectApprovals` below. Sharing the key means a mutation on
 * either surface (approve/reject) invalidates both at once, and switching
 * between them never re-fetches data the other already has warm.
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
 *     access to /projects at all, see useRoleGuard on that route).
 */
export function useApproveProjectDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<ProjectDto>(`/projects/${projectId}/approve`).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useRejectProjectDraft() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, reason }: { projectId: string; reason: string }) =>
      api.post<ProjectDto>(`/projects/${projectId}/reject`, { reason }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

/**
 * task-project-status-filter-ui. A 409 (`ConflictException`, "Согласование
 * уже получило ответ") or 404 (`NotFoundException`, "не найдено или уже
 * погашено" — `ApprovalsService.assertRespondable`) on either mutation is
 * NOT a real error for the caller: it means the viewer's own approval row
 * already resolved — most commonly because the project has TWO invited
 * approvers (senior + drop) and the viewer already acted while the project
 * itself stayed DRAFT waiting on the other one (partial agreement,
 * business spec §4.1), so a since-stale list still showed it as "needs your
 * decision". Both call sites treat this pair as "stop showing this item,
 * no toast" — every OTHER status (network/500/validation) stays a real,
 * surfaced error.
 */
export function isAlreadyRespondedError(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.response?.status === 409 || err.response?.status === 404)
}

/**
 * task-project-status-filter-ui. Projects where the viewer (SENIOR or DROP)
 * is an invited approver on a still-DRAFT project — the data behind
 * `PendingProjectApprovalsPanel`. Reuses `GET /projects` (no new backend
 * endpoint): for a non-ADMIN caller the backend already narrows the
 * response to the viewer's own projects (`seniorId`/`dropId` match) PLUS
 * any DRAFT/REJECTED project they were invited to approve
 * (`ProjectsService.findAll`'s "узкий путь к черновику" gate) — this hook
 * only buckets that response down to `status === 'DRAFT'` client-side.
 *
 * Deliberately does NOT try to distinguish "still pending on me" from
 * "I already approved, waiting on the other party" — that would need a
 * backend field this task's minimal, justified enrichment doesn't add (see
 * PR body «Допущения»). `isAlreadyRespondedError` above is what makes that
 * safe: a stale item's Confirm/Reject 409/404s harmlessly and disappears on
 * the very next interaction instead of silently misleading the viewer.
 */
export function usePendingProjectApprovals(enabled = true) {
  const query = useQuery({
    queryKey: PROJECTS_DEFAULT_QUERY_KEY,
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    enabled,
  })
  const pending = (query.data ?? []).filter((p) => p.status === 'DRAFT')
  return { ...query, pending }
}
