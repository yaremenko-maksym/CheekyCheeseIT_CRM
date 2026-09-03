import { Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePendingProjectApprovals } from '@/hooks/use-project-approvals'
import { ProjectApprovalActions } from '@/components/projects/ProjectApprovalActions'

const card = {
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
 */
export function PendingProjectApprovalsPanel() {
  const { pending, isLoading, isError } = usePendingProjectApprovals()

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
  if (isError || pending.length === 0) return null

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
          {pending.map((project) => (
            <div
              key={project.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2"
              data-testid={`pending-project-approval-${project.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{project.companyName}</p>
                <p className="truncate text-xs text-muted-foreground">{project.name}</p>
              </div>
              <ProjectApprovalActions projectId={project.id} companyName={project.companyName} />
            </div>
          ))}
        </CardContent>
      </Card>
    </motion.div>
  )
}
