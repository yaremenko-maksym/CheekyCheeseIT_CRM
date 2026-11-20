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
import { readinessPhrases } from './readiness-reason'

/**
 * The two ADMIN write controls on one source row of the health list: the enable switch and the
 * reset of the failure cap. Both are server-authoritative: the switch shows the server's `enabled`
 * (never optimistic), and a refused write leaves it where it was and says why in a toast.
 */

/** Enable / disable one source. A BLOCKED source stays off and names its readiness reason. */
export function SourceEnableSwitch({ source }: { source: JobSourceOperationalRowDto }) {
  // `mutate` twice in one tick would send two requests before `isPending` re-renders the switch.
  const inFlight = useRef(false)
  const { i18n, t } = useLingui()
  const hintId = useId()
  const mutation = useSetJobSourceEnabled()
  const blocked = source.readiness === 'BLOCKED'
  const reason = readinessPhrases(source.readinessReason, i18n).join('; ')

  const onCheckedChange = (enabled: boolean) => {
    if (blocked || inFlight.current) return
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

  const stateText = source.enabled ? t`Збір увімкнено` : t`Збір вимкнено`

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <Switch
          checked={source.enabled}
          disabled={blocked || mutation.isPending}
          onCheckedChange={onCheckedChange}
          aria-label={stateText}
          aria-describedby={blocked ? hintId : undefined}
          data-testid="job-source-enable-switch"
          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
        />
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {stateText}
        </span>
      </div>
      {blocked && (
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
          data-testid="job-source-reset-trigger"
        >
          <Trans>Скинути помилки</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              <Trans>Скинути помилки джерела</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Лічильник помилок і охолодження буде скинуто, збір піде за розкладом. Вкажіть
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
