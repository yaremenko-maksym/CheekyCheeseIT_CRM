import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Ban, CalendarOff, Check, ChevronRight, CircleHelp, PenLine, Rss } from 'lucide-react'
import {
  formatRelativeTime,
  type JobQueueListItemDto,
  type JobQueueTab,
  type JobSeniorityLevel,
  type JobSourceType,
} from '@crm/shared'
import { useLocale } from '@/lib/i18n'

/* Product names, deliberately not translated. */
const SOURCE_NAME: Record<JobSourceType, string> = {
  DOU_RSS: 'DOU',
  REMOTEOK_API: 'RemoteOK',
  REMOTIVE_API: 'Remotive',
  HIMALAYAS_API: 'Himalayas',
  JOBICY_API: 'Jobicy',
  ARBEITNOW_API: 'Arbeitnow',
  WORKINGNOMADS_API: 'Working Nomads',
  JOBGETHER_API: 'Jobgether',
  HN_HIRING: 'Hacker News: Who is hiring',
  GREENHOUSE_ATS: 'Greenhouse',
  LEVER_ATS: 'Lever',
  ASHBY_ATS: 'Ashby',
  WORKABLE_ATS: 'Workable',
  SMARTRECRUITERS_ATS: 'SmartRecruiters',
  RECRUITEE_ATS: 'Recruitee',
  PERSONIO_ATS: 'Personio',
  JOOBLE_API: 'Jooble',
  JSEARCH_API: 'JSearch',
  THEIRSTACK_API: 'TheirStack',
  MUSE_API: 'The Muse',
  REED_API: 'Reed',
  DJINNI_RSS: 'Djinni',
  WWR_RSS: 'We Work Remotely',
  EUREMOTEJOBS_RSS: 'EU Remote Jobs',
  JUSTJOIN_HTML: 'Just Join IT',
  NOFLUFF_HTML: 'No Fluff Jobs',
  LANDINGJOBS_HTML: 'Landing.jobs',
  NEXTLEVELJOBS_HTML: 'Next Level Jobs',
  DICE_HTML: 'Dice',
  THEHUB_HTML: 'The Hub',
  WTTJ_HTML: 'Welcome to the Jungle',
}

/** Product name of a source type; an unknown code falls back to the raw value. */
export function sourceLabel(sourceType: string): string {
  return Object.hasOwn(SOURCE_NAME, sourceType)
    ? SOURCE_NAME[sourceType as JobSourceType]
    : sourceType
}

// Module-level `msg` plurals, not the `plural()` macro (breaks under Stryker, see TxDateField).
const MATCHED_HR = msg`{n, plural, one {# сеньйор вашої команди має збіг стеку} few {# сеньйори вашої команди мають збіг стеку} many {# сеньйорів вашої команди мають збіг стеку} other {# сеньйора вашої команди мають збіг стеку}}`
const MATCHED_ADMIN = msg`{n, plural, one {# сеньйор має збіг стеку} few {# сеньйори мають збіг стеку} many {# сеньйорів мають збіг стеку} other {# сеньйора мають збіг стеку}}`
const MORE_KEYWORDS = msg`{n, plural, one {ще # ключове слово} few {ще # ключові слова} many {ще # ключових слів} other {ще # ключового слова}}`

/* UNKNOWN has no label: an unclassified role shows no badge rather than a noise chip. */
export const SENIORITY_LABEL: Record<JobSeniorityLevel, MessageDescriptor | null> = {
  MIDDLE: msg`Мідл`,
  SENIOR: msg`Сеньйор`,
  LEAD: msg`Лід`,
  UNKNOWN: null,
}
const ROW_KEYWORDS_SHOWN = 4
// spans, not <Badge>: Badge renders a <div>, invalid inside the row's <button>
const CHIP = 'rounded-md border px-1.5 py-0.5 text-xs'

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
  const triage = item.eligibility === 'TRIAGE'
  const seniorityLabel = SENIORITY_LABEL[item.seniority]
  const keywords = item.matchedKeywords
  const moreKeywords = keywords.length - ROW_KEYWORDS_SHOWN

  return (
    <button
      type="button"
      data-testid={`job-queue-row-${item.opportunityId}`}
      onClick={() => onOpen(item.opportunityId)}
      className="relative flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[560px]:rounded-none @min-[560px]:border-0 @min-[560px]:bg-transparent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1 @min-[720px]:contents">
        <span
          data-testid="job-queue-row-main"
          className="flex min-w-0 flex-col gap-1 @min-[720px]:flex-1"
        >
          {/* §4.3 line 1: triage badge · seniority badge; wraps at 320 px, never overflows */}
          {(triage || seniorityLabel) && (
            <span
              data-testid="job-queue-row-line1"
              className="flex min-w-0 flex-wrap items-center gap-1"
            >
              {triage && (
                // a span, not <Badge>: Badge renders a <div>, invalid inside this <button>
                <span
                  data-testid="job-queue-row-triage"
                  className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  <CircleHelp aria-hidden="true" className="size-3.5" />
                  <Trans>Потребує розгляду</Trans>
                </span>
              )}
              {seniorityLabel && (
                <span data-testid="job-queue-row-seniority" className={`${CHIP} font-medium`}>
                  {i18n._(seniorityLabel)}
                </span>
              )}
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
          {/* §4.3: a triage row replaces the stack line with its reason */}
          {!triage && keywords.length > 0 && (
            <span
              data-testid="job-queue-row-keywords"
              className="flex min-w-0 flex-wrap items-center gap-1"
            >
              {keywords.slice(0, ROW_KEYWORDS_SHOWN).map((keyword) => (
                <span
                  key={keyword}
                  data-testid="job-queue-row-keyword"
                  title={keyword}
                  className={`${CHIP} max-w-full truncate text-muted-foreground`}
                >
                  {keyword}
                </span>
              ))}
              {moreKeywords > 0 && (
                <span
                  data-testid="job-queue-row-keywords-more"
                  className={`${CHIP} text-muted-foreground tabular-nums`}
                >
                  {/* "+3" alone tells a screen reader nothing: it hears the sr-only phrase */}
                  <span aria-hidden="true">
                    <Trans>+{moreKeywords}</Trans>
                  </span>
                  <span className="sr-only">{i18n._(MORE_KEYWORDS.id, { n: moreKeywords })}</span>
                </span>
              )}
            </span>
          )}
          {/* all stop-listed arrives as TRIAGE too; then the stop-list line is the reason (§5.4) */}
          {triage && !stopListedAll && (
            <span
              data-testid="job-queue-row-triage-reason"
              className="text-sm text-muted-foreground"
            >
              <Trans>Роботодавця не вдалося підтвердити</Trans>
            </span>
          )}
        </span>
        <span
          data-testid="job-queue-row-meta"
          className="flex min-w-0 flex-col gap-1 @min-[720px]:w-[14.375rem] @min-[720px]:shrink-0"
        >
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
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground @min-[720px]:contents">
            {item.publishedAt ? (
              <span
                data-testid="job-queue-row-age"
                className="whitespace-nowrap @min-[720px]:order-first"
              >
                <Trans>Опубліковано {formatRelativeTime(item.publishedAt, locale)}</Trans>
              </span>
            ) : (
              <span
                data-testid="job-queue-row-age"
                className="inline-flex flex-wrap items-center gap-x-1 @min-[720px]:order-first"
              >
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
      </span>
      <ChevronRight
        aria-hidden="true"
        className="mt-1 hidden size-4 shrink-0 text-muted-foreground @min-[560px]:block"
      />
    </button>
  )
}
