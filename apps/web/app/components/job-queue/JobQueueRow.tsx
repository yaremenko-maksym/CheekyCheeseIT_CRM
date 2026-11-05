import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Ban, CalendarOff, Check, ChevronRight, CircleHelp, PenLine, Rss } from 'lucide-react'
import { formatRelativeTime, type JobQueueListItemDto, type JobQueueTab } from '@crm/shared'
import { useLocale } from '@/lib/i18n'

/**
 * Brand part of a source type (`DOU_RSS` → `DOU`). shortcut: the web app has no source
 * display-name map yet (the admin health panel shows the raw enum); replace with one
 * when product names are curated.
 */
export function sourceLabel(sourceType: string): string {
  return sourceType.replace(/_(RSS|API|ATS|HTML|HIRING)$/, '')
}

// Module-level `msg` plurals, not the `plural()` macro (breaks under Stryker, see TxDateField).
const MATCHED_HR = msg`{n, plural, one {# сеньйор вашої команди має збіг стеку} few {# сеньйори вашої команди мають збіг стеку} many {# сеньйорів вашої команди мають збіг стеку} other {# сеньйора вашої команди мають збіг стеку}}`
const MATCHED_ADMIN = msg`{n, plural, one {# сеньйор має збіг стеку} few {# сеньйори мають збіг стеку} many {# сеньйорів мають збіг стеку} other {# сеньйора мають збіг стеку}}`

export function JobQueueRow({
  item,
  tab,
  role,
  onOpen,
}: {
  item: JobQueueListItemDto
  tab: JobQueueTab
  /** ADMIN sees studio-wide counts, HR sees its team's (spec §4.3). */
  role: 'ADMIN' | 'HR'
  onOpen: (opportunityId: string) => void
}) {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const source = item.primarySource
  const sourceName = source ? t`Джерело: ${sourceLabel(source.sourceType)}` : t`Додано вручну`
  const SourceIcon = source ? Rss : PenLine
  const company = item.companyName ?? t`Компанію не вказано`
  const matched = item.matchedSeniorCount
  // id + values, not `{ ...MSG, values }`: the spread form crashes `lingui extract`.
  const matchedMsg = role === 'ADMIN' ? MATCHED_ADMIN : MATCHED_HR
  const submitted = item.submittedSeniorCount
  // a separate clause from the matched count: a manual submission can have no stack match (§4.3)
  const showSubmitted = tab === 'SUBMITTED' && submitted > 0
  // matched (LEAD) and stop-listed (EXCLUDED at SCOPED_RESTRICTIONS) are disjoint server counts;
  // the row must not read as "no matches" when every match is stop-listed (§4.6)
  const stopListedAll = matched === 0 && item.stopListedSeniorCount > 0
  const alsoSeen = item.alsoSeenOnCount
  const firstSeenAgo = formatRelativeTime(item.firstSeenAt, locale)

  return (
    <button
      type="button"
      data-testid={`job-queue-row-${item.opportunityId}`}
      onClick={() => onOpen(item.opportunityId)}
      className="flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[560px]:rounded-none @min-[560px]:border-0 @min-[560px]:bg-transparent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {item.eligibility === 'TRIAGE' && (
          // a span, not <Badge>: Badge renders a <div>, invalid inside this <button>
          <span
            data-testid="job-queue-row-triage"
            className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            <CircleHelp aria-hidden="true" className="size-3.5" />
            <Trans>Потребує розгляду</Trans>
          </span>
        )}
        <span className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">{item.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <SourceIcon
            data-testid="job-queue-row-source"
            role="img"
            aria-label={sourceName}
            className="size-4 shrink-0"
          />
          <span className="truncate">{company}</span>
        </span>
        {item.eligibility === 'TRIAGE' && (
          <span data-testid="job-queue-row-triage-reason" className="text-sm text-muted-foreground">
            <Trans>Роботодавця не вдалося підтвердити</Trans>
          </span>
        )}
        {(matched > 0 || showSubmitted) && (
          <span
            data-testid="job-queue-row-counts"
            className="flex flex-wrap gap-x-2 text-sm tabular-nums"
          >
            {matched > 0 && (
              <span data-testid="job-queue-row-matched" data-slot="matched-count">
                {i18n._(matchedMsg.id, { n: matched })}
              </span>
            )}
            {showSubmitted && (
              <span
                data-testid="job-queue-row-submitted"
                className="inline-flex items-center gap-1 text-muted-foreground"
              >
                <Check
                  data-testid="job-queue-row-submitted-icon"
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
                <Trans>{submitted} подано</Trans>
              </span>
            )}
          </span>
        )}
        {stopListedAll && (
          <span
            data-testid="job-queue-row-stop-listed"
            className="flex items-start gap-1.5 text-sm text-pretty text-muted-foreground"
          >
            <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {role === 'ADMIN' ? (
              <Trans>Усі сеньйори зі збігом внесли компанію до стоп-листа</Trans>
            ) : (
              <Trans>Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листа</Trans>
            )}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {item.publishedAt ? (
            <span className="whitespace-nowrap">
              <Trans>Опубліковано {formatRelativeTime(item.publishedAt, locale)}</Trans>
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-x-1">
              <CalendarOff aria-hidden="true" className="size-3.5 shrink-0" />
              <Trans>Дата публікації невідома</Trans>
              {/* §4.3: «вперше побачено» and its age never wrap apart; the separator wraps with them */}
              <span className="whitespace-nowrap">
                {' · '}
                <Trans>вперше побачено {firstSeenAgo}</Trans>
              </span>
            </span>
          )}
          {alsoSeen > 0 && (
            <span data-testid="job-queue-row-also-seen" className="whitespace-nowrap">
              <Trans>+{alsoSeen} на інших джерелах</Trans>
            </span>
          )}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="mt-1 hidden size-4 shrink-0 text-muted-foreground @min-[560px]:block"
      />
    </button>
  )
}
