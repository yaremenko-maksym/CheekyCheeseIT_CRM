import { useId, useRef } from 'react'
import { Ban, Check, Pause, ShieldAlert } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { formatRelativeTime, type JobSourceDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useSetJobSourceEnabled } from '@/hooks/use-job-sourcing'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { useLocale } from '@/lib/i18n'
import { sourceLabel } from '@/components/job-queue/JobQueueRow'
import { SourceBudgetRow } from './SourceBudgetRow'
import { deriveSourceState, type SourceStateKind } from './source-state'

/**
 * One source in the ADMIN panel — task 7.5, docs/design/vacancy-queue.md §7.
 *
 * Disabled / paused / blocked are three chips with three icons and three words, never one grey
 * badge: they have different causes and different remedies. Everything shown here is read off the
 * `/job-sourcing/sources` DTO; the switch is the only write, and it is never optimistic — the
 * switch always shows the SERVER's value, so a refused enable leaves it exactly where it was and
 * no cached policy or cost state is touched (the hook only refetches on success).
 */

const DAY_MS = 24 * 60 * 60 * 1000

const CHIP: Record<
  SourceStateKind,
  {
    variant: 'status-active' | 'secondary' | 'outline' | 'destructive'
    className: string
    icon: string
  }
> = {
  running: { variant: 'status-active', className: '', icon: 'check' },
  disabled: { variant: 'secondary', className: '', icon: 'ban' },
  paused: { variant: 'outline', className: 'border-amber-500/40 text-amber-400', icon: 'pause' },
  blocked: { variant: 'destructive', className: '', icon: 'shield-alert' },
}

function StateIcon({ kind }: { kind: SourceStateKind }) {
  const props = { 'aria-hidden': true, className: 'mr-1 size-3 shrink-0' }
  switch (kind) {
    case 'running':
      return <Check {...props} />
    case 'disabled':
      return <Ban {...props} />
    case 'paused':
      return <Pause {...props} />
    case 'blocked':
      return <ShieldAlert {...props} />
  }
}

export function SourceSwitchCard({ source }: { source: JobSourceDto }) {
  const { t } = useLingui()
  const locale = useLocale()
  const noteId = useId()
  const mutation = useSetJobSourceEnabled()
  // `mutate` twice in one tick would send two requests before `isPending` re-renders the switch
  // disabled, so the guard is a ref, not state.
  const inFlight = useRef(false)

  const now = Date.now()
  const state = deriveSourceState(source, now)
  const readinessReason = source.readinessReason
  const name = sourceLabel(source.type)

  const label: Record<SourceStateKind, string> = {
    running: t`Працює`,
    disabled: t`Вимкнено`,
    paused: t`Призупинено`,
    // Own context: the bare «Заблоковано» is already the finance «Locked» in the English catalog.
    blocked: t({ message: 'Заблоковано', context: 'job source readiness' }),
  }

  const pauseReason = (code: string | null): string | null => {
    if (code === null) return null
    if (code === 'HTTP_429') return t`джерело просило зачекати (429)`
    if (code === 'CHALLENGE_DETECTED') return t`джерело вимагає перевірки (challenge)`
    return t`код ${code}`
  }

  const note = (() => {
    switch (state.kind) {
      case 'running':
        return null
      case 'disabled':
        return t`Вимкнено адміністратором`
      case 'blocked':
        return readinessReason ? t`Не готове: ${readinessReason}` : t`Не готове до роботи`
      case 'paused': {
        if (!state.pausedUntil) return t`Пауза без визначеного часу`
        const until = new Date(state.pausedUntil)
        const when =
          until.getTime() - now < DAY_MS
            ? until.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
            : until.toLocaleString(locale, {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })
        const reason = pauseReason(state.code)
        return reason ? t`Пауза до ${when}: ${reason}` : t`Пауза до ${when}`
      }
    }
  })()

  const toggle = () => {
    if (inFlight.current || mutation.isPending) return
    inFlight.current = true
    mutation.reset()
    mutation.mutate(
      { id: source.id, enabled: !source.enabled },
      {
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  const { budget } = source
  const used = budget.used
  const limit = budget.limit
  const showQuota = (budget.state === 'ACTIVE' || budget.state === 'EXHAUSTED') && !!limit

  const never = t`ніколи`
  const stamps: Array<[string, string | null | undefined]> = [
    [t`Остання спроба`, source.lastAttemptAt],
    [t`Остання вдала`, source.lastSuccessAt],
    [t`Остання з даними`, source.lastNonemptyAt],
  ]

  const attemptedEnable = mutation.variables?.enabled === true
  const failureReason =
    (attemptedEnable && readinessReason) || getUserFacingErrorMessage(mutation.error)

  const chip = CHIP[state.kind]

  return (
    <li
      data-testid="job-source-card"
      data-source-type={source.type}
      className="flex flex-col gap-2.5 rounded-lg border border-border/60 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <Badge
            variant={chip.variant}
            className={chip.className}
            data-testid="job-source-state-chip"
            data-state={state.kind}
            data-icon={chip.icon}
          >
            <StateIcon kind={state.kind} />
            {label[state.kind]}
          </Badge>
        </div>
        <Switch
          // 44 px hit area around a 36 × 20 control, without growing the visible switch.
          className="relative after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2"
          checked={source.enabled}
          disabled={mutation.isPending}
          onCheckedChange={toggle}
          aria-label={name}
          aria-describedby={note ? noteId : undefined}
        />
      </div>

      {note && (
        <p id={noteId} data-testid="job-source-state-note" className="text-muted-foreground">
          {note}
        </p>
      )}

      <SourceBudgetRow source={source} embedded />

      {showQuota && limit && (
        <div className="flex flex-col gap-1">
          <div
            role="img"
            aria-label={t`Використано ${used} з ${limit}`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              data-testid="job-source-quota-used"
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, (used * 100) / limit)}%` }}
            />
          </div>
          <p data-testid="job-source-quota-legend" className="tabular-nums text-muted-foreground">
            <Trans>Використано {used}</Trans>
          </p>
        </div>
      )}

      <dl
        data-testid="job-source-timestamps"
        className="grid grid-cols-1 gap-x-4 gap-y-1.5 @min-[560px]:grid-cols-3"
      >
        {stamps.map(([term, iso]) => (
          <div key={term} className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="tabular-nums text-foreground">
              {iso ? formatRelativeTime(iso, locale) : never}
            </dd>
          </div>
        ))}
      </dl>

      {mutation.isError && (
        <p
          role="alert"
          data-testid="job-source-enable-failure"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive"
        >
          <span className="font-medium">
            {attemptedEnable ? t`Не вдалося увімкнути` : t`Не вдалося вимкнути`}
          </span>{' '}
          {t`Причина: ${failureReason}. Стан не змінено.`}
        </p>
      )}
    </li>
  )
}
