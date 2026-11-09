import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { CalendarOff, CircleHelp, RefreshCw, TriangleAlert, X } from 'lucide-react'
import {
  formatRelativeTime,
  type JobQueueCardResponseDto,
  type JobQueueCardSeniorDto,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { PostingMarkdown } from '@/components/job-sourcing/PostingMarkdown'
import { useJobQueueCard, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AlsoSeenOn } from './AlsoSeenOn'
import { SENIORITY_LABEL } from './JobQueueRow'
import { HIT_CHIP, MatchedSeniors } from './MatchedSeniors'
import { PossibleDuplicates } from './PossibleDuplicates'

const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs'

function CardHeader({ card }: { card: JobQueueCardResponseDto }) {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const triage = card.eligibility === 'TRIAGE'
  const seniority = SENIORITY_LABEL[card.seniority]
  const closed = card.availability === 'CLOSED' || card.availability === 'EXPIRED'
  const firstSeenAgo = formatRelativeTime(card.firstSeenAt, locale)

  return (
    <>
      {(triage || seniority || closed) && (
        <div data-testid="job-queue-card-badges" className="flex flex-wrap items-center gap-1">
          {triage && (
            <span className={cn(CHIP, 'border-dashed text-muted-foreground')}>
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
              <Trans>Закрита</Trans>
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
          <Trans>Опубліковано {formatRelativeTime(card.publishedAt, locale)}</Trans>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-1">
            <CalendarOff aria-hidden="true" className="size-3.5 shrink-0" />
            <Trans>Дата публікації невідома</Trans>
            <span className="whitespace-nowrap">
              {' · '}
              <Trans>вперше побачено {firstSeenAgo}</Trans>
            </span>
          </span>
        )}
      </p>
    </>
  )
}

function CardBody({
  scope,
  card,
  renderSeniorAction,
  onAccessLost,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
  renderSeniorAction?: ((senior: JobQueueCardSeniorDto) => ReactNode) | undefined
  onAccessLost: () => void
}) {
  return (
    <>
      {card.newerThanList && (
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
        renderAction={renderSeniorAction}
        onAccessLost={onAccessLost}
      />
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">
          <Trans>Опис</Trans>
        </h3>
        <PostingMarkdown markdown={card.descriptionMd} testId="job-queue-card-description" />
      </section>
      <AlsoSeenOn scope={scope} card={card} onAccessLost={onAccessLost} />
      {card.matchedKeywords.length > 0 && (
        <section data-testid="job-queue-card-stack" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            <Trans>Збіг стеку</Trans>
          </h3>
          <div className="flex flex-wrap gap-1">
            {card.matchedKeywords.map((keyword) => (
              <span key={keyword} className={cn(HIT_CHIP, 'max-w-full truncate')} title={keyword}>
                {keyword}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

/**
 * The vacancy card (spec §5): a modal labelled by its `h2`, full-screen below 640 px. A 403/404 on
 * the card or on one of its continuations closes it with one neutral toast for both, so the text
 * never says whether access changed; the hooks have already hidden the data and refreshed the
 * scope's lists. Task 7.4 fills `renderSeniorAction`
 * (per-senior submission) and `footer` (vacancy-level actions).
 */
export function JobQueueCard({
  scope,
  opportunityId,
  onClose,
  renderSeniorAction,
  footer,
  focusFallback,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  onClose: () => void
  /** Takes focus on close when the opener is gone or about to go (an access loss). */
  focusFallback?: RefObject<HTMLElement | null>
  renderSeniorAction?: ((senior: JobQueueCardSeniorDto) => ReactNode) | undefined
  footer?: ReactNode
}) {
  const { t } = useLingui()
  const query = useJobQueueCard(scope, opportunityId)
  const card = query.data
  // Radix returns focus to a Dialog.Trigger; the card opens from a row instead, so remember it
  const [returnFocusTo] = useState(() => document.activeElement)
  const closedOnLoss = useRef(false)

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
          className="fixed inset-0 z-50 flex h-dvh w-full flex-col bg-card shadow-xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border"
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
                renderSeniorAction={renderSeniorAction}
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
          {card && footer && (
            <div data-testid="job-queue-card-footer" className="border-t p-4 sm:px-6">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  )
}
