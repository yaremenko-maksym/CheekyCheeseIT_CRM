import { useId, useRef, type ReactNode } from 'react'
import { Ban, Check, Pause, ShieldAlert, type LucideIcon } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { formatRelativeTime, type JobSourceDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useSetJobSourceEnabled } from '@/hooks/use-job-sourcing'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { useLocale } from '@/lib/i18n'
import { sourceLabel } from '@/components/job-queue/JobQueueRow'
import { QuotaBar, type QuotaFigures } from './QuotaBar'
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
  { variant: 'status-active' | 'secondary' | 'outline' | 'destructive'; Icon: LucideIcon }
> = {
  running: { variant: 'status-active', Icon: Check },
  disabled: { variant: 'secondary', Icon: Ban },
  paused: { variant: 'outline', Icon: Pause },
  blocked: { variant: 'destructive', Icon: ShieldAlert },
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

  const label: Record<SourceStateKind, ReactNode> = {
    running: t`Працює`,
    disabled: t`Вимкнено`,
    paused: t`Призупинено`,
    // Own context: the bare «Заблоковано» is already the finance «Locked» in the English catalog.
    // `Trans` (not `t({ message })`): Stryker rewrites the string literal the macro needs.
    blocked: <Trans context="job source readiness">Заблоковано</Trans>,
  }

  const pauseReason = (code: string | null): string | null => {
    if (!code) return null
    if (code === 'HTTP_429') return t`джерело просило зачекати (429)`
    if (code === 'CHALLENGE_DETECTED') return t`джерело вимагає перевірки (challenge)`
    return t`код ${code}`
  }

  const note = (() => {
    if (state.kind === 'disabled') return t`Вимкнено адміністратором`
    if (state.kind === 'blocked') {
      return readinessReason ? t`Не готове: ${readinessReason}` : t`Не готове до роботи`
    }
    if (state.kind === 'paused') {
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
    return null
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

  // The account meter (r5) is the truth for a source that has one; the legacy per-source counter
  // (DOU) has no reserved / uncertain amounts. A limit of null or 0 draws no bar.
  const { budget, meter } = source
  const quota: QuotaFigures | null = meter
    ? meter.limit
      ? { ...meter, total: meter.limit }
      : null
    : (budget.state === 'ACTIVE' || budget.state === 'EXHAUSTED') && budget.limit
      ? {
          used: budget.used,
          reserved: 0,
          uncertain: 0,
          total: budget.limit,
          unit: 'REQUEST',
        }
      : null

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
            className={state.kind === 'paused' ? 'border-amber-500/40 text-amber-400' : undefined}
            data-testid="job-source-state-chip"
            data-state={state.kind}
            data-icon={chip.Icon.displayName}
          >
            <chip.Icon
              aria-hidden
              data-testid="job-source-state-icon"
              className="mr-1 size-3 shrink-0"
            />
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

      <SourceBudgetRow source={source} />

      {quota && <QuotaBar {...quota} />}

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
