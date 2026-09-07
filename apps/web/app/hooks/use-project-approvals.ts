import axios from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * task-project-status-filter-ui. Cache key for the "default" (non-archived)
 * project list — backs the /projects page's Активные/На подтверждении/
 * Отклонённые tabs (bucketed client-side by `project.status`, see
 * routes/_authenticated/projects/index.tsx).
 *
 * `'active'` (not `'false'`) matches the label the /projects page has used
 * for this exact query since before this task — kept identical on purpose,
 * not reinvented.
 *
 * SR-M-6 (fix-round 3): `usePendingProjectApprovals` used to share this key
 * too — see `PENDING_APPROVALS_QUERY_KEY` below for why that stopped. Both
 * mutations below now invalidate both keys explicitly to keep them in sync
 * without sharing a cache entry.
 */
export const PROJECTS_DEFAULT_QUERY_KEY = ['projects', { archived: 'active' }] as const

/**
 * SR-M-6 (PR #646 fix-round 3). `usePendingProjectApprovals` used to share
 * `PROJECTS_DEFAULT_QUERY_KEY` (see that constant's own doc) — cheap for
 * ADMIN/SENIOR, who already had `'projects'`-keyed data persisted before
 * this task, but this task is what FIRST mounts `PendingProjectApprovalsPanel`
 * (and therefore this hook) for DROP, on `DropDashboard` — a role that
 * previously had NO project data on disk at all (its only prior fetch was
 * the narrow, 5-field `DropProjectDto` via `useDropProjects`, whose
 * `['drop','projects']` key was never in the persist allow-list either).
 * Sharing the key meant DROP's IndexedDB started filling with the FULL
 * `ProjectDto` — `rate`, `notesGeneral`, share percentages, every
 * `members[].email` — the instant this widget mounted for them, since
 * `'projects'` IS allow-listed (`PERSISTED_KEY_PREFIXES`, __root.tsx).
 *
 * Query-key-based, not field-level (`SENSITIVE_PERSISTED_FIELDS`), on
 * purpose: this is data-at-rest for a role that had NONE before, on a
 * widget-only fetch — excluding the whole query costs nothing this hook's
 * own callers need persisted (the widget always wants fresh, "is someone
 * waiting on me right now" data, never a stale offline copy), whereas
 * stripping fields would touch the SAME 'projects' key ADMIN/SENIOR's
 * `/projects` list page still legitimately relies on for offline-resume.
 */
export const PENDING_APPROVALS_QUERY_KEY = ['approvals', 'pending'] as const

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
    // Invalidate on success AND on an "already responded" 409 (see
    // isAlreadyRespondedError below) — it means the shared project list is
    // now stale, so the card AND the dashboard widget self-correct on the
    // very next render instead of continuing to show a resolved item as
    // still awaiting a decision.
    //
    // SR-M-6 (fix-round 3): the card (`['projects']`) and the widget
    // (`PENDING_APPROVALS_QUERY_KEY`, deliberately a SEPARATE key now — see
    // that constant's own doc) no longer share one cache entry, so a
    // mutation from EITHER surface has to invalidate BOTH explicitly or the
    // other one goes stale silently.
    onSettled: (_data, error) => {
      if (!error || isAlreadyRespondedError(error)) {
        void qc.invalidateQueries({ queryKey: ['projects'] })
        void qc.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY })
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
        void qc.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY })
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
 * SR-M-6 (fix-round 3): queried under `PENDING_APPROVALS_QUERY_KEY`, NOT
 * `PROJECTS_DEFAULT_QUERY_KEY` — see that constant's own doc for why this
 * hook deliberately does NOT share the persisted `/projects` list-page
 * cache entry anymore. Same endpoint, same response shape, different key
 * only — `PendingProjectApprovalsPanel` never needed the sharing (it
 * always wants a fresh fetch, not an offline-resumed one).
 *
 * This hook itself does NOT try to distinguish "still pending on me" from
 * "I already approved, waiting on the other party" — SPEC-M-2 (PR #646
 * fix-round 1) DID add the backend fields that make that distinction
 * possible (`seniorApprovalPending`/`dropApprovalPending`, already on
 * `ProjectDto`), but the filtering itself lives one layer up, in
 * `PendingProjectApprovalsPanel`'s own `visiblePending` (COPY-H-2, fix-round
 * 2) — this hook only needs to know "is it DRAFT at all", the per-viewer
 * narrowing is the consuming component's job, not this shared hook's.
 * `isAlreadyRespondedError` above is the remaining safety net for the case
 * that narrowing still cannot fully close (a page freshly loaded before any
 * client-side dismiss has happened): a stale item's Confirm/Reject
 * 409/404s harmlessly and disappears on the very next interaction instead
 * of silently misleading the viewer.
 */
export function usePendingProjectApprovals(enabled = true) {
  const query = useQuery({
    queryKey: PENDING_APPROVALS_QUERY_KEY,
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    enabled,
  })
  // Stryker disable next-line ArrayDeclaration: any placeholder Stryker
  // substitutes for `[]` here gets filtered out by `.status === 'DRAFT'`
  // just the same as a real empty array would (a sentinel value has no
  // `.status` field, so it never passes the predicate) — no assertion on
  // `pending`'s content can distinguish "fallback is []" from "fallback is
  // some other filtered-out placeholder" through this hook's public output.
  const pending = (query.data ?? []).filter((p) => p.status === 'DRAFT')
  return { ...query, pending }
}
