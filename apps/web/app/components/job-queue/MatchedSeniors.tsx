import { useId, useRef, useState, type ReactNode } from 'react'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Ban, Check, ChevronDown, CircleHelp, Info, Users } from 'lucide-react'
import {
  TECHNICAL_ROLE_LABELS,
  formatRelativeTime,
  technicalRoleSchema,
  type JobQueueCardResponseDto,
  type JobQueueCardSeniorDto,
  type TailoredResumeRowDto,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { useJobQueueSeniors, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SeniorAvailabilityLabel } from '@/components/senior-availability/SeniorAvailabilityLabel'
import { PreviewContinuation } from './PreviewContinuation'
import { TailoredResumeControls } from './TailoredResumeControls'
import { useOpenForDetail, useTailoredRows } from './useTailoredResumes'

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

/** The own-scope submission row (taken or released); another team's bare marker is not one. */
export function ownSubmission(senior: JobQueueCardSeniorDto) {
  const s = senior.submission
  return s && 'state' in s ? s : null
}

/** Own-scope submission row only; a released row reads as untouched, the bare marker apart (§3). */
export function ownTaken(senior: JobQueueCardSeniorDto) {
  const s = ownSubmission(senior)
  return s?.state === 'TAKEN' ? s : null
}

/**
 * QA-LOW-1 (plan r5): a submission is a fact about the senior, shown to every team the senior belongs
 * to without a name — another team's submission arrives as a bare marker and reads «Подано» only.
 */
export function submittedElsewhere(senior: JobQueueCardSeniorDto) {
  const s = senior.submission
  return Boolean(s && 'submittedElsewhere' in s)
}

/** «Чому збіг» (spec §5.2): the matched keywords split by how the vacancy needs them. */
function MatchEvidence({ senior }: { senior: JobQueueCardSeniorDto }) {
  const [open, setOpen] = useState(false)
  const { i18n } = useLingui()
  const id = useId()
  if (senior.matchEvidence.length === 0) return null
  // A `kind: 'ROLE'` item carries a `TechnicalRole` id, not display text (CR-M-1 / SPEC-M-2): it
  // reads from the same `technical-role.*` catalog every other surface uses. An id the enum does
  // not know cannot be looked up, so it is shown as it came rather than dropped.
  const label = (e: JobQueueCardSeniorDto['matchEvidence'][number]) => {
    if (e.kind !== 'ROLE') return e.keyword
    const role = technicalRoleSchema.safeParse(e.keyword)
    return role.success ? i18n._(TECHNICAL_ROLE_LABELS[role.data]) : e.keyword
  }
  const keywords = (strength: 'CORE' | 'OPTIONAL') =>
    senior.matchEvidence
      .filter((e) => e.strength === strength)
      .map(label)
      .join(', ')
  const required = keywords('CORE')
  const nice = keywords('OPTIONAL')

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 min-h-11 gap-1 px-2 text-xs text-primary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Trans>Чому збіг</Trans>
        <ChevronDown
          aria-hidden="true"
          data-testid="job-queue-senior-evidence-chevron"
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </Button>
      {open && (
        <div
          id={id}
          data-testid={`job-queue-senior-evidence-${senior.seniorId}`}
          className="ml-1 flex min-w-0 flex-col gap-0.5 border-l-2 pl-3 [overflow-wrap:anywhere]"
        >
          {required && (
            <p>
              <Trans>Обов’язкові: {required}</Trans>
            </p>
          )}
          {nice && (
            <p className="text-muted-foreground">
              <Trans>Бажані: {nice}</Trans>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Task 5.4 (spec §7): the senior's own skills overlap, in the slot the «Збіг за:» row had.
 * Display only — it never sorts, filters or hides a card. No tooltip: the matched skills are
 * plain text, so pointer, touch, keyboard and screen reader all reach them (design decision 4).
 */
function SkillOverlap({ senior }: { senior: JobQueueCardSeniorDto }) {
  const overlap = senior.skillOverlap
  if (overlap === null) return null
  if (overlap.kind === 'NO_RESUME') {
    return (
      <span
        data-testid={`job-queue-senior-no-resume-${senior.seniorId}`}
        className="text-xs text-muted-foreground"
      >
        <Trans>немає резюме</Trans>
      </span>
    )
  }
  return (
    <div
      data-testid={`job-queue-senior-overlap-${senior.seniorId}`}
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
    >
      <span className="font-medium text-foreground tabular-nums">
        <Trans>
          {overlap.matched.length} з{' '}
          <Plural
            value={overlap.total}
            one="# навички"
            few="# навичок"
            many="# навичок"
            other="# навички"
          />
        </Trans>
      </span>
      {overlap.matched.map((skill) => (
        <span key={skill} className={cn(HIT_CHIP, 'max-w-full [overflow-wrap:anywhere]')}>
          {skill}
        </span>
      ))}
    </div>
  )
}

function SeniorBlock({
  senior,
  action,
  arrival,
  teamHeading,
  tailored,
}: {
  senior: JobQueueCardSeniorDto
  action: ReactNode
  /** The tailored CV + cover letter controls; absent while the batch GET has no row (flag off). */
  tailored: ReactNode
  /** The senior's place in fetch order; the keyboard hand-off finds the first new one by it. */
  arrival: number
  teamHeading: string | null
}) {
  const locale = useLocale()
  const taken = ownTaken(senior)
  const when = taken && formatRelativeTime(taken.submittedAt, locale)
  const who = taken?.submittedByName

  return (
    <li
      data-testid={`job-queue-senior-${senior.seniorId}`}
      data-arrival={arrival}
      // takes focus when it is the first senior a «Показати ще» brings in (PreviewContinuation)
      tabIndex={-1}
      className="flex flex-col gap-2 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {teamHeading !== null && (
        <h4 className="text-xs font-semibold text-muted-foreground [overflow-wrap:anywhere]">
          <Trans>Команда «{teamHeading}»</Trans>
        </h4>
      )}
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-yellow-subtle text-sm font-semibold text-avatar-text"
        >
          {initials(senior.displayName)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium [overflow-wrap:anywhere]">{senior.displayName}</span>
          {senior.availability !== null && (
            <SeniorAvailabilityLabel
              availability={senior.availability}
              testId={`job-queue-senior-availability-${senior.seniorId}`}
            />
          )}
          {senior.matchApproximate && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info aria-hidden="true" className="size-3.5 shrink-0" />
              <Trans>Збіг неточний</Trans>
            </span>
          )}
          <SkillOverlap senior={senior} />
          {senior.skillOverlap === null && senior.matchedKeywords.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">
                <Trans>Збіг за:</Trans>
              </span>
              {senior.matchedKeywords.map((keyword) => (
                <span
                  key={keyword}
                  className={cn(HIT_CHIP, 'max-w-full [overflow-wrap:anywhere]')}
                  title={keyword}
                >
                  {keyword}
                </span>
              ))}
            </div>
          )}
          <MatchEvidence senior={senior} />
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
          {!taken && submittedElsewhere(senior) && (
            <span
              data-testid={`job-queue-senior-submitted-${senior.seniorId}`}
              className="inline-flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
            >
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
              <Trans>Подано</Trans>
            </span>
          )}
          {tailored}
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

interface Row {
  senior: JobQueueCardSeniorDto
  arrival: number
  teamHeading: string | null
}

/**
 * ADMIN (§5.6): one run per team, teams in first-seen order, a heading on each run's first senior.
 * Seniors with no live team lead the list unheaded. The API orders seniors by id, not by team.
 */
function byTeam(seniors: JobQueueCardSeniorDto[]): Row[] {
  const noTeam: Row[] = []
  const runs = new Map<string, Row[]>()
  seniors.forEach((senior, arrival) => {
    const row = { senior, arrival, teamHeading: null }
    const { team } = senior
    if (!team) {
      noTeam.push(row)
      return
    }
    const run = runs.get(team.teamId)
    if (run) run.push(row)
    else runs.set(team.teamId, [{ ...row, teamHeading: team.teamName }])
  })
  return [...noTeam, ...[...runs.values()].flat()]
}

/**
 * «Сеньйори зі збігом» (spec §5.2–§5.6): only what the API returns for the actor's scope. ADMIN gets
 * team headings (the API sends `team` to the studio view only); per-senior availability has no
 * source and is not rendered. `renderAction` is the per-senior action slot Task 7.4 fills.
 */
export function MatchedSeniors({
  scope,
  card,
  renderAction,
  notice,
  onAccessLost,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
  renderAction?: ((senior: JobQueueCardSeniorDto) => ReactNode) | undefined
  /** Under the heading, above the first senior (the apply-first reminder); only over a list. */
  notice?: ReactNode
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
  // D10: one batch status read per card for every listed senior; a 404 (flag off) yields no rows
  const tailored = useTailoredRows(
    scope,
    card.opportunityId,
    seniors.map((s) => s.seniorId),
  )
  useOpenForDetail(
    card.opportunityId,
    [...tailored.values()].some((r) => r.eligibility === 'POSTING_PENDING'),
  )
  const tailoredFor = (seniorId: string, row: TailoredResumeRowDto | undefined) =>
    row && (
      <TailoredResumeControls
        scope={scope}
        opportunityId={card.opportunityId}
        seniorId={seniorId}
        row={row}
      />
    )

  let body: ReactNode
  let listed = false
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
  } else if (card.noMatchReason === 'EXCLUDED') {
    // the funnel excluded it at its current revision (CR2-M-1): neither triage nor a zero match
    body = (
      <EmptyState
        testId="job-queue-seniors-excluded"
        icon={<Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
        title={<Trans>Вакансію відсіяно автоматичним відбором</Trans>}
        body={
          <Trans>
            Система не пропонує її сеньйорам: вакансія не пройшла автоматичний відбір. Відкрийте
            опис, якщо хочете оцінити її вручну.
          </Trans>
        }
      />
    )
  } else if (card.eligibility === 'TRIAGE' && card.noMatchReason !== 'NO_MATCH') {
    // every zero-match card is TRIAGE by eligibility; a manual card nobody matches is a zero match
    // (AC 5), which only the API's reason can tell apart
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
    listed = true
    body = (
      <>
        {notice}
        <ul
          ref={list}
          data-testid="job-queue-seniors-list"
          className="flex flex-col divide-y rounded-lg border bg-card"
        >
          {(admin
            ? byTeam(seniors)
            : seniors.map((senior, arrival) => ({ senior, arrival, teamHeading: null }))
          ).map(({ senior, arrival, teamHeading }) => (
            <SeniorBlock
              key={senior.seniorId}
              senior={senior}
              arrival={arrival}
              teamHeading={teamHeading}
              action={renderAction?.(senior)}
              tailored={tailoredFor(senior.seniorId, tailored.get(senior.seniorId))}
            />
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
        {/* UX-L-5: `totalCount` counts the scope's LEAD and TRIAGE matches plus, on a manual card,
            its own TAKEN seniors, so a triage card can carry one while showing no list; the count
            belongs to a rendered list only */}
        {listed && (
          <span className="ml-auto text-muted-foreground tabular-nums">
            {card.seniors.totalCount}
          </span>
        )}
      </h3>
      {body}
    </section>
  )
}
