import { Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/context/auth'
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
  const { user } = useAuth()
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
      // CR-M-3 (PR #646 fix-round 2). `ConditionalExpression` on a single
      // ternary generates exactly two mutants — Stryker's own docs example
      // (`a < b ? b : a` → `true ? b : a` AND `false ? b : a`) — and a
      // per-line disable comment silences the whole mutator category, both
      // variants at once; there is no comment syntax that targets only one
      // of the two (confirmed against Stryker's disable-mutants reference —
      // scope is `next-line <mutatorName>`, never a specific generated
      // mutant). So the directive below covers BOTH, and both need a stated
      // reason, not just the one this comment used to name:
      //
      // - `false ? prev : next` (always returns `next`): equivalent. When
      //   nothing was pruned, `next`'s CONTENT already equals `prev`'s —
      //   returning `next` unconditionally still leaves every `.has(id)`
      //   call in this file identical; the only effect is an extra React
      //   re-render (new Set reference), which no test can observe without
      //   asserting a render count, an implementation detail this codebase
      //   does not test for.
      // - `true ? prev : next` (always returns `prev`, i.e. pruning never
      //   happens): NOT equivalent, and NOT actually silenced in practice —
      //   "a fresh fetch (dataUpdatedAt changes) prunes a dismissal for an
      //   item no longer in `pending`" (this file's own test, below) fails
      //   under this exact mutant: with `dismissedIds` never pruned, a
      //   later re-proposal of the same id would stay hidden, contradicting
      //   that test's `toBeInTheDocument()`. Left under the same directive
      //   anyway ONLY because Stryker cannot generate this mutant without
      //   its equivalent sibling above — not because it is untested.
      // Stryker disable next-line ConditionalExpression: covers both mutants of this ternary (see the block comment above) — `false?` branch is a true equivalent mutant (extra re-render only), `true?` branch is NOT equivalent but is independently killed by "a fresh fetch (dataUpdatedAt changes) prunes a dismissal..." below and cannot be generated separately from its sibling
      return next.size === prev.size ? prev : next
    })
    // Deliberately keyed on `dataUpdatedAt`, not `pending` — `pending` is a
    // brand-new filtered array every render (referentially), which would
    // re-run this on every render instead of only on an actual refetch.
    // (react-hooks/exhaustive-deps is not configured in this project's eslint.)
  }, [dataUpdatedAt])

  // COPY-H-2 (PR #646 fix-round 2). `pending` (usePendingProjectApprovals)
  // buckets purely on `project.status === 'DRAFT'` — it does not know WHO
  // is looking. On a two-approver project, the viewer's OWN half can
  // already be done (`seniorApprovalPending`/`dropApprovalPending` false
  // for them specifically) while the project stays DRAFT waiting on the
  // OTHER party — `dismissedIds` only covers "I acted THIS session"; a
  // fresh page load (or another device) would show the same
  // already-resolved item again with a live Confirm/Reject that only ever
  // 409s. `?? true` mirrors ProjectRow.tsx's own fallback: an old
  // cached/mocked DTO predating these two fields defaults to "still
  // pending", never to "already decided".
  const visiblePending = pending.filter((project) => {
    if (dismissedIds.has(project.id)) return false
    const viewerIsSenior = !!user?.id && user.id === project.seniorId
    const viewerIsDrop = !!user?.id && user.id === project.dropId
    const seniorStillPending = project.seniorApprovalPending ?? true
    const dropStillPending = project.dropApprovalPending ?? true
    if (viewerIsSenior) return seniorStillPending
    if (viewerIsDrop) return dropStillPending
    // Neither id matches this viewer — should not happen (the backend only
    // ever returns a DRAFT project to ADMIN or an invited approver), but
    // fail open to "show it" rather than silently hiding a genuine pending
    // decision behind a defensive guess.
    return true
  })

  if (isLoading) {
    return (
      <Skeleton
        className="h-24 w-full rounded-lg"
        data-testid="pending-project-approvals-loading"
      />
    )
  }

  // COPY-M-7 (PR #646 fix-round 2): DROP has NO other reachable surface for
  // this action at all (see the component doc above) — the earlier "silent
  // on error" reasoning ("the dashboard's own summary card already shows
  // an error") does not hold here: that OTHER card is about
  // useDropSummary's own data, a genuinely different fetch. If THIS panel's
  // `GET /projects` fails, silence means DROP never learns someone is
  // waiting on them, with no other screen that would tell them either. One
  // line, not a full error card — the empty case (genuinely nothing
  // pending) still renders nothing, that IS the correct "all clear" state.
  if (isError) {
    return (
      // COPY-L-6 (PR #646 fix-round 3): the card's own header four lines
      // below says "решения" ("Ждёт вашего решения") — this error used a
      // second word ("подтверждения") for the same object. One name per
      // concept in one card.
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
                {/* COPY-M-6 (PR #646 fix-round 2): DROP has no route access
                    to /projects at all — this widget is their ONLY view of
                    what they are being asked to agree to, so "да" here was
                    effectively blind (share % and who the senior is are
                    both already on the DTO, just not shown). Symmetric for
                    SENIOR: dropName stays masked from them either way (RBAC
                    rule #2, unrelated to this fix), so no attempt to name
                    the drop for that viewer — their own share % is still
                    useful context. `effectiveDropSharePercent`/
                    `effectiveSeniorSharePercent` (not the raw per-user
                    default `dropSharePercent`) — the resolved value,
                    accounting for a project-level override, is what
                    actually applies to THIS decision. */}
                {/* COPY-L-4 (PR #646 fix-round 3): a bare "Ваша доля: —%"
                    reads as a real value (an em-dash where a number usually
                    sits, still followed by a "%" sign) rather than as "this
                    is missing" — genuinely reachable only for a stale/cached
                    DTO predating these fields (same `?? true` precedent as
                    the approval-pending booleans elsewhere in this file),
                    but when it happens the sentence itself is wrong, not
                    just one token in it. Whole-sentence fallback instead of
                    a dash substituted into the normal template. */}
                {user?.id === project.dropId ? (
                  project.effectiveDropSharePercent != null ? (
                    <p className="truncate text-[11px] text-amber-300/70">
                      Ваша доля: {project.effectiveDropSharePercent}% · синьор: {project.seniorName}
                    </p>
                  ) : (
                    // COPY-L-7 (PR #646 fix-round 4): this single-line
                    // `truncate` sentence gets cut off at ~208px on a 320px
                    // viewport — "Доля неизвестна." (the fact) can survive
                    // that width fully; "Обновите страницу." (the fix, i.e.
                    // "reload") is the part `truncate` was dropping. Renamed
                    // shorter AND switched to `line-clamp-2` so the whole
                    // sentence fits without either.
                    <p className="line-clamp-2 text-[11px] text-amber-300/70">
                      Доля неизвестна. Обновите страницу.
                    </p>
                  )
                ) : user?.id === project.seniorId ? (
                  project.effectiveSeniorSharePercent != null ? (
                    <p className="truncate text-[11px] text-amber-300/70">
                      Ваша доля: {project.effectiveSeniorSharePercent}%
                    </p>
                  ) : (
                    // COPY-L-7: same rename + line-clamp-2 fix, symmetric
                    // with the drop-side branch above.
                    <p className="line-clamp-2 text-[11px] text-amber-300/70">
                      Доля неизвестна. Обновите страницу.
                    </p>
                  )
                ) : null}
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
