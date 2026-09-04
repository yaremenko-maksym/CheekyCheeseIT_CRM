import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { cn } from '@/lib/utils'
import { getAxiosStatus, getUserFacingErrorMessage } from '@/lib/axios-utils'
import {
  isAlreadyRespondedError,
  useApproveProjectDraft,
  useRejectProjectDraft,
} from '@/hooks/use-project-approvals'

export interface ProjectApprovalActionsProps {
  projectId: string
  /** Used only in the reject dialog's title/copy. */
  companyName: string
  /**
   * Called after a successful approve/reject, AND after a 409 (already
   * responded — see `isAlreadyRespondedError`'s doc; SR-M-4 narrowed this
   * from 409/404 to 409 only — a 404 is now a real, toasted error). Callers
   * use this to drop the item from a local list
   * (`PendingProjectApprovalsPanel`) or to rely on the shared query
   * invalidation alone (`ProjectRow`, which re-renders from the invalidated
   * list anyway).
   */
  onActed?: () => void
  className?: string
}

/**
 * task-project-status-filter-ui, §Что сделать item 3: "действие
 * подтверждения — в самой записи согласования, а не только на карточке
 * проекта". One component, two mount points:
 *   - `ProjectRow`'s status column (§7 design spec) — for ADMIN/SENIOR, who
 *     can reach /projects at all.
 *   - `PendingProjectApprovalsPanel` on DropDashboard/SeniorDashboard — the
 *     ONLY reachable surface for DROP, who has no route access to
 *     /projects (`useRoleGuard` on that route excludes DROP; see the
 *     task's «Допущения» for why a personal dashboard widget, not a new
 *     route/section).
 *
 * Both mutations already exist server-side (PR #630) with no `@Roles`
 * restriction — the server verifies the caller is actually an invited
 * approver and 404s otherwise, so this component adds no new capability,
 * only a second place to reach an already-safe action.
 */
/**
 * COPY-H-1 (PR #646 fix-round 2). The backend's own 404 message
 * ("Согласование не найдено или уже погашено" — `ApprovalsService.
 * loadLiveRowForUpdate`) reaches the user verbatim via
 * `getUserFacingErrorMessage`'s priority-1 backend-message passthrough —
 * three defects at once: "Согласование" is a name for the same concept the
 * rest of this UI calls "подтверждение" (tab, badge, button all agree; the
 * backend disagrees); "погашено" is the Расчёт/settle term this project's
 * glossary (`CONTEXT.md`) lists under `_Избегать_` for anything that is not
 * an actual payout — this is neither; and it names no next step. Mapped to
 * an own, actionable string here instead — the backend message stays
 * accurate for logs/support, this is what the USER sees.
 */
function friendlyErrorMessage(err: unknown): string {
  if (getAxiosStatus(err) === 404) {
    return 'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.'
  }
  return getUserFacingErrorMessage(err)
}

export function ProjectApprovalActions({
  projectId,
  companyName,
  onActed,
  className,
}: ProjectApprovalActionsProps) {
  const approve = useApproveProjectDraft()
  const reject = useRejectProjectDraft()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  function stop(e: React.MouseEvent) {
    // ProjectRow is a stretched-link row (Link's `::before` covers the
    // whole row, z-[1]) — these buttons sit at z-[2] so the click already
    // resolves to THEM, not the row navigation; stopPropagation/
    // preventDefault is the same "страховка" the senior/junior name links
    // in ProjectRow already carry for the same reason.
    e.stopPropagation()
    e.preventDefault()
  }

  function handleApprove(e: React.MouseEvent) {
    stop(e)
    approve.mutate(projectId, {
      // COPY-H-2 (PR #646 fix-round 2). Silence used to be the ENTIRE
      // feedback for a successful confirm — a viewer who just clicked had
      // no way to tell "it worked" from "nothing happened yet" without
      // watching the row/item disappear, which is not always immediate
      // (query invalidation) and easy to miss on a widget on a dashboard
      // full of other cards. `project.status` on the mutation response
      // tells us which of the two real outcomes happened: everyone has now
      // confirmed (ACTIVE), or the project is still waiting on the OTHER
      // invited approver (still DRAFT) — two different facts, two
      // different sentences, not one generic "done".
      onSuccess: (project) => {
        // COPY-M-8 (PR #646 fix-round 3): this used to say "Ждём решения
        // второй стороны" while ProjectRow's own caption for the exact same
        // fact says "Ждём дропа"/"Ждём синьора" — two names, one second
        // apart, for one thing. "Сторона" is also already the CRM's word
        // for an invoice's two signing parties (CONTEXT.md, «Инвойс»),
        // giving it a third, unrelated meaning here would have been a new
        // synonym the glossary explicitly warns against. The mutation
        // response already carries which one is still pending — same
        // fields ProjectRow reads for its own caption — so this can name
        // the actual missing side instead of a generic placeholder.
        toast.success(
          project.status === 'ACTIVE'
            ? `Проект «${companyName}» подтверждён`
            : project.dropApprovalPending
              ? 'Вы подтвердили. Ждём дропа'
              : 'Вы подтвердили. Ждём синьора',
        )
        onActed?.()
      },
      onError: (err) => {
        // SR-M-4: 409 ("already responded") stays a silent self-correction;
        // anything else — including a 404, which can mean the caller was
        // never actually an invited approver — is a REAL error and must be
        // visible, not just a vanished element with no explanation.
        if (isAlreadyRespondedError(err)) {
          onActed?.()
        } else {
          toast.error(friendlyErrorMessage(err))
        }
      },
    })
  }

  function handleRejectSubmit() {
    // No internal empty-reason guard here — the submit button's own
    // `disabled={reject.isPending || !reason.trim()}` (below) is the ONE
    // enforcement point, same precedent as ValidateDialog's reject button.
    // A disabled `<button>` never dispatches a click in a real browser (or
    // in `@testing-library/user-event`, which models that), so a second
    // guard here would be dead code no interaction could ever reach.
    reject.mutate(
      { projectId, reason: reason.trim() },
      {
        onSuccess: () => {
          setRejectOpen(false)
          setReason('')
          // COPY-H-2: same "success used to be silent" fix as approve — a
          // reject is a real, final, financially-relevant decision and
          // deserves the same one-line confirmation.
          toast.success('Проект отклонён, админ увидит причину')
          onActed?.()
        },
        onError: (err) => {
          // SR-M-4: same 409-only self-correction as handleApprove above —
          // a 404 here stays open with the inline error text (rejectError,
          // below) AND a toast, since the dialog is already visible and the
          // reason the user typed should not just disappear silently.
          if (isAlreadyRespondedError(err)) {
            setRejectOpen(false)
            setReason('')
            onActed?.()
          } else {
            toast.error(friendlyErrorMessage(err))
          }
        },
      },
    )
  }

  // COPY-H-1: `friendlyErrorMessage` here too, not raw `.message` — the
  // axios interceptor's own rewrite (`getUserFacingErrorMessage`) already
  // ran by the time `.error` reaches this component, but that rewrite has
  // no 404-specific case, so it still passes the backend's "Согласование
  // ... погашено" string straight through for THIS one status. An
  // "already responded" 409 is handled above and never shown as an error
  // at all. A 404 (SR-M-4) is a real error: shown BOTH here (inline, next
  // to the control the click was on) and as a toast above.
  const approveError =
    approve.isError && !isAlreadyRespondedError(approve.error)
      ? friendlyErrorMessage(approve.error)
      : null
  const rejectError =
    reject.isError && !isAlreadyRespondedError(reject.error)
      ? friendlyErrorMessage(reject.error)
      : null

  return (
    <>
      <div
        data-testid={`project-approval-actions-${projectId}`}
        className={cn('relative z-[2] flex flex-wrap items-center justify-end gap-1.5', className)}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          // UX-H-2 (PR #646 fix-round 1): h-11 (44px, responsive-design.md
          // hard-gate) on mobile, back to the tighter h-7 (28px) from sm:
          // (640px+) up — same responsive-height pattern index.tsx's
          // SegmentedToggle mobile instance already uses
          // ([&>button]:min-h-11) for the same 44px requirement.
          className="h-11 min-w-11 gap-1 border-emerald-500/30 px-2 text-[11px] text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 sm:h-7"
          onClick={handleApprove}
          disabled={approve.isPending}
          data-testid={`project-approval-approve-${projectId}`}
        >
          <Check className="h-3 w-3" aria-hidden />
          {/* COPY-L-1 (PR #646 fix-round 2, optional): repo convention is the
              deverbal noun ("Сохранение…", "Создание…", "Публикация…" — 15
              instances) over first-person plural ("Сохраняем…" — 4) —
              matches the majority. */}
          {approve.isPending ? 'Подтверждение…' : 'Подтвердить'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          // UX-H-2: same responsive-height fix as the Confirm button above.
          className="h-11 min-w-11 gap-1 border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/10 sm:h-7"
          onClick={(e) => {
            stop(e)
            setRejectOpen(true)
          }}
          disabled={reject.isPending}
          data-testid={`project-approval-reject-${projectId}`}
        >
          <X className="h-3 w-3" aria-hidden />
          Отклонить
        </Button>
      </div>
      {approveError && (
        <p className="relative z-[2] mt-1 text-right text-[10px] text-destructive">
          {approveError}
        </p>
      )}

      <Dialog
        open={rejectOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRejectOpen(false)
            setReason('')
          }
        }}
      >
        <CrmDialogContent maxWidth="sm:max-w-md">
          <CrmDialogHeader>
            {/* UX-L-1(r3) (PR #646 fix-round 3): an extreme companyName
                (own test fixture ran ~70 chars) wrapped the title 4-5 lines
                deep, pushing the reason field below the fold on 320px.
                `line-clamp-2` caps it — real company names are nowhere near
                this length, this is a defensive cap, not a truncation most
                users will ever see. */}
            <DialogTitle className="line-clamp-2">Отклонить проект «{companyName}»</DialogTitle>
            {/* COPY-L-5 (PR #646 fix-round 3): "причины отказа от
                подтверждения проекта" was four genitive nouns in a row — a
                screen-reader-only string, so it is read aloud, never seen,
                and this is exactly the register where a genitive chain
                reads worst. Shortened to the same two words the visible
                title already uses. */}
            <DialogDescription className="sr-only">Форма отказа: причина</DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody className="space-y-3">
            {/* COPY-L-3 (PR #646 fix-round 2, optional): this paragraph's
                "админ увидит её" claim used to be broader than the truth
                (every invited approver received the text) — SR-M-5 (same
                fix-round) narrowed rejectionReason to ADMIN-only, which
                makes this sentence accurate as written; no wording change
                needed here, only the `*` on the label below (obligatory
                field marked visually, matching the finance screens'
                convention — "Чек / подтверждение *").
                COPY-L-5 (fix-round 3): the `*` on the label below already
                says "obligatory" — this paragraph used to say it a second
                time ("Причина обязательна —"), then repeat the same fact.
                Trimmed to what the `*` doesn't already cover. */}
            <p className="text-sm text-muted-foreground">
              Админ увидит причину и сможет предложить проект заново.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs" id="project-approval-reject-reason-label">
                Причина отказа *
              </Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: нет бюджета на Q3"
                rows={3}
                // SR-L-2 (PR #646 fix-round 1): matches rejectProjectSchema's
                // / rejectApprovalInputSchema's own `.max(500, ...)` — without
                // this, 500+ characters would type fine here and only fail
                // as a 400 after Отклонить, with no hint at the field itself.
                maxLength={500}
                // UX-M-1 (PR #646 fix-round 3): links the counter below to
                // this field so a screen-reader user tabbed INTO the
                // Textarea also gets announced how much room is left,
                // without having to navigate to the counter paragraph
                // separately.
                aria-describedby="project-approval-reject-reason-counter"
                data-testid="project-approval-reject-reason"
              />
              {/* COPY-M-4 / QA-L-2 (PR #646 fix-round 2): maxLength alone is
                  silent — the field simply stops accepting input with no
                  sound or hint, and the schema's own "слишком длинная"
                  message becomes unreachable once this attribute is in
                  place. A visible counter is the only remaining signal.
                  UX-M-1 (fix-round 3): `aria-live="polite"` announces the
                  updated count on ITS OWN, for a screen-reader user who is
                  not focused on this paragraph (e.g. still typing in the
                  Textarea) — `aria-describedby` above covers the
                  focused-on-the-field case, this covers the ambient one;
                  "polite" (not "assertive") queues the announcement after
                  the current one instead of interrupting mid-keystroke. */}
              <p
                id="project-approval-reject-reason-counter"
                aria-live="polite"
                className="text-right text-[10px] text-muted-foreground"
              >
                {reason.length}/500
              </p>
            </div>
            {rejectError && <p className="text-xs text-destructive">{rejectError}</p>}
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectOpen(false)
                setReason('')
              }}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={handleRejectSubmit}
              disabled={reject.isPending || !reason.trim()}
              data-testid="project-approval-reject-submit"
            >
              {reject.isPending ? 'Отклонение…' : 'Отклонить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </>
  )
}
