import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import {
  Copy,
  ExternalLink,
  Info,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import type {
  JobQueueCardResponseDto,
  JobQueueCardSeniorDto,
  JobQueueSubmissionDto,
} from '@crm/shared'
import { openOriginalPosting } from '@/components/job-sourcing/open-original'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  getJobQueuePossibleDuplicateConflict,
  isAccessLoss,
  useCancelJobQueueSubmission,
  useMarkJobOpened,
  useSubmitJobQueueSenior,
  useSuppressJobQueueItem,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { getApiErrorCode } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { ownTaken, submittedElsewhere } from './MatchedSeniors'

/** §5.6: the one conflict text, used everywhere; it never says who changed what, or where. */
export const CONFLICT_NOTE = msg`Дані змінилися. Оновіть картку й повторіть.`

/**
 * QA-MED-2 / UX-L-3 / QA-LOW-2: every toast of the queue actions gets 44 px targets on mobile, on
 * these toasts only (sonner's styles are unlayered, hence `!`). The close keeps its 20 px circle; a
 * transparent `::before` widens its hit area, so it neither overhangs the corner nor meets the title.
 */
export const JOB_QUEUE_TOAST = {
  classNames: {
    actionButton: 'max-sm:min-h-11! max-sm:px-4!',
    closeButton: 'max-sm:before:absolute max-sm:before:-inset-3',
  },
}

/** A 409 from a concurrent change (an expected version or a reused key no longer matches). */
export function isQueueConflict(error: unknown) {
  const code = getApiErrorCode(error)
  return code === 'JOB_QUEUE_VERSION_CONFLICT' || code === 'JOB_QUEUE_IDEMPOTENCY_CONFLICT'
}

const NOTE = 'flex items-start gap-2 rounded-lg border p-3 text-sm'
const BLOCKING = cn(NOTE, 'border-destructive/40')

/**
 * The card's write gate (§5.7). A revision newer than the one the actor last looked at blocks every
 * «Записати подачу» until «Оновити картку»; a vacancy closed or expired at the source blocks them for
 * good. The conflict note stays until the next action starts; a stale card shows only its own note
 * (a 403/404 from a write is left to the card's read, which closes it with the one neutral toast).
 */
export function useCardGate(card: JobQueueCardResponseDto, refetch: () => void) {
  const [seenRevision, setSeenRevision] = useState(card.revision)
  const [conflict, setConflict] = useState(false)
  const refresh = useRef<HTMLButtonElement>(null)
  const closed = card.availability === 'CLOSED' || card.availability === 'EXPIRED'
  const stale = !closed && card.revision > seenRevision
  const earlier = card.submittedSeniorCount

  // UX-L-2: the actor's own write met the newer revision; focus goes to the one way forward, in the
  // commit (a senior's own restore runs first, as a child), so it never drops to <body>
  useLayoutEffect(() => {
    if (stale && conflict) refresh.current?.focus()
  }, [stale, conflict])

  const notes = (
    <>
      {closed && (
        <div data-testid="job-queue-closed" role="note" className={BLOCKING}>
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-medium text-destructive">
              {card.availability === 'EXPIRED' ? (
                <Trans>Термін вакансії на джерелі минув</Trans>
              ) : (
                <Trans>Вакансію закрито на джерелі</Trans>
              )}
            </p>
            <p className="text-muted-foreground text-pretty">
              <Trans>Нові подачі неможливі.</Trans>
              {earlier > 0 && (
                <span className="tabular-nums">
                  {' '}
                  <Trans>Раніше подано: {earlier}.</Trans>
                </span>
              )}
            </p>
          </div>
        </div>
      )}
      {stale && (
        <div
          data-testid="job-queue-stale"
          role="alert"
          className={cn(BLOCKING, 'flex-col sm:flex-row sm:items-center')}
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium text-destructive">
                <Trans>З’явилася новіша версія вакансії</Trans>
              </p>
              <p className="text-muted-foreground text-pretty">
                <Trans>Ця картка застаріла, тому записати подачу з неї не можна.</Trans>
              </p>
            </div>
          </div>
          <Button
            ref={refresh}
            type="button"
            variant="outline"
            className="min-h-11 shrink-0 self-start sm:self-auto"
            onClick={() => {
              setSeenRevision(card.revision)
              setConflict(false)
              refetch()
            }}
          >
            <RefreshCw aria-hidden="true" />
            <Trans>Оновити картку</Trans>
          </Button>
        </div>
      )}
      {conflict && !stale && <ConflictNote />}
    </>
  )

  return { blocked: closed || stale, stale, setConflict, notes }
}

function ConflictNote() {
  const { t } = useLingui()
  return (
    <div data-testid="job-queue-conflict" role="alert" className={BLOCKING}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="text-pretty">{t(CONFLICT_NOTE)}</p>
    </div>
  )
}

/** COPY-H-6: persistent, above the first senior; the caller hides it when no button is enabled. */
export function ApplyFirst() {
  return (
    <div data-testid="job-queue-apply-first" role="note" className={NOTE}>
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-pretty">
        <Trans>
          Спершу подайте на сайті джерела («Відкрити оригінал»), потім запишіть подачу тут.
        </Trans>
      </p>
    </div>
  )
}

/** Whether any «Записати подачу» can still be pressed (seniors beyond the preview count as open). */
export function hasOpenSubmit(card: JobQueueCardResponseDto) {
  return (
    card.seniors.nextCursor !== null ||
    card.seniors.items.some((s) => !ownTaken(s) && !submittedElsewhere(s))
  )
}

/** The ADMIN confirm (§5.6): the safe button takes the initial focus; focus then returns to `trigger`. */
function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  body,
  keep,
  confirm,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: RefObject<HTMLButtonElement | null>
  title: ReactNode
  body: ReactNode
  keep: ReactNode
  confirm: ReactNode
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-w-[calc(100%-2rem)] rounded-lg sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          trigger.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-9">{keep}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: 'destructive' }), 'min-h-11 sm:min-h-9')}
            onClick={onConfirm}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A «⋯» menu that opens a confirm. The menu would hand focus back to its trigger as it closes,
 * racing the dialog's own initial focus; it yields while the dialog opens.
 */
function AdminMenu({
  label,
  header,
  item,
  dialog,
}: {
  label: string
  header?: ReactNode
  item: ReactNode
  dialog: (props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    trigger: RefObject<HTMLButtonElement | null>
  }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const opening = useRef(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            className="size-11 shrink-0"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (!opening.current) return
            opening.current = false
            event.preventDefault()
          }}
        >
          {header && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {header}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            className="min-h-11 sm:min-h-0"
            onSelect={() => {
              opening.current = true
              setOpen(true)
            }}
          >
            {item}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog({ open, onOpenChange: setOpen, trigger })}
    </>
  )
}

/** ADMIN vacancy-level «⋯» (§5.6): suppress for every team. Triage assign is not offered (A2). */
export function AdminVacancyMenu({
  scope,
  opportunityId,
  onClose,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  onClose: () => void
}) {
  const { t } = useLingui()
  const suppress = useSuppressJobQueueItem(scope)
  return (
    <AdminMenu
      label={t`Дії адміністратора`}
      header={<Trans>Буде приховано для всієї студії</Trans>}
      item={<Trans>Приховати для всіх…</Trans>}
      dialog={(props) => (
        <ConfirmDialog
          {...props}
          title={<Trans>Приховати для всієї студії?</Trans>}
          body={<Trans>Вакансія зникне з черги для всіх команд.</Trans>}
          keep={<Trans>Не приховувати</Trans>}
          confirm={<Trans>Приховати для всіх</Trans>}
          onConfirm={() =>
            suppress.mutate(
              { opportunityId },
              {
                onSuccess: () => {
                  toast.success(t`Приховано`, JOB_QUEUE_TOAST)
                  onClose()
                },
                onError: (error) => {
                  if (!isAccessLoss(error))
                    toast.error(
                      t`Не вдалося приховати вакансію. Спробуйте ще раз.`,
                      JOB_QUEUE_TOAST,
                    )
                },
              },
            )
          }
        />
      )}
    />
  )
}

/** ADMIN per-senior «⋯» on a submitted senior (§5.6, D4): cancel that submission at its version. */
function CancelSubmissionMenu({
  scope,
  opportunityId,
  who,
  submission,
  onConflict,
  onCancelled,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  who: string
  submission: JobQueueSubmissionDto
  onConflict: (conflict: boolean) => void
  onCancelled: () => void
}) {
  const { t } = useLingui()
  const cancel = useCancelJobQueueSubmission(scope)
  return (
    <AdminMenu
      label={t`Дії адміністратора: ${who}`}
      item={<Trans>Скасувати подачу…</Trans>}
      dialog={(props) => (
        <ConfirmDialog
          {...props}
          title={<Trans>Скасувати подачу?</Trans>}
          body={<Trans>Подачу «{who}» буде скасовано. Записати її можна буде знову.</Trans>}
          keep={<Trans>Залишити</Trans>}
          confirm={<Trans>Скасувати подачу</Trans>}
          onConfirm={() => {
            onConflict(false)
            cancel.mutate(
              { opportunityId, submissionId: submission.id, expectedVersion: submission.version },
              {
                onSuccess: onCancelled,
                onError: (error) => {
                  if (isQueueConflict(error)) onConflict(true)
                  else if (!isAccessLoss(error))
                    toast.error(t`Не вдалося скасувати подачу. Спробуйте ще раз.`, JOB_QUEUE_TOAST)
                },
              },
            )
          }}
        />
      )}
    />
  )
}

/** §5.8: the senior's block expands in place; the safe choice is primary and takes focus. */
function DuplicateConfirm({
  seniorId,
  pending,
  keepRef,
  onKeep,
  onConfirm,
}: {
  seniorId: string
  pending: boolean
  keepRef: RefObject<HTMLButtonElement>
  onKeep: () => void
  onConfirm: () => void
}) {
  return (
    <div
      data-testid={`job-queue-duplicate-confirm-${seniorId}`}
      // the card's dialog leaves Escape to this block while focus is inside it
      data-escape-scope=""
      role="group"
      aria-labelledby={`job-queue-duplicate-title-${seniorId}`}
      className="flex flex-col gap-3 rounded-lg bg-yellow-subtle p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (!pending) onKeep()
      }}
    >
      <div className="flex items-start gap-2">
        <Copy aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p id={`job-queue-duplicate-title-${seniorId}`} className="font-medium text-pretty">
            <Trans>Цього сеньйора вже подано на схожу вакансію</Trans>
          </p>
          <p className="text-foreground/70 text-pretty">
            <Trans>Ви впевнені, що це інша вакансія?</Trans>
          </p>
        </div>
      </div>
      {/* QA-MED-1: `aria-disabled`, not `disabled`, while pending: a browser drops focus off a
          disabled button to <body>, outside the Escape scope, and Escape then closes the card */}
      <div className="flex flex-col items-start gap-2 sm:flex-row">
        <Button
          ref={keepRef}
          type="button"
          className="min-h-11 aria-disabled:opacity-50 sm:min-h-9"
          aria-disabled={pending || undefined}
          onClick={pending ? undefined : onKeep}
        >
          <Trans>Не записувати</Trans>
        </Button>
        <Button
          type="button"
          variant="outline"
          // UX-L-1: the default outline border is invisible on the amber surface
          className="min-h-11 border-yellow-muted aria-disabled:opacity-50 sm:min-h-9"
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          onClick={onConfirm}
        >
          {pending && (
            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          )}
          <Trans>Так, записати все одно</Trans>
        </Button>
      </div>
    </div>
  )
}

/**
 * One senior's action area (§5.3). Each senior owns its request, so its spinner and errors are its
 * own. The request carries the card revision the actor sees; a released own row re-submits at its
 * version. A possible duplicate opens the inline confirm instead of a toast.
 */
export function SeniorAction({
  scope,
  card,
  senior,
  blocked,
  onConflict,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
  senior: JobQueueCardSeniorDto
  blocked: boolean
  onConflict: (conflict: boolean) => void
}) {
  const { t } = useLingui()
  const submit = useSubmitJobQueueSenior(scope)
  const [confirming, setConfirming] = useState(false)
  // the pending state reaches the DOM a render later; a second click in between must not send
  const inFlight = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const menuBox = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLElement | null>(null)
  // CR-L-2 / UX-L-4: after the confirm closes or a cancel lands, focus returns to this senior — its
  // button if one is drawn, else its row — once the card shows the expected taken state
  const focusAfter = useRef<{ taken: boolean } | null>(null)
  const who = senior.displayName
  const taken = ownTaken(senior)

  useEffect(() => {
    if (confirming) keep.current?.focus()
  }, [confirming])

  // CR-M-3: a layout effect, so the restore runs in the commit, before Radix FocusScope parks focus
  // on the dialog when the focused confirm unmounts
  useLayoutEffect(() => {
    const li = (button.current ?? keep.current ?? menuBox.current)?.closest('li')
    if (li) row.current = li
    const wait = focusAfter.current
    if (!wait || confirming) return
    const active = document.activeElement
    // P2-1: only <body>, the card dialog or this senior's own target are "not moved on"; any other
    // focus (in this row or not) is the actor's choice, never pulled back
    const parked =
      !active ||
      active === document.body ||
      active.matches('[role="dialog"]') ||
      active === button.current ||
      active === row.current
    if (!parked) {
      focusAfter.current = null
      return
    }
    const own = button.current && !button.current.disabled ? button.current : row.current
    own?.focus()
    if (Boolean(taken) === wait.taken) focusAfter.current = null
  })

  if (submittedElsewhere(senior)) return null
  if (taken) {
    return scope.role === 'ADMIN' ? (
      <div ref={menuBox} className="flex justify-end">
        <CancelSubmissionMenu
          scope={scope}
          opportunityId={card.opportunityId}
          who={who}
          submission={taken}
          onConflict={onConflict}
          onCancelled={() => {
            focusAfter.current = { taken: false }
          }}
        />
      </div>
    ) : null
  }
  const released = senior.submission && 'state' in senior.submission ? senior.submission : null

  const send = (confirmPossibleDuplicate: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    onConflict(false)
    submit.mutate(
      {
        opportunityId: card.opportunityId,
        seniorId: senior.seniorId,
        expectedOpportunityRevision: card.revision,
        ...(released ? { expectedVersion: released.version } : {}),
        ...(confirmPossibleDuplicate ? { confirmPossibleDuplicate: true } : {}),
      },
      {
        onSuccess: () => {
          focusAfter.current = { taken: true }
          setConfirming(false)
          toast.success(t`Подачу записано: ${who}`, JOB_QUEUE_TOAST)
        },
        onError: (error) => {
          if (getJobQueuePossibleDuplicateConflict(error)) return setConfirming(true)
          focusAfter.current = { taken: false }
          setConfirming(false)
          if (isQueueConflict(error)) onConflict(true)
          else if (!isAccessLoss(error))
            toast.error(t`Не вдалося записати подачу. Спробуйте ще раз.`, JOB_QUEUE_TOAST)
        },
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  if (confirming) {
    return (
      <DuplicateConfirm
        seniorId={senior.seniorId}
        pending={submit.isPending}
        keepRef={keep}
        onKeep={() => {
          focusAfter.current = { taken: false }
          setConfirming(false)
        }}
        onConfirm={() => send(true)}
      />
    )
  }

  const pending = submit.isPending
  return (
    <Button
      ref={button}
      type="button"
      data-testid={`job-queue-submit-${senior.seniorId}`}
      aria-label={t`Записати подачу: ${who}`}
      aria-busy={pending || undefined}
      // QA-MED-1: pending is `aria-disabled` (focus stays); `send` drops the click while in flight
      aria-disabled={pending || undefined}
      disabled={blocked}
      className="min-h-11 w-full aria-disabled:opacity-50 sm:w-auto sm:self-start"
      onClick={() => send(false)}
    >
      {pending ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          <Trans>Записуємо…</Trans>
        </>
      ) : (
        <Trans>Записати подачу</Trans>
      )}
    </Button>
  )
}

/**
 * «Відкрити оригінал»: the primary source (the click is marked, fire-and-forget) or a manual card's
 * application link. The posting opens synchronously inside the click, or a phone blocks it.
 */
export function OpenOriginalButton({
  scope,
  card,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
}) {
  const markOpened = useMarkJobOpened(scope)
  const source = card.primarySource
  const url = source?.url ?? card.applicationUrl
  if (!url) return null
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 w-full sm:w-auto"
      onClick={() => {
        openOriginalPosting(url)
        if (source) markOpened(card.opportunityId, source.sourceRecordId)
      }}
    >
      <ExternalLink aria-hidden="true" />
      <Trans>Відкрити оригінал</Trans>
    </Button>
  )
}
