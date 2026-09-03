import { Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePendingProjectApprovals } from '@/hooks/use-project-approvals'
import { ProjectApprovalActions } from '@/components/projects/ProjectApprovalActions'

// Exported (not module-private) so a plain object-equality unit test can
// pin the exact animation values without fighting jsdom/framer-motion's
// runtime (which never actually animates in a test environment) — see
// __tests__/PendingProjectApprovalsPanel.test.tsx.
export const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

/**
 * task-project-status-filter-ui, §Что сделать item 3 + the task's «Два
 * места, где это ломается» decision (recorded in the PR's «Допущения»).
 * DROP has no route access to /projects at all
 * (`useRoleGuard(['ADMIN','SENIOR','HR','ACCOUNTANT'])` on that route
 * excludes DROP outright — confirmed by reading `route-access.ts`'s
 * `ROUTE_ACCESS` map) — this panel is DROP's ONLY reachable surface for
 * acting on a project awaiting their confirmation. Mounted on BOTH
 * `DropDashboard` and `SeniorDashboard`: SENIOR also has the `ProjectRow`
 * card on /projects, but gets this too for symmetry — "кнопка на
 * карточке — для тех, кто дошёл; кнопка в записи согласования — для всех".
 *
 * Deliberately NOT a new page or route. `/` is already the sole, universal
 * per-role home every authenticated role lands on — `route-access.ts`'s own
 * comment: "/ НЕ заводится записью в карте намеренно... доступен ВСЕМ
 * ролям включая DROP". This is one more self-scoped card alongside the KPI
 * grid / InProgressPanel already mounted there, not the "отдельный
 * раздел... собирающий черновики и запросы на смену доли" the owner
 * explicitly rejected (business spec §6.1 «Где черновик живёт в
 * интерфейсе»): that rejection was about a SHARED, cross-cutting queue at
 * a NEW route, replacing per-status filtering on /projects for ADMIN. This
 * is a personal "waiting on you" list on the page the viewer already lands
 * on, showing ONLY their own pending items — a different shape of surface
 * entirely, not the one that was rejected.
 *
 * Renders nothing (not even an empty Card) when there is nothing pending —
 * an "all clear" card on every single dashboard load would be noise the
 * KPI-grid-adjacent placement does not need; the panel simply does not
 * exist for that render, same as InProgressPanel's own empty sections.
 *
 * Local-dismiss on `onActed` (found live, real-stack, while verifying AC3
 * for DROP): `usePendingProjectApprovals` buckets purely on
 * `project.status === 'DRAFT'` — it cannot tell "still needs MY decision"
 * from "I already decided, project stays DRAFT waiting on the OTHER
 * invited approver" (a project can have both a senior AND a drop invited;
 * business spec §4.1 partial agreement). Without this, a viewer who just
 * approved/rejected keeps seeing their own already-resolved item until
 * some later, unrelated event finally moves the project out of `pending` —
 * on THIS, the viewer's only reachable surface for the action, "click
 * Confirm and it just sits there" reads as broken, not as "waiting on the
 * other party". `dismissedIds` hides an item the INSTANT its own mutation
 * settles (success or the harmless already-responded 409/404 — see
 * `isAlreadyRespondedError`), independent of whether the server-side
 * status ever changes. Pruned back to the intersection with the live
 * `pending` set on every fresh fetch so a ended dismissal never lingers
 * across a reject → re-propose cycle that legitimately brings the SAME
 * project id back into `pending` for a NEW decision.
 */
export function PendingProjectApprovalsPanel() {
  const { pending, isLoading, isError, dataUpdatedAt } = usePendingProjectApprovals()
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    setDismissedIds((prev) => {
      // No early-return for `prev.size === 0`: the size-comparison below
      // already returns `prev` unchanged in that case too (an empty `prev`
      // filters to an empty `next`, and `0 === 0`) — a guard in front of it
      // would only skip computing `stillPending`, never change the result.
      const stillPending = new Set(pending.map((p) => p.id))
      const next = new Set([...prev].filter((id) => stillPending.has(id)))
      // Stryker disable next-line ConditionalExpression: when nothing was pruned, `next`'s CONTENT already equals `prev`'s — returning `next` unconditionally still leaves every `.has(id)` call in this file identical; the only effect a mutant here has is an extra React re-render (new Set reference), which no test can observe without asserting a render count, an implementation detail this codebase does not test for
      return next.size === prev.size ? prev : next
    })
    // Deliberately keyed on `dataUpdatedAt`, not `pending` — `pending` is a
    // brand-new filtered array every render (referentially), which would
    // re-run this on every render instead of only on an actual refetch.
    // (react-hooks/exhaustive-deps is not configured in this project's eslint.)
  }, [dataUpdatedAt])

  const visiblePending = pending.filter((project) => !dismissedIds.has(project.id))

  if (isLoading) {
    return (
      <Skeleton
        className="h-24 w-full rounded-lg"
        data-testid="pending-project-approvals-loading"
      />
    )
  }

  // Silent on error: the dashboard's own primary summary card already shows
  // a "не удалось загрузить" error for ITS data; a second error card for
  // this secondary, optional widget would compete for the same attention.
  // A failed fetch just means the panel doesn't render this load — the next
  // successful load (or /projects, for whoever has that route) still shows
  // it.
  if (isError || visiblePending.length === 0) return null

  return (
    <motion.div initial={card.hidden} animate={card.show}>
      <Card className="border-amber-500/20" data-testid="pending-project-approvals-panel">
        <CardHeader className="px-5 pb-2 pt-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-400" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ждёт вашего решения
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-4">
          {visiblePending.map((project) => (
            <div
              key={project.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2"
              data-testid={`pending-project-approval-${project.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{project.companyName}</p>
                <p className="truncate text-xs text-muted-foreground">{project.name}</p>
              </div>
              <ProjectApprovalActions
                projectId={project.id}
                companyName={project.companyName}
                onActed={() => setDismissedIds((prev) => new Set(prev).add(project.id))}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </motion.div>
  )
}
