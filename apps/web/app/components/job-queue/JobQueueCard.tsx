import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { CalendarOff, Check, CircleHelp, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { formatRelativeTime, type JobQueueCardResponseDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { PostingMarkdown } from '@/components/job-sourcing/PostingMarkdown'
import { useIsMutating } from '@tanstack/react-query'
import { jobQueueScopeKey, useJobQueueCard, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AlsoSeenOn } from './AlsoSeenOn'
import { DismissMenu } from './DismissMenu'
import {
  AdminVacancyMenu,
  ApplyFirst,
  OpenOriginalButton,
  SeniorAction,
  hasOpenSubmit,
  useCardGate,
} from './JobQueueActions'
import { SENIORITY_LABEL } from './JobQueueRow'
import { HIT_CHIP, MatchedSeniors } from './MatchedSeniors'
import { PossibleDuplicates } from './PossibleDuplicates'

/** The event's target is inside an element matching `selector`. */
const inside = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null

const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs'
/** A vacancy stack token no senior of the scope matches. */
const STACK_CHIP = 'rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground'

function CardHeader({ card }: { card: JobQueueCardResponseDto }) {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  // an excluded vacancy is neither triage nor a zero match (CR2-M-1): its seniors block says so
  const triage = card.eligibility === 'TRIAGE' && card.noMatchReason !== 'EXCLUDED'
  const seniority = SENIORITY_LABEL[card.seniority]
  const closed = card.availability === 'CLOSED' || card.availability === 'EXPIRED'
  const firstSeenAgo = formatRelativeTime(card.firstSeenAt, locale)
  const lastSeenAgo = formatRelativeTime(card.lastSeenAt, locale)

  return (
    <>
      {(triage || seniority || closed) && (
        <div data-testid="job-queue-card-badges" className="flex flex-wrap items-center gap-1">
          {triage && (
            <span className={cn(CHIP, 'border-dashed border-yellow-muted text-muted-foreground')}>
              <CircleHelp aria-hidden="true" className="size-3.5" />
              <Trans>Потребує розгляду</Trans>
            </span>
          )}
          {seniority && <span className={cn(CHIP, 'font-medium')}>{i18n._(seniority)}</span>}
          {closed && (
            <span
              data-testid="job-queue-card-closed"
              className={cn(CHIP, 'border-destructive text-destructive')}
            >
              <TriangleAlert aria-hidden="true" className="size-3.5" />
              {card.availability === 'EXPIRED' ? (
                <Trans>Прострочена</Trans>
              ) : (
                <Trans>Закрита</Trans>
              )}
            </span>
          )}
        </div>
      )}
      <DialogPrimitive.Title className="text-lg font-semibold leading-snug [overflow-wrap:anywhere]">
        {card.title}
      </DialogPrimitive.Title>
      <p className="text-sm [overflow-wrap:anywhere]">
        {card.companyName ?? t`Компанію не вказано`}
      </p>
      <p data-testid="job-queue-card-meta" className="text-xs text-muted-foreground">
        {card.publishedAt ? (
          <span className="whitespace-nowrap">
            <Trans>Опубліковано {formatRelativeTime(card.publishedAt, locale)}</Trans>
          </span>
        ) : (
          <>
            <span className="whitespace-nowrap">
              <CalendarOff
                aria-hidden="true"
                data-testid="job-queue-card-meta-icon"
                className="mr-1 inline-block size-3.5 align-[-0.2em]"
              />
              <Trans>Дата публікації невідома</Trans>
            </span>
            <span className="whitespace-nowrap">
              {' · '}
              <Trans>вперше побачено {firstSeenAgo}</Trans>
            </span>
          </>
        )}
        <span className="whitespace-nowrap">
          {' · '}
          <Trans>востаннє бачили {lastSeenAgo}</Trans>
        </span>
      </p>
      <p data-testid="job-queue-terms" className="text-xs text-muted-foreground">
        {card.engagementForm === 'B2B' ? (
          <Trans>
            Форма співпраці: <span className="text-foreground">B2B</span>
          </Trans>
        ) : card.engagementForm === 'EMPLOYMENT' ? (
          <Trans>
            Форма співпраці: <span className="text-foreground">Трудовий договір</span>
          </Trans>
        ) : (
          <Trans>
            Форма співпраці: <span className="text-foreground">Не вказано</span>
          </Trans>
        )}
      </p>
    </>
  )
}

function CardBody({
  scope,
  card,
  refetch,
  onAccessLost,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
  refetch: () => void
  onAccessLost: () => void
}) {
  const gate = useCardGate(card, refetch)
  // a write belongs to the scope it started in: another team's actions are other buttons
  const scopeKey = JSON.stringify(jobQueueScopeKey(scope))
  return (
    <>
      {gate.notes}
      {card.newerThanList && !gate.stale && (
        <div
          data-testid="job-queue-card-updated"
          role="status"
          className="flex items-start gap-2 rounded-lg bg-yellow-subtle p-3 text-sm text-foreground"
        >
          <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-medium">
              <Trans>Вакансію оновлено після побудови списку</Trans>
            </p>
            <p className="text-foreground/70">
              <Trans>Нижче — актуальні дані.</Trans>
            </p>
          </div>
        </div>
      )}
      <PossibleDuplicates preview={card.possibleDuplicates} />
      <MatchedSeniors
        scope={scope}
        card={card}
        notice={!gate.blocked && hasOpenSubmit(card) && <ApplyFirst />}
        renderAction={(senior) => (
          <SeniorAction
            key={scopeKey}
            scope={scope}
            card={card}
            senior={senior}
            blocked={gate.blocked}
            onConflict={gate.setConflict}
          />
        )}
        onAccessLost={onAccessLost}
      />
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">
          <Trans>Опис</Trans>
        </h3>
        <PostingMarkdown markdown={card.descriptionMd} testId="job-queue-card-description" />
      </section>
      <AlsoSeenOn scope={scope} card={card} onAccessLost={onAccessLost} />
      <VacancyStack card={card} />
    </>
  )
}

/**
 * «Збіг стеку» (spec §5.1): the vacancy's stack, the tokens the scope's seniors match in the hit
 * style. A row stored before the stack was kept (Task 7.3b) falls back to the matched tokens.
 */
function VacancyStack({ card }: { card: JobQueueCardResponseDto }) {
  const stack = card.stackKeywords.length > 0 ? card.stackKeywords : card.matchedKeywords
  if (stack.length === 0) return null
  const hits = new Set(card.matchedKeywords.map((k) => k.toLowerCase()))
  return (
    <section data-testid="job-queue-card-stack" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        <Trans>Збіг стеку</Trans>
      </h3>
      <div className="flex flex-wrap gap-1">
        {stack.map((keyword) => {
          const hit = hits.has(keyword.toLowerCase())
          return (
            <Fragment key={keyword}>
              <span
                data-testid="job-queue-card-stack-chip"
                data-hit={hit}
                className={cn(
                  hit ? cn(HIT_CHIP, 'inline-flex items-center gap-1') : STACK_CHIP,
                  'max-w-full [overflow-wrap:anywhere]',
                )}
                title={keyword}
              >
                {/* the hit style alone would be the only cue (SC 1.4.1) */}
                {hit && (
                  <Check
                    aria-hidden="true"
                    data-testid="job-queue-card-stack-hit-icon"
                    className="size-3 shrink-0"
                  />
                )}
                {keyword}
              </span>
              {hit && (
                <span className="sr-only">
                  , <Trans context="job-queue stack chip, screen-reader suffix">збігається</Trans>
                </span>
              )}
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}

/**
 * The vacancy card (spec §5): a modal labelled by its `h2`, full-screen below 640 px. A 403/404 on
 * the card or on one of its continuations closes it with one neutral toast for both, so the text
 * never says whether access changed; the hooks have already hidden the data and refreshed the
 * scope's lists. The per-senior and vacancy-level actions are `JobQueueActions` / `DismissMenu`.
 */
export function JobQueueCard({
  scope,
  opportunityId,
  onClose,
  focusFallback,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  onClose: () => void
  /** Takes focus on close when the opener is gone or about to go (an access loss). */
  focusFallback?: RefObject<HTMLElement | null>
}) {
  const { t } = useLingui()
  const query = useJobQueueCard(scope, opportunityId)
  const card = query.data
  // Radix returns focus to a Dialog.Trigger; the card opens from a row instead, so remember it
  const [returnFocusTo] = useState(() => document.activeElement)
  const closedOnLoss = useRef(false)
  // QA-MED-1 (r3): a write's outcome is shown in this card, so Escape waits for it to settle
  const writing = useIsMutating() > 0

  const loseAccess = useCallback(() => {
    if (closedOnLoss.current) return
    closedOnLoss.current = true
    toast.error(t`Цю вакансію не знайдено`)
    onClose()
  }, [onClose, t])

  useEffect(() => {
    if (query.accessLost) loseAccess()
  }, [query.accessLost, loseAccess])

  if (query.accessLost) return null

  return (
    <DialogPrimitive.Root
      open
      // no Dialog.Trigger, so Radix only ever reports a close
      onOpenChange={onClose}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-testid="job-queue-card"
          aria-describedby={undefined}
          aria-busy={query.isPending || undefined}
          // an inline confirm (`data-escape-scope`) takes Escape for itself; the card stays open
          onEscapeKeyDown={(event) => {
            if (writing || inside(event.target, '[data-escape-scope]')) event.preventDefault()
          }}
          // UX-M-1 (r3): a toast sits outside the modal, and a press on it is not a dismissal
          onInteractOutside={(event) => {
            if (inside(event.target, '[data-sonner-toaster]')) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // after a loss the list refresh removes the opening row, so focus would fall to <body>;
            // a card opened by URL has no opener at all (<body> was active), so it parks there too
            const opener =
              returnFocusTo instanceof HTMLElement &&
              returnFocusTo !== document.body &&
              returnFocusTo.isConnected &&
              !closedOnLoss.current
                ? returnFocusTo
                : focusFallback?.current
            opener?.focus()
          }}
          // enter/exit: the shadcn dialog's tw-animate-css set, the fade always (spec §12: opacity only
          // under reduced motion), the zoom only when motion is safe and from 640 px, where the panel is
          // not full-screen
          className="fixed inset-0 z-50 flex h-dvh w-full flex-col bg-card shadow-xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:motion-safe:data-[state=open]:zoom-in-95 sm:motion-safe:data-[state=closed]:zoom-out-95"
        >
          <div className="flex items-start gap-2 border-b p-4 pr-2 sm:p-6 sm:pr-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {card ? (
                <CardHeader card={card} />
              ) : (
                <DialogPrimitive.Title className="text-lg font-semibold">
                  {query.isError ? (
                    <Trans>Не вдалося завантажити вакансію</Trans>
                  ) : (
                    <Trans>Завантажуємо вакансію…</Trans>
                  )}
                </DialogPrimitive.Title>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t`Закрити`}
                className="size-11 shrink-0"
              >
                <X aria-hidden="true" className="size-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
            {card ? (
              <CardBody
                scope={scope}
                card={card}
                refetch={() => void query.refetch()}
                onAccessLost={loseAccess}
              />
            ) : (
              query.isError && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start"
                  onClick={() => void query.refetch()}
                >
                  <Trans>Спробувати ще раз</Trans>
                </Button>
              )
            )}
          </div>
          {card && (
            <div
              data-testid="job-queue-card-footer"
              className="flex flex-col gap-2 border-t p-4 sm:flex-row sm:items-center sm:px-6"
            >
              <OpenOriginalButton scope={scope} card={card} />
              <div className="flex gap-2 sm:ml-auto">
                <DismissMenu
                  scope={scope}
                  opportunityId={card.opportunityId}
                  dismissal={card.dismissal}
                  onClose={onClose}
                />
                {scope.role === 'ADMIN' && (
                  <AdminVacancyMenu
                    scope={scope}
                    opportunityId={card.opportunityId}
                    onClose={onClose}
                  />
                )}
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  )
}
