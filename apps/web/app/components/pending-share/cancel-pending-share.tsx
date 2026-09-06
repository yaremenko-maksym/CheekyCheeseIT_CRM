import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectDetailDto, UserWithPermissionsResponse } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/axios'
import { seniorShareErrorMessage } from '@/hooks/use-user-profile'

/**
 * task-648-fix-round-2 (SR-H-2 / SPEC-H-2 / CR-H-3 / UX-H-3(r2) / QA-HIGH-2).
 *
 * The client half of `POST …/senior-share/cancel`. Round 1 shipped the
 * endpoint and no way to reach it: five review axes independently found that
 * `cancelSeniorShareChange` had zero call sites in `apps/web`, and that the
 * only documented way to withdraw a proposal — "return the slider to the
 * active value" — was unreachable through the project form (which only sends
 * the field when it DIFFERS from the active value) and destructive on the
 * user form (which sent it unconditionally, so editing a phone killed a live
 * proposal). Round 2 removed that implicit path entirely; this is the
 * explicit one that replaces it.
 *
 * ONE module for both halves on purpose. The two surfaces differ only in the
 * URL and in which query keys go stale; everything the reviewer cared about —
 * the confirmation step, the 404/409 mapping, the toast wording, the 44px
 * touch target — is the kind of thing that drifts the moment it is written
 * twice.
 */

export type PendingShareScope = 'user' | 'project'

/**
 * `UserWithPermissionsResponse` (users half) and `ProjectDetailDto` (project
 * half) both carry the post-cancel effective percent, under different names.
 * Narrowed here rather than in each caller so the toast can name the real
 * number the server settled on — the lesson COPY-M-3 recorded in round 1
 * ("name the value the server confirmed, not the one the operator clicked").
 */
function effectivePercentOf(scope: PendingShareScope, data: unknown): number | null {
  if (scope === 'user') {
    const percent = (data as UserWithPermissionsResponse | undefined)?.user?.seniorSharePercent
    return typeof percent === 'number' ? percent : null
  }
  const percent = (data as ProjectDetailDto | undefined)?.effectiveSeniorSharePercent
  return typeof percent === 'number' ? percent : null
}

export function useCancelPendingShare(scope: PendingShareScope, id: string) {
  const qc = useQueryClient()

  const invalidate = () => {
    if (scope === 'user') {
      void qc.invalidateQueries({ queryKey: ['user-profile', id] })
      void qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      void qc.invalidateQueries({ queryKey: ['users-admin'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
    } else {
      void qc.invalidateQueries({ queryKey: ['projects', id] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    }
  }

  return useMutation({
    mutationFn: async () => {
      const response = await api.post<unknown>(
        scope === 'user'
          ? `/users/${id}/senior-share/cancel`
          : `/projects/${id}/senior-share/cancel`,
      )
      return response.data
    },
    onSuccess: (data) => {
      const percent = effectivePercentOf(scope, data)
      toast.success(
        percent === null
          ? 'Предложение отменено — действует прежний процент'
          : `Предложение отменено — действует ${percent}%`,
      )
      invalidate()
    },
    onError: (err: unknown) => {
      // Same 404/409 mapping the approve/reject pair uses, and the same
      // refetch-on-failure (QA-MED-5, round 1): a proposal someone else
      // already resolved must not leave a live-looking button on screen.
      toast.error(seniorShareErrorMessage(err, 'Не удалось отменить предложение'))
      invalidate()
    },
  })
}

/**
 * Icon-only withdraw button, sized for touch. `h-11 w-11` until `sm:` is the
 * same 44px floor UX-H-1 established for the approve/reject pair in round 1 —
 * this button sits next to the same badge on the same 320px screens.
 */
export function CancelPendingShareButton({
  scope,
  id,
  className,
}: {
  scope: PendingShareScope
  id: string
  className?: string
}) {
  const cancelMutation = useCancelPendingShare(scope, id)
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label="Отменить предложение"
      title="Отменить предложение"
      className={`h-11 w-11 shrink-0 p-0 sm:h-8 sm:w-8 ${className ?? ''}`}
      disabled={cancelMutation.isPending}
      onClick={() => cancelMutation.mutate()}
      data-testid={`cancel-pending-share-${scope}`}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </Button>
  )
}

/**
 * UX-H-3(r2), the finding's "более важное место": the edit dialogs. An ADMIN
 * who opens the form to "fix" the percent was shown a slider holding the
 * ACTIVE value and nothing at all about the proposal already awaiting an
 * answer — so the natural gesture (type a new number, save) silently
 * superseded a live proposal the operator never knew existed.
 *
 * Rendered into the hint slot both forms already have, so it appears exactly
 * where the reader is looking when they touch the field.
 */
export function PendingShareEditNotice({
  scope,
  id,
  pendingPercent,
  approverName,
  testId,
}: {
  scope: PendingShareScope
  id: string
  /** The proposed percent. Already resolved by the server for the project
   * half's "clear the override" case (`effectivePercentAfterApproval`), so
   * this component never guesses a number. */
  pendingPercent: number
  approverName: string
  testId?: string
}) {
  const cancelMutation = useCancelPendingShare(scope, id)
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2"
      data-testid={testId ?? `pending-share-edit-notice-${scope}`}
    >
      <p className="text-xs">
        Предложено <span className="font-medium tabular-nums">{pendingPercent}%</span> — ждёт
        подтверждения: {approverName}. Новое значение заменит предложение.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 sm:h-8"
        disabled={cancelMutation.isPending}
        onClick={() => cancelMutation.mutate()}
        data-testid={`cancel-pending-share-${scope}-in-dialog`}
      >
        {cancelMutation.isPending ? 'Отмена…' : 'Отменить предложение'}
      </Button>
    </div>
  )
}
