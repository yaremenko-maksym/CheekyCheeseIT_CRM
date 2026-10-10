import { useEffect, useMemo, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SafeHttpLink } from '@/components/SafeHttpLink'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useInterviewRecording, useLinkInterviewRecording } from '@/lib/meeting-recorder-api'
import { LinkRecordingDialog } from './LinkRecordingDialog'

type RecordingDetailDialogProps = {
  recordingId: string | null
  open: boolean
  currentInterviewId: string
  onOpenChange: (open: boolean) => void
  onNestedDialogStateChange?: (open: boolean) => void
  onRemovedFromInterview?: () => void
}

function formatOffset(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function RecordingDetailDialog({
  recordingId,
  open,
  currentInterviewId,
  onOpenChange,
  onNestedDialogStateChange,
  onRemovedFromInterview,
}: RecordingDetailDialogProps) {
  const { t, i18n } = useLingui()
  const { user } = useAuth()
  const detailQuery = useInterviewRecording(recordingId, open)
  const unlinkMutation = useLinkInterviewRecording()
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [unlinkOpen, setUnlinkOpen] = useState(false)

  useEffect(() => {
    onNestedDialogStateChange?.(relinkOpen || unlinkOpen)
    return () => onNestedDialogStateChange?.(false)
  }, [relinkOpen, unlinkOpen, onNestedDialogStateChange])

  useEffect(() => {
    if (!open) {
      setRelinkOpen(false)
      setUnlinkOpen(false)
    }
  }, [open])

  const detail = detailQuery.data
  const recording = detail?.snapshot
  const readiness = detail?.readiness

  const startedAtLabel = useMemo(() => {
    if (!detail) return ''
    return new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(detail.startedAt))
  }, [detail, i18n.locale])

  const transcriptStatus = !detail
    ? ''
    : readiness?.pending.includes('transcript')
      ? t`Транскрипт обробляється`
      : recording?.transcript
        ? t`Транскрипт готовий`
        : t`Транскрипт не передано`

  const analysisStatus = !detail
    ? ''
    : readiness?.pending.includes('analysis') || recording?.analysis?.status === 'analyzing'
      ? t`Аналіз обробляється`
      : !recording?.analysis
        ? t`Аналіз не передано`
        : recording.analysis.status === 'completed'
          ? t`Аналіз готовий`
          : recording.analysis.status === 'failed'
            ? t`Помилка аналізу`
            : recording.analysis.status === 'canceled'
              ? t`Аналіз скасовано`
              : t`Аналіз недоступний`

  function closeDetail() {
    if (relinkOpen || unlinkOpen) return
    onOpenChange(false)
  }

  function unlink() {
    if (!recordingId) return
    unlinkMutation.mutate(
      {
        recordingId,
        interviewId: null,
        previousInterviewId: detail?.interviewId ?? currentInterviewId,
      },
      {
        onSuccess: () => {
          toast.success(t`Запис відв'язано`)
          setUnlinkOpen(false)
          onOpenChange(false)
          onRemovedFromInterview?.()
        },
        onError: () => toast.error(t`Не вдалося відв'язати запис`),
      },
    )
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDetail()
        }}
      >
        <CrmDialogContent maxWidth="max-w-[calc(100vw-1rem)] sm:max-w-3xl">
          <CrmDialogHeader>
            <DialogTitle className="pr-6 break-words">
              {detail?.title ?? t`Запис співбесіди`}
            </DialogTitle>
            <DialogDescription>
              <Trans>Транскрипт, нотатки та аналіз, отримані від Meeting Recorder.</Trans>
            </DialogDescription>

            {detail && (
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time dateTime={detail.startedAt}>{startedAtLabel}</time>
                  {detail.durationMs !== null && (
                    <span className="tabular-nums">
                      <Trans>{Math.max(1, Math.round(detail.durationMs / 60_000))} хв</Trans>
                    </span>
                  )}
                  {detail.provider && <span>{detail.provider}</span>}
                </div>
                {detail.meetingUrl && (
                  <SafeHttpLink
                    url={detail.meetingUrl}
                    className="block max-w-full truncate underline underline-offset-2 hover:text-foreground"
                    fallbackClassName="block max-w-full truncate"
                  />
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1" aria-live="polite">
                  <span>{transcriptStatus}</span>
                  <span>{analysisStatus}</span>
                  {readiness?.pending.includes('artifact-delivery') && (
                    <span>
                      <Trans>Доставка матеріалів триває</Trans>
                    </span>
                  )}
                </div>
              </div>
            )}
          </CrmDialogHeader>

          <CrmDialogBody className="space-y-6 pb-5">
            {detailQuery.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : detailQuery.isError ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    <Trans>Не вдалося завантажити запис.</Trans>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
                    <Trans>Повторити</Trans>
                  </Button>
                </AlertDescription>
              </Alert>
            ) : recording ? (
              <>
                <section aria-labelledby="recording-transcript-heading" className="space-y-3">
                  <h3 id="recording-transcript-heading" className="text-sm font-semibold">
                    <Trans>Транскрипт</Trans>
                  </h3>
                  {readiness?.pending.includes('transcript') ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Транскрипт ще обробляється.</Trans>
                    </p>
                  ) : !recording.transcript ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Не передано</Trans>
                    </p>
                  ) : recording.transcript.segments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Транскрипт порожній</Trans>
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {recording.transcript.segments.map((segment, index) => (
                        <div
                          key={`${segment.tStartMs}-${segment.tEndMs}-${index}`}
                          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm md:grid-cols-[4rem_8rem_minmax(0,1fr)]"
                          style={{ contentVisibility: 'auto', containIntrinsicSize: '0 56px' }}
                        >
                          <time className="tabular-nums text-xs text-muted-foreground">
                            {formatOffset(segment.tStartMs)}
                          </time>
                          <div className="min-w-0 md:contents">
                            {segment.speaker && (
                              <p className="mb-0.5 break-words text-xs font-medium text-muted-foreground md:mb-0">
                                {segment.speaker}
                              </p>
                            )}
                            <p className="min-w-0 whitespace-pre-wrap break-words">
                              {segment.text}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {recording.note !== undefined && (
                  <section aria-labelledby="recording-note-heading" className="space-y-2">
                    <h3 id="recording-note-heading" className="text-sm font-semibold">
                      <Trans>Нотатка рекордера</Trans>
                    </h3>
                    <p className="whitespace-pre-wrap break-words text-sm">{recording.note}</p>
                  </section>
                )}

                {recording.notations && recording.notations.length > 0 && (
                  <section aria-labelledby="recording-notations-heading" className="space-y-2">
                    <h3 id="recording-notations-heading" className="text-sm font-semibold">
                      <Trans>Нотатки за часом</Trans>
                    </h3>
                    <div className="space-y-1.5">
                      {recording.notations.map((notation, index) => (
                        <div
                          key={`${notation.tStartMs}-${index}`}
                          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm"
                        >
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {formatOffset(notation.tStartMs)}
                          </span>
                          <p className="whitespace-pre-wrap break-words">{notation.text}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section aria-labelledby="recording-analysis-heading" className="space-y-3">
                  <h3 id="recording-analysis-heading" className="text-sm font-semibold">
                    <Trans>Аналіз</Trans>
                  </h3>
                  {readiness?.pending.includes('analysis') ||
                  recording.analysis?.status === 'analyzing' ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Аналіз ще обробляється.</Trans>
                    </p>
                  ) : !recording.analysis ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Не передано</Trans>
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">{analysisStatus}</p>
                      {recording.analysis.status === 'failed' && recording.analysis.error && (
                        <p className="whitespace-pre-wrap break-words text-sm text-destructive">
                          {recording.analysis.error}
                        </p>
                      )}
                      {recording.analysis.topics && recording.analysis.topics.length > 0 && (
                        <div className="space-y-2">
                          {recording.analysis.topics.map((topic, index) => (
                            <div
                              key={index}
                              className="rounded-md border border-border px-3 py-2 text-sm"
                            >
                              <p className="break-words font-medium">{topic.keywords.join(', ')}</p>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                  <Trans>Важливість: {topic.importance}</Trans>
                                </span>
                                <span>
                                  <Trans>Фрагментів: {topic.spans.length}</Trans>
                                </span>
                              </div>
                              {topic.spans.length > 0 && (
                                <p className="mt-1 break-words text-xs text-muted-foreground tabular-nums">
                                  {topic.spans
                                    .map(
                                      (span) =>
                                        `${formatOffset(span.tStartMs)}–${formatOffset(span.tEndMs)}`,
                                    )
                                    .join(', ')}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </CrmDialogBody>

          {user?.role === 'ADMIN' && detail?.interviewId && (
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setUnlinkOpen(true)}>
                <Trans>Відв'язати</Trans>
              </Button>
              <Button variant="outline" onClick={() => setRelinkOpen(true)}>
                <Trans>Переприв'язати</Trans>
              </Button>
            </CrmDialogFooter>
          )}
        </CrmDialogContent>
      </Dialog>

      {recordingId && detail && (
        <LinkRecordingDialog
          open={relinkOpen}
          onOpenChange={setRelinkOpen}
          recordingId={recordingId}
          recordingTitle={detail.title}
          previousInterviewId={detail.interviewId ?? currentInterviewId}
          onLinked={() => {
            onOpenChange(false)
            onRemovedFromInterview?.()
          }}
        />
      )}

      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Відв'язати запис?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Запис зникне з цієї співбесіди та повернеться до списку неприв'язаних записів.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              data-testid="cancel-button"
              onClick={() => setUnlinkOpen(false)}
            >
              <Trans>Скасувати</Trans>
            </Button>
            <Button variant="destructive" onClick={unlink} disabled={unlinkMutation.isPending}>
              {unlinkMutation.isPending ? t`Відв'язування…` : t`Відв'язати`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
