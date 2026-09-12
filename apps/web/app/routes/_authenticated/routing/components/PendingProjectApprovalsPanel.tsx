import { Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePendingItems } from '@/hooks/use-pending-items'
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
 * grid / InProgressPanel already mounted there.
 *
 * Renders nothing (not even an empty Card) when there is nothing pending —
 * an "all clear" card on every single dashboard load would be noise the
 * KPI-grid-adjacent placement does not need; the panel simply does not
 * exist for that render, same as InProgressPanel's own empty sections.
 *
 * task-pending-screen (SR-L-6, #646 security review round 4). Was:
 * `usePendingProjectApprovals` → full `GET /projects`, client-filtered to
 * `status === 'DRAFT'` — for a DROP viewer that response carries `rate`,
 * `notesGeneral`, `members[].email`, none of which `mapProject` strips for
 * this endpoint. Now: `usePendingItems()` → `GET /pending`, filtered to
 * `kind === 'PROJECT_APPROVAL'` — the response is `PendingItem`, a shape
 * that structurally cannot carry those fields (they are not columns on it).
 * DROP's dashboard no longer requests the full project list at all — see
 * `__tests__/PendingProjectApprovalsPanel.test.tsx` "no /projects request".
 *
 * `visiblePending`/`dismissedIds`'s OLD job — telling "still needs MY
 * decision" apart from "I already decided, waiting on the OTHER invited
 * approver" — is now the SERVER's job: `mine` comes from
 * `ApprovalsService.listPendingForApprover(viewer)`, which is per-viewer by
 * construction (a row exists only while THAT approver's decision is still
 * open). `dismissedIds` below keeps only its ORIGINAL secondary purpose —
 * an instant "it's gone" feel on `onActed`, before the invalidated query's
 * round trip completes — pruned back to the live set on every fresh fetch
 * so a dismissal never lingers across a reject → re-propose cycle that
 * legitimately brings the SAME project id back for a NEW decision.
 *
 * The share line below is the SAME information the old rendering read off
 * the full `ProjectDto` (`effectiveDropSharePercent` /
 * `effectiveSeniorSharePercent` + `seniorName`), now carried by
 * `PendingItem.viewerSharePercent` / `.seniorName` — integration decision 2,
 * 2026-09-11. Keeping it is the point: a DROP has no route access to
 * `/projects` at all, so without it "да" here would be blind (COPY-M-6, #646
 * fix-round 2). What changed is WHO decides which figure the viewer may see:
 * the server now sends only the viewer's own, instead of the client picking
 * a field out of a DTO that carried both.
 */
export function PendingProjectApprovalsPanel() {
  const { mine, isLoading, isError, dataUpdatedAt } = usePendingItems()
  const pending = mine.filter((item) => item.kind === 'PROJECT_APPROVAL')
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    setDismissedIds((prev) => {
      const stillPending = new Set(pending.map((p) => p.subjectId))
      const next = new Set([...prev].filter((id) => stillPending.has(id)))
      return next.size === prev.size ? prev : next
    })
    // Deliberately keyed on `dataUpdatedAt`, not `pending` — `pending` is a
    // brand-new filtered array every render (referentially), which would
    // re-run this on every render instead of only on an actual refetch.
    // (react-hooks/exhaustive-deps is not configured in this project's eslint.)
  }, [dataUpdatedAt])

  const visiblePending = pending.filter((item) => !dismissedIds.has(item.subjectId))

  if (isLoading) {
    return (
      <Skeleton
        className="h-24 w-full rounded-lg"
        data-testid="pending-project-approvals-loading"
      />
    )
  }

  // COPY-M-7 (PR #646 fix-round 2): DROP has NO other reachable surface for
  // this action at all — silence on error would mean DROP never learns
  // someone is waiting on them, with no other screen that would tell them
  // either. One line, not a full error card — the empty case (genuinely
  // nothing pending) still renders nothing, that IS the correct "all clear"
  // state.
  if (isError) {
    return (
      // COPY-L-6 (PR #646 fix-round 3): the card's own header four lines
      // below says "решения" ("Ждёт вашего решения") — this error uses the
      // same word for the same object.
      <p className="text-xs text-muted-foreground" data-testid="pending-project-approvals-error">
        Не удалось проверить, ждёт ли вас решение по проекту. Обновите страницу.
      </p>
    )
  }
  if (visiblePending.length === 0) return null

  return (
    <motion.div initial={card.hidden} animate={card.show}>
      <Card className="border-amber-500/20" data-testid="pending-project-approvals-panel">
        <CardHeader className="px-5 pb-2 pt-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-400" aria-hidden />
            {/* task-pending-screen §14 вопрос 1 (design spec): заголовок
                виджета сознательно НЕ переименован — оркестраторская
                addendum п.1 "заголовок виджета не менять". */}
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ждёт вашего решения
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-4">
          {visiblePending.map((item) => (
            <div
              key={item.subjectId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2"
              data-testid={`pending-project-approval-${item.subjectId}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                {item.proposedBy ? (
                  // COPY-H-1 (PR #667 fix-round 3): present tense —
                  // `proposedBy` is a displayName with no gender attached, so
                  // the past tense «Предложил Ірина Савенко» was wrong for
                  // half the names the field can hold. Same resolution #648
                  // reached for «Подтверждает {имя}», and the same wording
                  // the /pending row uses for this very item.
                  <p className="truncate text-xs text-muted-foreground">
                    Предлагает {item.proposedBy}
                  </p>
                ) : null}
                {/* COPY-L-4 / COPY-L-7 (PR #646 fix-rounds 3-4) are kept
                    verbatim in behaviour: a missing figure gets a WHOLE
                    replacement sentence rather than an em-dash dropped into
                    the normal template (a bare "Ваша доля: —%" reads as a
                    real value), and that sentence is `line-clamp-2`, not
                    `truncate`, because at 320px `truncate` was cutting off
                    the actionable half of it. */}
                {item.viewerSharePercent != null ? (
                  <p className="truncate text-[11px] text-amber-300/70">
                    Ваша доля: {item.viewerSharePercent}%
                    {item.seniorName ? ` · синьор: ${item.seniorName}` : ''}
                  </p>
                ) : (
                  <p className="line-clamp-2 text-[11px] text-amber-300/70">
                    Доля неизвестна. Обновите страницу.
                  </p>
                )}
              </div>
              <ProjectApprovalActions
                projectId={item.subjectId}
                companyName={item.title}
                onActed={() => setDismissedIds((prev) => new Set(prev).add(item.subjectId))}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </motion.div>
  )
}
