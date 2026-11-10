import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { EyeOff } from 'lucide-react'
import type { JobQueueDismissRequestDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  isAccessLoss,
  useDismissJobQueueItem,
  useUndoJobQueueDismissal,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { CONFLICT_NOTE, isQueueConflict } from './JobQueueActions'

const UNDO_MS = 8000

const REASONS = [
  { reason: 'NOT_RELEVANT', label: msg`Нерелевантна` },
  { reason: 'SPAM', label: msg`Спам` },
  { reason: 'DEAD_LINK', label: msg`Мертве посилання` },
] as const

/** QA-MED-2: sonner's action and close are 24 / 20 px; 44 px on mobile, for this toast only. */
const UNDO_TOAST_TARGETS = {
  actionButton: 'max-sm:min-h-11! max-sm:px-4!',
  closeButton: 'max-sm:size-11!',
}

/**
 * «Приховати» (§5.9): a fixed reason, scoped to the actor (own team; ADMIN in the studio scope —
 * the whole studio), then an 8 s undo in exactly that scope. The hooks keep the latest dismissal
 * version past this menu (the card closes on a hide), so the next hide or undo sends it, and a
 * newer one on the server is a conflict the actor sees, never silently applied. A reload forgets
 * it until the card carries its dismissal (7.3b). The card closes on success: its modal layer
 * would leave the undo toast unreachable (inert, no focus).
 */
export function DismissMenu({
  scope,
  opportunityId,
  onClose,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  onClose: () => void
}) {
  const { t } = useLingui()
  const dismiss = useDismissJobQueueItem(scope)
  const undo = useUndoJobQueueDismissal(scope)
  const kind = scope.role === 'ADMIN' && scope.teamId === null ? 'STUDIO' : 'TEAM'

  const failed = (error: unknown, failure: string) => {
    if (isQueueConflict(error)) toast.error(t(CONFLICT_NOTE))
    else if (!isAccessLoss(error)) toast.error(failure)
  }

  const hide = (reason: JobQueueDismissRequestDto['reason']) =>
    dismiss.mutate(
      { opportunityId, scope: kind, reason },
      {
        onSuccess: (res) => {
          toast(t`Приховано`, {
            duration: UNDO_MS,
            classNames: UNDO_TOAST_TARGETS,
            action: {
              label: t({ message: 'Скасувати', context: 'undo a hide' }),
              // the card is closed by now: the promise settles after unmount, mutate callbacks would not
              onClick: () => {
                void undo
                  .mutateAsync({ opportunityId, scope: res.scope, expectedVersion: res.version })
                  .catch((error: unknown) =>
                    failed(error, t`Не вдалося повернути вакансію. Спробуйте ще раз.`),
                  )
              },
            },
          })
          onClose()
        },
        onError: (error) => failed(error, t`Не вдалося приховати вакансію. Спробуйте ще раз.`),
      },
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11 flex-1 sm:flex-none">
          <EyeOff aria-hidden="true" />
          <Trans>Приховати</Trans>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {kind === 'STUDIO' ? (
            <Trans>Буде приховано для всієї студії</Trans>
          ) : (
            <Trans>Буде приховано для вашої команди</Trans>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {REASONS.map(({ reason, label }) => (
          <DropdownMenuItem
            key={reason}
            className="min-h-11 sm:min-h-0"
            disabled={dismiss.isPending}
            onSelect={() => hide(reason)}
          >
            {t(label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
