import { useRef, useState, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Ban, Check, CircleHelp, Info, Users } from 'lucide-react'
import {
  formatRelativeTime,
  type JobQueueCardResponseDto,
  type JobQueueCardSeniorDto,
} from '@crm/shared'
import { useJobQueueSeniors, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { PreviewContinuation } from './PreviewContinuation'

const SENIORS_PAGE = 200
/** §5.1.6 hit style: matched stack tokens, amber on the card. */
export const HIT_CHIP =
  'rounded-md border border-yellow-muted/40 bg-yellow-subtle px-1.5 py-0.5 text-xs text-primary'

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

/** Own-scope submission row only; the foreign bare marker and a released row read as untouched (§3). */
function ownTaken(senior: JobQueueCardSeniorDto) {
  const s = senior.submission
  return s && 'state' in s && s.state === 'TAKEN' ? s : null
}

function SeniorBlock({ senior, action }: { senior: JobQueueCardSeniorDto; action: ReactNode }) {
  const locale = useLocale()
  const taken = ownTaken(senior)
  const when = taken && formatRelativeTime(taken.submittedAt, locale)
  const who = taken?.submittedByName

  return (
    <li
      data-testid={`job-queue-senior-${senior.seniorId}`}
      // takes focus when it is the first senior a «Показати ще» brings in (PreviewContinuation)
      tabIndex={-1}
      className="flex flex-col gap-2 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-yellow-subtle text-sm font-semibold text-avatar-text"
        >
          {initials(senior.displayName)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium [overflow-wrap:anywhere]">{senior.displayName}</span>
          {senior.matchApproximate && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info aria-hidden="true" className="size-3.5 shrink-0" />
              <Trans>Збіг неточний</Trans>
            </span>
          )}
          {senior.matchedKeywords.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">
                <Trans>Збіг за:</Trans>
              </span>
              {senior.matchedKeywords.map((keyword) => (
                <span key={keyword} className={cn(HIT_CHIP, 'max-w-full truncate')} title={keyword}>
                  {keyword}
                </span>
              ))}
            </div>
          )}
          {taken && (
            <span
              data-testid={`job-queue-senior-submitted-${senior.seniorId}`}
              className="inline-flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
            >
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
              {who ? (
                <Trans>
                  Подано: {who} · {when}
                </Trans>
              ) : (
                <Trans>Подано · {when}</Trans>
              )}
            </span>
          )}
        </div>
      </div>
      {action}
    </li>
  )
}

function EmptyState({
  testId,
  icon,
  title,
  body,
  dashed,
}: {
  testId: string
  icon: ReactNode
  title: ReactNode
  body: ReactNode
  dashed?: boolean
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-sm',
        dashed && 'border-dashed border-yellow-muted',
      )}
    >
      {icon}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-pretty">{title}</p>
        <p className="text-muted-foreground text-pretty">{body}</p>
      </div>
    </div>
  )
}

/**
 * «Сеньйори зі збігом» (spec §5.2–§5.5): only what the API returns for the actor's scope. Team
 * headings (§5.6) and availability / match evidence (§5.2) are not in the card API, so not rendered.
 * `renderAction` is the per-senior action slot Task 7.4 fills («Записати подачу» and its states).
 */
export function MatchedSeniors({
  scope,
  card,
  renderAction,
  onAccessLost,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
  renderAction?: ((senior: JobQueueCardSeniorDto) => ReactNode) | undefined
  onAccessLost: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  // the continuation fetches as soon as it has a cursor, so it gets one only after the first click
  const more = useJobQueueSeniors(
    scope,
    card.opportunityId,
    expanded ? card.seniors.nextCursor : null,
  )
  const admin = scope.role === 'ADMIN'
  const seniors = [...card.seniors.items, ...(more.data?.pages.flatMap((page) => page.items) ?? [])]
  const stopListed = card.stopListedSeniorCount

  let body: ReactNode
  // stop-all first: the API calls a vacancy whose only matches are stop-listed TRIAGE (its
  // eligibility counts LEAD matches only), and the stop-list is the reason to show (§5.4)
  if (seniors.length === 0 && stopListed > 0) {
    body = (
      <EmptyState
        testId="job-queue-seniors-stop-all"
        icon={<Ban aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
        title={
          admin ? (
            <Trans>Усі сеньйори зі збігом внесли компанію до стоп-листа</Trans>
          ) : (
            <Trans>Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листа</Trans>
          )
        }
        body={<Trans>Стек збігається, проте вакансію їм не пропонують.</Trans>}
      />
    )
  } else if (card.eligibility === 'TRIAGE') {
    body = (
      <EmptyState
        testId="job-queue-seniors-triage"
        dashed
        icon={
          <CircleHelp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        }
        title={<Trans>Сеньйорів не підібрано автоматично</Trans>}
        body={
          <Trans>
            Роботодавця не вдалося підтвердити, тому система не пропонує цю вакансію конкретним
            сеньйорам. Оцініть її вручну за описом.
          </Trans>
        }
      />
    )
  } else if (seniors.length === 0) {
    body = (
      <EmptyState
        testId="job-queue-seniors-none"
        icon={<Users aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
        title={<Trans>Немає сеньйорів зі збігом стеку</Trans>}
        body={
          admin ? (
            <Trans>Вакансія лишається в черзі, але жоден сеньйор не збігається за стеком.</Trans>
          ) : (
            <Trans>
              Вакансія лишається в черзі, але жоден сеньйор із вашої команди не збігається за
              стеком.
            </Trans>
          )
        }
      />
    )
  } else {
    body = (
      <>
        <ul
          ref={list}
          data-testid="job-queue-seniors-list"
          className="flex flex-col divide-y rounded-lg border bg-card"
        >
          {seniors.map((senior) => (
            <SeniorBlock key={senior.seniorId} senior={senior} action={renderAction?.(senior)} />
          ))}
        </ul>
        <PreviewContinuation
          testId="job-queue-seniors"
          shown={seniors.length}
          total={card.seniors.totalCount}
          pageSize={SENIORS_PAGE}
          more={more}
          started={expanded}
          previewCursor={card.seniors.nextCursor}
          list={list}
          onStart={() => setExpanded(true)}
          onAccessLost={onAccessLost}
        />
        {stopListed > 0 && (
          <div
            data-testid="job-queue-stop-some"
            role="note"
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="tabular-nums">
                <Trans>Виключено за стоп-листом: {stopListed}</Trans>
              </p>
              <p className="text-pretty">
                <Trans>
                  Ці сеньйори внесли компанію до власного стоп-листа, тому вакансія їм не
                  пропонується.
                </Trans>
              </p>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <section data-testid="job-queue-seniors" className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        <Trans>Сеньйори зі збігом</Trans>
        {card.seniors.totalCount > 0 && (
          <span className="text-muted-foreground tabular-nums">{card.seniors.totalCount}</span>
        )}
      </h3>
      {body}
    </section>
  )
}
