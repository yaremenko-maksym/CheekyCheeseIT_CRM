import { useState } from 'react'
import { Check, X } from 'lucide-react'
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
   * Called after a successful approve/reject, AND after a 409/404 (already
   * responded — see `isAlreadyRespondedError`'s doc). Callers use this to
   * drop the item from a local list (`PendingProjectApprovalsPanel`) or to
   * rely on the shared query invalidation alone (`ProjectRow`, which
   * re-renders from the invalidated list anyway).
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
      onSuccess: () => onActed?.(),
      onError: (err) => {
        if (isAlreadyRespondedError(err)) onActed?.()
      },
    })
  }

  function handleRejectSubmit() {
    const trimmed = reason.trim()
    if (!trimmed) return
    reject.mutate(
      { projectId, reason: trimmed },
      {
        onSuccess: () => {
          setRejectOpen(false)
          setReason('')
          onActed?.()
        },
        onError: (err) => {
          if (isAlreadyRespondedError(err)) {
            setRejectOpen(false)
            setReason('')
            onActed?.()
          }
        },
      },
    )
  }

  // The axios response interceptor already rewrites `.message` to a
  // friendly RU string (getUserFacingErrorMessage) before it reaches here —
  // an "already responded" 409/404 is handled above and never shown as an
  // error at all.
  const approveError =
    approve.isError && !isAlreadyRespondedError(approve.error)
      ? (approve.error as Error).message
      : null
  const rejectError =
    reject.isError && !isAlreadyRespondedError(reject.error)
      ? (reject.error as Error).message
      : null

  return (
    <>
      <div
        className={cn('relative z-[2] flex flex-wrap items-center justify-end gap-1.5', className)}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 min-w-11 gap-1 border-emerald-500/30 px-2 text-[11px] text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          onClick={handleApprove}
          disabled={approve.isPending}
          data-testid={`project-approval-approve-${projectId}`}
        >
          <Check className="h-3 w-3" aria-hidden />
          {approve.isPending ? 'Подтверждаем…' : 'Подтвердить'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 min-w-11 gap-1 border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/10"
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
            <DialogTitle>Отклонить проект «{companyName}»</DialogTitle>
            <DialogDescription className="sr-only">
              Форма причины отказа от подтверждения проекта
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Причина обязательна — админ увидит её и сможет предложить проект заново.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Причина отказа</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: нет бюджета на Q3"
                rows={3}
                data-testid="project-approval-reject-reason"
              />
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
              {reject.isPending ? 'Отклоняем…' : 'Отклонить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </>
  )
}
