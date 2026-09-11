import { useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
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
import type { PendingShareScope } from '@/components/pending-share/cancel-pending-share'
import {
  seniorShareErrorMessage,
  useApproveSeniorShareChange,
  useRejectSeniorShareChange,
} from '@/hooks/use-user-profile'

export interface SeniorShareApprovalActionsProps {
  scope: PendingShareScope
  id: string
  /** Same contract as `ProjectApprovalActions.onActed` — called after a
   * successful approve/reject, so a caller (the /pending row) can drop the
   * item from its local list without waiting for the invalidated query to
   * re-render. */
  onActed?: () => void
  className?: string
}

/**
 * task-pending-screen (design spec §5.2 п.1, §6.2). Visually 1:1 with
 * `ProjectApprovalActions` — same button classes, same reject-dialog shape
 * (CrmDialogContent, reason counter, 500-char cap) — this is the
 * SHARE_APPROVAL counterpart for the /pending screen's `mine` list.
 *
 * Unlike `ProjectApprovalActions`, the toast text lives in the mutation
 * hooks themselves (`useApproveSeniorShareChange`/`useRejectSeniorShareChange`,
 * `use-user-profile.ts`) — the SAME hooks the profile-tab banner
 * (`OverviewTab.tsx`) already calls for `scope: 'user'`. This component only
 * adds the `scope: 'project'` caller those hooks were generalized for
 * (task addendum item 2) — no new mutation logic, no new toast wording.
 */
export function SeniorShareApprovalActions({
  scope,
  id,
  onActed,
  className,
}: SeniorShareApprovalActionsProps) {
  const approve = useApproveSeniorShareChange(scope, id)
  const reject = useRejectSeniorShareChange(scope, id)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  const approveLabel = approve.isPending ? 'Подтверждение…' : 'Подтвердить'
  const rejectLabel = 'Отклонить'

  function handleApprove() {
    approve.mutate(undefined, { onSuccess: () => onActed?.() })
  }

  function handleRejectSubmit() {
    reject.mutate(reason.trim(), {
      onSuccess: () => {
        setRejectOpen(false)
        setReason('')
        onActed?.()
      },
    })
  }

  const approveError = approve.isError
    ? seniorShareErrorMessage(approve.error, 'Не удалось подтвердить')
    : null
  const rejectError = reject.isError
    ? seniorShareErrorMessage(reject.error, 'Не удалось отклонить')
    : null

  return (
    <>
      <div
        data-testid={`senior-share-approval-actions-${scope}-${id}`}
        className={cn(
          'relative z-[2] flex max-w-full flex-wrap items-center justify-end gap-1.5',
          className,
        )}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          // UX-H-2 precedent (ProjectApprovalActions): h-11 (44px) mobile
          // floor, sm:h-7 from 640px — responsive-design.md hard-gate.
          className="h-11 min-w-11 gap-1 border-emerald-500/30 px-2 text-[11px] text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 sm:h-7"
          onClick={handleApprove}
          disabled={approve.isPending}
          aria-label={approveLabel}
          title={approveLabel}
          data-testid={`senior-share-approve-${scope}-${id}`}
        >
          {approve.isPending ? (
            <Loader2
              className="h-3 w-3 animate-spin"
              aria-hidden
              data-testid={`senior-share-approve-${scope}-${id}-spinner`}
            />
          ) : (
            <Check className="h-3 w-3" aria-hidden />
          )}
          <span>{approveLabel}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 min-w-11 gap-1 border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/10 sm:h-7"
          onClick={() => setRejectOpen(true)}
          disabled={reject.isPending}
          aria-label={rejectLabel}
          title={rejectLabel}
          data-testid={`senior-share-reject-${scope}-${id}`}
        >
          {reject.isPending ? (
            <Loader2
              className="h-3 w-3 animate-spin"
              aria-hidden
              data-testid={`senior-share-reject-${scope}-${id}-spinner`}
            />
          ) : (
            <X className="h-3 w-3" aria-hidden />
          )}
          <span>{rejectLabel}</span>
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
            <DialogTitle>Отклонить предложение</DialogTitle>
            <DialogDescription>Причина обязательна и будет видна администратору.</DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`senior-share-reject-reason-${scope}-${id}`}>
                Причина отказа *
              </Label>
              <Textarea
                id={`senior-share-reject-reason-${scope}-${id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: ошиблись с расчётом"
                rows={3}
                maxLength={500}
                aria-describedby={`senior-share-reject-reason-counter-${scope}-${id}`}
                data-testid="senior-share-reject-reason"
              />
              <p
                id={`senior-share-reject-reason-counter-${scope}-${id}`}
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
              data-testid="senior-share-reject-submit"
            >
              {reject.isPending ? 'Отклонение…' : 'Отклонить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </>
  )
}
