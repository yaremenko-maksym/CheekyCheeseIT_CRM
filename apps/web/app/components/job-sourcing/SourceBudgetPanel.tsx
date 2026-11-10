import { msg } from '@lingui/core/macro'
import { ChevronRight } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { useJobSources } from '@/hooks/use-job-sourcing'
import { SourceSwitchCard } from './SourceSwitchCard'
import { deriveSourceState } from './source-state'

export { formatResetAt } from './SourceBudgetRow'

// Module-level `msg` plural, not the `plural()` macro (breaks under Stryker, see TxDateField).
const SOURCES_COUNT = msg`{n, plural, one {# джерело} few {# джерела} many {# джерел} other {# джерела}}`

/**
 * ADMIN-only source list: budget, state, switch. Renders nothing at all for other roles (the query
 * is disabled), rather than an empty box that invites "why is this empty?".
 *
 * `collapsible` is the queue-page form (task 7.5): a closed «Джерела вакансій» section whose
 * summary line already says how many sources are paused or blocked, so a problem is visible
 * without opening it. Without it the panel is the always-open list inside the suggestion dialog.
 */
export function SourceBudgetPanel({
  canView,
  collapsible = false,
}: {
  canView: boolean
  collapsible?: boolean
}) {
  // A separate component: the non-ADMIN path runs no hook at all (no query, no i18n context).
  return canView ? <SourceBudgetPanelBody collapsible={collapsible} /> : null
}

function SourceBudgetPanelBody({ collapsible }: { collapsible: boolean }) {
  const { data, isLoading, isError } = useJobSources(true)
  const { i18n, t } = useLingui()

  const items = data?.items ?? []
  const now = Date.now()
  const kinds = items.map((source) => deriveSourceState(source, now).kind)
  const paused = kinds.filter((kind) => kind === 'paused').length
  const blocked = kinds.filter((kind) => kind === 'blocked').length
  const summary = data
    ? [
        i18n._(SOURCES_COUNT.id, { n: items.length }),
        ...(paused > 0 ? [t`${paused} призупинено`] : []),
        ...(blocked > 0 ? [t`${blocked} заблоковано`] : []),
      ].join(' · ')
    : null

  const body = (
    <section
      className={collapsible ? undefined : 'mt-6 border-t border-border/50 pt-4'}
      data-testid="job-source-budgets"
    >
      {!collapsible && <h3 className="text-sm font-medium text-foreground">Бюджет источников</h3>}
      <p className="mt-1 text-xs text-muted-foreground">
        Сбор останавливается, когда запросы источника закончились — и ручной запуск тратит тот же
        лимит.
      </p>

      {isLoading && <p className="mt-3 text-xs text-muted-foreground">Загрузка…</p>}

      {isError && !isLoading && (
        <p className="mt-3 text-xs text-destructive" data-testid="job-source-budgets-error">
          Не удалось загрузить состояние источников.
        </p>
      )}

      {!isLoading && !isError && (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((source) => (
            <SourceSwitchCard key={source.id} source={source} />
          ))}
          {items.length === 0 && (
            <li className="text-xs text-muted-foreground">Источники не настроены.</li>
          )}
        </ul>
      )}
    </section>
  )

  if (!collapsible) return body

  return (
    <details data-testid="job-source-section" className="group rounded-lg border border-border/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="font-medium text-foreground">
          <Trans>Джерела вакансій</Trans>
        </span>
        {summary && (
          <span
            data-testid="job-source-summary"
            className="ml-auto text-xs tabular-nums text-muted-foreground"
          >
            {summary}
          </span>
        )}
      </summary>
      <div className="px-3 pb-3">{body}</div>
    </details>
  )
}
