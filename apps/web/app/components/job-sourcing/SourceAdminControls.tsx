import { useId, useRef, useState, type FormEvent } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { JOB_SOURCE_RESET_REASON_MAX, type JobSourceOperationalRowDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useResetJobSourceFailures } from '@/hooks/use-job-source-admin'
import { useSetJobSourceEnabled } from '@/hooks/use-job-sourcing'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { sourceLabel } from '@/components/job-queue/JobQueueRow'
import { readinessPhrases } from './readiness-reason'

/**
 * The two ADMIN write controls on one source row of the health list: the enable switch and the
 * reset of the failure cap. Both are server-authoritative: the switch shows the server's `enabled`
 * (never optimistic), and a refused write leaves it where it was and says why in a toast.
 */

/**
 * Enable / disable one source. The server refuses only enabling a BLOCKED source, so an off
 * BLOCKED source is inert and names its readiness reason, while an on one can still be switched off.
 */
export function SourceEnableSwitch({ source }: { source: JobSourceOperationalRowDto }) {
  // `mutate` twice in one tick would send two requests before `isPending` re-renders the switch.
  const inFlight = useRef(false)
  const { i18n, t } = useLingui()
  const hintId = useId()
  const mutation = useSetJobSourceEnabled()
  const cannotEnable = source.readiness === 'BLOCKED' && !source.enabled
  const reason = readinessPhrases(source.readinessReason, i18n).join('; ')

  const onCheckedChange = (enabled: boolean) => {
    if (cannotEnable || inFlight.current) return
    inFlight.current = true
    mutation.mutate(
      { id: source.id, enabled },
      {
        onError: (error) => toast.error(getUserFacingErrorMessage(error)),
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  // The same state words as the sibling `SourceSwitchCard`; the switch itself states it via `aria-checked`.
  const stateText = source.enabled ? t`Працює` : t`Вимкнено`

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <Switch
          // 44 px hit area around a 36 × 20 control, without growing the visible switch. The
          // off track is `muted-foreground`, not the primitive's near-black `input`, so the
          // switched-off control keeps ≥ 3:1 against the row (SC 1.4.11).
          className="relative after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 data-[state=unchecked]:bg-muted-foreground"
          checked={source.enabled}
          // Not `disabled`: a natively disabled button drops keyboard focus mid-toggle. The guard
          // in `onCheckedChange` is what refuses the write.
          aria-disabled={cannotEnable || mutation.isPending || undefined}
          onCheckedChange={onCheckedChange}
          aria-label={sourceLabel(source.type)}
          aria-describedby={cannotEnable ? hintId : undefined}
          data-testid="job-source-enable-switch"
        />
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {stateText}
        </span>
      </div>
      {cannotEnable && (
        <span id={hintId} className="text-xs text-destructive">
          {reason ? (
            <Trans>Не можна увімкнути: {reason}</Trans>
          ) : (
            <Trans context="job source readiness">Заблоковано</Trans>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * "Reset failures" — shown only while the failure cap is engaged (`consecutiveFailures > 0` or a
 * cooldown is set). The reason is required; the server's schema decides its limits, the textarea
 * only mirrors the bound so a too-long reason cannot be typed.
 */
export function SourceResetFailures({ source }: { source: JobSourceOperationalRowDto }) {
  const { t } = useLingui()
  const name = sourceLabel(source.type)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const reasonId = useId()
  const mutation = useResetJobSourceFailures(source.id)

  if (source.consecutiveFailures === 0 && source.cooldownUntil === null) return null

  const trimmed = reason.trim()
  const canSubmit = trimmed.length > 0 && !mutation.isPending

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    mutation.mutate(trimmed, {
      onSuccess: () => {
        toast.success(t`Помилки скинуто`)
        setReason('')
        setOpen(false)
      },
      onError: (error) => toast.error(getUserFacingErrorMessage(error)),
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          // Many rows carry this button: its accessible name says which source it resets.
          aria-label={t`Скинути помилки: ${name}`}
          data-testid="job-source-reset-trigger"
        >
          <Trans>Скинути помилки</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              <Trans>Скинути помилки джерела: {name}</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Лічильник помилок і охолодження буде скинуто. Збір піде за розкладом. Вкажіть
                причину: вона записується в журнал.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={reasonId}>
              <Trans>Причина</Trans>
            </Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={JOB_SOURCE_RESET_REASON_MAX}
              required
              rows={3}
              data-testid="job-source-reset-reason"
            />
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="min-h-11 sm:min-h-9"
              data-testid="job-source-reset-submit"
            >
              <Trans>Скинути</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
