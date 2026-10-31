import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { JobSourceOperationalRowDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useJobSourceHealth } from '@/hooks/use-job-source-admin'
import {
  stateBadgeVariant,
  useSourceHealthLabels,
} from '@/components/job-sourcing/use-source-health-labels'

export const Route = createFileRoute('/_authenticated/admin/sources/')({
  component: SourcesHealthPage,
})

/** Relative freshness ("2 год тому"), the operational signal — absent when we have never collected. */
function useFreshness() {
  const { i18n } = useLingui()
  return (iso: string | null): string | null => {
    if (!iso) return null
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return null
    const diffMin = Math.round((then - Date.now()) / 60_000)
    const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
    const absMin = Math.abs(diffMin)
    if (absMin < 60) return rtf.format(diffMin, 'minute')
    const diffHour = Math.round(diffMin / 60)
    if (Math.abs(diffHour) < 48) return rtf.format(diffHour, 'hour')
    return rtf.format(Math.round(diffHour / 24), 'day')
  }
}

function SourceRow({
  source,
  fresh,
}: {
  source: JobSourceOperationalRowDto
  fresh: (iso: string | null) => string | null
}) {
  const { stateLabel, reasonLabel, profileSummaryText } = useSourceHealthLabels()
  const lastSeen = fresh(source.lastCollectedAt)
  const newest = fresh(source.newestItemPublishedAt)

  return (
    <Link
      to="/admin/sources/$sourceId"
      params={{ sourceId: source.id }}
      data-testid="job-source-health-row"
      data-source-type={source.type}
      data-state={source.state ?? 'NONE'}
      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-4 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{source.type}</span>
          <Badge variant={stateBadgeVariant(source.state)}>{stateLabel(source.state)}</Badge>
          {source.reasonCode && (
            <span className="text-xs text-muted-foreground">{reasonLabel(source.reasonCode)}</span>
          )}
          {!source.enabled && (
            <Badge variant="secondary">
              <Trans>Вимкнено</Trans>
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span>{profileSummaryText(source.profileSummary)}</span>
          <span>
            {lastSeen ? <Trans>Збір: {lastSeen}</Trans> : <Trans>Збору ще не було</Trans>}
          </span>
          {newest && (
            <span>
              <Trans>Остання вакансія: {newest}</Trans>
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function SourcesHealthPage() {
  const { data, isLoading, isError, refetch } = useJobSourceHealth()
  const fresh = useFreshness()

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="job-source-admin-list">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Стан зовнішніх джерел вакансій: що зараз справне, наскільки свіжі дані та з якою
          періодичністю ми їх збираємо. Відкрийте джерело, щоб побачити історію запусків і подій.
        </Trans>
      </p>

      {isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && !isLoading && (
        <div
          className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive"
          data-testid="job-source-admin-error"
        >
          <span>
            <Trans>Не вдалося завантажити стан джерел.</Trans>
          </span>
          <button
            type="button"
            className="text-xs underline underline-offset-2"
            onClick={() => void refetch()}
          >
            <Trans>Повторити</Trans>
          </button>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="flex flex-col gap-2">
          {data?.items.map((source) => (
            <SourceRow key={source.id} source={source} fresh={fresh} />
          ))}
          {(data?.items.length ?? 0) === 0 && (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              <Trans>Джерел ще не налаштовано.</Trans>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
