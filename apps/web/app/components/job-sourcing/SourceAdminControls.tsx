import { useId, useRef, useState, type FormEvent } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
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
import { jobSourceHealthQueryKey, useResetJobSourceFailures } from '@/hooks/use-job-source-admin'
import { useSetJobSourceEnabled } from '@/hooks/use-job-sourcing'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { sourceLabel } from '@/components/job-queue/JobQueueRow'
import { readinessPhrases } from './readiness-reason'

/**
 * The two ADMIN write controls on one source row of the health list: the enable switch and the
 * reset of the failure cap. Both are server-authoritative: the switch shows the server's `enabled`
 * (never optimistic), and a refused write leaves it where it was and says why in a toast.
 */

/** The first block of the source id: shown in the row, so same-type rows can be told apart. */
// shortcut: 8 hex chars are not guaranteed unique; switch to the full id if two rows ever collide.
export const sourceShortId = (id: string): string => id.slice(0, 8)

/** The accessible name of a row's controls: the source's product name plus its short id. */
export const sourceRowName = (source: JobSourceOperationalRowDto): string =>
  `${sourceLabel(source.type)} (${sourceShortId(source.id)})`

const cannotEnable = (source: JobSourceOperationalRowDto) =>
  source.readiness === 'BLOCKED' && !source.enabled

/**
 * Enable / disable one source. The server refuses only enabling a BLOCKED source, so an off
 * BLOCKED source is inert and points at its readiness reason (`SourceEnableHint`, `hintId`), while
 * an on one can still be switched off.
 */
export function SourceEnableSwitch({
  source,
  hintId,
}: {
  source: JobSourceOperationalRowDto
  hintId?: string
}) {
  // `mutate` twice in one tick would send two requests before `isPending` re-renders the switch.
  const inFlight = useRef(false)
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const mutation = useSetJobSourceEnabled()
  const blocked = cannotEnable(source)

  const onCheckedChange = (enabled: boolean) => {
    if (blocked || inFlight.current) return
    inFlight.current = true
    mutation.mutate(
      { id: source.id, enabled },
      {
        onError: (error) => {
          toast.error(getUserFacingErrorMessage(error))
          // A refusal (409 `JOB_SOURCE_NOT_READY`) means this row is stale: refetch the list so it
          // shows the server's readiness without a reload. Here, not in the shared hook, whose
          // other caller (`SourceSwitchCard`) deliberately refetches nothing on a refusal.
          void queryClient.invalidateQueries({ queryKey: jobSourceHealthQueryKey })
        },
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  // The same state words as the sibling `SourceSwitchCard`; the switch itself states it via `aria-checked`.
  const stateText = source.enabled ? t`Працює` : t`Вимкнено`

  return (
    <div className="flex items-center gap-2">
      <Switch
        // 44 px hit area around a 36 × 20 control, without growing the visible switch. The
        // off track is `muted-foreground`, not the primitive's near-black `input`, so the
        // switched-off control keeps ≥ 3:1 against the row (SC 1.4.11).
        className="relative after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 data-[state=unchecked]:bg-muted-foreground"
        checked={source.enabled}
        // Not `disabled`: a natively disabled button drops keyboard focus mid-toggle. The guard
        // in `onCheckedChange` is what refuses the write.
        aria-disabled={blocked || mutation.isPending || undefined}
        onCheckedChange={onCheckedChange}
        aria-label={sourceRowName(source)}
        aria-describedby={blocked ? hintId : undefined}
        data-testid="job-source-enable-switch"
      />
      {/* A fixed width keeps the switch in one column whatever the state word. */}
      <span className="min-w-16 text-xs text-muted-foreground" aria-hidden="true">
        {stateText}
      </span>
    </div>
  )
}

/**
 * Why an off BLOCKED source cannot be enabled. Rendered by the row as its own full-width line, so
 * the hint never narrows the row's text column or pushes its switch out of line.
 */
export function SourceEnableHint({
  source,
  id,
}: {
  source: JobSourceOperationalRowDto
  id: string
}) {
  const { i18n } = useLingui()
  if (!cannotEnable(source)) return null
  const reason = readinessPhrases(source.readinessReason, i18n).join('; ')

  return (
    <span id={id} className="text-xs text-destructive">
      {reason ? (
        <Trans>Не можна увімкнути: {reason}</Trans>
      ) : (
        <Trans context="job source readiness">Заблоковано</Trans>
      )}
    </span>
  )
}

/**
 * "Reset failures" — shown only while the failure cap is engaged (`consecutiveFailures > 0` or a
 * cooldown is set). The reason is required; the server's schema decides its limits, the textarea
 * only mirrors the bound so a too-long reason cannot be typed.
 */
export function SourceResetFailures({ source }: { source: JobSourceOperationalRowDto }) {
  const { t } = useLingui()
  const name = sourceRowName(source)
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
          // 44 px hit area at every width: the box itself at < 640 px, the `::after` above it.
          className="relative min-h-11 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 sm:min-h-9"
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
